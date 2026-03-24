//! HTTP server for serving the web client static files and the MCP permission bridge API.
//!
//! Runs alongside the WebSocket server to provide a browser-based remote interface
//! to the Claude Orchestrator. Also hosts POST /api/permission for the MCP permission
//! bridge, which forwards tool-approval requests from the Claude CLI to the Tauri UI.

use axum::extract::State as AxumState;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::post;
use axum::Router;
use parking_lot::RwLock;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

use crate::types::PermissionRequestEvent;

/// Shared map of pending permission requests. The oneshot sender is resolved
/// when the user allows/denies in the UI via `respond_to_permission`.
pub type PendingPermissions = Arc<RwLock<HashMap<String, oneshot::Sender<Value>>>>;

/// Request body from the MCP permission bridge.
#[derive(Deserialize)]
struct PermissionRequest {
    workspace_id: String,
    agent_id: String,
    request_id: String,
    tool_name: String,
    input: Value,
}

/// Shared state for the axum permission endpoint.
#[derive(Clone)]
struct PermissionApiState {
    pending: PendingPermissions,
    app_handle: AppHandle,
}

pub struct HttpServer {
    port: u16,
    web_dist_path: PathBuf,
    task: Arc<RwLock<Option<JoinHandle<()>>>>,
}

impl HttpServer {
    pub fn new(port: u16, web_dist_path: PathBuf) -> Self {
        Self {
            port,
            web_dist_path,
            task: Arc::new(RwLock::new(None)),
        }
    }

    /// Start the HTTP server.
    ///
    /// When `serve_web` is `false`, only the `/api/permission` endpoint is
    /// mounted (for the MCP permission bridge).  When `true`, the web client
    /// static files are also served — call this when the user explicitly
    /// starts the remote server.
    pub async fn start(
        &self,
        pending_permissions: PendingPermissions,
        app_handle: AppHandle,
        serve_web: bool,
    ) -> Result<(), String> {
        // If already running, stop first so we can rebuild with/without web.
        if let Some(handle) = self.task.write().take() {
            if !handle.is_finished() {
                handle.abort();
            }
        }

        let api_state = PermissionApiState {
            pending: pending_permissions,
            app_handle,
        };

        // API routes — no CORS (only called by local Node.js MCP bridge, not browsers)
        let api_routes = Router::new()
            .route("/api/permission", post(handle_permission_request))
            .with_state(api_state);

        // Only serve static web client files when explicitly requested
        // (i.e. when the user starts the remote server).
        let mut app = api_routes;
        if serve_web {
            let index_path = self.web_dist_path.join("index.html");
            if self.web_dist_path.exists() {
                let cors = CorsLayer::new()
                    .allow_origin(Any)
                    .allow_methods(Any)
                    .allow_headers(Any);
                app = app.fallback_service(
                    ServeDir::new(&self.web_dist_path)
                        .not_found_service(ServeFile::new(&index_path)),
                ).layer(cors);
            }
        }

        let addr = format!("127.0.0.1:{}", self.port);
        let listener = TcpListener::bind(&addr)
            .await
            .map_err(|e| format!("Failed to bind HTTP server: {}", e))?;

        tracing::info!("HTTP server listening on {}", addr);

        let handle = tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                tracing::error!("HTTP server error: {}", e);
            }
        });

        *self.task.write() = Some(handle);
        Ok(())
    }

    pub fn stop(&self) {
        if let Some(handle) = self.task.write().take() {
            handle.abort();
        }
        tracing::info!("HTTP server stopped");
    }
}

/// Handler for POST /api/permission — called by the MCP permission bridge.
/// Creates a oneshot channel, emits a `permission-request` Tauri event to the frontend,
/// then blocks (long-poll) until the user responds via `respond_to_permission`.
async fn handle_permission_request(
    AxumState(state): AxumState<PermissionApiState>,
    axum::Json(req): axum::Json<PermissionRequest>,
) -> impl IntoResponse {
    let (tx, rx) = oneshot::channel::<Value>();

    // Store the sender so respond_to_permission can resolve it
    state
        .pending
        .write()
        .insert(req.request_id.clone(), tx);

    // Emit the permission-request event to the Tauri frontend.
    // The MCP bridge doesn't have access to the upstream tool_use_id
    // from the Claude API, so we leave it empty.
    let permission_event = PermissionRequestEvent {
        workspace_id: req.workspace_id,
        agent_id: req.agent_id,
        request_id: req.request_id.clone(),
        tool_name: req.tool_name.clone(),
        tool_input: req.input,
        tool_use_id: String::new(),
    };
    let _ = state.app_handle.emit("permission-request", &permission_event);

    // Long-poll: wait for the user to respond, with a 5-minute timeout
    // to prevent leaked requests when the UI reloads or the agent is stopped.
    match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
        Ok(Ok(response)) => (StatusCode::OK, axum::Json(response)).into_response(),
        Ok(Err(_)) => {
            // Channel dropped (e.g., agent was stopped) — deny by default
            state.pending.write().remove(&req.request_id);
            let deny = serde_json::json!({
                "behavior": "deny",
                "message": "Permission request was cancelled"
            });
            (StatusCode::OK, axum::Json(deny)).into_response()
        }
        Err(_) => {
            // Timed out waiting for user response
            state.pending.write().remove(&req.request_id);
            let deny = serde_json::json!({
                "behavior": "deny",
                "message": "Permission request timed out (5 minutes)"
            });
            (StatusCode::OK, axum::Json(deny)).into_response()
        }
    }
}
