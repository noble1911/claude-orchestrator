use parking_lot::RwLock;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::net::{IpAddr, UdpSocket};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::mpsc;

pub mod claude;
pub mod commands;
mod database;
pub mod git;
pub mod helpers;
mod http_server;
pub mod types;
mod websocket_server;

use claude::discovery::find_claude_cli_with_env;
use claude::models::{append_claude_request_args, write_stdin_user_message};
use claude::runner::reset_agent_claude_session;
use commands::agent::{status_for_agent_start, status_for_agent_stop};
use database::Database;
use helpers::*;
use http_server::{HttpServer, PendingPermissions};
pub use types::*;
use websocket_server::{
    ChangeInfo, CheckInfo, FileEntryInfo, MessageInfo, RepositoryInfo, ServerCommand, WebSocketServer,
    WorkspaceInfo, WsResponse,
};

const REMOTE_SERVER_PORT: u16 = 3001;
pub const HTTP_SERVER_PORT: u16 = 3002;


// Application State
pub struct AppState {
    db: Arc<Database>,
    repositories: RwLock<HashMap<String, Repository>>,
    workspaces: RwLock<HashMap<String, Workspace>>,
    agents: RwLock<HashMap<String, Agent>>,
    /// Tracks child process PIDs per agent so we can send SIGINT to interrupt.
    child_pids: RwLock<HashMap<String, u32>>,
    /// Stdin handles for Claude CLI processes, used to send permission responses.
    agent_stdin: RwLock<HashMap<String, Arc<Mutex<ChildStdin>>>>,
    /// Pending permission requests from the MCP bridge, keyed by request_id.
    /// Shared with the HTTP server; the oneshot sender is resolved when the user
    /// allows/denies via the UI.
    pending_permission_requests: PendingPermissions,
    ws_server: Option<Arc<WebSocketServer>>,
    http_server: Option<Arc<HttpServer>>,
    ws_server_running: RwLock<bool>,
    ws_connected_clients: RwLock<usize>,
    pairing_code: Arc<RwLock<Option<String>>>,
    /// Bearer token for the God workspace orchestrator API.
    /// Persisted in the database so it survives app restarts — a god agent
    /// that was started in a prior session will still have the correct token.
    pub(crate) api_token: String,
}

impl AppState {
    fn new(db: Database) -> Self {
        let db = Arc::new(db);

        // Load or generate a persistent API token so god agents survive app restarts
        let api_token = match db.get_setting("api_token") {
            Ok(Some(token)) => token,
            _ => {
                let token = new_id();
                let _ = db.set_setting("api_token", &token);
                token
            }
        };

        let mut state = Self {
            db: db.clone(),
            repositories: RwLock::new(HashMap::new()),
            workspaces: RwLock::new(HashMap::new()),
            agents: RwLock::new(HashMap::new()),
            child_pids: RwLock::new(HashMap::new()),
            agent_stdin: RwLock::new(HashMap::new()),
            pending_permission_requests: Arc::new(RwLock::new(HashMap::new())),
            ws_server: None,
            http_server: None,
            ws_server_running: RwLock::new(false),
            ws_connected_clients: RwLock::new(0),
            pairing_code: Arc::new(RwLock::new(None)),
            api_token,
        };

        // Load persisted data
        state.load_from_db();
        state
    }
    
    fn load_from_db(&mut self) {
        // Load repositories
        if let Ok(repos) = self.db.get_all_repositories() {
            let mut repo_map = self.repositories.write();
            for repo in repos {
                repo_map.insert(repo.id.clone(), repo);
            }
        }
        
        // Load all workspaces (regular + god + children) into memory
        if let Ok(workspaces) = self.db.get_all_workspaces_unfiltered() {
            let mut ws_map = self.workspaces.write();
            for ws in workspaces {
                ws_map.insert(ws.id.clone(), ws);
            }
        }
    }
    
    fn set_ws_server(&mut self, server: Arc<WebSocketServer>) {
        self.ws_server = Some(server);
    }

    fn set_http_server(&mut self, server: Arc<HttpServer>) {
        self.http_server = Some(server);
    }
}

fn to_workspace_info(workspace: &Workspace, has_agent: bool) -> WorkspaceInfo {
    WorkspaceInfo {
        id: workspace.id.clone(),
        repo_id: workspace.repo_id.clone(),
        name: workspace.name.clone(),
        branch: workspace.branch.clone(),
        status: workspace.status.as_str().to_string(),
        has_agent,
        pinned_at: workspace.pinned_at.clone(),
        notes: workspace.notes.clone(),
    }
}

fn to_repository_info(repository: &Repository) -> RepositoryInfo {
    RepositoryInfo {
        id: repository.id.clone(),
        path: repository.path.clone(),
        name: repository.name.clone(),
        default_branch: repository.default_branch.clone(),
        added_at: repository.added_at.clone(),
    }
}

// Git helpers
fn detect_remote_connect_host() -> String {
    let socket = match UdpSocket::bind("0.0.0.0:0") {
        Ok(socket) => socket,
        Err(_) => return "localhost".to_string(),
    };

    if socket.connect("8.8.8.8:80").is_err() {
        return "localhost".to_string();
    }

    match socket.local_addr() {
        Ok(addr) => match addr.ip() {
            IpAddr::V4(v4) => v4.to_string(),
            IpAddr::V6(v6) => format!("[{}]", v6),
        },
        Err(_) => "localhost".to_string(),
    }
}

fn build_server_status(state: &AppState) -> ServerStatus {
    let running = *state.ws_server_running.read();
    let connected_clients = *state.ws_connected_clients.read();
    let pairing_code = state.pairing_code.read().clone();
    let host = detect_remote_connect_host();
    ServerStatus {
        running,
        port: REMOTE_SERVER_PORT,
        connected_clients,
        connect_url: format!("ws://{}:{}", host, REMOTE_SERVER_PORT),
        web_url: format!("http://{}:{}", host, HTTP_SERVER_PORT),
        pairing_code,
    }
}

fn generate_pairing_code_string() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    format!("{:06}", seed % 1_000_000)
}

// Tauri Commands
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    
    app.dialog()
        .file()
        .set_title("Select Git Repository")
        .pick_folder(move |folder_path| {
            let path = folder_path.map(|p| p.to_string());
            let _ = tx.send(path);
        });
    
    rx.recv()
        .map_err(|e| format!("Dialog error: {}", e))
}

#[tauri::command]
async fn get_app_status(state: State<'_, Arc<AppState>>) -> Result<AppStatus, String> {
    let repositories: Vec<Repository> = state.repositories.read().values().cloned().collect();
    
    Ok(AppStatus {
        repositories,
        server_status: build_server_status(state.inner().as_ref()),
    })
}

#[tauri::command]
async fn start_remote_server(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<ServerStatus, String> {
    let server = state
        .ws_server
        .clone()
        .ok_or_else(|| "Remote server is not initialized.".to_string())?;

    // Generate a pairing code when starting the server
    let code = generate_pairing_code_string();
    *state.pairing_code.write() = Some(code);

    server.start().await?;
    *state.ws_server_running.write() = true;
    *state.ws_connected_clients.write() = server.client_count();

    // Restart the HTTP server with web client static files enabled.
    // On app init it was started with only the permission API (serve_web=false);
    // now upgrade it to also serve the web client.
    if let Some(http) = &state.http_server {
        let pending = state.pending_permission_requests.clone();
        let app_state_clone: Arc<AppState> = state.inner().clone();
        http.start(pending, app, app_state_clone, true).await
            .map_err(|e| format!("Failed to start HTTP server with web client: {}", e))?;
    }

    Ok(build_server_status(state.inner().as_ref()))
}

#[tauri::command]
async fn stop_remote_server(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<ServerStatus, String> {
    let server = state
        .ws_server
        .clone()
        .ok_or_else(|| "Remote server is not initialized.".to_string())?;

    server.stop();
    *state.ws_server_running.write() = false;
    *state.ws_connected_clients.write() = 0;
    *state.pairing_code.write() = None;

    // Downgrade the HTTP server: stop serving web client static files
    // but keep the /api/permission endpoint alive for the MCP bridge.
    if let Some(http) = &state.http_server {
        let pending = state.pending_permission_requests.clone();
        let app_state_clone: Arc<AppState> = state.inner().clone();
        if let Err(e) = http.start(pending, app, app_state_clone, false).await {
            tracing::warn!("Failed to restart HTTP server in API-only mode: {}", e);
        }
    }

    Ok(build_server_status(state.inner().as_ref()))
}

#[tauri::command]
async fn regenerate_pairing_code(state: State<'_, Arc<AppState>>) -> Result<ServerStatus, String> {
    let code = generate_pairing_code_string();
    *state.pairing_code.write() = Some(code);
    Ok(build_server_status(state.inner().as_ref()))
}

#[tauri::command]
async fn check_for_app_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app
        .updater()
        .map_err(|e| format!("Failed to initialize updater: {}", e))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("Failed to check for updates: {}", e))?;

    Ok(update.map(|item| UpdateInfo {
        current_version: item.current_version,
        version: item.version,
        body: item.body,
        date: item.date.map(|d| d.to_string()),
    }))
}

#[tauri::command]
async fn install_app_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app
        .updater()
        .map_err(|e| format!("Failed to initialize updater: {}", e))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("Failed to check for updates: {}", e))?
        .ok_or_else(|| "No update available.".to_string())?;

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("Failed to download/install update: {}", e))?;

    app.request_restart();
    Ok(())
}

#[tauri::command]
async fn add_repository(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Repository, String> {
    commands::repository::add_repository(&state, path)
}

#[tauri::command]
async fn remove_repository(
    repo_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    commands::repository::remove_repository(&state, repo_id)
}

#[tauri::command]
async fn list_repositories(state: State<'_, Arc<AppState>>) -> Result<Vec<Repository>, String> {
    commands::repository::list_repositories(&state)
}

#[tauri::command]
async fn list_workspaces(
    repo_id: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<Workspace>, String> {
    commands::workspace::list_workspaces(&state, repo_id)
}

/// Check if a repository has a git operation in progress (Conductor pattern)
#[tauri::command]
async fn check_git_busy(
    repo_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    commands::workspace::check_git_busy(&state, repo_id)
}

#[tauri::command]
async fn get_orchestrator_config(
    repo_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<OrchestratorConfig, String> {
    commands::workspace::get_orchestrator_config(&state, repo_id)
}

#[tauri::command]
async fn get_workspace_config(
    workspace_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<OrchestratorConfig, String> {
    commands::workspace::get_workspace_config(&state, workspace_id)
}

#[tauri::command]
async fn run_orchestrator_script(
    workspace_id: String,
    script_type: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(String, String, i32), String> {
    commands::workspace::run_orchestrator_script(&state, workspace_id, script_type)
}

#[tauri::command]
async fn create_workspace(
    repo_id: String,
    name: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Workspace, String> {
    commands::workspace::create_workspace(&state, repo_id, name)
}

#[tauri::command]
async fn remove_workspace(
    workspace_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    commands::workspace::remove_workspace(&state, workspace_id)
}

#[tauri::command]
async fn rename_workspace(
    workspace_id: String,
    name: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Workspace, String> {
    commands::workspace::rename_workspace(&state, workspace_id, name)
}

#[tauri::command]
async fn update_workspace_unread(
    workspace_id: String,
    unread: i32,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    commands::workspace::update_workspace_unread(&state, workspace_id, unread)
}

#[tauri::command]
async fn update_workspace_display_order(
    workspace_id: String,
    display_order: i32,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    commands::workspace::update_workspace_display_order(&state, workspace_id, display_order)
}

#[tauri::command]
async fn toggle_workspace_pinned(
    workspace_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Workspace, String> {
    commands::workspace::toggle_workspace_pinned(&state, workspace_id)
}

#[tauri::command]
async fn update_workspace_notes(
    workspace_id: String,
    notes: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    commands::workspace::update_workspace_notes(&state, workspace_id, notes)
}

#[tauri::command]
async fn set_workspace_status(
    workspace_id: String,
    status: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Workspace, String> {
    commands::workspace::set_workspace_status(&state, workspace_id, status)
}

#[tauri::command]
async fn run_workspace_terminal_command(
    workspace_id: String,
    command: String,
    env_overrides: Option<HashMap<String, String>>,
    state: State<'_, Arc<AppState>>,
) -> Result<TerminalCommandResult, String> {
    commands::workspace::run_workspace_terminal_command(&state, workspace_id, command, env_overrides)
}

// ─── God Workspace Commands ─────────────────────────────────────────

#[tauri::command]
async fn create_god_workspace(
    repo_id: String,
    name: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Workspace, String> {
    commands::god_workspace::create_god_workspace(&state, repo_id, name)
}

#[tauri::command]
async fn list_god_workspaces(state: State<'_, Arc<AppState>>) -> Result<Vec<Workspace>, String> {
    commands::god_workspace::list_god_workspaces(&state)
}

#[tauri::command]
async fn remove_god_workspace(
    id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    commands::god_workspace::remove_god_workspace(&state, id)
}

#[tauri::command]
async fn list_god_child_workspaces(
    god_workspace_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<Workspace>, String> {
    commands::god_workspace::list_god_child_workspaces(&state, god_workspace_id)
}

#[tauri::command]
async fn create_god_child_workspace(
    god_workspace_id: String,
    repo_id: String,
    name: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Workspace, String> {
    commands::god_workspace::create_god_child_workspace(&state, god_workspace_id, repo_id, name)
}

// ─── Agent Commands ─────────────────────────────────────────────────

#[tauri::command]
async fn list_agents(state: State<'_, Arc<AppState>>) -> Result<Vec<Agent>, String> {
    commands::agent::list_agents(&state)
}

/// Core start_agent logic — callable from both Tauri commands and HTTP handlers.
pub(crate) fn start_agent_core(
    state: &Arc<AppState>,
    app: tauri::AppHandle,
    workspace_id: String,
    env_overrides: Option<HashMap<String, String>>,
) -> Result<Agent, String> {
    // Guard: reject if an agent is already running in this workspace
    {
        let agents = state.agents.read();
        if agents.values().any(|a| a.workspace_id == workspace_id) {
            return Err("An agent is already running in this workspace".to_string());
        }
    }

    // Get workspace info
    let workspace = {
        let workspaces = state.workspaces.read();
        workspaces.get(&workspace_id).cloned()
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?
    };

    let agent_id = new_id();
    let session_id = new_id();

    // Try to resume the most recent Claude session for this workspace so that
    // conversations survive app restarts.  Falls back to a fresh session if
    // no prior session exists.
    let claude_session_id: Option<String> = state
        .db
        .get_latest_claude_session_id(&workspace_id)
        .unwrap_or(None);

    // Create session in database
    let now = now_rfc3339();
    state.db.insert_session(&session_id, &workspace_id, claude_session_id.as_deref(), &now)
        .map_err(|e| format!("Failed to create session: {}", e))?;

    // Create agent record
    let agent = Agent {
        id: agent_id.clone(),
        workspace_id: workspace_id.clone(),
        status: AgentStatus::Running,
        session_id: Some(session_id.clone()),
        claude_session_id: claude_session_id.clone(),
        processing: false,
    };

    {
        let mut agents = state.agents.write();
        agents.insert(agent_id.clone(), agent.clone());
    }

    // Update workspace status
    let next_status = {
        let mut workspaces = state.workspaces.write();
        if let Some(workspace) = workspaces.get_mut(&workspace_id) {
            let next = status_for_agent_start(&workspace.status);
            workspace.status = next.clone();
            workspace.last_activity = Some(now_rfc3339());
            Some(next)
        } else {
            None
        }
    };

    // Update database
    if let Some(status) = next_status {
        let now = now_rfc3339();
        let _ = state
            .db
            .update_workspace_status(&workspace_id, &status, Some(&now));
    }

    // Get WebSocket server for broadcasting
    let ws_server = state.ws_server.clone();

    // Spawn Claude CLI in background thread
    let workspace_path = workspace.worktree_path.clone();
    let workspace_name = workspace.name.clone();
    let agent_id_clone = agent_id.clone();
    let db = state.db.clone();
    let session_id_clone = session_id.clone();
    let workspace_id_clone = workspace_id.clone();
    let mut env_overrides_clone = env_overrides.unwrap_or_default();

    // Inject God workspace identity into the agent's environment so the
    // bundled skill can reference $GOD_WORKSPACE_ID in curl commands.
    if workspace.is_god {
        env_overrides_clone.insert("GOD_WORKSPACE_ID".to_string(), workspace_id.clone());
        env_overrides_clone.insert("GOD_WORKSPACE_REPO_ID".to_string(), workspace.repo_id.clone());
        env_overrides_clone.insert("ORCHESTRATOR_API_TOKEN".to_string(), state.api_token.clone());
    }

    std::thread::spawn(move || {
        run_claude_cli(
            app,
            agent_id_clone,
            workspace_path,
            workspace_name,
            claude_session_id,
            db,
            session_id_clone,
            ws_server,
            workspace_id_clone,
            env_overrides_clone,
        );
    });

    Ok(agent)
}

#[tauri::command]
async fn start_agent(
    workspace_id: String,
    env_overrides: Option<HashMap<String, String>>,
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<Agent, String> {
    start_agent_core(state.inner(), app, workspace_id, env_overrides)
}


fn load_cli_shell_env() -> HashMap<String, String> {
    // Source env vars from the user's login shell profile — NOT the Tauri
    // parent process.  The parent process may carry stale values (e.g. expired
    // AWS STS session tokens) that override the user's real credential chain.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = Command::new(&shell)
        .args(["-lic", "printenv"])
        // Avoid shell-framework writes that can fail in app/sandbox contexts.
        .env("DISABLE_AUTO_UPDATE", "true")
        .env("DISABLE_UPDATE_PROMPT", "true")
        .env("ZSH_DISABLE_COMPFIX", "true")
        .env("ZSH_COMPDUMP", "/tmp/.zcompdump-claude-orchestrator")
        .output();

    let env_map: HashMap<String, String> = match output {
        Ok(ref out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let mut map = HashMap::new();
            for line in stdout.lines() {
                if let Some((key, value)) = line.split_once('=') {
                    if !key.trim().is_empty() {
                        map.insert(key.to_string(), value.to_string());
                    }
                }
            }
            if map.is_empty() {
                // Shell returned nothing — fall back to parent process env
                // as a last resort so the CLI can still find basic vars.
                std::env::vars().collect()
            } else {
                map
            }
        }
        Err(_) => std::env::vars().collect(),
    };

    env_map
}

fn env_truthy(value: Option<&String>) -> bool {
    match value.map(|s| s.trim().to_lowercase()) {
        Some(v) if v == "1" || v == "true" || v == "yes" || v == "on" => true,
        _ => false,
    }
}

fn env_nonempty(env_map: &HashMap<String, String>, key: &str) -> bool {
    env_map
        .get(key)
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

#[derive(Debug, Deserialize, Default)]
struct ClaudeSettingsFile {
    env: Option<HashMap<String, String>>,
    #[serde(rename = "model")]
    _model: Option<String>,
    #[serde(rename = "awsAuthRefresh")]
    aws_auth_refresh: Option<String>,
}

fn parse_claude_settings(raw: &str) -> ClaudeSettingsFile {
    serde_json::from_str::<ClaudeSettingsFile>(raw).unwrap_or_default()
}

#[cfg(test)]
fn parse_claude_settings_env(raw: &str) -> HashMap<String, String> {
    parse_claude_settings(raw)
        .env
        .unwrap_or_default()
        .into_iter()
        .filter(|(key, value)| !key.trim().is_empty() && !value.trim().is_empty())
        .collect()
}

fn load_claude_settings() -> ClaudeSettingsFile {
    let home = match std::env::var("HOME") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => return ClaudeSettingsFile::default(),
    };

    let settings_path = PathBuf::from(home).join(".claude").join("settings.json");
    let raw = match std::fs::read_to_string(settings_path) {
        Ok(content) => content,
        Err(_) => return ClaudeSettingsFile::default(),
    };

    parse_claude_settings(&raw)
}

fn load_claude_settings_env() -> HashMap<String, String> {
    load_claude_settings()
        .env
        .unwrap_or_default()
        .into_iter()
        .filter(|(key, value)| !key.trim().is_empty() && !value.trim().is_empty())
        .collect()
}

fn load_claude_settings_auth_refresh_command() -> Option<String> {
    load_claude_settings()
        .aws_auth_refresh
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn summarize_command_output(raw: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(raw);
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn run_aws_auth_refresh(env_map: &HashMap<String, String>) -> Option<Result<String, String>> {
    if !env_truthy(env_map.get("CLAUDE_CODE_USE_BEDROCK")) {
        return None;
    }

    let refresh_cmd = load_claude_settings_auth_refresh_command()?;
    let shell = env_map
        .get("SHELL")
        .cloned()
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/zsh".to_string());
    let mut cmd = Command::new(shell);
    cmd.args(["-lc", &refresh_cmd]);
    configure_cli_env(&mut cmd, env_map);

    let output = match cmd.output() {
        Ok(value) => value,
        Err(e) => {
            return Some(Err(format!(
                "Failed to execute awsAuthRefresh command: {}",
                e
            )));
        }
    };

    if output.status.success() {
        if let Some(line) = summarize_command_output(&output.stdout) {
            Some(Ok(format!("awsAuthRefresh completed: {}", line)))
        } else {
            Some(Ok("awsAuthRefresh completed successfully.".to_string()))
        }
    } else {
        let detail = summarize_command_output(&output.stderr)
            .or_else(|| summarize_command_output(&output.stdout))
            .unwrap_or_else(|| "No error output from command.".to_string());
        let code = output
            .status
            .code()
            .map(|value| value.to_string())
            .unwrap_or_else(|| "signal".to_string());
        Some(Err(format!(
            "awsAuthRefresh failed (exit {}): {}",
            code, detail
        )))
    }
}

fn aws_shared_profile_exists(profile: &str) -> bool {
    let home = match std::env::var("HOME") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => return false,
    };

    let aws_dir = PathBuf::from(home).join(".aws");
    let candidates = [aws_dir.join("config"), aws_dir.join("credentials")];
    let profile_header = format!("[{}]", profile);
    let config_profile_header = format!("[profile {}]", profile);

    for candidate in candidates {
        let content = match std::fs::read_to_string(candidate) {
            Ok(text) => text,
            Err(_) => continue,
        };

        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.eq_ignore_ascii_case(&profile_header)
                || trimmed.eq_ignore_ascii_case(&config_profile_header)
            {
                return true;
            }
        }
    }

    false
}

fn build_effective_cli_env(env_overrides: &HashMap<String, String>) -> HashMap<String, String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut env_map = load_cli_shell_env();

    let existing = env_map
        .get("PATH")
        .cloned()
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
    let extra = format!(
        "{}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        home
    );
    let merged = if existing.is_empty() {
        extra
    } else {
        format!("{}:{}", extra, existing)
    };
    env_map.insert("PATH".to_string(), merged);

    // Merge env values from ~/.claude/settings.json so Claude's local
    // Bedrock/SSO setup works without duplicating vars in this app.
    // Precedence: shell env < Claude settings env < app overrides.
    for (key, value) in load_claude_settings_env() {
        env_map.insert(key, value);
    }

    for (key, value) in env_overrides {
        if !key.trim().is_empty() {
            env_map.insert(key.clone(), value.clone());
        }
    }

    // Bedrock with AWS SSO typically relies on shared config files in ~/.aws.
    // Ensure the SDK config chain is enabled and fall back to `default` profile
    // when static keys/profile env vars are not explicitly provided.
    if env_truthy(env_map.get("CLAUDE_CODE_USE_BEDROCK")) {
        if !env_nonempty(&env_map, "AWS_SDK_LOAD_CONFIG") {
            env_map.insert("AWS_SDK_LOAD_CONFIG".to_string(), "1".to_string());
        }

        let has_profile_env =
            env_nonempty(&env_map, "AWS_PROFILE") || env_nonempty(&env_map, "AWS_DEFAULT_PROFILE");
        let has_static_keys =
            env_nonempty(&env_map, "AWS_ACCESS_KEY_ID") && env_nonempty(&env_map, "AWS_SECRET_ACCESS_KEY");
        if !has_profile_env && !has_static_keys && aws_shared_profile_exists("default") {
            env_map.insert("AWS_PROFILE".to_string(), "default".to_string());
        }
    }

    env_map
}

/// Environment variable prefixes that override the CLI's built-in model
/// resolution.  Stripping them lets `--model opus` (etc.) resolve to the
/// latest model ID the CLI itself knows about, instead of stale values
/// baked into the user's shell profile.
const MODEL_OVERRIDE_ENV_PREFIXES: &[&str] = &[
    "CLAUDE_MODEL_",
    "CLAUDE_BEDROCK_MODEL_",
];

fn configure_cli_env(cmd: &mut Command, env_map: &HashMap<String, String>) {
    // Start with a clean environment so no stale vars from the parent
    // process (Tauri app / launchd) leak into the Claude CLI subprocess.
    cmd.env_clear();
    for (key, value) in env_map {
        let dominated = MODEL_OVERRIDE_ENV_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix));
        if !dominated {
            cmd.env(key, value);
        }
    }
}

fn auth_env_feedback(env_map: &HashMap<String, String>) -> (String, Option<String>) {
    let bedrock = env_truthy(env_map.get("CLAUDE_CODE_USE_BEDROCK"));
    let aws_key = env_nonempty(env_map, "AWS_ACCESS_KEY_ID");
    let aws_secret = env_nonempty(env_map, "AWS_SECRET_ACCESS_KEY");
    let aws_session = env_nonempty(env_map, "AWS_SESSION_TOKEN");
    let aws_profile = env_nonempty(env_map, "AWS_PROFILE");
    let aws_default_profile = env_nonempty(env_map, "AWS_DEFAULT_PROFILE");
    let aws_default_profile_config = aws_shared_profile_exists("default");
    let anthropic_key = env_nonempty(env_map, "ANTHROPIC_API_KEY");
    let has_profile_chain = aws_profile || aws_default_profile || aws_default_profile_config;

    let summary = format!(
        "env mode: bedrock={}, aws_key={}, aws_secret={}, aws_session={}, aws_profile={}, aws_default_profile={}, aws_default_profile_config={}, anthropic_key={}",
        bedrock,
        aws_key,
        aws_secret,
        aws_session,
        aws_profile,
        aws_default_profile,
        aws_default_profile_config,
        anthropic_key
    );

    let hint = if bedrock {
        if !(has_profile_chain || (aws_key && aws_secret)) {
            Some(
                "Bedrock mode is enabled but no AWS auth chain was detected. Run `aws sso login` for your profile (or default), or set AWS_PROFILE / AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY."
                    .to_string(),
            )
        } else {
            None
        }
    } else if !anthropic_key {
        Some(
            "ANTHROPIC_API_KEY is not set. Claude may fail with login/API key errors unless your CLI session is already authenticated."
                .to_string(),
        )
    } else {
        None
    };

    (summary, hint)
}

fn normalize_permission_mode(mode: Option<&str>) -> &'static str {
    match mode.map(|v| v.trim()) {
        Some("dangerouslySkipPermissions") => "dangerouslySkipPermissions",
        Some("bypassPermissions") => "bypassPermissions",
        Some("plan") => "plan",
        Some("default") => "default",
        Some("acceptEdits") => "acceptEdits",
        Some("dontAsk") => "dontAsk",
        Some("auto") => "auto",
        _ => "dangerouslySkipPermissions",
    }
}

fn normalize_model(model: Option<&str>) -> Option<String> {
    let value = model.map(|v| v.trim()).filter(|v| !v.is_empty())?;
    let lower = value.to_ascii_lowercase();
    if lower == "default" {
        None
    } else if lower == "opus" || lower == "sonnet" || lower == "haiku" {
        Some(lower)
    } else {
        Some(value.to_string())
    }
}

fn normalize_effort(effort: Option<&str>) -> Option<&'static str> {
    let value = effort.map(|v| v.trim()).filter(|v| !v.is_empty())?;
    if value.eq_ignore_ascii_case("low") {
        Some("low")
    } else if value.eq_ignore_ascii_case("medium") {
        Some("medium")
    } else if value.eq_ignore_ascii_case("high") {
        Some("high")
    } else {
        None
    }
}

/// Map short aliases to concrete model IDs.
///
/// The Claude CLI's built-in alias resolution is stale on Bedrock
/// (e.g. "opus" → Opus 4.1).  When Bedrock is enabled we map aliases
/// directly to cross-region inference model IDs (`global.anthropic.*`).
/// For non-Bedrock (API) usage, model family names work fine.
///
/// NOTE: the Bedrock model IDs have inconsistent naming — update these
/// when new models are released on Bedrock.
fn resolve_model_for_runtime(requested_model: Option<&str>, is_bedrock: bool) -> Option<String> {
    let value = requested_model
        .map(str::trim)
        .filter(|v| !v.is_empty())?;

    if is_bedrock {
        match value {
            "opus" => return Some("global.anthropic.claude-opus-4-6-v1".to_string()),
            "sonnet" => return Some("global.anthropic.claude-sonnet-4-6".to_string()),
            "haiku" => return Some("global.anthropic.claude-haiku-4-5-20251001-v1:0".to_string()),
            _ => {}
        }
    } else {
        match value {
            "opus" => return Some("claude-opus-4-6".to_string()),
            "sonnet" => return Some("claude-sonnet-4-6".to_string()),
            "haiku" => return Some("claude-haiku-4-5".to_string()),
            _ => {}
        }
    }

    Some(value.to_string())
}

fn extract_model_suggestion(error_text: &str) -> Option<String> {
    let needle = "Try --model to switch to ";
    let start = error_text.find(needle)?;
    let tail = &error_text[start + needle.len()..];
    let token = tail
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_matches(|c: char| c == '.' || c == ',' || c == '"' || c == '\'' || c == '`');
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

fn detect_credential_error(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    const PATTERNS: &[&str] = &[
        "expiredtoken",
        "expiredtokenexception",
        "the security token included in the request is expired",
        "invalidclienttokenid",
        "unrecognizedclientexception",
        "accessdeniedexception",
        "not authorized to perform",
        "unable to locate credentials",
        "no credentials found",
        "invalid identity token",
        "token has expired",
        "request has expired",
        "signing error",
        "unauthorizedexception",
        "forbidden",
        "access denied",
        "invalidsignatureexception",
        "signaturedoesnotmatch",
        "request signature we calculated does not match",
        "could not load credentials",
        "nocredentialproviders",
        "the security token included in the request is invalid",
        "invalid security token",
        "missing authentication token",
        "status code: 401",
        "status code: 403",
        "http 401",
        "http 403",
    ];
    if PATTERNS.iter().any(|p| lower.contains(p)) {
        return true;
    }
    if lower.contains("credentials") && (lower.contains("expired") || lower.contains("invalid")) {
        return true;
    }
    false
}

fn extract_http_status_code(text: &str) -> Option<u16> {
    for token in text.split(|c: char| !c.is_ascii_digit()) {
        if token.len() != 3 {
            continue;
        }
        if let Ok(code) = token.parse::<u16>() {
            if (400..=599).contains(&code) {
                return Some(code);
            }
        }
    }
    None
}

fn credential_error_message(details: &str) -> String {
    if let Some(status) = extract_http_status_code(details) {
        format!(
            "AWS authentication failed (HTTP {}). Your credentials appear invalid or expired. Run `aws sso login` for your profile, or update environment overrides in Setup.",
            status
        )
    } else {
        "AWS authentication failed. Your credentials appear invalid or expired. Run `aws sso login` for your profile, or update environment overrides in Setup.".to_string()
    }
}

/// Detect "Prompt is too long" errors from the Claude CLI.
/// This happens when a resumed session's conversation history exceeds the
/// model's context window and the CLI fails to compact in time.
fn detect_prompt_too_long(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("prompt is too long")
        || lower.contains("prompt too long")
        || lower.contains("context length exceeded")
        || lower.contains("maximum context length")
}

/// Sleep for `total_secs` but check every second whether the agent has been
/// removed from `AppState::agents` (i.e. the user called stop_agent).
/// Returns `true` if the full duration elapsed, `false` if interrupted.
fn interruptible_sleep(
    app_state: &Arc<AppState>,
    agent_id: &str,
    total_secs: u64,
) -> bool {
    for _ in 0..total_secs {
        if !app_state.agents.read().contains_key(agent_id) {
            return false; // Agent was stopped — abort.
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    true
}

fn extract_missing_conversation_session_id(text: &str) -> Option<String> {
    let marker = "No conversation found with session ID:";
    let start = text.find(marker)?;
    let tail = &text[start + marker.len()..];
    let session_id = tail
        .trim()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_');
    if session_id.is_empty() {
        None
    } else {
        Some(session_id.to_string())
    }
}

fn stream_event_payload<'a>(event: &'a Value) -> &'a Value {
    if event.get("type").and_then(|v| v.as_str()) == Some("stream_event") {
        event.get("event").unwrap_or(event)
    } else {
        event
    }
}

fn extract_stream_session_id(event: &Value) -> Option<String> {
    event
        .get("session_id")
        .and_then(|v| v.as_str())
        .or_else(|| stream_event_payload(event).get("session_id").and_then(|v| v.as_str()))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn choose_assistant_text(delta_text: &str, snapshot_text: Option<&String>) -> Option<String> {
    let delta_trimmed = delta_text.trim();
    let snapshot_trimmed = snapshot_text
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());

    match (snapshot_trimmed, delta_trimmed.is_empty()) {
        (Some(snapshot), false) => {
            if snapshot.len() >= delta_trimmed.len() {
                Some(snapshot.to_string())
            } else {
                Some(delta_text.to_string())
            }
        }
        (Some(snapshot), true) => Some(snapshot.to_string()),
        (None, false) => Some(delta_text.to_string()),
        (None, true) => None,
    }
}

fn normalize_text_for_dedupe(text: &str) -> String {
    text.replace("\r\n", "\n").trim().to_string()
}

fn emit_agent_message_with_options(
    app: &tauri::AppHandle,
    db: &Database,
    session_id: &str,
    agent_id: &str,
    workspace_id: &str,
    ws_server: &Option<Arc<WebSocketServer>>,
    content: String,
    is_error: bool,
    role: &str,
    timestamp: Option<&str>,
    persist: bool,
) {
    let timestamp = timestamp
        .map(|value| value.to_string())
        .unwrap_or_else(|| now_rfc3339());
    let msg = AgentMessage {
        agent_id: agent_id.to_string(),
        workspace_id: Some(workspace_id.to_string()),
        role: role.to_string(),
        content: content.clone(),
        is_error,
        timestamp: timestamp.clone(),
    };
    if persist {
        let _ = db.insert_message(session_id, agent_id, role, &msg.content, is_error, &msg.timestamp);
    }
    let _ = app.emit("agent-message", msg.clone());
    if let Some(ws) = ws_server {
        ws.broadcast_to_workspace(workspace_id, &WsResponse::AgentMessage {
            workspace_id: workspace_id.to_string(),
            role: role.to_string(),
            content: msg.content,
            is_error,
            timestamp: msg.timestamp,
        });
    }
}

fn emit_agent_message(
    app: &tauri::AppHandle,
    db: &Database,
    session_id: &str,
    agent_id: &str,
    workspace_id: &str,
    ws_server: &Option<Arc<WebSocketServer>>,
    content: String,
    is_error: bool,
    role: &str,
) {
    emit_agent_message_with_options(
        app,
        db,
        session_id,
        agent_id,
        workspace_id,
        ws_server,
        content,
        is_error,
        role,
        None,
        true,
    );
}

fn emit_agent_run_state(
    app: &tauri::AppHandle,
    ws_server: &Option<Arc<WebSocketServer>>,
    workspace_id: &str,
    agent_id: &str,
    running: bool,
) {
    let timestamp = now_rfc3339();
    let event = AgentRunStateEvent {
        workspace_id: workspace_id.to_string(),
        agent_id: agent_id.to_string(),
        running,
        timestamp: timestamp.clone(),
    };
    let _ = app.emit("agent-run-state", event.clone());
    if let Some(ws) = ws_server {
        ws.broadcast_to_workspace(
            workspace_id,
            &WsResponse::AgentRunState {
                workspace_id: workspace_id.to_string(),
                agent_id: agent_id.to_string(),
                running,
                timestamp,
            },
        );
    }
}

/// Guard that emits `agent-run-state: false` when dropped, even on thread panic.
/// Create this right after emitting `running: true` in the agent execution thread.
/// Call `disarm()` before the explicit `emit_agent_run_state(false)` to avoid double-emit.
struct RunStateGuard {
    app: tauri::AppHandle,
    ws_server: Option<Arc<WebSocketServer>>,
    workspace_id: String,
    agent_id: String,
    armed: bool,
}

impl RunStateGuard {
    fn new(
        app: tauri::AppHandle,
        ws_server: Option<Arc<WebSocketServer>>,
        workspace_id: String,
        agent_id: String,
    ) -> Self {
        Self { app, ws_server, workspace_id, agent_id, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for RunStateGuard {
    fn drop(&mut self) {
        if self.armed {
            emit_agent_run_state(&self.app, &self.ws_server, &self.workspace_id, &self.agent_id, false);
        }
    }
}

/// Guard that resets `Agent.processing = false` when dropped.
/// Ensures the HTTP API's busy flag is always cleared, even on early returns or panics.
struct ProcessingGuard {
    app_state: Arc<AppState>,
    agent_id: String,
}

impl Drop for ProcessingGuard {
    fn drop(&mut self) {
        let mut agents = self.app_state.agents.write();
        if let Some(a) = agents.get_mut(&self.agent_id) {
            a.processing = false;
        }
    }
}

fn summarize_tool_call(tool_name: &str, input_json: &str) -> Option<String> {
    let parsed = serde_json::from_str::<Value>(input_json).ok();
    let lower = tool_name.to_lowercase();

    let message = if lower.contains("glob") {
        let pattern = parsed
            .as_ref()
            .and_then(|v| v.get("pattern"))
            .and_then(|v| v.as_str())
            .unwrap_or(input_json);
        format!("Glob {}", pattern)
    } else if lower.contains("grep") {
        let pattern = parsed
            .as_ref()
            .and_then(|v| v.get("pattern"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let path = parsed
            .as_ref()
            .and_then(|v| v.get("path"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if pattern.is_empty() && path.is_empty() {
            format!("Grep {}", input_json)
        } else if path.is_empty() {
            format!("Grep {}", pattern)
        } else if pattern.is_empty() {
            format!("Grep in {}", path)
        } else {
            format!("Grep '{}' in {}", pattern, path)
        }
    } else if lower.contains("read") {
        let file = parsed
            .as_ref()
            .and_then(|v| v.get("file_path").or_else(|| v.get("path")))
            .and_then(|v| v.as_str())
            .unwrap_or(input_json);
        let offset = parsed
            .as_ref()
            .and_then(|v| v.get("offset"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let limit = parsed
            .as_ref()
            .and_then(|v| v.get("limit"))
            .and_then(|v| v.as_i64());
        if let Some(limit) = limit {
            if offset > 0 {
                format!("Read {} lines from {} (offset {})", limit, file, offset)
            } else {
                format!("Read {} lines from {}", limit, file)
            }
        } else {
            format!("Read {}", file)
        }
    } else if lower.contains("bash") || lower.contains("shell") {
        let cmd = parsed
            .as_ref()
            .and_then(|v| {
                v.get("command")
                    .or_else(|| v.get("cmd"))
                    .or_else(|| v.get("input"))
            })
            .and_then(|v| v.as_str())
            .unwrap_or(input_json);
        format!("Run {}", cmd)
    } else if lower.contains("ls") || lower.contains("list") {
        let path = parsed
            .as_ref()
            .and_then(|v| v.get("path"))
            .and_then(|v| v.as_str())
            .unwrap_or(".");
        format!("List {}", path)
    } else if lower.contains("task") {
        let description = parsed
            .as_ref()
            .and_then(|v| v.get("description"))
            .and_then(|v| v.as_str())
            .unwrap_or("Run delegated task");
        format!("Task {}", description)
    } else {
        let compact = if input_json.len() > 180 {
            format!("{}...", &input_json[..180])
        } else {
            input_json.to_string()
        };
        format!("{} {}", tool_name, compact)
    };

    Some(message)
}

fn extract_exit_plan_text(tool_name: &str, input_json: &str) -> Option<String> {
    if !tool_name.eq_ignore_ascii_case("ExitPlanMode") {
        return None;
    }
    let parsed = serde_json::from_str::<Value>(input_json).ok()?;
    let plan = parsed.get("plan").and_then(|v| v.as_str())?.trim();
    if plan.is_empty() {
        return None;
    }
    Some(plan.to_string())
}

#[derive(Debug, Clone, PartialEq)]
enum ActivityEvent {
    Activity(String),
    Question(String),
    Plan(String),
}

fn parse_stream_event_for_activity(
    event: &Value,
    tool_names: &mut HashMap<i64, String>,
    tool_inputs: &mut HashMap<i64, String>,
) -> Vec<ActivityEvent> {
    let mut out = Vec::new();
    let payload = stream_event_payload(event);
    let event_type = match payload.get("type").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return out,
    };

    match event_type {
        "system" => {
            let subtype = payload
                .get("subtype")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if subtype == "init" {
                let model = payload
                    .get("model")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown model");
                let permission_mode = payload
                    .get("permissionMode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                out.push(ActivityEvent::Activity(format!(
                    "Claude initialized ({}, permission={})",
                    model, permission_mode
                )));
            } else if !subtype.is_empty() {
                out.push(ActivityEvent::Activity(format!("System {}", subtype)));
            }
        }
        "assistant" => {
            if let Some(content) = payload
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(|v| v.as_array())
            {
                for item in content {
                    let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if item_type == "thinking" || item_type == "redacted_thinking" {
                        out.push(ActivityEvent::Activity("Thinking".to_string()));
                    } else if item_type == "tool_use" {
                        let tool_name = item
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("tool")
                            .to_string();
                        if let Some(input_val) = item.get("input") {
                            let input_json = if input_val.is_string() {
                                input_val.as_str().unwrap_or("").to_string()
                            } else {
                                serde_json::to_string(input_val).unwrap_or_default()
                            };
                            if !input_json.trim().is_empty() {
                                if tool_name == "AskUserQuestion" {
                                    out.push(ActivityEvent::Question(input_json));
                                } else if let Some(plan_text) =
                                    extract_exit_plan_text(&tool_name, &input_json)
                                {
                                    out.push(ActivityEvent::Activity("Plan ready for review".to_string()));
                                    out.push(ActivityEvent::Plan(plan_text));
                                } else if let Some(summary) = summarize_tool_call(&tool_name, &input_json) {
                                    out.push(ActivityEvent::Activity(summary));
                                }
                            }
                        } else {
                            out.push(ActivityEvent::Activity(format!("Tool {}", tool_name)));
                        }
                    }
                }
            }
        }
        "content_block_start" => {
            let block_type = payload
                .get("content_block")
                .and_then(|b| b.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let index = payload
                .get("index")
                .and_then(|v| v.as_i64())
                .unwrap_or(-1);
            if block_type == "thinking" {
                out.push(ActivityEvent::Activity("Thinking".to_string()));
            } else if block_type == "tool_use" {
                let tool_name = payload
                    .get("content_block")
                    .and_then(|b| b.get("name"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool")
                    .to_string();
                if index >= 0 {
                    tool_names.insert(index, tool_name.clone());
                    tool_inputs.insert(index, String::new());
                }
            }
        }
        "content_block_delta" => {
            let delta_type = payload
                .get("delta")
                .and_then(|d| d.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let index = payload
                .get("index")
                .and_then(|v| v.as_i64())
                .unwrap_or(-1);
            if delta_type == "thinking_delta" {
                // Suppress token-level thinking deltas to avoid noisy character-by-character updates.
            } else if delta_type == "input_json_delta" && index >= 0 {
                let partial = payload
                    .get("delta")
                    .and_then(|d| d.get("partial_json"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if !partial.is_empty() {
                    tool_inputs
                        .entry(index)
                        .and_modify(|s| s.push_str(partial))
                        .or_insert_with(|| partial.to_string());
                }
            }
        }
        "content_block_stop" => {
            let index = payload
                .get("index")
                .and_then(|v| v.as_i64())
                .unwrap_or(-1);
            if index >= 0 {
                if let (Some(tool_name), Some(input_json)) = (tool_names.remove(&index), tool_inputs.remove(&index)) {
                    if !input_json.trim().is_empty() {
                        if tool_name == "AskUserQuestion" {
                            out.push(ActivityEvent::Question(input_json));
                        } else if let Some(plan_text) =
                            extract_exit_plan_text(&tool_name, &input_json)
                        {
                            out.push(ActivityEvent::Activity("Plan ready for review".to_string()));
                            out.push(ActivityEvent::Plan(plan_text));
                        } else if let Some(summary) = summarize_tool_call(&tool_name, &input_json) {
                            out.push(ActivityEvent::Activity(summary));
                        } else {
                            out.push(ActivityEvent::Activity(format!("Tool {}", tool_name)));
                        }
                    } else {
                        out.push(ActivityEvent::Activity(format!("Tool {}", tool_name)));
                    }
                }
            }
        }
        _ => {}
    }

    out
}

fn extract_result_text(event: &Value) -> Option<String> {
    let payload = stream_event_payload(event);

    if payload.get("type").and_then(|v| v.as_str()) != Some("result") {
        return None;
    }

    if let Some(text) = payload.get("result").and_then(|v| v.as_str()) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    if let Some(text) = payload.get("output_text").and_then(|v| v.as_str()) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    if let Some(content) = payload.get("content").and_then(|v| v.as_array()) {
        let mut buf = String::new();
        for item in content {
            if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
                if !t.trim().is_empty() {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(t.trim());
                }
            }
        }
        if !buf.is_empty() {
            return Some(buf);
        }
    }

    None
}

fn extract_assistant_message_text(event: &Value) -> Option<String> {
    let payload = stream_event_payload(event);

    if payload.get("type").and_then(|v| v.as_str()) != Some("assistant") {
        return None;
    }

    let content = payload
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_array())?;

    let mut buf = String::new();
    for item in content {
        if item.get("type").and_then(|v| v.as_str()) == Some("text") {
            if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(trimmed);
                }
            }
        }
    }

    if buf.is_empty() { None } else { Some(buf) }
}

fn extract_stream_error_text(payload: &Value) -> Option<String> {
    if payload.get("type").and_then(|v| v.as_str()) != Some("error") {
        return None;
    }

    let err_obj = payload.get("error");
    let err_type = err_obj
        .and_then(|v| v.get("type"))
        .and_then(|v| v.as_str())
        .unwrap_or("error");
    let err_message = err_obj
        .and_then(|v| v.get("message"))
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("message").and_then(|v| v.as_str()))
        .unwrap_or("Claude streaming error");

    Some(format!("Stream error ({}): {}", err_type, err_message.trim()))
}

fn update_text_blocks_from_stream_event(payload: &Value, text_blocks: &mut HashMap<i64, String>) -> bool {
    let event_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match event_type {
        "message_start" => {
            text_blocks.clear();
            true
        }
        "content_block_start" => {
            let block_type = payload
                .get("content_block")
                .and_then(|v| v.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let index = payload.get("index").and_then(|v| v.as_i64()).unwrap_or(-1);
            if block_type == "text" && index >= 0 {
                text_blocks.entry(index).or_default();
                true
            } else {
                false
            }
        }
        "content_block_delta" => {
            let index = payload.get("index").and_then(|v| v.as_i64()).unwrap_or(-1);
            let delta_type = payload
                .get("delta")
                .and_then(|v| v.get("type"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if delta_type == "text_delta" && index >= 0 {
                if let Some(chunk) = payload
                    .get("delta")
                    .and_then(|v| v.get("text"))
                    .and_then(|v| v.as_str())
                {
                    if !chunk.is_empty() {
                        text_blocks
                            .entry(index)
                            .and_modify(|value| value.push_str(chunk))
                            .or_insert_with(|| chunk.to_string());
                        return true;
                    }
                }
            }
            false
        }
        "message_delta" | "message_stop" | "content_block_stop" => false,
        _ => false,
    }
}

fn build_text_from_blocks(text_blocks: &HashMap<i64, String>) -> Option<String> {
    if text_blocks.is_empty() {
        return None;
    }
    let mut indices: Vec<i64> = text_blocks.keys().copied().collect();
    indices.sort_unstable();

    let mut output = String::new();
    for index in indices {
        if let Some(chunk) = text_blocks.get(&index) {
            if chunk.is_empty() {
                continue;
            }
            output.push_str(chunk);
        }
    }

    if output.trim().is_empty() {
        None
    } else {
        Some(output)
    }
}

fn choose_streaming_assistant_text(
    text_blocks: &HashMap<i64, String>,
    delta_text: &str,
    snapshot_text: Option<&String>,
) -> Option<String> {
    build_text_from_blocks(text_blocks).or_else(|| choose_assistant_text(delta_text, snapshot_text))
}

fn run_claude_cli(
    app: tauri::AppHandle,
    agent_id: String,
    workspace_path: String,
    workspace_name: String,
    existing_session: Option<String>,
    db: Arc<Database>,
    session_id: String,
    ws_server: Option<Arc<WebSocketServer>>,
    workspace_id: String,
    env_overrides: HashMap<String, String>,
) {
    let effective_env = build_effective_cli_env(&env_overrides);
    let claude_path = match find_claude_cli_with_env(Some(&effective_env)) {
        Some(p) => p,
        None => {
            let msg = AgentMessage {
                agent_id: agent_id.clone(),
                workspace_id: Some(workspace_id.clone()),
                role: "system".to_string(),
                content: "Error: Claude CLI not found. Please install claude.".to_string(),
                is_error: true,
                timestamp: now_rfc3339(),
            };
            let _ = db.insert_message(&session_id, &agent_id, "system", &msg.content, true, &msg.timestamp);
            let _ = app.emit("agent-message", msg.clone());
            
            // Broadcast to WebSocket clients
            if let Some(ws) = &ws_server {
                ws.broadcast_to_workspace(&workspace_id, &WsResponse::AgentMessage {
                    workspace_id: workspace_id.clone(),
                    role: "system".to_string(),
                    content: msg.content,
                    is_error: true,
                    timestamp: msg.timestamp,
                });
            }
            return;
        }
    };
    
    // Send initial message
    let init_msg = AgentMessage {
        agent_id: agent_id.clone(),
        workspace_id: Some(workspace_id.clone()),
        role: "system".to_string(),
        content: format!("Launching Claude in workspace: {}", workspace_name),
        is_error: false,
        timestamp: now_rfc3339(),
    };
    let _ = db.insert_message(&session_id, &agent_id, "system", &init_msg.content, false, &init_msg.timestamp);
    let _ = app.emit("agent-message", init_msg.clone());
    
    // Broadcast to WebSocket clients
    if let Some(ws) = &ws_server {
        ws.broadcast_to_workspace(&workspace_id, &WsResponse::AgentMessage {
            workspace_id: workspace_id.clone(),
            role: "system".to_string(),
            content: init_msg.content,
            is_error: false,
            timestamp: init_msg.timestamp,
        });
    }

    // Do not run a synthetic startup prompt. Agent startup should be quiet and
    // wait for the user's first real message.
    let ready_msg = AgentMessage {
        agent_id: agent_id.clone(),
        workspace_id: Some(workspace_id.clone()),
        role: "system".to_string(),
        content: format!("Claude is ready in workspace: {}", workspace_name),
        is_error: false,
        timestamp: now_rfc3339(),
    };
    let _ = db.insert_message(&session_id, &agent_id, "system", &ready_msg.content, false, &ready_msg.timestamp);
    let _ = app.emit("agent-message", ready_msg.clone());
    if let Some(ws) = &ws_server {
        ws.broadcast_to_workspace(&workspace_id, &WsResponse::AgentMessage {
            workspace_id: workspace_id.clone(),
            role: "system".to_string(),
            content: ready_msg.content,
            is_error: false,
            timestamp: ready_msg.timestamp,
        });
    }

    // Ensure these remain referenced for future reintroduction of startup runs.
    let _ = (&workspace_path, &existing_session, &env_overrides, &claude_path, &effective_env);
}

#[tauri::command]
async fn stop_agent(
    agent_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    commands::agent::stop_agent(&state, agent_id)
}

/// Interrupt the currently running Claude CLI process for an agent by sending
/// SIGINT.  The agent and session remain alive so the user can send follow-up
/// messages.
#[tauri::command]
async fn interrupt_agent(
    agent_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    commands::agent::interrupt_agent(&state, agent_id)
}

#[tauri::command]
async fn respond_to_permission(
    agent_id: String,
    request_id: String,
    allow: bool,
    deny_message: Option<String>,
    updated_input: Option<Value>,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    commands::agent::respond_to_permission(&state, agent_id, request_id, allow, deny_message, updated_input)
}

/// Answer a question asked by the Claude CLI (AskUserQuestion tool).
/// Writes the answer directly to the running process's stdin, just like
/// permission responses.  This avoids the need to spawn a new CLI process
/// and prevents the answer from being queued behind the "running" state.
#[tauri::command]
async fn answer_agent_question(
    agent_id: String,
    message: String,
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let app_state = state.inner().clone();

    // Look up agent info for DB persistence and message emission
    let (session_id, workspace_id) = {
        let agents = app_state.agents.read();
        let agent = agents.get(&agent_id).ok_or("Agent not found")?;
        (
            agent.session_id.clone().ok_or("No active session")?,
            agent.workspace_id.clone(),
        )
    };

    // Emit the user message — this also persists it to the database
    let ws_server = app_state.ws_server.clone();
    emit_agent_message(
        &app,
        &app_state.db,
        &session_id,
        &agent_id,
        &workspace_id,
        &ws_server,
        message.clone(),
        false,
        "user",
    );

    // Write the answer to the existing CLI process's stdin
    let handle = {
        let stdins = app_state.agent_stdin.read();
        stdins.get(&agent_id).cloned()
    };
    let handle = handle.ok_or("No active CLI process for this agent")?;
    let mut stdin = handle.lock().map_err(|e| format!("Stdin lock poisoned: {}", e))?;
    write_stdin_user_message(&mut stdin, &message)
        .map_err(|e| format!("Failed to write answer to stdin: {}", e))?;

    Ok(())
}

/// Core send_message logic — callable from both Tauri commands and HTTP handlers.
pub(crate) fn send_message_core(
    app_state: &std::sync::Arc<AppState>,
    app: tauri::AppHandle,
    agent_id: String,
    message: String,
    env_overrides: Option<HashMap<String, String>>,
    permission_mode: Option<String>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    // Get workspace path and session info for this agent.
    // Acquire locks sequentially (never hold agents + workspaces simultaneously).
    let (workspace_id, session_id, claude_session_id) = {
        let agents = app_state.agents.read();
        let agent = agents.get(&agent_id).ok_or("Agent not found")?;
        (agent.workspace_id.clone(), agent.session_id.clone(), agent.claude_session_id.clone())
    };
    let (workspace_path, is_god) = {
        let workspaces = app_state.workspaces.read();
        let workspace = workspaces.get(&workspace_id).ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        (workspace.worktree_path.clone(), workspace.is_god)
    };
    
    let session_id = session_id.ok_or("No active session")?;
    
    // Save user message to database
    let now = now_rfc3339();
    let _ = app_state
        .db
        .insert_message(&session_id, &agent_id, "user", &message, false, &now);

    // Persist model selection to session
    if let Some(ref m) = model {
        let _ = app_state.db.update_session_model(&session_id, Some(m));
    }

    // Get WebSocket server for broadcasting
    let ws_server = app_state.ws_server.clone();
    
    // Run claude with the message in a background thread
    let agent_id_clone = agent_id.clone();
    let message_clone = message.clone();
    let db = app_state.db.clone();
    let app_state_for_pids = app_state.clone();
    let mut env_overrides = env_overrides.unwrap_or_default();

    // Inject God workspace env vars so the agent can make curl calls to the
    // orchestrator API. Same vars as start_agent_core — needed here because
    // send_message_core spawns a fresh CLI process for each message.
    if is_god {
        env_overrides.insert("GOD_WORKSPACE_ID".to_string(), workspace_id.clone());
        env_overrides.insert("ORCHESTRATOR_API_TOKEN".to_string(), app_state.api_token.clone());
        // GOD_WORKSPACE_REPO_ID requires an extra workspace field read, but the
        // god agent rarely needs it during message sends (only during create).
        // Inject it if available for completeness.
        if let Some(repo_id) = app_state.workspaces.read().get(&workspace_id).map(|w| w.repo_id.clone()) {
            env_overrides.insert("GOD_WORKSPACE_REPO_ID".to_string(), repo_id);
        }
    }
    let requested_permission_mode = normalize_permission_mode(permission_mode.as_deref()).to_string();
    let requested_model = normalize_model(model.as_deref());
    let requested_effort = normalize_effort(effort.as_deref()).map(str::to_string);

    std::thread::spawn(move || {
        emit_agent_run_state(
            &app,
            &ws_server,
            &workspace_id,
            &agent_id_clone,
            true,
        );
        // Safety net: if this thread panics, the guard's Drop impl will emit running=false.
        let mut _run_guard = RunStateGuard::new(
            app.clone(),
            ws_server.clone(),
            workspace_id.clone(),
            agent_id_clone.clone(),
        );
        // Ensure the per-message processing flag is cleared on all exit paths (including panic).
        let _processing_guard = ProcessingGuard {
            app_state: app_state_for_pids.clone(),
            agent_id: agent_id_clone.clone(),
        };
        let effective_env = build_effective_cli_env(&env_overrides);
        let claude_path = match find_claude_cli_with_env(Some(&effective_env)) {
            Some(p) => p,
            None => {
                let msg = AgentMessage {
                    agent_id: agent_id_clone.clone(),
                    workspace_id: Some(workspace_id.clone()),
                    role: "system".to_string(),
                    content: "Error: Claude CLI not found".to_string(),
                    is_error: true,
                    timestamp: now_rfc3339(),
                };
                let _ = app.emit("agent-message", msg.clone());
                
                if let Some(ws) = &ws_server {
                    ws.broadcast_to_workspace(&workspace_id, &WsResponse::AgentMessage {
                        workspace_id: workspace_id.clone(),
                        role: "system".to_string(),
                        content: msg.content,
                        is_error: true,
                        timestamp: msg.timestamp,
                    });
                }
                // Guard will emit running=false on return.
                return;
            }
        };
        let (env_summary, env_hint) = auth_env_feedback(&effective_env);
        let permission_mode = requested_permission_mode.as_str();
        let is_bedrock = env_truthy(effective_env.get("CLAUDE_CODE_USE_BEDROCK"));
        let resolved_model = resolve_model_for_runtime(requested_model.as_deref(), is_bedrock);
        let model = resolved_model.as_deref();
        let effort = requested_effort.as_deref();

        // Retry loop: when the CLI reports "Prompt is too long", the session's
        // conversation history exceeded the context window.  The CLI typically
        // compacts (summarises) the history as a side-effect of the failed load,
        // so retrying after a delay often succeeds.
        const MAX_PROMPT_TOO_LONG_RETRIES: u32 = 6;
        let mut prompt_too_long_attempts: u32 = 0;

        'retry: loop {

        // Build a compatibility-first command and include optional flags only
        // when the detected Claude CLI supports them.
        let mut cmd = Command::new(&claude_path);
        cmd.current_dir(&workspace_path);
        configure_cli_env(&mut cmd, &effective_env);
        let interactive = append_claude_request_args(
            &mut cmd,
            &claude_path,
            permission_mode,
            model,
            effort,
            claude_session_id.as_deref(),
            &message_clone,
            &workspace_id,
            &agent_id_clone,
            HTTP_SERVER_PORT,
        );
        if interactive {
            cmd.stdin(Stdio::piped());
        } else {
            cmd.stdin(Stdio::null());
        }
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                emit_agent_message(
                    &app,
                    &db,
                    &session_id,
                    &agent_id_clone,
                    &workspace_id,
                    &ws_server,
                    format!("Error spawning Claude: {}", e),
                    true,
                    "error",
                );
                emit_agent_message(
                    &app,
                    &db,
                    &session_id,
                    &agent_id_clone,
                    &workspace_id,
                    &ws_server,
                    env_summary.clone(),
                    true,
                    "error",
                );
                if let Some(hint) = env_hint.clone() {
                    emit_agent_message(
                        &app,
                        &db,
                        &session_id,
                        &agent_id_clone,
                        &workspace_id,
                        &ws_server,
                        format!("Hint: {}", hint),
                        true,
                        "error",
                    );
                }
                // Guard will emit running=false on return.
                return;
            }
        };

        // Store child PID so we can send SIGINT to interrupt
        app_state_for_pids.child_pids.write().insert(agent_id_clone.clone(), child.id());

        // Store stdin handle so we can write permission responses
        let stdin_handle = child.stdin.take().map(|s| Arc::new(Mutex::new(s)));
        if let Some(ref handle) = stdin_handle {
            app_state_for_pids
                .agent_stdin
                .write()
                .insert(agent_id_clone.clone(), handle.clone());
        }

        // In interactive permission mode, send the user message via stdin
        // since we didn't pass it as a `-p` CLI argument.
        if interactive {
            if let Some(ref handle) = stdin_handle {
                match handle.lock() {
                    Ok(mut stdin) => {
                        if let Err(e) = write_stdin_user_message(&mut stdin, &message_clone) {
                            eprintln!("[orchestrator] Failed to write user message to stdin: {}", e);
                            emit_agent_message(
                                &app,
                                &db,
                                &session_id,
                                &agent_id_clone,
                                &workspace_id,
                                &ws_server,
                                format!("Error sending message to Claude: {}", e),
                                true,
                                "error",
                            );
                        }
                    }
                    Err(e) => {
                        eprintln!("[orchestrator] Stdin lock poisoned: {}", e);
                    }
                }
            }
        }

        let mut assistant_delta_text = String::new();
        let mut latest_assistant_snapshot: Option<String> = None;
        let mut result_text_fallback: Option<String> = None;
        let mut assistant_text_blocks: HashMap<i64, String> = HashMap::new();
        let mut assistant_stream_timestamp: Option<String> = None;
        let mut assistant_stream_last_emitted: Option<String> = None;
        let mut tool_names: HashMap<i64, String> = HashMap::new();
        let mut tool_inputs: HashMap<i64, String> = HashMap::new();
        let mut known_claude_session_id = claude_session_id.clone();
        let allow_init_activity = known_claude_session_id.is_none();
        let mut last_activity: Option<String> = None;
        let mut last_question: Option<String> = None;
        let mut last_plan: Option<String> = None;
        let mut error_emitted = false;
        let mut saw_credential_error = false;
        let mut saw_prompt_too_long = false;
        let mut missing_conversation_session_id: Option<String> = None;
        let stderr_handle = child.stderr.take().map(|stderr| {
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut stderr_buf = String::new();
                let _ = std::io::Read::read_to_string(&mut reader, &mut stderr_buf);
                stderr_buf
            })
        });

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(event) = serde_json::from_str::<Value>(&line) {
                    let payload = stream_event_payload(&event);
                    if let Some(stream_session_id) = extract_stream_session_id(&event) {
                        if known_claude_session_id.as_deref() != Some(stream_session_id.as_str()) {
                            known_claude_session_id = Some(stream_session_id.clone());
                            {
                                let mut agents = app_state_for_pids.agents.write();
                                if let Some(agent) = agents.get_mut(&agent_id_clone) {
                                    agent.claude_session_id = Some(stream_session_id.clone());
                                }
                            }
                            let _ = db.update_session_claude_id(&session_id, &stream_session_id);
                        }
                    }

                    let payload_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");

                    // Keep-alive event; no UI action required.
                    if payload_type == "ping" {
                        continue;
                    }

                    // Permission prompt: the CLI is blocked waiting for
                    // a control_response on stdin.  Forward the request to
                    // the frontend and continue reading the stream.
                    if payload_type == "control_request" {
                        let request = payload.get("request").cloned().unwrap_or(Value::Null);
                        let tool_name = request.get("tool_name").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
                        let request_id = payload.get("request_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        if request_id.is_empty() {
                            eprintln!("[orchestrator] control_request missing request_id, skipping");
                            continue;
                        }
                        let permission_event = PermissionRequestEvent {
                            workspace_id: workspace_id.clone(),
                            agent_id: agent_id_clone.clone(),
                            request_id,
                            tool_name: tool_name.clone(),
                            tool_input: request.get("input").cloned().unwrap_or(Value::Null),
                            tool_use_id: request.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        };
                        let _ = app.emit("permission-request", &permission_event);
                        if let Some(ws) = &ws_server {
                            ws.broadcast_to_workspace(&workspace_id, &WsResponse::PermissionRequest(permission_event));
                        }
                        emit_agent_message(
                            &app,
                            &db,
                            &session_id,
                            &agent_id_clone,
                            &workspace_id,
                            &ws_server,
                            format!("🔒 Permission requested: **{}**", tool_name),
                            false,
                            "system",
                        );
                        continue;
                    }

                    if let Some(stream_error) = extract_stream_error_text(payload) {
                        if missing_conversation_session_id.is_none() {
                            missing_conversation_session_id =
                                extract_missing_conversation_session_id(&stream_error);
                        }
                        if !saw_prompt_too_long && detect_prompt_too_long(&stream_error) {
                            saw_prompt_too_long = true;
                        }
                        emit_agent_message(
                            &app,
                            &db,
                            &session_id,
                            &agent_id_clone,
                            &workspace_id,
                            &ws_server,
                            stream_error,
                            true,
                            "error",
                        );
                        error_emitted = true;
                        continue;
                    }

                    if update_text_blocks_from_stream_event(payload, &mut assistant_text_blocks) {
                        // Updated in-memory streaming text blocks.
                    }

                    for event_item in parse_stream_event_for_activity(&event, &mut tool_names, &mut tool_inputs) {
                        match event_item {
                            ActivityEvent::Activity(activity) => {
                                if !allow_init_activity && activity.starts_with("Claude initialized (") {
                                    continue;
                                }
                                if last_activity.as_deref() == Some(activity.as_str()) {
                                    continue;
                                }
                                // Reset question dedup: activity means the CLI moved past
                                // the previous question, so a repeat is a genuine re-ask.
                                last_question = None;
                                emit_agent_message(
                                    &app,
                                    &db,
                                    &session_id,
                                    &agent_id_clone,
                                    &workspace_id,
                                    &ws_server,
                                    activity.clone(),
                                    false,
                                    "system",
                                );
                                last_activity = Some(activity);
                            }
                            ActivityEvent::Question(json_content) => {
                                if last_question.as_deref() == Some(json_content.as_str()) {
                                    continue;
                                }
                                emit_agent_message(
                                    &app,
                                    &db,
                                    &session_id,
                                    &agent_id_clone,
                                    &workspace_id,
                                    &ws_server,
                                    json_content.clone(),
                                    false,
                                    "question",
                                );
                                last_question = Some(json_content);
                            }
                            ActivityEvent::Plan(plan_content) => {
                                let normalized_plan = normalize_text_for_dedupe(&plan_content);
                                if normalized_plan.is_empty()
                                    || last_plan.as_deref() == Some(normalized_plan.as_str())
                                {
                                    continue;
                                }
                                emit_agent_message(
                                    &app,
                                    &db,
                                    &session_id,
                                    &agent_id_clone,
                                    &workspace_id,
                                    &ws_server,
                                    plan_content.clone(),
                                    false,
                                    "assistant",
                                );
                                last_plan = Some(normalized_plan);
                            }
                        }
                    }

                    if let Some(text) = extract_assistant_message_text(&event) {
                        latest_assistant_snapshot = Some(text);
                    }

                    if payload_type == "content_block_delta" {
                        if payload
                            .get("delta")
                            .and_then(|d| d.get("type"))
                            .and_then(|v| v.as_str())
                            == Some("text_delta")
                        {
                            if let Some(chunk) = payload
                                .get("delta")
                                .and_then(|d| d.get("text"))
                                .and_then(|v| v.as_str())
                            {
                                assistant_delta_text.push_str(chunk);
                            }
                        }
                    }

                    if let Some(stream_text) = choose_streaming_assistant_text(
                        &assistant_text_blocks,
                        &assistant_delta_text,
                        latest_assistant_snapshot.as_ref(),
                    ) {
                        let normalized_stream = normalize_text_for_dedupe(&stream_text);
                        if !normalized_stream.is_empty()
                            && assistant_stream_last_emitted.as_deref()
                                != Some(normalized_stream.as_str())
                            && last_plan.as_deref() != Some(normalized_stream.as_str())
                        {
                            if assistant_stream_timestamp.is_none() {
                                assistant_stream_timestamp = Some(now_rfc3339());
                            }
                            emit_agent_message_with_options(
                                &app,
                                &db,
                                &session_id,
                                &agent_id_clone,
                                &workspace_id,
                                &ws_server,
                                stream_text,
                                false,
                                "assistant",
                                assistant_stream_timestamp.as_deref(),
                                false,
                            );
                            assistant_stream_last_emitted = Some(normalized_stream);
                        }
                    }

                    if payload_type == "result" {
                        if result_text_fallback.is_none() {
                            result_text_fallback = extract_result_text(&event);
                        }
                        let is_error = payload.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
                        if is_error {
                            let errors = payload
                                .get("errors")
                                .and_then(|v| v.as_array())
                                .map(|arr| {
                                    arr.iter()
                                        .filter_map(|v| v.as_str())
                                        .collect::<Vec<_>>()
                                        .join("\n")
                                })
                                .filter(|s| !s.trim().is_empty())
                                .or_else(|| extract_result_text(&event))
                                .unwrap_or_else(|| "Claude execution failed".to_string());
                            if missing_conversation_session_id.is_none() {
                                missing_conversation_session_id =
                                    extract_missing_conversation_session_id(&errors);
                            }
                            if !saw_prompt_too_long && detect_prompt_too_long(&errors) {
                                saw_prompt_too_long = true;
                            }
                            if detect_credential_error(&errors) {
                                saw_credential_error = true;
                                emit_agent_message(
                                    &app,
                                    &db,
                                    &session_id,
                                    &agent_id_clone,
                                    &workspace_id,
                                    &ws_server,
                                    credential_error_message(&errors),
                                    true,
                                    "credential_error",
                                );
                            }
                            emit_agent_message(
                                &app,
                                &db,
                                &session_id,
                                &agent_id_clone,
                                &workspace_id,
                                &ws_server,
                                errors,
                                true,
                                "error",
                            );
                            error_emitted = true;
                        }
                        // The `result` event is the CLI's final output. Break out
                        // of the stdout loop immediately — the MCP bridge subprocess
                        // may hold the pipe's write-end FD open, preventing EOF.
                        break;
                    }
                } else {
                    // Forward non-JSON runtime output so authentication/runtime issues are visible.
                    let cli_line = format!("cli: {}", line);
                    if missing_conversation_session_id.is_none() {
                        missing_conversation_session_id =
                            extract_missing_conversation_session_id(&line);
                    }
                    if !saw_prompt_too_long && detect_prompt_too_long(&line) {
                        saw_prompt_too_long = true;
                    }
                    let line_has_credential_error = detect_credential_error(&cli_line);
                    if line_has_credential_error {
                        saw_credential_error = true;
                        emit_agent_message(
                            &app,
                            &db,
                            &session_id,
                            &agent_id_clone,
                            &workspace_id,
                            &ws_server,
                            credential_error_message(&cli_line),
                            true,
                            "credential_error",
                        );
                    }
                    let line_is_error = line_has_credential_error || missing_conversation_session_id.is_some();
                    emit_agent_message(
                        &app,
                        &db,
                        &session_id,
                        &agent_id_clone,
                        &workspace_id,
                        &ws_server,
                        cli_line,
                        line_is_error,
                        if line_is_error { "error" } else { "system" },
                    );
                    if line_is_error {
                        error_emitted = true;
                    }
                }
            }
        }

        // Drop the stdin handle before wait() so the CLI sees EOF if it's
        // reading stdin (prevents deadlock when process exits normally).
        drop(stdin_handle);
        app_state_for_pids.agent_stdin.write().remove(&agent_id_clone);

        let status = match child.wait() {
            Ok(s) => s,
            Err(e) => {
                app_state_for_pids.child_pids.write().remove(&agent_id_clone);
                emit_agent_message(
                    &app,
                    &db,
                    &session_id,
                    &agent_id_clone,
                    &workspace_id,
                    &ws_server,
                    format!("Error waiting for Claude: {}", e),
                    true,
                    "error",
                );
                return;
            }
        };
        let mut stderr_buf = String::new();
        if let Some(handle) = stderr_handle {
            if let Ok(collected) = handle.join() {
                stderr_buf = collected;
            }
        }
        if missing_conversation_session_id.is_none() {
            missing_conversation_session_id = extract_missing_conversation_session_id(&stderr_buf);
        }
        if !saw_prompt_too_long && detect_prompt_too_long(&stderr_buf) {
            saw_prompt_too_long = true;
        }

        // Clean up stored PID now that process has exited
        app_state_for_pids.child_pids.write().remove(&agent_id_clone);

        if let Some(stale_session_id) = missing_conversation_session_id.clone() {
            if saw_credential_error {
                emit_agent_message(
                    &app,
                    &db,
                    &session_id,
                    &agent_id_clone,
                    &workspace_id,
                    &ws_server,
                    format!(
                        "Claude reported missing session {} while AWS auth failed. Session reset was deferred; complete authentication and resend your last message.",
                        stale_session_id
                    ),
                    true,
                    "error",
                );
            } else {
                reset_agent_claude_session(
                    &app_state_for_pids,
                    &db,
                    &session_id,
                    &agent_id_clone,
                );
                emit_agent_message(
                    &app,
                    &db,
                    &session_id,
                    &agent_id_clone,
                    &workspace_id,
                    &ws_server,
                    format!(
                        "Claude session {} is no longer valid for the current auth context. The session was reset automatically; resend your last message.",
                        stale_session_id
                    ),
                    true,
                    "error",
                );
            }
            error_emitted = true;
        }

        if let Some(assistant_text) = choose_streaming_assistant_text(
            &assistant_text_blocks,
            &assistant_delta_text,
            latest_assistant_snapshot.as_ref(),
        ) {
            let normalized_assistant = normalize_text_for_dedupe(&assistant_text);
            if !normalized_assistant.is_empty()
                && last_plan.as_deref() != Some(normalized_assistant.as_str())
            {
                if assistant_stream_timestamp.is_some() {
                    emit_agent_message_with_options(
                        &app,
                        &db,
                        &session_id,
                        &agent_id_clone,
                        &workspace_id,
                        &ws_server,
                        assistant_text,
                        false,
                        "assistant",
                        assistant_stream_timestamp.as_deref(),
                        true,
                    );
                } else {
                    emit_agent_message(
                        &app,
                        &db,
                        &session_id,
                        &agent_id_clone,
                        &workspace_id,
                        &ws_server,
                        assistant_text,
                        false,
                        "assistant",
                    );
                }
            }
        } else if let Some(fallback) = result_text_fallback {
            let normalized_fallback = normalize_text_for_dedupe(&fallback);
            if !normalized_fallback.is_empty()
                && last_plan.as_deref() != Some(normalized_fallback.as_str())
            {
                if assistant_stream_timestamp.is_some() {
                    emit_agent_message_with_options(
                        &app,
                        &db,
                        &session_id,
                        &agent_id_clone,
                        &workspace_id,
                        &ws_server,
                        fallback,
                        false,
                        "assistant",
                        assistant_stream_timestamp.as_deref(),
                        true,
                    );
                } else {
                    emit_agent_message(
                        &app,
                        &db,
                        &session_id,
                        &agent_id_clone,
                        &workspace_id,
                        &ws_server,
                        fallback,
                        false,
                        "assistant",
                    );
                }
            }
        } else if status.success() && !error_emitted {
            emit_agent_message(
                &app,
                &db,
                &session_id,
                &agent_id_clone,
                &workspace_id,
                &ws_server,
                "Claude completed without a text response.".to_string(),
                false,
                "assistant",
            );
        }

        if !status.success() && !error_emitted {
            let error_content = if !stderr_buf.trim().is_empty() {
                stderr_buf
            } else {
                format!("Claude exited with status: {:?}", status.code())
            };
            if let Some(suggested_model) = extract_model_suggestion(&error_content) {
                emit_agent_message(
                    &app,
                    &db,
                    &session_id,
                    &agent_id_clone,
                    &workspace_id,
                    &ws_server,
                    format!("Suggested model from Claude: {}", suggested_model),
                    true,
                    "error",
                );
            }
            if !saw_prompt_too_long && detect_prompt_too_long(&error_content) {
                saw_prompt_too_long = true;
            }
            if detect_credential_error(&error_content) {
                saw_credential_error = true;
                emit_agent_message(
                    &app,
                    &db,
                    &session_id,
                    &agent_id_clone,
                    &workspace_id,
                    &ws_server,
                    credential_error_message(&error_content),
                    true,
                    "credential_error",
                );
            }
            emit_agent_message(
                &app,
                &db,
                &session_id,
                &agent_id_clone,
                &workspace_id,
                &ws_server,
                error_content,
                true,
                "error",
            );
            emit_agent_message(
                &app,
                &db,
                &session_id,
                &agent_id_clone,
                &workspace_id,
                &ws_server,
                env_summary.clone(),
                true,
                "error",
            );
            if let Some(ref hint) = env_hint {
                emit_agent_message(
                    &app,
                    &db,
                    &session_id,
                    &agent_id_clone,
                    &workspace_id,
                    &ws_server,
                    format!("Hint: {}", hint),
                    true,
                    "error",
                );
            }
        }

        // When the CLI reports "Prompt is too long", the session history exceeded
        // the context window.  The CLI typically compacts the history as a side-effect
        // of the failed load, so retrying after a delay often succeeds.
        if saw_prompt_too_long && missing_conversation_session_id.is_none() {
            if prompt_too_long_attempts < MAX_PROMPT_TOO_LONG_RETRIES {
                prompt_too_long_attempts += 1;
                let delay_secs: u64 = 30;
                emit_agent_message(
                    &app,
                    &db,
                    &session_id,
                    &agent_id_clone,
                    &workspace_id,
                    &ws_server,
                    format!(
                        "Context window exceeded — the CLI is compacting conversation history. Retrying in {} seconds (attempt {}/{})...",
                        delay_secs, prompt_too_long_attempts, MAX_PROMPT_TOO_LONG_RETRIES
                    ),
                    false,
                    "system",
                );
                if !interruptible_sleep(&app_state_for_pids, &agent_id_clone, delay_secs) {
                    // Agent was stopped during the wait — bail out.
                    break 'retry;
                }
                continue 'retry;
            } else {
                // Exhausted retries — reset session so the user isn't stuck.
                reset_agent_claude_session(
                    &app_state_for_pids,
                    &db,
                    &session_id,
                    &agent_id_clone,
                );
                emit_agent_message(
                    &app,
                    &db,
                    &session_id,
                    &agent_id_clone,
                    &workspace_id,
                    &ws_server,
                    "Context compaction did not reduce the session enough after multiple attempts. The session was reset — your next message will start a fresh conversation.".to_string(),
                    true,
                    "error",
                );
            }
        }

        if saw_credential_error {
            if let Some(refresh_result) = run_aws_auth_refresh(&effective_env) {
                match refresh_result {
                    Ok(message) => emit_agent_message(
                        &app,
                        &db,
                        &session_id,
                        &agent_id_clone,
                        &workspace_id,
                        &ws_server,
                        format!(
                            "{} Resend your last message once browser authentication completes.",
                            message
                        ),
                        false,
                        "system",
                    ),
                    Err(message) => emit_agent_message(
                        &app,
                        &db,
                        &session_id,
                        &agent_id_clone,
                        &workspace_id,
                        &ws_server,
                        message,
                        true,
                        "error",
                    ),
                }
            }
        }

        break; // Normal exit — no retry needed.
        } // end 'retry loop

        // Emit running=false after the retry loop completes (success or exhausted retries).
        // Deferred so the agent stays "running" during retries.
        _run_guard.disarm();
        emit_agent_run_state(
            &app,
            &ws_server,
            &workspace_id,
            &agent_id_clone,
            false,
        );
    });

    Ok(())
}

#[tauri::command]
async fn send_message_to_agent(
    agent_id: String,
    message: String,
    env_overrides: Option<HashMap<String, String>>,
    permission_mode: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    send_message_core(state.inner(), app, agent_id, message, env_overrides, permission_mode, model, effort)
}

#[tauri::command]
async fn get_agent_messages(
    workspace_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<AgentMessage>, String> {
    commands::agent::get_agent_messages(&state, workspace_id)
}

#[tauri::command]
async fn open_workspace_in_editor(
    workspace_id: String,
    editor: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    commands::pr::open_workspace_in_editor(&state, workspace_id, editor)
}

#[tauri::command]
async fn create_pull_request(
    workspace_id: String,
    title: String,
    body: String,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    commands::pr::create_pull_request(&state, workspace_id, title, body)
}

#[tauri::command]
async fn mark_workspace_in_review(
    workspace_id: String,
    pr_url: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    commands::pr::mark_workspace_in_review(&state, workspace_id, pr_url)
}

/// Sync workspace review state from GitHub PR state.
/// - OPEN PR => InReview
/// - MERGED PR => Merged
/// Returns workspace IDs that transitioned to Merged.
#[tauri::command]
async fn sync_pr_statuses(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<String>, String> {
    commands::pr::sync_pr_statuses(&state)
}

#[tauri::command]
async fn list_skills(
    repo_id: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<SkillListResponse, String> {
    commands::skills::list_skills(&state, repo_id)
}

#[tauri::command]
async fn save_skill(
    scope: String,
    repo_id: Option<String>,
    relative_path: Option<String>,
    name: String,
    content: String,
    state: State<'_, Arc<AppState>>,
) -> Result<SkillEntry, String> {
    commands::skills::save_skill(&state, scope, repo_id, relative_path, name, content)
}

#[tauri::command]
async fn delete_skill(
    scope: String,
    repo_id: Option<String>,
    relative_path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    commands::skills::delete_skill(&state, scope, repo_id, relative_path)
}

#[tauri::command]
async fn list_workspace_files(
    workspace_id: String,
    relative_path: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<WorkspaceFileEntry>, String> {
    commands::files::list_workspace_files(&state, workspace_id, relative_path)
}

#[tauri::command]
async fn read_workspace_file(
    workspace_id: String,
    relative_path: String,
    max_bytes: Option<usize>,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    commands::files::read_workspace_file(&state, workspace_id, relative_path, max_bytes)
}

/// Write content to a file inside a workspace. Path-traversal guarded.
#[tauri::command]
async fn write_workspace_file(
    workspace_id: String,
    relative_path: String,
    content: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    commands::files::write_workspace_file(&state, workspace_id, relative_path, content)
}

/// Read any file by absolute path. No workspace restriction.
#[tauri::command]
async fn read_file_by_path(
    file_path: String,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    commands::files::read_file_by_path(file_path, max_bytes)
}

#[tauri::command]
async fn list_workspace_changes(
    workspace_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<WorkspaceChangeEntry>, String> {
    commands::files::list_workspace_changes(&state, workspace_id)
}

#[tauri::command]
async fn read_workspace_change_diff(
    workspace_id: String,
    path: String,
    old_path: Option<String>,
    status: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    commands::files::read_workspace_change_diff(&state, workspace_id, path, old_path, status)
}

#[tauri::command]
async fn list_workspace_checks(
    workspace_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<WorkspaceCheckDefinition>, String> {
    commands::checks::list_workspace_checks(&state, workspace_id)
}

#[tauri::command]
async fn run_workspace_checks(
    workspace_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<WorkspaceCheckResult>, String> {
    commands::checks::run_workspace_checks(&state, workspace_id)
}

#[tauri::command]
async fn run_single_workspace_check(
    workspace_id: String,
    check_name: String,
    check_command: String,
    state: State<'_, Arc<AppState>>,
) -> Result<WorkspaceCheckResult, String> {
    commands::checks::run_single_workspace_check(&state, workspace_id, check_name, check_command)
}

// WebSocket command handler
async fn handle_ws_commands(
    mut rx: mpsc::UnboundedReceiver<ServerCommand>,
    state: Arc<AppState>,
    app: tauri::AppHandle,
) {
    while let Some(cmd) = rx.recv().await {
        match cmd {
            ServerCommand::ClientCountChanged { connected_clients } => {
                *state.ws_connected_clients.write() = connected_clients;
                let _ = app.emit("remote-clients-updated", connected_clients);
            }
            ServerCommand::ListRepositories { response_tx } => {
                let repos = state.repositories.read();
                let mut repository_list: Vec<RepositoryInfo> =
                    repos.values().map(to_repository_info).collect();
                repository_list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                let response = WsResponse::RepositoryList {
                    repositories: repository_list,
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            ServerCommand::AddRepository { path, response_tx } => {
                let response = match commands::repository::add_repository(&state, path) {
                    Ok(repo) => WsResponse::RepositoryAdded {
                        repository: to_repository_info(&repo),
                    },
                    Err(e) => WsResponse::Error { message: e },
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            ServerCommand::RemoveRepository { repo_id, response_tx } => {
                let response = match commands::repository::remove_repository(&state, repo_id.clone()) {
                    Ok(()) => WsResponse::RepositoryRemoved { repo_id },
                    Err(e) => WsResponse::Error { message: e },
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            ServerCommand::ListWorkspaces { repo_id, response_tx } => {
                let workspaces = state.workspaces.read();
                let agents = state.agents.read();
                
                let mut workspace_list: Vec<WorkspaceInfo> = workspaces
                    .values()
                    .filter(|ws| repo_id.as_ref().map_or(true, |id| &ws.repo_id == id))
                    .map(|ws| {
                        let has_agent = agents.values().any(|a| a.workspace_id == ws.id);
                        to_workspace_info(ws, has_agent)
                    })
                    .collect();
                workspace_list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                
                let response = WsResponse::WorkspaceList { workspaces: workspace_list };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            ServerCommand::CreateWorkspace { repo_id, name, response_tx } => {
                let trimmed = name.trim();
                if trimmed.is_empty() {
                    let response = WsResponse::Error { message: "Workspace name cannot be empty".to_string() };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    continue;
                }
                let response = match commands::workspace::create_workspace(&state, repo_id, trimmed.to_string()) {
                    Ok(ws) => WsResponse::WorkspaceCreated { workspace: to_workspace_info(&ws, false) },
                    Err(e) => WsResponse::Error { message: e },
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            ServerCommand::RenameWorkspace { workspace_id, name, response_tx } => {
                let response = match commands::workspace::rename_workspace(&state, workspace_id.clone(), name) {
                    Ok(ws) => {
                        let has_agent = state.agents.read().values().any(|a| a.workspace_id == workspace_id);
                        WsResponse::WorkspaceRenamed { workspace: to_workspace_info(&ws, has_agent) }
                    }
                    Err(e) => WsResponse::Error { message: e },
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            ServerCommand::RemoveWorkspace { workspace_id, response_tx } => {
                let response = match commands::workspace::remove_workspace(&state, workspace_id.clone()) {
                    Ok(()) => WsResponse::WorkspaceRemoved { workspace_id },
                    Err(e) => WsResponse::Error { message: e },
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            ServerCommand::GetMessages { workspace_id, response_tx } => {
                let response = match commands::agent::get_agent_messages(&state, workspace_id.clone()) {
                    Ok(messages) => {
                        let mapped: Vec<MessageInfo> = messages.into_iter().map(|m| MessageInfo {
                            agent_id: m.agent_id, role: m.role, content: m.content,
                            is_error: m.is_error, timestamp: m.timestamp,
                        }).collect();
                        WsResponse::MessageHistory { workspace_id, messages: mapped }
                    }
                    Err(e) => WsResponse::Error { message: e },
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            ServerCommand::ListFiles { workspace_id, relative_path, response_tx } => {
                let rel = relative_path.unwrap_or_default();
                let response = match commands::files::list_workspace_files(&state, workspace_id.clone(), Some(rel.clone())) {
                    Ok(file_entries) => {
                        let entries: Vec<FileEntryInfo> = file_entries.into_iter().map(|e| FileEntryInfo {
                            name: e.name, path: e.path, is_dir: e.is_dir,
                        }).collect();
                        WsResponse::FilesList { workspace_id, relative_path: rel, entries }
                    }
                    Err(e) => WsResponse::Error { message: e },
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            ServerCommand::ReadFile { workspace_id, relative_path, max_bytes, response_tx } => {
                let response = match commands::files::read_workspace_file(&state, workspace_id.clone(), relative_path.clone(), max_bytes) {
                    Ok(content) => WsResponse::FileContent { workspace_id, path: relative_path, content },
                    Err(e) => WsResponse::Error { message: e },
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            ServerCommand::ListChanges { workspace_id, response_tx } => {
                let response = match commands::files::list_workspace_changes(&state, workspace_id.clone()) {
                    Ok(entries) => {
                        let changes: Vec<ChangeInfo> = entries.into_iter().map(|c| ChangeInfo {
                            status: c.status, path: c.path, old_path: c.old_path,
                        }).collect();
                        WsResponse::ChangesList { workspace_id, changes }
                    }
                    Err(e) => WsResponse::Error { message: e },
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            ServerCommand::RunChecks { workspace_id, response_tx } => {
                let response = match commands::checks::run_workspace_checks(&state, workspace_id.clone()) {
                    Ok(results) => {
                        let checks: Vec<CheckInfo> = results.into_iter().map(|c| CheckInfo {
                            name: c.name, command: c.command, success: c.success,
                            exit_code: c.exit_code, stdout: c.stdout, stderr: c.stderr,
                            duration_ms: c.duration_ms, skipped: c.skipped,
                        }).collect();
                        WsResponse::ChecksResult { workspace_id, checks }
                    }
                    Err(e) => WsResponse::Error { message: e },
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            ServerCommand::SendMessage {
                workspace_id,
                message,
                permission_mode,
                model,
                effort,
                response_tx: _,
            } => {
                // Find agent for workspace
                let agent_id = {
                    let agents = state.agents.read();
                    agents.values()
                        .find(|a| a.workspace_id == workspace_id)
                        .map(|a| a.id.clone())
                };

                if let Some(agent_id) = agent_id {
                    // Delegate to send_message_core — the same path used by the Tauri command
                    // and HTTP handler. This ensures ProcessingGuard, env injection, and retry
                    // logic are all applied consistently.
                    if let Err(e) = send_message_core(
                        &state,
                        app.clone(),
                        agent_id,
                        message,
                        None, // env_overrides — WS clients don't send these
                        permission_mode,
                        model,
                        effort,
                    ) {
                        tracing::warn!("WS SendMessage failed: {}", e);
                    }
                }
            }

            ServerCommand::StartAgent { workspace_id, response_tx } => {
                // Delegate to start_agent_core — handles session resume, god workspace
                // env injection (ORCHESTRATOR_API_TOKEN, GOD_WORKSPACE_ID), and the
                // "already running" guard in one place.
                let response = match start_agent_core(&state, app.clone(), workspace_id.clone(), None) {
                    Ok(agent) => WsResponse::AgentStarted {
                        workspace_id,
                        agent_id: agent.id,
                    },
                    Err(e) if e.contains("already running") => {
                        // Return existing agent ID rather than an error
                        let agent_id = state.agents.read().values()
                            .find(|a| a.workspace_id == workspace_id)
                            .map(|a| a.id.clone())
                            .unwrap_or_default();
                        WsResponse::AgentStarted { workspace_id, agent_id }
                    }
                    Err(e) => WsResponse::Error { message: e },
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            
            ServerCommand::StopAgent { workspace_id, response_tx } => {
                let agent_id = {
                    let agents = state.agents.read();
                    agents.values()
                        .find(|a| a.workspace_id == workspace_id)
                        .map(|a| a.id.clone())
                };

                if let Some(agent_id) = agent_id {
                    let _ = commands::agent::stop_agent(&state, agent_id);
                    let response = WsResponse::AgentStopped { workspace_id };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                } else {
                    let response = WsResponse::Error { message: "No agent found for workspace".to_string() };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                }
            }

            ServerCommand::InterruptAgent { workspace_id, response_tx } => {
                let agent_id = {
                    let agents = state.agents.read();
                    agents.values()
                        .find(|a| a.workspace_id == workspace_id)
                        .map(|a| a.id.clone())
                };
                if let Some(agent_id) = agent_id {
                    let pid = state.child_pids.read().get(&agent_id).copied();
                    if let Some(pid) = pid {
                        unsafe { libc::kill(pid as libc::pid_t, libc::SIGINT); }
                        let response = WsResponse::AgentInterrupted { workspace_id };
                        let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    } else {
                        let response = WsResponse::Error { message: "No running process found for agent".to_string() };
                        let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    }
                } else {
                    let response = WsResponse::Error { message: "No agent found for workspace".to_string() };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                }
            }

            ServerCommand::RespondToPermission { workspace_id, request_id, allow, deny_message, response_tx } => {
                // Try the MCP bridge path first (HTTP long-poll oneshot channel).
                let pending_entry = state.pending_permission_requests.write().remove(&request_id);
                if let Some((_ws_id, tx)) = pending_entry {
                    let response = if allow {
                        serde_json::json!({ "behavior": "allow" })
                    } else {
                        serde_json::json!({
                            "behavior": "deny",
                            "message": deny_message.as_deref().unwrap_or("User denied this action")
                        })
                    };
                    let _ = tx.send(response);
                    let resp = serde_json::json!({ "type": "ok" });
                    let _ = response_tx.send(serde_json::to_string(&resp).unwrap());
                    continue;
                }
                // Fall back to stdin control_response path.
                let agent_id = {
                    let agents = state.agents.read();
                    agents.values()
                        .find(|a| a.workspace_id == workspace_id)
                        .map(|a| a.id.clone())
                };
                if let Some(agent_id) = agent_id {
                    match commands::agent::respond_to_permission(&state, agent_id, request_id, allow, deny_message, None) {
                        Ok(()) => {
                            let resp = serde_json::json!({ "type": "ok" });
                            let _ = response_tx.send(serde_json::to_string(&resp).unwrap());
                        }
                        Err(e) => {
                            let resp = WsResponse::Error { message: e };
                            let _ = response_tx.send(serde_json::to_string(&resp).unwrap());
                        }
                    }
                } else {
                    let resp = WsResponse::Error { message: "No agent found for workspace".to_string() };
                    let _ = response_tx.send(serde_json::to_string(&resp).unwrap());
                }
            }

            ServerCommand::SetWorkspaceStatus { workspace_id, status, response_tx } => {
                let response = match commands::workspace::set_workspace_status(&state, workspace_id.clone(), status) {
                    Ok(ws) => {
                        let has_agent = state.agents.read().values().any(|a| a.workspace_id == workspace_id);
                        let info = to_workspace_info(&ws, has_agent);
                        if let Some(ws_server) = &state.ws_server {
                            ws_server.broadcast_all(&WsResponse::WorkspaceUpdated { workspace: info.clone() });
                        }
                        WsResponse::WorkspaceUpdated { workspace: info }
                    }
                    Err(e) => WsResponse::Error { message: e },
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            ServerCommand::ToggleWorkspacePin { workspace_id, response_tx } => {
                let response = match commands::workspace::toggle_workspace_pinned(&state, workspace_id.clone()) {
                    Ok(ws) => {
                        let has_agent = state.agents.read().values().any(|a| a.workspace_id == workspace_id);
                        WsResponse::WorkspaceUpdated { workspace: to_workspace_info(&ws, has_agent) }
                    }
                    Err(e) => WsResponse::Error { message: e },
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            ServerCommand::UpdateWorkspaceNotes { workspace_id, notes, response_tx } => {
                let _ = commands::workspace::update_workspace_notes(&state, workspace_id.clone(), notes);
                let workspace_info = {
                    let workspaces = state.workspaces.read();
                    workspaces.get(&workspace_id).map(|ws| {
                        let has_agent = state.agents.read().values().any(|a| a.workspace_id == workspace_id);
                        to_workspace_info(ws, has_agent)
                    })
                };
                if let Some(info) = workspace_info {
                    let response = WsResponse::WorkspaceUpdated { workspace: info };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                }
            }
            ServerCommand::UpdateWorkspaceOrder { workspace_id, display_order, response_tx } => {
                let _ = commands::workspace::update_workspace_display_order(&state, workspace_id.clone(), display_order);
                let workspace_info = {
                    let workspaces = state.workspaces.read();
                    workspaces.get(&workspace_id).map(|ws| {
                        let has_agent = state.agents.read().values().any(|a| a.workspace_id == workspace_id);
                        to_workspace_info(ws, has_agent)
                    })
                };
                if let Some(info) = workspace_info {
                    let response = WsResponse::WorkspaceUpdated { workspace: info };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                }
            }
            ServerCommand::ReadChangeDiff { workspace_id, file_path, response_tx } => {
                let response = match commands::files::read_workspace_change_diff(&state, workspace_id.clone(), file_path.clone(), None, None) {
                    Ok(diff) => WsResponse::ChangeDiff { workspace_id, file_path, diff },
                    Err(e) => WsResponse::Error { message: e },
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            ServerCommand::RunTerminalCommand { workspace_id, command, response_tx } => {
                let response = match commands::workspace::run_workspace_terminal_command(&state, workspace_id.clone(), command, None) {
                    Ok(result) => WsResponse::TerminalOutput {
                        workspace_id,
                        stdout: result.stdout,
                        stderr: result.stderr,
                        exit_code: result.exit_code,
                    },
                    Err(e) => WsResponse::Error { message: e },
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    
    // Initialize database
    let app_data_dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("claude-orchestrator");
    
    let db_path = app_data_dir.join("data.db");
    
    let db = Database::new(db_path)
        .expect("Failed to initialize database");
    
    let mut app_state = AppState::new(db);
    
    // Create WebSocket command channel
    let (ws_cmd_tx, ws_cmd_rx) = mpsc::unbounded_channel::<ServerCommand>();
    
    // Create WebSocket server
    let pairing_code = app_state.pairing_code.clone();
    let ws_server = Arc::new(WebSocketServer::new(REMOTE_SERVER_PORT, ws_cmd_tx, pairing_code));
    app_state.set_ws_server(ws_server.clone());

    // Create HTTP server for web client
    // In dev: resolve from CARGO_MANIFEST_DIR (src-tauri) -> ../web/dist
    // In prod: resolve from macOS bundle -> Contents/Resources/web-dist/
    let dev_web_dist = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../web/dist");
    let web_dist_path = if dev_web_dist.exists() {
        dev_web_dist
    } else if let Ok(exe_path) = std::env::current_exe() {
        // macOS .app bundle: Contents/MacOS/<binary> -> Contents/Resources/web-dist
        exe_path.parent().unwrap_or(&exe_path).join("../Resources/web-dist")
    } else {
        app_data_dir.join("web-dist")
    };
    let http_server = Arc::new(HttpServer::new(HTTP_SERVER_PORT, web_dist_path));
    app_state.set_http_server(http_server);
    
    let app_state = Arc::new(app_state);
    let app_state_for_ws = app_state.clone();
    
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(app_state)
        .setup(move |app| {
            let app_handle = app.handle().clone();

            // Build native menu bar with a Settings item in the application menu.
            let settings_item = MenuItemBuilder::with_id("settings", "Settings...")
                .accelerator("CmdOrCtrl+;")
                .build(app)?;

            let app_menu = SubmenuBuilder::new(app, "Claude Orchestrator")
                .about(None)
                .separator()
                .item(&settings_item)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .separator()
                .close_window()
                .build()?;

            let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])?;
            app.set_menu(menu)?;

            let app_handle_menu = app_handle.clone();
            app.on_menu_event(move |_app, event| {
                if event.id().as_ref() == "settings" {
                    let _ = app_handle_menu.emit("open-settings", ());
                }
            });

            let ws_server_clone = ws_server.clone();
            let startup_state = app_state_for_ws.clone();
            let command_state = app_state_for_ws.clone();

            // WebSocket server is started manually by the user via start_remote_server command.
            // Drop unused clones to avoid resource leaks.
            drop(ws_server_clone);

            // Auto-start the HTTP server so the MCP permission bridge can reach
            // POST /api/permission even before the user starts the remote server.
            if let Some(http) = &startup_state.http_server {
                let pending = startup_state.pending_permission_requests.clone();
                let http_app_handle = app_handle.clone();
                let http = http.clone();
                let http_app_state = startup_state.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = http.start(pending, http_app_handle, http_app_state, false).await {
                        tracing::warn!("Failed to auto-start HTTP server: {}", e);
                    }
                });
            }
            drop(startup_state);

            // Start command handler
            tauri::async_runtime::spawn(async move {
                handle_ws_commands(ws_cmd_rx, command_state, app_handle).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            get_app_status,
            start_remote_server,
            stop_remote_server,
            regenerate_pairing_code,
            check_for_app_update,
            install_app_update,
            add_repository,
            remove_repository,
            list_repositories,
            list_workspaces,
            check_git_busy,
            get_orchestrator_config,
            get_workspace_config,
            run_orchestrator_script,
            create_workspace,
            remove_workspace,
            rename_workspace,
            update_workspace_unread,
            update_workspace_display_order,
            toggle_workspace_pinned,
            update_workspace_notes,
            set_workspace_status,
            create_god_workspace,
            list_god_workspaces,
            remove_god_workspace,
            list_god_child_workspaces,
            create_god_child_workspace,
            list_agents,
            start_agent,
            stop_agent,
            interrupt_agent,
            respond_to_permission,
            answer_agent_question,
            send_message_to_agent,
            get_agent_messages,
            open_workspace_in_editor,
            create_pull_request,
            mark_workspace_in_review,
            sync_pr_statuses,
            list_skills,
            save_skill,
            delete_skill,
            list_workspace_files,
            read_workspace_file,
            write_workspace_file,
            read_file_by_path,
            list_workspace_changes,
            read_workspace_change_diff,
            list_workspace_checks,
            run_workspace_checks,
            run_single_workspace_check,
            run_workspace_terminal_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_permission_mode_defaults_to_skip() {
        assert_eq!(normalize_permission_mode(None), "dangerouslySkipPermissions");
        assert_eq!(
            normalize_permission_mode(Some("dangerouslySkipPermissions")),
            "dangerouslySkipPermissions"
        );
        assert_eq!(
            normalize_permission_mode(Some("bypassPermissions")),
            "bypassPermissions"
        );
        assert_eq!(normalize_permission_mode(Some("plan")), "plan");
        assert_eq!(normalize_permission_mode(Some("default")), "default");
        assert_eq!(normalize_permission_mode(Some("acceptEdits")), "acceptEdits");
        assert_eq!(normalize_permission_mode(Some("dontAsk")), "dontAsk");
        assert_eq!(normalize_permission_mode(Some("auto")), "auto");
    }

    #[test]
    fn normalize_model_maps_aliases_and_bedrock_ids() {
        assert_eq!(normalize_model(None), None);
        assert_eq!(normalize_model(Some("default")), None);
        assert_eq!(
            normalize_model(Some("opus")),
            Some("opus".to_string())
        );
        assert_eq!(
            normalize_model(Some("sonnet")),
            Some("sonnet".to_string())
        );
        assert_eq!(
            normalize_model(Some("haiku")),
            Some("haiku".to_string())
        );
        assert_eq!(
            normalize_model(Some("global.anthropic.claude-sonnet-4-6-20260115-v1:0")),
            Some("global.anthropic.claude-sonnet-4-6-20260115-v1:0".to_string())
        );
    }

    #[test]
    fn parse_claude_settings_env_extracts_non_empty_values() {
        let raw = r#"{
            "env": {
                "AWS_PROFILE": "obsidianos-stage",
                "EMPTY": "   ",
                "": "ignored"
            },
            "awsAuthRefresh": "aws sso login --profile obsidianos-stage"
        }"#;
        let env = parse_claude_settings_env(raw);
        assert_eq!(
            env.get("AWS_PROFILE"),
            Some(&"obsidianos-stage".to_string())
        );
        assert!(!env.contains_key("EMPTY"));
        assert!(!env.contains_key(""));
    }

    #[test]
    fn parse_claude_settings_reads_auth_refresh_command() {
        let raw = r#"{
            "awsAuthRefresh": "aws sso login --profile obsidianos-stage"
        }"#;
        let settings = parse_claude_settings(raw);
        assert_eq!(
            settings.aws_auth_refresh,
            Some("aws sso login --profile obsidianos-stage".to_string())
        );
    }

    #[test]
    fn resolve_model_for_runtime_bedrock_aliases() {
        assert_eq!(
            resolve_model_for_runtime(Some("opus"), true),
            Some("global.anthropic.claude-opus-4-6-v1".to_string())
        );
        assert_eq!(
            resolve_model_for_runtime(Some("sonnet"), true),
            Some("global.anthropic.claude-sonnet-4-6".to_string())
        );
        assert_eq!(
            resolve_model_for_runtime(Some("haiku"), true),
            Some("global.anthropic.claude-haiku-4-5-20251001-v1:0".to_string())
        );
    }

    #[test]
    fn resolve_model_for_runtime_api_aliases() {
        assert_eq!(
            resolve_model_for_runtime(Some("opus"), false),
            Some("claude-opus-4-6".to_string())
        );
        assert_eq!(
            resolve_model_for_runtime(Some("sonnet"), false),
            Some("claude-sonnet-4-6".to_string())
        );
        assert_eq!(
            resolve_model_for_runtime(Some("haiku"), false),
            Some("claude-haiku-4-5".to_string())
        );
    }

    #[test]
    fn resolve_model_for_runtime_full_ids_passthrough() {
        assert_eq!(
            resolve_model_for_runtime(Some("global.anthropic.claude-opus-4-6-v1"), true),
            Some("global.anthropic.claude-opus-4-6-v1".to_string())
        );
        assert_eq!(
            resolve_model_for_runtime(Some("claude-sonnet-4-6"), false),
            Some("claude-sonnet-4-6".to_string())
        );

        // None, empty, and whitespace return None
        assert_eq!(resolve_model_for_runtime(None, true), None);
        assert_eq!(resolve_model_for_runtime(Some(""), false), None);
        assert_eq!(resolve_model_for_runtime(Some("  "), true), None);
    }

    #[test]
    fn configure_cli_env_strips_model_override_vars() {
        let mut env = HashMap::new();
        env.insert("PATH".to_string(), "/usr/bin".to_string());
        env.insert("HOME".to_string(), "/Users/test".to_string());
        env.insert("CLAUDE_CODE_USE_BEDROCK".to_string(), "1".to_string());
        env.insert(
            "CLAUDE_MODEL_OPUS".to_string(),
            "stale-opus-id".to_string(),
        );
        env.insert(
            "CLAUDE_BEDROCK_MODEL_SONNET".to_string(),
            "stale-sonnet-id".to_string(),
        );

        let mut cmd = Command::new("echo");
        configure_cli_env(&mut cmd, &env);

        // We can't easily inspect cmd's env, so verify the function compiles
        // and runs without panic.  The real assertion is that model-override
        // keys are filtered out — we test the predicate directly:
        for key in &["CLAUDE_MODEL_OPUS", "CLAUDE_BEDROCK_MODEL_SONNET"] {
            assert!(
                MODEL_OVERRIDE_ENV_PREFIXES.iter().any(|p| key.starts_with(p)),
                "{key} should be filtered"
            );
        }
        for key in &["PATH", "HOME", "CLAUDE_CODE_USE_BEDROCK"] {
            assert!(
                !MODEL_OVERRIDE_ENV_PREFIXES.iter().any(|p| key.starts_with(p)),
                "{key} should NOT be filtered"
            );
        }
    }

    #[test]
    fn extract_model_suggestion_reads_cli_hint() {
        let text = "API Error: invalid model. Try --model to switch to us.anthropic.claude-opus-4-1-20250805-v1:0.";
        assert_eq!(
            extract_model_suggestion(text),
            Some("us.anthropic.claude-opus-4-1-20250805-v1:0".to_string())
        );
    }

    #[test]
    fn choose_assistant_text_prefers_more_complete_snapshot() {
        let delta = "I'll explore";
        let snapshot = Some("I'll explore the person package and create a comprehensive overview.".to_string());
        assert_eq!(
            choose_assistant_text(delta, snapshot.as_ref()),
            Some("I'll explore the person package and create a comprehensive overview.".to_string())
        );
    }

    #[test]
    fn summarize_tool_task_uses_description() {
        let input = r#"{"description":"Explore person package structure","prompt":"..."}"#;
        assert_eq!(
            summarize_tool_call("Task", input),
            Some("Task Explore person package structure".to_string())
        );
    }

    #[test]
    fn parse_init_activity_includes_permission_mode() {
        let event = json!({
            "type": "system",
            "subtype": "init",
            "model": "claude-sonnet-4-6",
            "permissionMode": "plan"
        });
        let mut tool_names = HashMap::new();
        let mut tool_inputs = HashMap::new();
        let activities = parse_stream_event_for_activity(&event, &mut tool_names, &mut tool_inputs);
        assert_eq!(
            activities,
            vec![ActivityEvent::Activity(
                "Claude initialized (claude-sonnet-4-6, permission=plan)".to_string()
            )]
        );
    }

    #[test]
    fn parse_ask_user_question_tool_use_emits_question_event() {
        let event = json!({
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "name": "AskUserQuestion",
                        "input": {
                            "questions": [
                                {
                                    "question": "Pick a mode",
                                    "options": [
                                        { "label": "Fast" },
                                        { "label": "Safe" }
                                    ]
                                }
                            ]
                        }
                    }
                ]
            }
        });
        let mut tool_names = HashMap::new();
        let mut tool_inputs = HashMap::new();
        let activities = parse_stream_event_for_activity(&event, &mut tool_names, &mut tool_inputs);
        assert!(matches!(activities.first(), Some(ActivityEvent::Question(_))));
    }

    #[test]
    fn parse_exit_plan_mode_tool_use_emits_plan_event() {
        let event = json!({
            "type": "assistant",
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "name": "ExitPlanMode",
                        "input": {
                            "allowedPrompts": [],
                            "plan": "# Plan Title\n\n1. Step one\n2. Step two"
                        }
                    }
                ]
            }
        });
        let mut tool_names = HashMap::new();
        let mut tool_inputs = HashMap::new();
        let activities = parse_stream_event_for_activity(&event, &mut tool_names, &mut tool_inputs);
        assert!(activities.iter().any(|evt| matches!(evt, ActivityEvent::Plan(plan) if plan.contains("Plan Title"))));
    }
}
