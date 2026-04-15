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

use crate::helpers::{
    fixed_length_constant_time_eq, MAX_ARTIFACTS_PER_GOD_WORKSPACE, MAX_CHILD_WORKSPACES,
    MAX_MESSAGES_PER_CHILD,
};
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
            .route("/api/workspace/wait", get(handle_wait_workspace))
            .route("/api/artifacts", get(handle_get_artifacts).post(handle_put_artifact).delete(handle_delete_artifact))
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
    /// Optional regex pattern — when set, the status/wait endpoints check the last
    /// agent message and include `completionMatch` if it matches.
    completion_pattern: Option<String>,
}

/// POST /api/workspaces/create — create a child workspace for a god workspace.
async fn handle_create_child_workspace(
    AxumState(state): AxumState<ApiState>,
    axum::Json(req): axum::Json<CreateChildRequest>,
) -> impl IntoResponse {
    let child_count = {
        let workspaces = state.app_state.workspaces.read();
        workspaces.values()
            .filter(|w| w.parent_god_workspace_id.as_deref() == Some(&req.god_workspace_id))
            .count()
    };
    if child_count >= MAX_CHILD_WORKSPACES {
        return (StatusCode::UNPROCESSABLE_ENTITY, axum::Json(serde_json::json!({
            "error": format!("Child workspace limit ({}) reached for this god workspace", MAX_CHILD_WORKSPACES),
        }))).into_response();
    }

    // Compile the optional completion pattern before creating the workspace
    // so we fail fast on invalid regex without creating an orphan workspace.
    let compiled_pattern = match &req.completion_pattern {
        Some(pat) => match regex::Regex::new(pat) {
            Ok(re) => Some(re),
            Err(e) => {
                return (StatusCode::BAD_REQUEST, axum::Json(serde_json::json!({
                    "error": format!("Invalid completion_pattern regex: {}", e),
                }))).into_response();
            }
        },
        None => None,
    };

    match crate::commands::god_workspace::create_god_child_workspace(
        &state.app_state,
        req.god_workspace_id,
        req.repo_id,
        req.name,
    ) {
        Ok(ws) => {
            if let Some(re) = compiled_pattern {
                state.app_state.completion_patterns.write().insert(ws.id.clone(), re);
            }
            (StatusCode::CREATED, axum::Json(serde_json::json!({
                "id": ws.id,
                "name": ws.name,
                "repoId": ws.repo_id,
                "branch": ws.branch,
                "status": "idle",
            }))).into_response()
        }
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

    let msg_count = state.app_state.db.get_workspace_message_count(&req.workspace_id).unwrap_or(0);
    if msg_count >= MAX_MESSAGES_PER_CHILD {
        return (StatusCode::UNPROCESSABLE_ENTITY, axum::Json(serde_json::json!({
            "error": format!("Message limit ({}) reached for this workspace", MAX_MESSAGES_PER_CHILD),
        }))).into_response();
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

/// Build the structured status JSON for a workspace (shared by status and wait endpoints).
/// Lock ordering: acquires workspaces (read) then drops it before acquiring agents (read).
/// The `cloned()` + `?` ensures the workspaces guard is released before agents is taken.
fn build_workspace_status(app_state: &crate::AppState, workspace_id: &str) -> Option<serde_json::Value> {
    let workspace = app_state.workspaces.read().get(workspace_id).cloned();
    let ws = workspace?;

    let agents = app_state.agents.read();
    let agent = agents.values().find(|a| a.workspace_id == workspace_id);
    let has_agent = agent.is_some();
    let agent_status = agent.map(|a| a.status.as_str().to_string());
    let processing = agent.map(|a| a.processing).unwrap_or(false);
    drop(agents);

    let completion_reason = app_state.last_completion_reason.read()
        .get(workspace_id).map(|r| r.as_str());

    let (message_count, full_last_message) = app_state.db
        .get_workspace_message_stats(workspace_id)
        .unwrap_or((0, None));

    const MAX_LAST_MESSAGE_LEN: usize = 2000;

    // Check completion pattern against the full (untruncated) message
    let completion_match = full_last_message.as_deref().and_then(|msg| {
        let patterns = app_state.completion_patterns.read();
        let re = patterns.get(workspace_id)?;
        re.find(msg).map(|m| m.as_str().to_string())
    });

    let last_agent_message = full_last_message.map(|msg| {
        if msg.len() > MAX_LAST_MESSAGE_LEN {
            let boundary = msg.char_indices()
                .map(|(i, _)| i)
                .take_while(|&i| i <= MAX_LAST_MESSAGE_LEN)
                .last()
                .unwrap_or(0);
            format!("{}...", &msg[..boundary])
        } else {
            msg
        }
    });

    Some(serde_json::json!({
        "id": ws.id,
        "name": ws.name,
        "repoId": ws.repo_id,
        "branch": ws.branch,
        "status": ws.status.as_str(),
        "hasAgent": has_agent,
        "agentStatus": agent_status,
        "processing": processing,
        "completionReason": completion_reason,
        "completionMatch": completion_match,
        "lastAgentMessage": last_agent_message,
        "messageCount": message_count,
        "lastActivity": ws.last_activity,
        "notes": ws.notes,
    }))
}

/// GET /api/workspace/status?workspace_id=...&god_workspace_id=... — get detailed status for a workspace.
async fn handle_get_workspace_status(
    AxumState(state): AxumState<ApiState>,
    Query(req): Query<WorkspaceIdRequest>,
) -> impl IntoResponse {
    if let Err(resp) = verify_workspace_ownership(&state.app_state, &req.workspace_id, &req.god_workspace_id) {
        return resp.into_response();
    }
    match build_workspace_status(&state.app_state, &req.workspace_id) {
        Some(status) => (StatusCode::OK, axum::Json(status)).into_response(),
        None => (StatusCode::NOT_FOUND, axum::Json(serde_json::json!({
            "error": "Workspace not found",
        }))).into_response(),
    }
}

/// Query params for the wait endpoint.
#[derive(Deserialize)]
struct WaitWorkspaceRequest {
    workspace_id: String,
    god_workspace_id: String,
    /// Timeout in seconds (default 300, max 300).
    timeout: Option<u64>,
}

/// GET /api/workspace/wait?workspace_id=...&god_workspace_id=...&timeout=...
/// Long-polls until the agent in the workspace finishes processing, or the timeout expires.
/// Returns the same structured status as /api/workspace/status.
async fn handle_wait_workspace(
    AxumState(state): AxumState<ApiState>,
    Query(req): Query<WaitWorkspaceRequest>,
) -> impl IntoResponse {
    if let Err(resp) = verify_workspace_ownership(&state.app_state, &req.workspace_id, &req.god_workspace_id) {
        return resp.into_response();
    }

    let timeout_secs = req.timeout.unwrap_or(300).min(300);

    // Subscribe FIRST so we cannot miss a completion that fires during the check.
    let mut rx = state.app_state.agent_completions.subscribe();

    // Fast path: if the agent is not currently processing, return immediately.
    {
        let agents = state.app_state.agents.read();
        let is_processing = agents.values()
            .find(|a| a.workspace_id == req.workspace_id)
            .map(|a| a.processing)
            .unwrap_or(false);
        if !is_processing {
            return match build_workspace_status(&state.app_state, &req.workspace_id) {
                Some(status) => (StatusCode::OK, axum::Json(serde_json::json!({
                    "waited": false,
                    "timedOut": false,
                    "workspace": status,
                }))).into_response(),
                None => (StatusCode::NOT_FOUND, axum::Json(serde_json::json!({
                    "error": "Workspace not found",
                }))).into_response(),
            };
        }
    }
    let timeout = std::time::Duration::from_secs(timeout_secs);

    // Wait for the matching workspace completion or timeout.
    let timed_out = match tokio::time::timeout(timeout, async {
        loop {
            match rx.recv().await {
                Ok(ws_id) if ws_id == req.workspace_id => break,
                Ok(_) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    }).await {
        Ok(()) => false,
        Err(_) => true,
    };

    match build_workspace_status(&state.app_state, &req.workspace_id) {
        Some(status) => (StatusCode::OK, axum::Json(serde_json::json!({
            "waited": true,
            "timedOut": timed_out,
            "workspace": status,
        }))).into_response(),
        None => (StatusCode::NOT_FOUND, axum::Json(serde_json::json!({
            "error": "Workspace not found",
        }))).into_response(),
    }
}

// ─── Shared Artifact Store ────────────────────────────────────────────

/// Query params for GET /api/artifacts.
#[derive(Deserialize)]
struct GetArtifactsRequest {
    god_workspace_id: String,
    /// Optional: return only a single artifact by key.
    key: Option<String>,
}

/// Verify that a god_workspace_id refers to a real god workspace.
fn verify_god_workspace_exists(
    app_state: &crate::AppState,
    god_workspace_id: &str,
) -> Result<(), (StatusCode, axum::Json<Value>)> {
    let workspaces = app_state.workspaces.read();
    match workspaces.get(god_workspace_id) {
        Some(ws) if ws.is_god => Ok(()),
        _ => Err((StatusCode::NOT_FOUND, axum::Json(serde_json::json!({
            "error": "God workspace not found",
        })))),
    }
}

/// GET /api/artifacts?god_workspace_id=...&key=... — list or get artifacts.
async fn handle_get_artifacts(
    AxumState(state): AxumState<ApiState>,
    Query(req): Query<GetArtifactsRequest>,
) -> impl IntoResponse {
    if let Err(resp) = verify_god_workspace_exists(&state.app_state, &req.god_workspace_id) {
        return resp.into_response();
    }

    let artifacts = state.app_state.artifacts.read();
    let store = artifacts.get(&req.god_workspace_id);

    match req.key {
        Some(key) => {
            let entry = store.and_then(|s| s.get(&key));
            match entry {
                Some((value, updated_at)) => (StatusCode::OK, axum::Json(serde_json::json!({
                    "key": key,
                    "value": value,
                    "updatedAt": updated_at,
                }))).into_response(),
                None => (StatusCode::NOT_FOUND, axum::Json(serde_json::json!({
                    "error": format!("Artifact '{}' not found", key),
                }))).into_response(),
            }
        }
        None => {
            let mut items: Vec<Value> = store
                .map(|s| s.iter().map(|(k, (v, ts))| serde_json::json!({
                    "key": k,
                    "value": v,
                    "updatedAt": ts,
                })).collect())
                .unwrap_or_default();
            items.sort_by(|a, b| {
                let ta = a["updatedAt"].as_str().unwrap_or("");
                let tb = b["updatedAt"].as_str().unwrap_or("");
                tb.cmp(ta)
            });
            (StatusCode::OK, axum::Json(serde_json::json!({ "artifacts": items }))).into_response()
        }
    }
}

/// Request body for POST /api/artifacts.
#[derive(Deserialize)]
struct PutArtifactRequest {
    god_workspace_id: String,
    key: String,
    value: String,
}

const MAX_ARTIFACT_KEY_LEN: usize = 256;

/// POST /api/artifacts — store or update a shared artifact.
async fn handle_put_artifact(
    AxumState(state): AxumState<ApiState>,
    axum::Json(req): axum::Json<PutArtifactRequest>,
) -> impl IntoResponse {
    if req.key.is_empty() || req.key.len() > MAX_ARTIFACT_KEY_LEN {
        return (StatusCode::BAD_REQUEST, axum::Json(serde_json::json!({
            "error": format!("Artifact key must be 1-{} characters", MAX_ARTIFACT_KEY_LEN),
        }))).into_response();
    }
    if let Err(resp) = verify_god_workspace_exists(&state.app_state, &req.god_workspace_id) {
        return resp.into_response();
    }

    let updated_at = crate::helpers::now_rfc3339();
    let mut artifacts = state.app_state.artifacts.write();
    let store = artifacts.entry(req.god_workspace_id).or_default();
    if !store.contains_key(&req.key) && store.len() >= MAX_ARTIFACTS_PER_GOD_WORKSPACE {
        return (StatusCode::UNPROCESSABLE_ENTITY, axum::Json(serde_json::json!({
            "error": format!("Artifact limit ({}) reached for this god workspace", MAX_ARTIFACTS_PER_GOD_WORKSPACE),
        }))).into_response();
    }
    store.insert(req.key.clone(), (req.value, updated_at.clone()));
    (StatusCode::OK, axum::Json(serde_json::json!({
        "stored": true,
        "key": req.key,
        "updatedAt": updated_at,
    }))).into_response()
}

/// Query params for DELETE /api/artifacts.
#[derive(Deserialize)]
struct DeleteArtifactRequest {
    god_workspace_id: String,
    key: String,
}

/// DELETE /api/artifacts — remove a shared artifact by key.
async fn handle_delete_artifact(
    AxumState(state): AxumState<ApiState>,
    Query(req): Query<DeleteArtifactRequest>,
) -> impl IntoResponse {
    if let Err(resp) = verify_god_workspace_exists(&state.app_state, &req.god_workspace_id) {
        return resp.into_response();
    }

    let mut artifacts = state.app_state.artifacts.write();
    if let Some(store) = artifacts.get_mut(&req.god_workspace_id) {
        if store.remove(&req.key).is_some() {
            return (StatusCode::OK, axum::Json(serde_json::json!({
                "deleted": true,
                "key": req.key,
            }))).into_response();
        }
    }
    (StatusCode::NOT_FOUND, axum::Json(serde_json::json!({
        "error": format!("Artifact '{}' not found", req.key),
    }))).into_response()
}
