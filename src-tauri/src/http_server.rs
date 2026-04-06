//! HTTP server for serving the web client static files, the MCP permission bridge API,
//! and the God workspace orchestration REST API.
//!
//! Runs alongside the WebSocket server to provide a browser-based remote interface
//! to the Claude Orchestrator. Also hosts POST /api/permission for the MCP permission
//! bridge, which forwards tool-approval requests from the Claude CLI to the Tauri UI.

use axum::extract::{Query, Request, State as AxumState};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::IntoResponse;
use axum::routing::{get, post};
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
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

use crate::helpers::fixed_length_constant_time_eq;
use crate::types::PermissionRequestEvent;
use crate::AppState;

/// Shared map of pending permission requests. The oneshot sender is resolved
/// when the user allows/denies in the UI via `respond_to_permission`.
/// Each entry stores (workspace_id, sender) so we can selectively drop
/// permissions for a specific workspace when its agent is stopped.
pub type PendingPermissions = Arc<RwLock<HashMap<String, (String, oneshot::Sender<Value>)>>>;

/// Request body from the MCP permission bridge.
#[derive(Deserialize)]
struct PermissionRequest {
    workspace_id: String,
    agent_id: String,
    request_id: String,
    tool_name: String,
    input: Value,
}

/// Shared state for all axum handlers.
#[derive(Clone)]
struct ApiState {
    pending: PendingPermissions,
    app_handle: AppHandle,
    app_state: Arc<AppState>,
    api_token: String,
}

/// Middleware that verifies the `Authorization: Bearer <token>` header
/// on orchestrator API routes. The permission bridge endpoint is excluded.
async fn require_bearer_token(
    AxumState(state): AxumState<ApiState>,
    req: Request,
    next: Next,
) -> impl IntoResponse {
    let auth_header = req.headers().get("authorization").and_then(|v| v.to_str().ok());
    match auth_header {
        Some(header) if header.starts_with("Bearer ") => {
            let token = &header[7..];
            if fixed_length_constant_time_eq(token.as_bytes(), state.api_token.as_bytes()) {
                next.run(req).await.into_response()
            } else {
                (StatusCode::UNAUTHORIZED, axum::Json(serde_json::json!({
                    "error": "Invalid bearer token"
                }))).into_response()
            }
        }
        _ => {
            (StatusCode::UNAUTHORIZED, axum::Json(serde_json::json!({
                "error": "Missing Authorization: Bearer <token> header"
            }))).into_response()
        }
    }
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
    /// When `serve_web` is `false`, only the API endpoints are mounted
    /// (permission bridge + orchestrator API). When `true`, the web client
    /// static files are also served.
    pub async fn start(
        &self,
        pending_permissions: PendingPermissions,
        app_handle: AppHandle,
        app_state: Arc<AppState>,
        serve_web: bool,
    ) -> Result<(), String> {
        // If already running, stop first so we can rebuild with/without web.
        if let Some(handle) = self.task.write().take() {
            if !handle.is_finished() {
                handle.abort();
            }
        }

        let api_token = app_state.api_token.clone();
        let api_state = ApiState {
            pending: pending_permissions,
            app_handle,
            app_state,
            api_token,
        };

        // Orchestrator API routes — protected by bearer token
        // 512 KB body limit — generous for any reasonable prompt, protects against
        // accidental OOM from a runaway god-agent prompt builder.
        const MAX_REQUEST_BODY_BYTES: usize = 512 * 1024;

        let orchestrator_routes = Router::new()
            .route("/api/workspaces", get(handle_list_workspaces))
            .route("/api/workspaces/create", post(handle_create_child_workspace))
            .route("/api/workspace/messages", get(handle_get_workspace_messages))
            .route("/api/workspace/send", post(handle_send_message))
            .route("/api/workspace/start-agent", post(handle_start_agent))
            .route("/api/workspace/stop-agent", post(handle_stop_agent))
            .route("/api/workspace/status", get(handle_get_workspace_status))
            .layer(axum::extract::DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
            .route_layer(middleware::from_fn_with_state(api_state.clone(), require_bearer_token));

        // Permission bridge — no token required (uses its own request_id auth)
        let api_routes = Router::new()
            .route("/api/permission", post(handle_permission_request))
            .layer(axum::extract::DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
            .merge(orchestrator_routes)
            .with_state(api_state);

        // CORS — allow Tauri webview origins and the localhost HTTP server itself.
        // Non-browser callers (Claude CLI, curl) don't send Origin headers so
        // CORS doesn't affect them. We restrict to known origins rather than Any
        // to prevent arbitrary web pages from making cross-origin API calls.
        let allowed_origins = [
            format!("http://127.0.0.1:{}", self.port).parse().unwrap(),
            format!("http://localhost:{}", self.port).parse().unwrap(),
            "tauri://localhost".parse().unwrap(),
            "https://tauri.localhost".parse().unwrap(),
        ];
        let cors = CorsLayer::new()
            .allow_origin(allowed_origins)
            .allow_methods([axum::http::Method::GET, axum::http::Method::POST])
            .allow_headers([axum::http::header::AUTHORIZATION, axum::http::header::CONTENT_TYPE]);

        // Only serve static web client files when explicitly requested
        // (i.e. when the user starts the remote server).
        let mut app = api_routes.layer(cors);
        if serve_web {
            let index_path = self.web_dist_path.join("index.html");
            if self.web_dist_path.exists() {
                app = app.fallback_service(
                    ServeDir::new(&self.web_dist_path)
                        .not_found_service(ServeFile::new(&index_path)),
                );
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

// ─── Permission Bridge Handler ──────────────────────────────────────

/// Handler for POST /api/permission — called by the MCP permission bridge.
/// Creates a oneshot channel, emits a `permission-request` Tauri event to the frontend,
/// then blocks (long-poll) until the user responds via `respond_to_permission`.
async fn handle_permission_request(
    AxumState(state): AxumState<ApiState>,
    axum::Json(req): axum::Json<PermissionRequest>,
) -> impl IntoResponse {
    let (tx, rx) = oneshot::channel::<Value>();

    // Store the sender (with workspace_id for scoped cleanup) so
    // respond_to_permission can resolve it.
    let prev = state
        .pending
        .write()
        .insert(req.request_id.clone(), (req.workspace_id.clone(), tx));
    // If a duplicate request_id was already pending, the old sender is dropped
    // here, which auto-denies that stale request (channel recv error path).
    drop(prev);

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
            // Channel dropped (e.g., agent was stopped) — deny by default.
            // Remove stale entry (may already be gone if stop_agent cleaned it).
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

// ─── God Workspace Orchestrator API ─────────────────────────────────

/// GET /api/workspaces?god_workspace_id=<id> — list child workspaces for a god workspace.
/// The `god_workspace_id` parameter is required to enforce per-god-workspace scoping
/// (all god workspaces share a single bearer token, so without this filter a
/// compromised agent could enumerate workspaces belonging to other god workspaces).
async fn handle_list_workspaces(
    AxumState(state): AxumState<ApiState>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let god_ws_id = match params.get("god_workspace_id") {
        Some(id) => id,
        None => {
            return (StatusCode::BAD_REQUEST, axum::Json(serde_json::json!({
                "error": "Missing required query parameter: god_workspace_id",
            }))).into_response();
        }
    };

    match crate::commands::god_workspace::list_god_child_workspaces(&state.app_state, god_ws_id.clone()) {
        Ok(workspaces) => {
            let agents = state.app_state.agents.read();
            let result: Vec<Value> = workspaces.iter().map(|ws| {
                let agent = agents.values().find(|a| a.workspace_id == ws.id);
                serde_json::json!({
                    "id": ws.id,
                    "name": ws.name,
                    "repoId": ws.repo_id,
                    "branch": ws.branch,
                    "status": ws.status.as_str(),
                    "hasAgent": agent.is_some(),
                    "agentStatus": agent.map(|a| a.status.as_str().to_string()),
                })
            }).collect();
            (StatusCode::OK, axum::Json(serde_json::json!({ "workspaces": result }))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

/// Request body for creating a child workspace.
#[derive(Deserialize)]
struct CreateChildRequest {
    god_workspace_id: String,
    repo_id: String,
    name: String,
}

/// POST /api/workspaces/create — create a child workspace for a god workspace.
async fn handle_create_child_workspace(
    AxumState(state): AxumState<ApiState>,
    axum::Json(req): axum::Json<CreateChildRequest>,
) -> impl IntoResponse {
    match crate::commands::god_workspace::create_god_child_workspace(
        &state.app_state,
        req.god_workspace_id,
        req.repo_id,
        req.name,
    ) {
        Ok(ws) => (StatusCode::CREATED, axum::Json(serde_json::json!({
            "id": ws.id,
            "name": ws.name,
            "repoId": ws.repo_id,
            "branch": ws.branch,
            "status": "idle",
        }))).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, axum::Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

/// Request body/query for workspace-targeted operations.
/// Includes `god_workspace_id` so we can verify the workspace belongs to the caller.
#[derive(Deserialize)]
struct WorkspaceIdRequest {
    workspace_id: String,
    god_workspace_id: String,
}

/// Verify that a workspace belongs to a specific god workspace. Returns 403 if not.
fn verify_workspace_ownership(
    app_state: &AppState,
    workspace_id: &str,
    god_workspace_id: &str,
) -> Result<(), (StatusCode, axum::Json<Value>)> {
    let workspaces = app_state.workspaces.read();
    match workspaces.get(workspace_id) {
        Some(ws) => {
            if ws.parent_god_workspace_id.as_deref() != Some(god_workspace_id) {
                Err((StatusCode::FORBIDDEN, axum::Json(serde_json::json!({
                    "error": "Workspace does not belong to this god workspace",
                }))))
            } else {
                Ok(())
            }
        }
        None => Err((StatusCode::NOT_FOUND, axum::Json(serde_json::json!({
            "error": "Workspace not found",
        })))),
    }
}

/// GET /api/workspace/messages?workspace_id=...&god_workspace_id=... — get message history for a workspace.
async fn handle_get_workspace_messages(
    AxumState(state): AxumState<ApiState>,
    Query(req): Query<WorkspaceIdRequest>,
) -> impl IntoResponse {
    if let Err(resp) = verify_workspace_ownership(&state.app_state, &req.workspace_id, &req.god_workspace_id) {
        return resp.into_response();
    }
    match state.app_state.db.get_messages_by_workspace(&req.workspace_id) {
        Ok(messages) => {
            let result: Vec<Value> = messages.iter().map(|m| {
                serde_json::json!({
                    "role": m.role,
                    "content": m.content,
                    "isError": m.is_error,
                    "timestamp": m.timestamp,
                })
            }).collect();
            (StatusCode::OK, axum::Json(serde_json::json!({ "messages": result }))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(serde_json::json!({ "error": format!("{}", e) }))).into_response(),
    }
}

/// Request body for sending a message to an agent.
#[derive(Deserialize)]
struct SendMessageRequest {
    workspace_id: String,
    god_workspace_id: String,
    message: String,
}

/// POST /api/workspace/send — send a message to the agent running in a workspace.
/// Uses send_message_core which spawns a new CLI process for each message
/// (same as the Tauri send_message_to_agent command).
async fn handle_send_message(
    AxumState(state): AxumState<ApiState>,
    axum::Json(req): axum::Json<SendMessageRequest>,
) -> impl IntoResponse {
    if let Err(resp) = verify_workspace_ownership(&state.app_state, &req.workspace_id, &req.god_workspace_id) {
        return resp.into_response();
    }
    // Find the agent for this workspace, check it's not busy, and atomically
    // set `processing = true` to prevent concurrent sends from racing past the check.
    // Note: `AgentStatus` tracks lifecycle (alive vs stopped), not per-message busy state.
    // The background thread in `send_message_core` resets `processing = false` when done.
    let agent_id = {
        let mut agents = state.app_state.agents.write();
        match agents.values_mut().find(|a| a.workspace_id == req.workspace_id) {
            Some(a) => {
                if a.processing {
                    return (StatusCode::CONFLICT, axum::Json(serde_json::json!({
                        "error": "Agent is busy processing a message. Wait for it to finish or poll status.",
                    }))).into_response();
                }
                a.processing = true;
                a.id.clone()
            }
            None => {
                return (StatusCode::BAD_REQUEST, axum::Json(serde_json::json!({
                    "error": "No agent running in this workspace. Start one first.",
                }))).into_response();
            }
        }
    };

    // permission_mode defaults to dangerouslySkipPermissions (via normalize_permission_mode(None)).
    // This is intentional: child agents spawned by the god workspace are controlled
    // programmatically — there is no human to respond to CLI permission prompts.
    // Tool approval, when needed, goes through the MCP permission bridge instead.
    match crate::send_message_core(
        &state.app_state,
        state.app_handle.clone(),
        agent_id.clone(),
        req.message,
        None,  // env_overrides
        None,  // permission_mode — intentionally skip (see comment above)
        None,  // model — uses workspace default
        None,  // effort — uses workspace default
    ) {
        Ok(()) => (StatusCode::OK, axum::Json(serde_json::json!({
            "sent": true,
            "agentId": agent_id,
        }))).into_response(),
        Err(e) => {
            // Reset the processing flag — the background thread was never
            // spawned, so nothing will clear it. Without this reset, all
            // future sends to this workspace return 409 Conflict indefinitely.
            let mut agents = state.app_state.agents.write();
            if let Some(a) = agents.values_mut().find(|a| a.id == agent_id) {
                a.processing = false;
            }
            (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(serde_json::json!({
                "error": e,
            }))).into_response()
        }
    }
}

/// POST /api/workspace/start-agent — start an agent in a workspace.
/// Calls start_agent_core directly to spawn the Claude CLI process.
async fn handle_start_agent(
    AxumState(state): AxumState<ApiState>,
    axum::Json(req): axum::Json<WorkspaceIdRequest>,
) -> impl IntoResponse {
    if let Err(resp) = verify_workspace_ownership(&state.app_state, &req.workspace_id, &req.god_workspace_id) {
        return resp.into_response();
    }
    // Token injection for god workspaces is handled inside start_agent_core,
    // so we pass None here to avoid double-injection.
    let workspace_id = req.workspace_id.clone();
    match crate::start_agent_core(&state.app_state, state.app_handle.clone(), req.workspace_id, None) {
        Ok(agent) => {
            (StatusCode::CREATED, axum::Json(serde_json::json!({
                "status": "started",
                "agentId": agent.id,
            }))).into_response()
        }
        Err(e) if e.contains("already running") => {
            // Return the existing agent's ID so callers don't need a separate status call.
            // If the agent was stopped between the error and this lookup (TOCTOU), return
            // 409 Conflict so the caller knows to retry rather than receiving a null agentId.
            let agent_id = state.app_state.agents.read().values()
                .find(|a| a.workspace_id == workspace_id)
                .map(|a| a.id.clone());
            match agent_id {
                Some(id) => (StatusCode::OK, axum::Json(serde_json::json!({
                    "status": "already_running",
                    "agentId": id,
                }))).into_response(),
                None => (StatusCode::CONFLICT, axum::Json(serde_json::json!({
                    "error": "Agent was stopped concurrently. Retry the request.",
                }))).into_response(),
            }
        }
        Err(e) => {
            (StatusCode::BAD_REQUEST, axum::Json(serde_json::json!({
                "error": e,
            }))).into_response()
        }
    }
}

/// POST /api/workspace/stop-agent — stop the agent running in a workspace.
async fn handle_stop_agent(
    AxumState(state): AxumState<ApiState>,
    axum::Json(req): axum::Json<WorkspaceIdRequest>,
) -> impl IntoResponse {
    if let Err(resp) = verify_workspace_ownership(&state.app_state, &req.workspace_id, &req.god_workspace_id) {
        return resp.into_response();
    }
    let agent_id = {
        let agents = state.app_state.agents.read();
        agents.values()
            .find(|a| a.workspace_id == req.workspace_id)
            .map(|a| a.id.clone())
    };

    match agent_id {
        Some(id) => {
            match crate::commands::agent::stop_agent(&state.app_state, id.clone()) {
                Ok(()) => (StatusCode::OK, axum::Json(serde_json::json!({
                    "stopped": true,
                    "agentId": id,
                }))).into_response(),
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(serde_json::json!({
                    "error": e,
                }))).into_response(),
            }
        }
        None => (StatusCode::OK, axum::Json(serde_json::json!({
            "stopped": false,
            "message": "No agent running in this workspace",
        }))).into_response(),
    }
}

/// GET /api/workspace/status?workspace_id=...&god_workspace_id=... — get detailed status for a workspace.
async fn handle_get_workspace_status(
    AxumState(state): AxumState<ApiState>,
    Query(req): Query<WorkspaceIdRequest>,
) -> impl IntoResponse {
    if let Err(resp) = verify_workspace_ownership(&state.app_state, &req.workspace_id, &req.god_workspace_id) {
        return resp.into_response();
    }
    let workspace = state.app_state.workspaces.read().get(&req.workspace_id).cloned();

    match workspace {
        Some(ws) => {
            let agents = state.app_state.agents.read();
            let agent = agents.values().find(|a| a.workspace_id == req.workspace_id);
            (StatusCode::OK, axum::Json(serde_json::json!({
                "id": ws.id,
                "name": ws.name,
                "repoId": ws.repo_id,
                "branch": ws.branch,
                "status": ws.status.as_str(),
                "hasAgent": agent.is_some(),
                "agentStatus": agent.map(|a| a.status.as_str().to_string()),
                "lastActivity": ws.last_activity,
                "notes": ws.notes,
            }))).into_response()
        }
        None => (StatusCode::NOT_FOUND, axum::Json(serde_json::json!({
            "error": "Workspace not found",
        }))).into_response(),
    }
}
