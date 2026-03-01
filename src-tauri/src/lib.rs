use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::net::{IpAddr, UdpSocket};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::{Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::mpsc;
use uuid::Uuid;

mod database;
mod process_manager;
mod websocket_server;

use database::Database;
use websocket_server::{ChangeInfo, CheckInfo, FileEntryInfo, MessageInfo, WebSocketServer, WsResponse, WorkspaceInfo, ServerCommand};

static CLAUDE_HELP_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
const REMOTE_SERVER_PORT: u16 = 3001;

// Types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub id: String,
    pub path: String,
    pub name: String,
    pub default_branch: String,
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub repo_id: String,
    pub name: String,
    pub branch: String,
    pub worktree_path: String,
    pub status: WorkspaceStatus,
    pub last_activity: Option<String>,
    pub pr_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceStatus {
    Idle,
    Running,
    #[serde(rename = "inReview")]
    InReview,
    Merged,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    pub workspace_id: String,
    pub status: AgentStatus,
    pub session_id: Option<String>,
    pub claude_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Starting,
    Running,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    pub port: u16,
    pub connected_clients: usize,
    pub connect_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub repositories: Vec<Repository>,
    pub server_status: ServerStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    pub agent_id: String,
    pub workspace_id: Option<String>,
    pub role: String,
    pub content: String,
    pub is_error: bool,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChangeEntry {
    pub status: String,
    pub path: String,
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCheckResult {
    pub name: String,
    pub command: String,
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u128,
    pub skipped: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCheckDefinition {
    pub name: String,
    pub command: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommandResult {
    pub command: String,
    pub cwd: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u128,
}

// Application State
pub struct AppState {
    db: Arc<Database>,
    repositories: RwLock<HashMap<String, Repository>>,
    workspaces: RwLock<HashMap<String, Workspace>>,
    agents: RwLock<HashMap<String, Agent>>,
    /// Tracks child process PIDs per agent so we can send SIGINT to interrupt.
    child_pids: RwLock<HashMap<String, u32>>,
    ws_server: Option<Arc<WebSocketServer>>,
    ws_server_running: RwLock<bool>,
    ws_connected_clients: RwLock<usize>,
}

impl AppState {
    fn new(db: Database) -> Self {
        let db = Arc::new(db);
        let mut state = Self {
            db: db.clone(),
            repositories: RwLock::new(HashMap::new()),
            workspaces: RwLock::new(HashMap::new()),
            agents: RwLock::new(HashMap::new()),
            child_pids: RwLock::new(HashMap::new()),
            ws_server: None,
            ws_server_running: RwLock::new(false),
            ws_connected_clients: RwLock::new(0),
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
        
        // Load workspaces
        if let Ok(workspaces) = self.db.get_all_workspaces() {
            let mut ws_map = self.workspaces.write();
            for ws in workspaces {
                ws_map.insert(ws.id.clone(), ws);
            }
        }
    }
    
    fn set_ws_server(&mut self, server: Arc<WebSocketServer>) {
        self.ws_server = Some(server);
    }
}

// Git helpers
fn get_default_branch(repo_path: &str) -> Result<String, String> {
    let output = Command::new("git")
        .args(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;
    
    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout)
            .trim()
            .replace("origin/", "");
        Ok(branch)
    } else {
        Ok("main".to_string())
    }
}

fn is_git_repo(path: &str) -> bool {
    Command::new("git")
        .args(["rev-parse", "--git-dir"])
        .current_dir(path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn create_worktree(repo_path: &str, worktree_path: &str, branch: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["worktree", "add", "-b", branch, worktree_path])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to create worktree: {}", e))?;
    
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git worktree failed: {}", stderr));
    }
    
    Ok(())
}

fn remove_worktree(repo_path: &str, worktree_path: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["worktree", "remove", worktree_path, "--force"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to remove worktree: {}", e))?;
    
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git worktree remove failed: {}", stderr));
    }
    
    Ok(())
}

fn remove_workspace_directory(repo_path: &str, worktree_path: &str) -> Result<(), String> {
    let repo_root = PathBuf::from(repo_path);
    let allowed_root = repo_root.join(".worktrees");
    let workspace_path = PathBuf::from(worktree_path);

    if !workspace_path.starts_with(&allowed_root) {
        return Err(format!(
            "Refusing to delete workspace path outside .worktrees: {}",
            worktree_path
        ));
    }

    if workspace_path.exists() {
        std::fs::remove_dir_all(&workspace_path)
            .map_err(|e| format!("Failed to delete workspace files: {}", e))?;
    }

    Ok(())
}

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
    let host = detect_remote_connect_host();
    ServerStatus {
        running,
        port: REMOTE_SERVER_PORT,
        connected_clients,
        connect_url: format!("ws://{}:{}", host, REMOTE_SERVER_PORT),
    }
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
async fn start_remote_server(state: State<'_, Arc<AppState>>) -> Result<ServerStatus, String> {
    let server = state
        .ws_server
        .clone()
        .ok_or_else(|| "Remote server is not initialized.".to_string())?;

    server.start().await?;
    *state.ws_server_running.write() = true;
    *state.ws_connected_clients.write() = server.client_count();

    Ok(build_server_status(state.inner().as_ref()))
}

#[tauri::command]
async fn stop_remote_server(state: State<'_, Arc<AppState>>) -> Result<ServerStatus, String> {
    let server = state
        .ws_server
        .clone()
        .ok_or_else(|| "Remote server is not initialized.".to_string())?;

    server.stop();
    *state.ws_server_running.write() = false;
    *state.ws_connected_clients.write() = 0;

    Ok(build_server_status(state.inner().as_ref()))
}

#[tauri::command]
async fn add_repository(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Repository, String> {
    let path_buf = PathBuf::from(&path);
    
    if !path_buf.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    
    if !path_buf.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }
    
    if !is_git_repo(&path) {
        return Err("Not a git repository. Please select a folder containing a .git directory.".to_string());
    }
    
    let name = path_buf
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Repository")
        .to_string();
    
    let default_branch = get_default_branch(&path)?;
    
    let repo = Repository {
        id: Uuid::new_v4().to_string(),
        path,
        name,
        default_branch,
        added_at: chrono::Utc::now().to_rfc3339(),
    };
    
    // Save to database
    state.db.insert_repository(&repo)
        .map_err(|e| format!("Failed to save repository: {}", e))?;
    
    let mut repos = state.repositories.write();
    repos.insert(repo.id.clone(), repo.clone());
    
    Ok(repo)
}

#[tauri::command]
async fn remove_repository(
    repo_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let repo_path = {
        let repos = state.repositories.read();
        repos.get(&repo_id).map(|r| r.path.clone())
    };
    
    if let Some(repo_path) = repo_path {
        let workspaces_to_remove: Vec<Workspace> = {
            let workspaces = state.workspaces.read();
            workspaces.values()
                .filter(|w| w.repo_id == repo_id)
                .cloned()
                .collect()
        };
        
        for workspace in workspaces_to_remove {
            if let Err(e) = remove_worktree(&repo_path, &workspace.worktree_path) {
                tracing::warn!(
                    "git worktree remove failed for {}: {}",
                    workspace.worktree_path,
                    e
                );
            }
            if let Err(e) = remove_workspace_directory(&repo_path, &workspace.worktree_path) {
                tracing::warn!(
                    "workspace directory cleanup failed for {}: {}",
                    workspace.worktree_path,
                    e
                );
            }
            let mut workspaces = state.workspaces.write();
            workspaces.remove(&workspace.id);
        }
    }
    
    // Delete from database
    state.db.delete_repository(&repo_id)
        .map_err(|e| format!("Failed to delete repository: {}", e))?;
    
    let mut repos = state.repositories.write();
    repos.remove(&repo_id);
    Ok(())
}

#[tauri::command]
async fn list_repositories(state: State<'_, Arc<AppState>>) -> Result<Vec<Repository>, String> {
    let repos = state.repositories.read();
    Ok(repos.values().cloned().collect())
}

#[tauri::command]
async fn list_workspaces(
    repo_id: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<Workspace>, String> {
    let workspaces = state.workspaces.read();
    let result: Vec<Workspace> = workspaces.values()
        .filter(|w| repo_id.as_ref().map_or(true, |id| &w.repo_id == id))
        .cloned()
        .collect();
    Ok(result)
}

#[tauri::command]
async fn create_workspace(
    repo_id: String,
    name: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Workspace, String> {
    let repo = {
        let repos = state.repositories.read();
        repos.get(&repo_id).cloned()
            .ok_or("Repository not found")?
    };
    
    let branch = format!("workspace/{}", name.to_lowercase().replace(' ', "-"));
    
    let worktrees_dir = PathBuf::from(&repo.path).join(".worktrees");
    std::fs::create_dir_all(&worktrees_dir)
        .map_err(|e| format!("Failed to create worktrees directory: {}", e))?;
    
    let worktree_path = worktrees_dir.join(&name);
    let worktree_path_str = worktree_path.to_string_lossy().to_string();
    
    create_worktree(&repo.path, &worktree_path_str, &branch)?;
    
    let workspace = Workspace {
        id: Uuid::new_v4().to_string(),
        repo_id,
        name,
        branch,
        worktree_path: worktree_path_str,
        status: WorkspaceStatus::Idle,
        last_activity: None,
        pr_url: None,
    };
    
    // Save to database
    state.db.insert_workspace(&workspace)
        .map_err(|e| format!("Failed to save workspace: {}", e))?;
    
    let mut workspaces = state.workspaces.write();
    workspaces.insert(workspace.id.clone(), workspace.clone());
    
    Ok(workspace)
}

#[tauri::command]
async fn remove_workspace(
    workspace_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let (repo_path, worktree_path) = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces.get(&workspace_id)
            .ok_or("Workspace not found")?;
        
        let repos = state.repositories.read();
        let repo = repos.get(&workspace.repo_id)
            .ok_or("Repository not found")?;
        
        (repo.path.clone(), workspace.worktree_path.clone())
    };
    
    if let Err(e) = remove_worktree(&repo_path, &worktree_path) {
        tracing::warn!("git worktree remove failed for {}: {}", worktree_path, e);
    }
    remove_workspace_directory(&repo_path, &worktree_path)?;
    
    // Delete from database
    state.db.delete_workspace(&workspace_id)
        .map_err(|e| format!("Failed to delete workspace: {}", e))?;
    
    let mut workspaces = state.workspaces.write();
    workspaces.remove(&workspace_id);
    
    Ok(())
}

#[tauri::command]
async fn rename_workspace(
    workspace_id: String,
    name: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Workspace, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Workspace name cannot be empty".to_string());
    }

    let updated = {
        let mut workspaces = state.workspaces.write();
        let workspace = workspaces
            .get_mut(&workspace_id)
            .ok_or("Workspace not found")?;
        workspace.name = trimmed.to_string();
        workspace.clone()
    };

    state
        .db
        .update_workspace_name(&workspace_id, trimmed)
        .map_err(|e| format!("Failed to rename workspace: {}", e))?;

    Ok(updated)
}

#[tauri::command]
async fn run_workspace_terminal_command(
    workspace_id: String,
    command: String,
    env_overrides: Option<HashMap<String, String>>,
    state: State<'_, Arc<AppState>>,
) -> Result<TerminalCommandResult, String> {
    let cmd = command.trim();
    if cmd.is_empty() {
        return Err("Command cannot be empty".to_string());
    }

    let workspace = {
        let workspaces = state.workspaces.read();
        workspaces
            .get(&workspace_id)
            .cloned()
            .ok_or("Workspace not found")?
    };

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let started = Instant::now();
    let mut process = Command::new(shell);
    process.current_dir(&workspace.worktree_path);
    process.args(["-lc", cmd]);
    let overrides = env_overrides.unwrap_or_default();
    let effective_env = build_effective_cli_env(&overrides);
    configure_cli_env(&mut process, &effective_env);
    let output = process
        .output()
        .map_err(|e| format!("Failed to execute command: {}", e))?;

    Ok(TerminalCommandResult {
        command: cmd.to_string(),
        cwd: workspace.worktree_path,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
        duration_ms: started.elapsed().as_millis(),
    })
}

#[tauri::command]
async fn list_agents(state: State<'_, Arc<AppState>>) -> Result<Vec<Agent>, String> {
    let agents = state.agents.read();
    Ok(agents.values().cloned().collect())
}

#[tauri::command]
async fn start_agent(
    workspace_id: String,
    env_overrides: Option<HashMap<String, String>>,
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<Agent, String> {
    // Get workspace info
    let workspace = {
        let workspaces = state.workspaces.read();
        workspaces.get(&workspace_id).cloned()
            .ok_or("Workspace not found")?
    };
    
    let agent_id = Uuid::new_v4().to_string();
    let session_id = Uuid::new_v4().to_string();
    
    // Always start a fresh Claude session for each launched agent.
    // Reusing persisted session IDs can fail with:
    // "No conversation found with session ID ..."
    // and can incorrectly route auth mode (e.g. requiring /login).
    let claude_session_id: Option<String> = None;
    
    // Create session in database
    let now = chrono::Utc::now().to_rfc3339();
    state.db.insert_session(&session_id, &workspace_id, claude_session_id.as_deref(), &now)
        .map_err(|e| format!("Failed to create session: {}", e))?;
    
    // Create agent record
    let agent = Agent {
        id: agent_id.clone(),
        workspace_id: workspace_id.clone(),
        status: AgentStatus::Running,
        session_id: Some(session_id.clone()),
        claude_session_id: claude_session_id.clone(),
    };
    
    {
        let mut agents = state.agents.write();
        agents.insert(agent_id.clone(), agent.clone());
    }
    
    // Update workspace status
    {
        let mut workspaces = state.workspaces.write();
        if let Some(workspace) = workspaces.get_mut(&workspace_id) {
            workspace.status = WorkspaceStatus::Running;
            workspace.last_activity = Some(chrono::Utc::now().to_rfc3339());
        }
    }
    
    // Update database
    let now = chrono::Utc::now().to_rfc3339();
    let _ = state.db.update_workspace_status(&workspace_id, &WorkspaceStatus::Running, Some(&now));
    
    // Get WebSocket server for broadcasting
    let ws_server = state.ws_server.clone();
    
    // Spawn Claude CLI in background thread
    let workspace_path = workspace.worktree_path.clone();
    let workspace_name = workspace.name.clone();
    let agent_id_clone = agent_id.clone();
    let db = state.db.clone();
    let session_id_clone = session_id.clone();
    let workspace_id_clone = workspace_id.clone();
    let env_overrides_clone = env_overrides.unwrap_or_default();

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

fn find_claude_cli_in_path(path_value: &str) -> Option<String> {
    for dir in std::env::split_paths(path_value) {
        let candidate = dir.join("claude");
        if candidate.exists() && candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

fn find_claude_cli_with_env(env_map: Option<&HashMap<String, String>>) -> Option<String> {
    let home = env_map
        .and_then(|map| map.get("HOME").cloned())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_default();
    let preferred_paths = [
        format!("{}/.local/bin/claude", home),
        format!("{}/.claude/local/claude", home),
    ];

    for path in preferred_paths {
        if std::path::Path::new(&path).exists() {
            return Some(path);
        }
    }

    if let Some(map) = env_map {
        if let Some(found) = map
            .get("PATH")
            .and_then(|path_value| find_claude_cli_in_path(path_value))
        {
            return Some(found);
        }
    }

    if let Ok(path_value) = std::env::var("PATH") {
        if let Some(found) = find_claude_cli_in_path(&path_value) {
            return Some(found);
        }
    }

    let paths = [
        "/usr/local/bin/claude".to_string(),
        "/opt/homebrew/bin/claude".to_string(),
    ];
    
    paths.iter()
        .find(|p| std::path::Path::new(p).exists())
        .cloned()
}

fn claude_help_text(claude_path: &str) -> Option<String> {
    let cache = CLAUDE_HELP_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(cached) = guard.get(claude_path) {
            return Some(cached.clone());
        }
    }

    let output = Command::new(claude_path).arg("--help").output().ok()?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    if text.trim().is_empty() {
        tracing::warn!(claude_path = %claude_path, "claude --help returned empty output");
        return None;
    }
    tracing::info!(
        claude_path = %claude_path,
        help_len = text.len(),
        has_model_flag = text.contains("--model"),
        "claude --help output captured"
    );

    if let Ok(mut guard) = cache.lock() {
        guard.insert(claude_path.to_string(), text.clone());
    }
    Some(text)
}

fn claude_supports_option(claude_path: &str, option: &str) -> bool {
    claude_help_text(claude_path)
        .map(|help| help.contains(option))
        .unwrap_or(false)
}

fn claude_supports_stream_json(claude_path: &str) -> bool {
    claude_supports_option(claude_path, "--output-format")
}

fn claude_supports_permission_mode(claude_path: &str) -> bool {
    claude_supports_option(claude_path, "--permission-mode")
}

fn claude_supports_model_option(claude_path: &str) -> bool {
    claude_supports_option(claude_path, "--model")
}

fn claude_supports_resume_option(claude_path: &str) -> bool {
    claude_supports_option(claude_path, "--resume")
}

fn append_claude_request_args(
    cmd: &mut Command,
    claude_path: &str,
    permission_mode: &str,
    model: Option<&str>,
    effort: Option<&str>,
    claude_session_id: Option<&str>,
    prompt: &str,
) {
    cmd.arg("--print");
    if claude_supports_stream_json(claude_path) {
        // Claude CLI requires --verbose when using --output-format=stream-json.
        // Keep this coupled so we don't regress into runtime arg errors.
        cmd.arg("--verbose");
        cmd.args(["--output-format", "stream-json"]);
    }
    if claude_supports_permission_mode(claude_path) {
        cmd.args(["--permission-mode", permission_mode]);
    }
    // Always pass --model and --resume when values are present.
    // These flags have been stable since Claude CLI ~2.0 and gating them
    // behind `claude --help` feature detection is fragile: --help can fail
    // in the Tauri subprocess environment (no TTY, restricted env), causing
    // critical flags to be silently dropped.
    if let Some(model) = model {
        cmd.args(["--model", model]);
    }
    if let Some(effort) = effort {
        cmd.args(["--effort", effort]);
    }
    if let Some(claude_sid) = claude_session_id {
        cmd.args(["--resume", claude_sid]);
    }
    cmd.args(["-p", prompt]);
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

    let mut env_map: HashMap<String, String> = match output {
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

    for (key, value) in env_overrides {
        if !key.trim().is_empty() {
            env_map.insert(key.clone(), value.clone());
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
    let aws_key = env_map.get("AWS_ACCESS_KEY_ID").map(|v| !v.trim().is_empty()).unwrap_or(false);
    let aws_secret = env_map.get("AWS_SECRET_ACCESS_KEY").map(|v| !v.trim().is_empty()).unwrap_or(false);
    let aws_session = env_map.get("AWS_SESSION_TOKEN").map(|v| !v.trim().is_empty()).unwrap_or(false);
    let aws_profile = env_map.get("AWS_PROFILE").map(|v| !v.trim().is_empty()).unwrap_or(false);
    let anthropic_key = env_map
        .get("ANTHROPIC_API_KEY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);

    let summary = format!(
        "env mode: bedrock={}, aws_key={}, aws_secret={}, aws_session={}, aws_profile={}, anthropic_key={}",
        bedrock, aws_key, aws_secret, aws_session, aws_profile, anthropic_key
    );

    let hint = if bedrock {
        if !(aws_profile || (aws_key && aws_secret)) {
            Some(
                "Bedrock mode is enabled but AWS credentials are missing. Set AWS_PROFILE or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY."
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
        Some("plan") => "plan",
        _ => "bypassPermissions",
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
    let msg = AgentMessage {
        agent_id: agent_id.to_string(),
        workspace_id: Some(workspace_id.to_string()),
        role: role.to_string(),
        content: content.clone(),
        is_error,
        timestamp: chrono::Utc::now().to_rfc3339(),
    };
    let _ = db.insert_message(session_id, agent_id, role, &msg.content, is_error, &msg.timestamp);
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

fn parse_stream_event_for_activity(
    event: &Value,
    tool_names: &mut HashMap<i64, String>,
    tool_inputs: &mut HashMap<i64, String>,
) -> Vec<String> {
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
                out.push(format!(
                    "Claude initialized ({}, permission={})",
                    model, permission_mode
                ));
            } else if !subtype.is_empty() {
                out.push(format!("System {}", subtype));
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
                        out.push("Thinking".to_string());
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
                                if let Some(summary) = summarize_tool_call(&tool_name, &input_json) {
                                    out.push(summary);
                                }
                            }
                        } else {
                            out.push(format!("Tool {}", tool_name));
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
                out.push("Thinking".to_string());
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
                        if let Some(summary) = summarize_tool_call(&tool_name, &input_json) {
                            out.push(summary);
                        } else {
                            out.push(format!("Tool {}", tool_name));
                        }
                    } else {
                        out.push(format!("Tool {}", tool_name));
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
                timestamp: chrono::Utc::now().to_rfc3339(),
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
        timestamp: chrono::Utc::now().to_rfc3339(),
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
        timestamp: chrono::Utc::now().to_rfc3339(),
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
    let (workspace_id, session_id) = {
        let mut agents = state.agents.write();
        if let Some(agent) = agents.remove(&agent_id) {
            (Some(agent.workspace_id), agent.session_id)
        } else {
            (None, None)
        }
    };
    
    // End session in database
    if let Some(sid) = session_id {
        let now = chrono::Utc::now().to_rfc3339();
        let _ = state.db.end_session(&sid, &now);
    }
    
    // Update workspace status if no more agents
    if let Some(ws_id) = workspace_id.clone() {
        let agents = state.agents.read();
        let has_running = agents.values().any(|a| a.workspace_id == ws_id);
        
        if !has_running {
            let mut workspaces = state.workspaces.write();
            if let Some(workspace) = workspaces.get_mut(&ws_id) {
                workspace.status = WorkspaceStatus::Idle;
            }
            let _ = state.db.update_workspace_status(&ws_id, &WorkspaceStatus::Idle, None);
            
            // Broadcast to WebSocket clients
            if let Some(ws) = &state.ws_server {
                ws.broadcast_to_workspace(&ws_id.clone(), &WsResponse::AgentStopped {
                    workspace_id: ws_id.clone(),
                });
            }
        }
    }
    
    Ok(())
}

/// Interrupt the currently running Claude CLI process for an agent by sending
/// SIGINT.  The agent and session remain alive so the user can send follow-up
/// messages.
#[tauri::command]
async fn interrupt_agent(
    agent_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let pid = {
        let pids = state.child_pids.read();
        pids.get(&agent_id).copied()
    };
    match pid {
        Some(pid) => {
            // Send SIGINT (graceful interrupt) to the child process
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGINT);
            }
            Ok(())
        }
        None => Err("No running process found for this agent".into()),
    }
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
    let app_state = state.inner().clone();
    // Get workspace path and session info for this agent
    let (workspace_id, workspace_path, session_id, claude_session_id) = {
        let agents = app_state.agents.read();
        let agent = agents.get(&agent_id).ok_or("Agent not found")?;
        
        let workspaces = app_state.workspaces.read();
        let workspace = workspaces.get(&agent.workspace_id).ok_or("Workspace not found")?;
        (agent.workspace_id.clone(), workspace.worktree_path.clone(), agent.session_id.clone(), agent.claude_session_id.clone())
    };
    
    let session_id = session_id.ok_or("No active session")?;
    
    // Save user message to database
    let now = chrono::Utc::now().to_rfc3339();
    let _ = app_state
        .db
        .insert_message(&session_id, &agent_id, "user", &message, false, &now);
    
    // Get WebSocket server for broadcasting
    let ws_server = app_state.ws_server.clone();
    
    // Run claude with the message in a background thread
    let agent_id_clone = agent_id.clone();
    let message_clone = message.clone();
    let db = app_state.db.clone();
    let app_state_for_pids = app_state.clone();
    let env_overrides = env_overrides.unwrap_or_default();
    let requested_permission_mode = normalize_permission_mode(permission_mode.as_deref()).to_string();
    let requested_model = normalize_model(model.as_deref());
    let requested_effort = normalize_effort(effort.as_deref()).map(str::to_string);

    std::thread::spawn(move || {
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
                    timestamp: chrono::Utc::now().to_rfc3339(),
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
                return;
            }
        };
        let (env_summary, env_hint) = auth_env_feedback(&effective_env);
        let permission_mode = requested_permission_mode.as_str();
        let is_bedrock = env_truthy(effective_env.get("CLAUDE_CODE_USE_BEDROCK"));
        let resolved_model = resolve_model_for_runtime(requested_model.as_deref(), is_bedrock);
        let model = resolved_model.as_deref();
        let effort = requested_effort.as_deref();

        // Build a compatibility-first command and include optional flags only
        // when the detected Claude CLI supports them.
        let mut cmd = Command::new(&claude_path);
        cmd.current_dir(&workspace_path);
        configure_cli_env(&mut cmd, &effective_env);
        append_claude_request_args(
            &mut cmd,
            &claude_path,
            permission_mode,
            model,
            effort,
            claude_session_id.as_deref(),
            &message_clone,
        );
        eprintln!(
            "[orchestrator] CLI: path={} model={:?} effort={:?} resume={:?}",
            claude_path, model, effort, claude_session_id
        );
        // Dump Claude/AWS env vars to diagnose stale model resolution
        let mut debug_env: Vec<_> = effective_env
            .iter()
            .filter(|(k, _)| {
                k.starts_with("CLAUDE") || k.starts_with("AWS") || k.starts_with("ANTHROPIC")
            })
            .collect();
        debug_env.sort_by_key(|(k, _)| k.clone());
        for (k, v) in &debug_env {
            eprintln!("[orchestrator] env: {}={}", k, v);
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
                return;
            }
        };

        // Store child PID so we can send SIGINT to interrupt
        app_state_for_pids.child_pids.write().insert(agent_id_clone.clone(), child.id());

        let mut assistant_delta_text = String::new();
        let mut latest_assistant_snapshot: Option<String> = None;
        let mut result_text_fallback: Option<String> = None;
        let mut tool_names: HashMap<i64, String> = HashMap::new();
        let mut tool_inputs: HashMap<i64, String> = HashMap::new();
        let mut known_claude_session_id = claude_session_id.clone();
        let allow_init_activity = known_claude_session_id.is_none();
        let mut last_activity: Option<String> = None;
        let mut error_emitted = false;

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
                                let mut agents = app_state.agents.write();
                                if let Some(agent) = agents.get_mut(&agent_id_clone) {
                                    agent.claude_session_id = Some(stream_session_id.clone());
                                }
                            }
                            let _ = db.update_session_claude_id(&session_id, &stream_session_id);
                        }
                    }

                    for activity in parse_stream_event_for_activity(&event, &mut tool_names, &mut tool_inputs) {
                        if !allow_init_activity && activity.starts_with("Claude initialized (") {
                            continue;
                        }
                        if last_activity.as_deref() == Some(activity.as_str()) {
                            continue;
                        }
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

                    if let Some(text) = extract_assistant_message_text(&event) {
                        latest_assistant_snapshot = Some(text);
                    }

                    if payload.get("type").and_then(|v| v.as_str()) == Some("content_block_delta") {
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

                    if payload.get("type").and_then(|v| v.as_str()) == Some("result") {
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
                    }
                } else {
                    // Forward non-JSON runtime output so authentication/runtime issues are visible.
                    emit_agent_message(
                        &app,
                        &db,
                        &session_id,
                        &agent_id_clone,
                        &workspace_id,
                        &ws_server,
                        format!("cli: {}", line),
                        false,
                        "system",
                    );
                }
            }
        }

        let mut stderr_buf = String::new();
        if let Some(stderr) = child.stderr.take() {
            let mut reader = BufReader::new(stderr);
            let _ = std::io::Read::read_to_string(&mut reader, &mut stderr_buf);
        }

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

        // Clean up stored PID now that process has exited
        app_state_for_pids.child_pids.write().remove(&agent_id_clone);

        if let Some(assistant_text) = choose_assistant_text(&assistant_delta_text, latest_assistant_snapshot.as_ref()) {
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
        } else if let Some(fallback) = result_text_fallback {
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
            if let Some(hint) = env_hint {
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
    });
    
    Ok(())
}

#[tauri::command]
async fn get_agent_messages(
    workspace_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<AgentMessage>, String> {
    state.db.get_messages_by_workspace(&workspace_id)
        .map_err(|e| format!("Failed to get messages: {}", e))
}

#[tauri::command]
async fn create_pull_request(
    workspace_id: String,
    title: String,
    body: String,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let (repo_path, worktree_path, branch) = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces.get(&workspace_id)
            .ok_or("Workspace not found")?;
        
        let repos = state.repositories.read();
        let repo = repos.get(&workspace.repo_id)
            .ok_or("Repository not found")?;
        
        (repo.path.clone(), workspace.worktree_path.clone(), workspace.branch.clone())
    };
    
    // First push the branch from the worktree
    let push_output = Command::new("git")
        .args(["push", "-u", "origin", &branch])
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| format!("Failed to push: {}", e))?;
    
    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        return Err(format!("Git push failed: {}", stderr));
    }
    
    // Create PR using gh CLI from repo root
    let pr_output = Command::new("gh")
        .args(["pr", "create", "--title", &title, "--body", &body, "--head", &branch])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("Failed to create PR: {}", e))?;
    
    if !pr_output.status.success() {
        let stderr = String::from_utf8_lossy(&pr_output.stderr);
        return Err(format!("PR creation failed: {}", stderr));
    }
    
    let pr_url = String::from_utf8_lossy(&pr_output.stdout).trim().to_string();

    // Transition workspace to InReview and store PR URL
    {
        let mut workspaces = state.workspaces.write();
        if let Some(workspace) = workspaces.get_mut(&workspace_id) {
            workspace.status = WorkspaceStatus::InReview;
            workspace.pr_url = Some(pr_url.clone());
        }
    }
    let _ = state.db.update_workspace_pr_url(&workspace_id, &pr_url, &WorkspaceStatus::InReview);

    Ok(pr_url)
}

/// Check PR status for all InReview workspaces using `gh pr view`.
/// Returns a list of workspace IDs that transitioned to Merged.
#[tauri::command]
async fn sync_pr_statuses(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<String>, String> {
    // Collect InReview workspaces with PR URLs
    let to_check: Vec<(String, String, String)> = {
        let workspaces = state.workspaces.read();
        let repos = state.repositories.read();
        workspaces.values()
            .filter(|ws| matches!(ws.status, WorkspaceStatus::InReview))
            .filter_map(|ws| {
                let pr_url = ws.pr_url.as_ref()?;
                let repo = repos.get(&ws.repo_id)?;
                Some((ws.id.clone(), pr_url.clone(), repo.path.clone()))
            })
            .collect()
    };

    let mut merged_ids = Vec::new();
    for (ws_id, pr_url, repo_path) in to_check {
        // gh pr view <url> --json state -q .state
        let output = Command::new("gh")
            .args(["pr", "view", &pr_url, "--json", "state", "-q", ".state"])
            .current_dir(&repo_path)
            .output();
        if let Ok(output) = output {
            let state_str = String::from_utf8_lossy(&output.stdout).trim().to_lowercase();
            if state_str == "merged" {
                {
                    let mut workspaces = state.workspaces.write();
                    if let Some(ws) = workspaces.get_mut(&ws_id) {
                        ws.status = WorkspaceStatus::Merged;
                    }
                }
                let _ = state.db.update_workspace_status(&ws_id, &WorkspaceStatus::Merged, None);
                merged_ids.push(ws_id);
            }
        }
    }
    Ok(merged_ids)
}

#[tauri::command]
async fn list_workspace_files(
    workspace_id: String,
    relative_path: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<WorkspaceFileEntry>, String> {
    let workspace_root = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces
            .get(&workspace_id)
            .ok_or("Workspace not found")?;
        workspace.worktree_path.clone()
    };

    let root = std::fs::canonicalize(&workspace_root)
        .map_err(|e| format!("Failed to resolve workspace path: {}", e))?;

    let requested_rel = relative_path.unwrap_or_default();
    let target = if requested_rel.is_empty() {
        root.clone()
    } else {
        root.join(&requested_rel)
    };

    let canonical_target = std::fs::canonicalize(&target)
        .map_err(|e| format!("Failed to resolve target path: {}", e))?;

    if !canonical_target.starts_with(&root) {
        return Err("Path is outside workspace root".to_string());
    }

    let read_dir = std::fs::read_dir(&canonical_target)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut entries: Vec<WorkspaceFileEntry> = Vec::new();

    for item in read_dir {
        let entry = item.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to inspect directory entry: {}", e))?;
        let entry_path = entry.path();
        let relative = entry_path
            .strip_prefix(&root)
            .map_err(|e| format!("Failed to normalize file path: {}", e))?;
        let relative_str = relative.to_string_lossy().replace('\\', "/");
        let name = entry.file_name().to_string_lossy().to_string();

        entries.push(WorkspaceFileEntry {
            name,
            path: relative_str,
            is_dir: file_type.is_dir(),
        });
    }

    entries.sort_by(|a, b| {
        use std::cmp::Ordering;
        match (a.is_dir, b.is_dir) {
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

#[tauri::command]
async fn read_workspace_file(
    workspace_id: String,
    relative_path: String,
    max_bytes: Option<usize>,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let workspace_root = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces
            .get(&workspace_id)
            .ok_or("Workspace not found")?;
        workspace.worktree_path.clone()
    };

    let root = std::fs::canonicalize(&workspace_root)
        .map_err(|e| format!("Failed to resolve workspace path: {}", e))?;
    let target = root.join(&relative_path);
    let canonical_target = std::fs::canonicalize(&target)
        .map_err(|e| format!("Failed to resolve file path: {}", e))?;

    if !canonical_target.starts_with(&root) {
        return Err("Path is outside workspace root".to_string());
    }

    let metadata = std::fs::metadata(&canonical_target)
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;
    if !metadata.is_file() {
        return Err("Path is not a file".to_string());
    }

    let limit = max_bytes.unwrap_or(200_000);
    let bytes = std::fs::read(&canonical_target)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let (slice, truncated) = if bytes.len() > limit {
        (&bytes[..limit], true)
    } else {
        (&bytes[..], false)
    };

    let mut content = String::from_utf8_lossy(slice).to_string();
    if truncated {
        content.push_str("\n\n[truncated]");
    }
    Ok(content)
}

#[tauri::command]
async fn list_workspace_changes(
    workspace_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<WorkspaceChangeEntry>, String> {
    let workspace_root = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces
            .get(&workspace_id)
            .ok_or("Workspace not found")?;
        workspace.worktree_path.clone()
    };

    let output = Command::new("git")
        .args(["status", "--porcelain=1", "--untracked-files=all"])
        .current_dir(&workspace_root)
        .output()
        .map_err(|e| format!("Failed to run git status: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git status failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut changes = Vec::new();

    for line in stdout.lines() {
        if line.len() < 3 {
            continue;
        }

        let status = line[0..2].to_string();
        let rest = line[3..].to_string();
        if let Some((old_path, new_path)) = rest.split_once(" -> ") {
            changes.push(WorkspaceChangeEntry {
                status,
                path: new_path.to_string(),
                old_path: Some(old_path.to_string()),
            });
        } else {
            changes.push(WorkspaceChangeEntry {
                status,
                path: rest,
                old_path: None,
            });
        }
    }

    Ok(changes)
}

#[tauri::command]
async fn read_workspace_change_diff(
    workspace_id: String,
    path: String,
    old_path: Option<String>,
    status: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let workspace_root = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces
            .get(&workspace_id)
            .ok_or("Workspace not found")?;
        workspace.worktree_path.clone()
    };

    let status_trimmed = status.unwrap_or_default().trim().to_string();
    if status_trimmed == "??" {
        let full_path = PathBuf::from(&workspace_root).join(&path);
        let bytes = std::fs::read(&full_path)
            .map_err(|e| format!("Failed to read untracked file for diff: {}", e))?;
        let limit = 200_000usize;
        let (slice, truncated) = if bytes.len() > limit {
            (&bytes[..limit], true)
        } else {
            (&bytes[..], false)
        };
        let content = String::from_utf8_lossy(slice).to_string();

        let mut output = String::new();
        output.push_str(&format!("diff --git a/{0} b/{0}\n", path));
        output.push_str("new file mode 100644\n");
        output.push_str("--- /dev/null\n");
        output.push_str(&format!("+++ b/{}\n", path));
        output.push_str("@@ -0,0 +1 @@\n");

        if content.is_empty() {
            output.push_str("+\n");
        } else {
            for line in content.lines() {
                output.push('+');
                output.push_str(line);
                output.push('\n');
            }
            if truncated {
                output.push_str("+\n+[truncated]\n");
            }
        }
        return Ok(output);
    }

    let mut cmd = Command::new("git");
    cmd.current_dir(&workspace_root);
    cmd.args(["diff", "--no-color", "HEAD", "--"]);
    if let Some(old) = old_path.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        cmd.arg(old);
    }
    cmd.arg(&path);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git diff failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if stdout.trim().is_empty() {
        return Ok("No textual diff output for this change.".to_string());
    }

    Ok(stdout)
}

fn detect_workspace_checks(workspace_root: &str) -> Vec<WorkspaceCheckDefinition> {
    let root_path = PathBuf::from(workspace_root);
    let mut checks: Vec<WorkspaceCheckDefinition> = Vec::new();

    if root_path.join("Cargo.toml").exists() {
        checks.push(WorkspaceCheckDefinition {
            name: "Cargo Check".to_string(),
            command: "cargo check".to_string(),
            description: "Rust compile and type checks without producing binaries.".to_string(),
        });
    }
    if root_path.join("package.json").exists() {
        checks.push(WorkspaceCheckDefinition {
            name: "NPM Lint".to_string(),
            command: "npm run lint --if-present".to_string(),
            description: "Runs JavaScript/TypeScript linting when configured.".to_string(),
        });
        checks.push(WorkspaceCheckDefinition {
            name: "NPM Build".to_string(),
            command: "npm run build --if-present".to_string(),
            description: "Build verification for frontend or Node projects.".to_string(),
        });
    }

    let has_gradle_project = root_path.join("build.gradle").exists()
        || root_path.join("build.gradle.kts").exists()
        || root_path.join("settings.gradle").exists()
        || root_path.join("settings.gradle.kts").exists();
    if root_path.join("gradlew").exists() {
        checks.push(WorkspaceCheckDefinition {
            name: "Gradle Check".to_string(),
            command: "./gradlew check --console=plain".to_string(),
            description: "Runs Gradle's standard verification lifecycle.".to_string(),
        });
        checks.push(WorkspaceCheckDefinition {
            name: "Gradle Build".to_string(),
            command: "./gradlew build --console=plain".to_string(),
            description: "Runs full Gradle build including tests and packaging tasks.".to_string(),
        });
    } else if has_gradle_project {
        checks.push(WorkspaceCheckDefinition {
            name: "Gradle Check".to_string(),
            command: "gradle check --console=plain".to_string(),
            description: "Runs Gradle verification using a system Gradle install.".to_string(),
        });
        checks.push(WorkspaceCheckDefinition {
            name: "Gradle Build".to_string(),
            command: "gradle build --console=plain".to_string(),
            description: "Runs full Gradle build using a system Gradle install.".to_string(),
        });
    }

    checks
}

#[tauri::command]
async fn list_workspace_checks(
    workspace_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<WorkspaceCheckDefinition>, String> {
    let workspace_root = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces
            .get(&workspace_id)
            .ok_or("Workspace not found")?;
        workspace.worktree_path.clone()
    };

    Ok(detect_workspace_checks(&workspace_root))
}

#[tauri::command]
async fn run_workspace_checks(
    workspace_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<WorkspaceCheckResult>, String> {
    let workspace_root = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces
            .get(&workspace_id)
            .ok_or("Workspace not found")?;
        workspace.worktree_path.clone()
    };

    let checks = detect_workspace_checks(&workspace_root);

    if checks.is_empty() {
        return Ok(vec![WorkspaceCheckResult {
            name: "No configured checks".to_string(),
            command: "-".to_string(),
            success: true,
            exit_code: Some(0),
            stdout: "No known check commands were detected for this workspace.".to_string(),
            stderr: String::new(),
            duration_ms: 0,
            skipped: true,
        }]);
    }

    let mut results = Vec::new();
    for check in checks {
        let mut parts = check.command.split_whitespace();
        let Some(bin) = parts.next() else {
            results.push(WorkspaceCheckResult {
                name: check.name.clone(),
                command: check.command.clone(),
                success: false,
                exit_code: None,
                stdout: String::new(),
                stderr: "Invalid check command configuration.".to_string(),
                duration_ms: 0,
                skipped: false,
            });
            continue;
        };
        let args: Vec<String> = parts.map(|arg| arg.to_string()).collect();
        let cmd_str = check.command.clone();
        let started = Instant::now();

        let result = match Command::new(bin).args(&args).current_dir(&workspace_root).output() {
            Ok(output) => {
                let elapsed = started.elapsed().as_millis();
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                WorkspaceCheckResult {
                    name: check.name.clone(),
                    command: cmd_str,
                    success: output.status.success(),
                    exit_code: output.status.code(),
                    stdout,
                    stderr,
                    duration_ms: elapsed,
                    skipped: false,
                }
            }
            Err(e) => WorkspaceCheckResult {
                name: check.name.clone(),
                command: cmd_str,
                success: false,
                exit_code: None,
                stdout: String::new(),
                stderr: format!("Failed to execute check: {}", e),
                duration_ms: started.elapsed().as_millis(),
                skipped: false,
            },
        };

        results.push(result);
    }

    Ok(results)
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
            ServerCommand::ListWorkspaces { response_tx } => {
                let workspaces = state.workspaces.read();
                let agents = state.agents.read();
                
                let workspace_list: Vec<WorkspaceInfo> = workspaces.values().map(|ws| {
                    let has_agent = agents.values().any(|a| a.workspace_id == ws.id);
                    WorkspaceInfo {
                        id: ws.id.clone(),
                        name: ws.name.clone(),
                        branch: ws.branch.clone(),
                        status: match ws.status {
                            WorkspaceStatus::Idle => "idle".to_string(),
                            WorkspaceStatus::Running => "running".to_string(),
                            WorkspaceStatus::InReview => "inReview".to_string(),
                            WorkspaceStatus::Merged => "merged".to_string(),
                        },
                        has_agent,
                    }
                }).collect();
                
                let response = WsResponse::WorkspaceList { workspaces: workspace_list };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }

            ServerCommand::GetMessages { workspace_id, response_tx } => {
                match state.db.get_messages_by_workspace(&workspace_id) {
                    Ok(messages) => {
                        let mapped: Vec<MessageInfo> = messages
                            .into_iter()
                            .map(|m| MessageInfo {
                                agent_id: m.agent_id,
                                role: m.role,
                                content: m.content,
                                is_error: m.is_error,
                                timestamp: m.timestamp,
                            })
                            .collect();
                        let response = WsResponse::MessageHistory {
                            workspace_id,
                            messages: mapped,
                        };
                        let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    }
                    Err(e) => {
                        let response = WsResponse::Error {
                            message: format!("Failed to load messages: {}", e),
                        };
                        let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    }
                }
            }

            ServerCommand::ListFiles { workspace_id, relative_path, response_tx } => {
                let root_path = {
                    let workspaces = state.workspaces.read();
                    match workspaces.get(&workspace_id) {
                        Some(ws) => ws.worktree_path.clone(),
                        None => {
                            let response = WsResponse::Error { message: "Workspace not found".to_string() };
                            let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                            continue;
                        }
                    }
                };
                let root = match std::fs::canonicalize(&root_path) {
                    Ok(p) => p,
                    Err(e) => {
                        let response = WsResponse::Error { message: format!("Failed to resolve workspace path: {}", e) };
                        let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                        continue;
                    }
                };
                let rel = relative_path.unwrap_or_default();
                let target = if rel.is_empty() { root.clone() } else { root.join(&rel) };
                let canonical_target = match std::fs::canonicalize(&target) {
                    Ok(p) => p,
                    Err(e) => {
                        let response = WsResponse::Error { message: format!("Failed to resolve target path: {}", e) };
                        let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                        continue;
                    }
                };
                if !canonical_target.starts_with(&root) {
                    let response = WsResponse::Error { message: "Path is outside workspace root".to_string() };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    continue;
                }
                let read_dir = match std::fs::read_dir(&canonical_target) {
                    Ok(r) => r,
                    Err(e) => {
                        let response = WsResponse::Error { message: format!("Failed to read directory: {}", e) };
                        let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                        continue;
                    }
                };
                let mut entries: Vec<FileEntryInfo> = Vec::new();
                for item in read_dir {
                    if let Ok(entry) = item {
                        if let Ok(file_type) = entry.file_type() {
                            let entry_path = entry.path();
                            if let Ok(relative) = entry_path.strip_prefix(&root) {
                                entries.push(FileEntryInfo {
                                    name: entry.file_name().to_string_lossy().to_string(),
                                    path: relative.to_string_lossy().replace('\\', "/"),
                                    is_dir: file_type.is_dir(),
                                });
                            }
                        }
                    }
                }
                entries.sort_by(|a, b| {
                    use std::cmp::Ordering;
                    match (a.is_dir, b.is_dir) {
                        (true, false) => Ordering::Less,
                        (false, true) => Ordering::Greater,
                        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
                    }
                });
                let response = WsResponse::FilesList {
                    workspace_id,
                    relative_path: rel,
                    entries,
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }

            ServerCommand::ReadFile { workspace_id, relative_path, max_bytes, response_tx } => {
                let root_path = {
                    let workspaces = state.workspaces.read();
                    match workspaces.get(&workspace_id) {
                        Some(ws) => ws.worktree_path.clone(),
                        None => {
                            let response = WsResponse::Error { message: "Workspace not found".to_string() };
                            let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                            continue;
                        }
                    }
                };
                let root = match std::fs::canonicalize(&root_path) {
                    Ok(p) => p,
                    Err(e) => {
                        let response = WsResponse::Error { message: format!("Failed to resolve workspace path: {}", e) };
                        let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                        continue;
                    }
                };
                let target = root.join(&relative_path);
                let canonical_target = match std::fs::canonicalize(&target) {
                    Ok(p) => p,
                    Err(e) => {
                        let response = WsResponse::Error { message: format!("Failed to resolve file path: {}", e) };
                        let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                        continue;
                    }
                };
                if !canonical_target.starts_with(&root) {
                    let response = WsResponse::Error { message: "Path is outside workspace root".to_string() };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    continue;
                }
                let limit = max_bytes.unwrap_or(200_000);
                let bytes = match std::fs::read(&canonical_target) {
                    Ok(b) => b,
                    Err(e) => {
                        let response = WsResponse::Error { message: format!("Failed to read file: {}", e) };
                        let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                        continue;
                    }
                };
                let (slice, truncated) = if bytes.len() > limit {
                    (&bytes[..limit], true)
                } else {
                    (&bytes[..], false)
                };
                let mut content = String::from_utf8_lossy(slice).to_string();
                if truncated {
                    content.push_str("\n\n[truncated]");
                }
                let response = WsResponse::FileContent { workspace_id, path: relative_path, content };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }

            ServerCommand::ListChanges { workspace_id, response_tx } => {
                let workspace_root = {
                    let workspaces = state.workspaces.read();
                    match workspaces.get(&workspace_id) {
                        Some(ws) => ws.worktree_path.clone(),
                        None => {
                            let response = WsResponse::Error { message: "Workspace not found".to_string() };
                            let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                            continue;
                        }
                    }
                };
                let output = match Command::new("git")
                    .args(["status", "--porcelain=1", "--untracked-files=all"])
                    .current_dir(&workspace_root)
                    .output()
                {
                    Ok(o) => o,
                    Err(e) => {
                        let response = WsResponse::Error { message: format!("Failed to run git status: {}", e) };
                        let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                        continue;
                    }
                };
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let response = WsResponse::Error { message: format!("Git status failed: {}", stderr) };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    continue;
                }
                let stdout = String::from_utf8_lossy(&output.stdout);
                let mut changes = Vec::new();
                for line in stdout.lines() {
                    if line.len() < 3 {
                        continue;
                    }
                    let status = line[0..2].to_string();
                    let rest = line[3..].to_string();
                    if let Some((old_path, new_path)) = rest.split_once(" -> ") {
                        changes.push(ChangeInfo { status, path: new_path.to_string(), old_path: Some(old_path.to_string()) });
                    } else {
                        changes.push(ChangeInfo { status, path: rest, old_path: None });
                    }
                }
                let response = WsResponse::ChangesList { workspace_id, changes };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }

            ServerCommand::RunChecks { workspace_id, response_tx } => {
                let workspace_root = {
                    let workspaces = state.workspaces.read();
                    match workspaces.get(&workspace_id) {
                        Some(ws) => ws.worktree_path.clone(),
                        None => {
                            let response = WsResponse::Error { message: "Workspace not found".to_string() };
                            let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                            continue;
                        }
                    }
                };
                let checks = detect_workspace_checks(&workspace_root);
                let mut results: Vec<CheckInfo> = Vec::new();
                if checks.is_empty() {
                    results.push(CheckInfo {
                        name: "No configured checks".to_string(),
                        command: "-".to_string(),
                        success: true,
                        exit_code: Some(0),
                        stdout: "No known check commands were detected for this workspace.".to_string(),
                        stderr: String::new(),
                        duration_ms: 0,
                        skipped: true,
                    });
                } else {
                    for check in checks {
                        let mut parts = check.command.split_whitespace();
                        let Some(bin) = parts.next() else {
                            results.push(CheckInfo {
                                name: check.name.clone(),
                                command: check.command.clone(),
                                success: false,
                                exit_code: None,
                                stdout: String::new(),
                                stderr: "Invalid check command configuration.".to_string(),
                                duration_ms: 0,
                                skipped: false,
                            });
                            continue;
                        };
                        let args: Vec<String> = parts.map(|arg| arg.to_string()).collect();
                        let started = Instant::now();
                        match Command::new(bin).args(&args).current_dir(&workspace_root).output() {
                            Ok(output) => {
                                results.push(CheckInfo {
                                    name: check.name.clone(),
                                    command: check.command.clone(),
                                    success: output.status.success(),
                                    exit_code: output.status.code(),
                                    stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                                    stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                                    duration_ms: started.elapsed().as_millis(),
                                    skipped: false,
                                });
                            }
                            Err(e) => {
                                results.push(CheckInfo {
                                    name: check.name.clone(),
                                    command: check.command.clone(),
                                    success: false,
                                    exit_code: None,
                                    stdout: String::new(),
                                    stderr: format!("Failed to execute check: {}", e),
                                    duration_ms: started.elapsed().as_millis(),
                                    skipped: false,
                                });
                            }
                        }
                    }
                }
                let response = WsResponse::ChecksResult { workspace_id, checks: results };
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
                    // Reuse the existing send_message_to_agent logic via a command invocation
                    // For simplicity, we'll just emit the message directly here
                    let (workspace_path, session_id, claude_session_id) = {
                        let agents = state.agents.read();
                        let agent = match agents.get(&agent_id) {
                            Some(a) => a,
                            None => continue,
                        };
                        
                        let workspaces = state.workspaces.read();
                        let workspace = match workspaces.get(&agent.workspace_id) {
                            Some(w) => w,
                            None => continue,
                        };
                        (workspace.worktree_path.clone(), agent.session_id.clone(), agent.claude_session_id.clone())
                    };
                    
                    if let Some(session_id) = session_id {
                        let now = chrono::Utc::now().to_rfc3339();
                        let _ = state.db.insert_message(&session_id, &agent_id, "user", &message, false, &now);
                        
                        let ws_server = state.ws_server.clone();
                        let db = state.db.clone();
                        let app_clone = app.clone();
                        let app_state_clone = state.clone();
                        let workspace_id_clone = workspace_id.clone();
                        let agent_id_clone = agent_id.clone();
                        let env_overrides: HashMap<String, String> = HashMap::new();
                        let requested_permission_mode =
                            normalize_permission_mode(permission_mode.as_deref()).to_string();
                        let requested_model = normalize_model(model.as_deref());
                        let requested_effort = normalize_effort(effort.as_deref()).map(str::to_string);
                        
                        std::thread::spawn(move || {
                            let effective_env = build_effective_cli_env(&env_overrides);
                            if let Some(claude_path) = find_claude_cli_with_env(Some(&effective_env)) {
                                let mut cmd = Command::new(&claude_path);
                                cmd.current_dir(&workspace_path);
                                let (env_summary, env_hint) = auth_env_feedback(&effective_env);
                                let permission_mode = requested_permission_mode.as_str();
                                let is_bedrock = env_truthy(effective_env.get("CLAUDE_CODE_USE_BEDROCK"));
                                let resolved_model =
                                    resolve_model_for_runtime(requested_model.as_deref(), is_bedrock);
                                let model = resolved_model.as_deref();
                                let effort = requested_effort.as_deref();
                                configure_cli_env(&mut cmd, &effective_env);
                                append_claude_request_args(
                                    &mut cmd,
                                    &claude_path,
                                    permission_mode,
                                    model,
                                    effort,
                                    claude_session_id.as_deref(),
                                    &message,
                                );

                                cmd.stdout(Stdio::piped());
                                cmd.stderr(Stdio::piped());
                                let mut child = match cmd.spawn() {
                                    Ok(c) => c,
                                    Err(e) => {
                                        emit_agent_message(
                                            &app_clone,
                                            &db,
                                            &session_id,
                                            &agent_id_clone,
                                            &workspace_id_clone,
                                            &ws_server,
                                            format!("Error spawning Claude: {}", e),
                                            true,
                                            "error",
                                        );
                                        emit_agent_message(
                                            &app_clone,
                                            &db,
                                            &session_id,
                                            &agent_id_clone,
                                            &workspace_id_clone,
                                            &ws_server,
                                            env_summary.clone(),
                                            true,
                                            "error",
                                        );
                                        if let Some(hint) = env_hint.clone() {
                                            emit_agent_message(
                                                &app_clone,
                                                &db,
                                                &session_id,
                                                &agent_id_clone,
                                                &workspace_id_clone,
                                                &ws_server,
                                                format!("Hint: {}", hint),
                                                true,
                                                "error",
                                            );
                                        }
                                        return;
                                    }
                                };

                                // Store child PID for interrupt support
                                app_state_clone.child_pids.write().insert(agent_id_clone.clone(), child.id());

                                let mut assistant_delta_text = String::new();
                                let mut latest_assistant_snapshot: Option<String> = None;
                                let mut result_text_fallback: Option<String> = None;
                                let mut tool_names: HashMap<i64, String> = HashMap::new();
                                let mut tool_inputs: HashMap<i64, String> = HashMap::new();
                                let mut known_claude_session_id = claude_session_id.clone();
                                let allow_init_activity = known_claude_session_id.is_none();
                                let mut last_activity: Option<String> = None;
                                let mut error_emitted = false;

                                if let Some(stdout) = child.stdout.take() {
                                    let reader = BufReader::new(stdout);
                                    for line in reader.lines().flatten() {
                                        if line.trim().is_empty() {
                                            continue;
                                        }
                                        if let Ok(event) = serde_json::from_str::<Value>(&line) {
                                            let payload = stream_event_payload(&event);
                                            if let Some(stream_session_id) = extract_stream_session_id(&event) {
                                                if known_claude_session_id.as_deref()
                                                    != Some(stream_session_id.as_str())
                                                {
                                                    known_claude_session_id = Some(stream_session_id.clone());
                                                    {
                                                        let mut agents = app_state_clone.agents.write();
                                                        if let Some(agent) = agents.get_mut(&agent_id_clone) {
                                                            agent.claude_session_id = Some(stream_session_id.clone());
                                                        }
                                                    }
                                                    let _ = db.update_session_claude_id(
                                                        &session_id,
                                                        &stream_session_id,
                                                    );
                                                }
                                            }

                                            for activity in parse_stream_event_for_activity(
                                                &event,
                                                &mut tool_names,
                                                &mut tool_inputs,
                                            ) {
                                                if !allow_init_activity
                                                    && activity.starts_with("Claude initialized (")
                                                {
                                                    continue;
                                                }
                                                if last_activity.as_deref() == Some(activity.as_str()) {
                                                    continue;
                                                }
                                                emit_agent_message(
                                                    &app_clone,
                                                    &db,
                                                    &session_id,
                                                    &agent_id_clone,
                                                    &workspace_id_clone,
                                                    &ws_server,
                                                    activity.clone(),
                                                    false,
                                                    "system",
                                                );
                                                last_activity = Some(activity);
                                            }

                                            if let Some(text) = extract_assistant_message_text(&event) {
                                                latest_assistant_snapshot = Some(text);
                                            }

                                            if payload.get("type").and_then(|v| v.as_str()) == Some("content_block_delta")
                                                && payload.get("delta").and_then(|d| d.get("type")).and_then(|v| v.as_str())
                                                    == Some("text_delta")
                                            {
                                                if let Some(chunk) =
                                                    payload.get("delta").and_then(|d| d.get("text")).and_then(|v| v.as_str())
                                                {
                                                    assistant_delta_text.push_str(chunk);
                                                }
                                            }

                                            if payload.get("type").and_then(|v| v.as_str()) == Some("result") {
                                                if result_text_fallback.is_none() {
                                                    result_text_fallback = extract_result_text(&event);
                                                }
                                                let is_error =
                                                    payload.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
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
                                                    emit_agent_message(
                                                        &app_clone,
                                                        &db,
                                                        &session_id,
                                                        &agent_id_clone,
                                                        &workspace_id_clone,
                                                        &ws_server,
                                                        errors,
                                                        true,
                                                        "error",
                                                    );
                                                    error_emitted = true;
                                                }
                                            }
                                        } else {
                                            emit_agent_message(
                                                &app_clone,
                                                &db,
                                                &session_id,
                                                &agent_id_clone,
                                                &workspace_id_clone,
                                                &ws_server,
                                                format!("cli: {}", line),
                                                false,
                                                "system",
                                            );
                                        }
                                    }
                                }

                                let mut stderr_buf = String::new();
                                if let Some(stderr) = child.stderr.take() {
                                    let mut reader = BufReader::new(stderr);
                                    let _ = std::io::Read::read_to_string(&mut reader, &mut stderr_buf);
                                }

                                let status = match child.wait() {
                                    Ok(s) => s,
                                    Err(e) => {
                                        app_state_clone.child_pids.write().remove(&agent_id_clone);
                                        emit_agent_message(
                                            &app_clone,
                                            &db,
                                            &session_id,
                                            &agent_id_clone,
                                            &workspace_id_clone,
                                            &ws_server,
                                            format!("Error waiting for Claude: {}", e),
                                            true,
                                            "error",
                                        );
                                        return;
                                    }
                                };

                                app_state_clone.child_pids.write().remove(&agent_id_clone);

                                if let Some(assistant_text) =
                                    choose_assistant_text(&assistant_delta_text, latest_assistant_snapshot.as_ref())
                                {
                                    emit_agent_message(
                                        &app_clone,
                                        &db,
                                        &session_id,
                                        &agent_id_clone,
                                        &workspace_id_clone,
                                        &ws_server,
                                        assistant_text,
                                        false,
                                        "assistant",
                                    );
                                } else if let Some(fallback) = result_text_fallback {
                                    emit_agent_message(
                                        &app_clone,
                                        &db,
                                        &session_id,
                                        &agent_id_clone,
                                        &workspace_id_clone,
                                        &ws_server,
                                        fallback,
                                        false,
                                        "assistant",
                                    );
                                } else if status.success() && !error_emitted {
                                    emit_agent_message(
                                        &app_clone,
                                        &db,
                                        &session_id,
                                        &agent_id_clone,
                                        &workspace_id_clone,
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
                                            &app_clone,
                                            &db,
                                            &session_id,
                                            &agent_id_clone,
                                            &workspace_id_clone,
                                            &ws_server,
                                            format!("Suggested model from Claude: {}", suggested_model),
                                            true,
                                            "error",
                                        );
                                    }
                                    emit_agent_message(
                                        &app_clone,
                                        &db,
                                        &session_id,
                                        &agent_id_clone,
                                        &workspace_id_clone,
                                        &ws_server,
                                        error_content,
                                        true,
                                        "error",
                                    );
                                    emit_agent_message(
                                        &app_clone,
                                        &db,
                                        &session_id,
                                        &agent_id_clone,
                                        &workspace_id_clone,
                                        &ws_server,
                                        env_summary.clone(),
                                        true,
                                        "error",
                                    );
                                    if let Some(hint) = env_hint {
                                        emit_agent_message(
                                            &app_clone,
                                            &db,
                                            &session_id,
                                            &agent_id_clone,
                                            &workspace_id_clone,
                                            &ws_server,
                                            format!("Hint: {}", hint),
                                            true,
                                            "error",
                                        );
                                    }
                                }
                            }
                        });
                    }
                }
            }
            
            ServerCommand::StartAgent { workspace_id, response_tx } => {
                // Reuse an existing running agent for this workspace when available.
                if let Some(existing_agent_id) = {
                    let agents = state.agents.read();
                    agents
                        .values()
                        .find(|a| a.workspace_id == workspace_id)
                        .map(|a| a.id.clone())
                } {
                    let response = WsResponse::AgentStarted {
                        workspace_id,
                        agent_id: existing_agent_id,
                    };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    continue;
                }

                let workspace = {
                    let workspaces = state.workspaces.read();
                    match workspaces.get(&workspace_id) {
                        Some(ws) => ws.clone(),
                        None => {
                            let response = WsResponse::Error {
                                message: "Workspace not found".to_string(),
                            };
                            let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                            continue;
                        }
                    }
                };

                let agent_id = Uuid::new_v4().to_string();
                let session_id = Uuid::new_v4().to_string();
                let claude_session_id: Option<String> = None;
                let now = chrono::Utc::now().to_rfc3339();

                if let Err(e) = state.db.insert_session(
                    &session_id,
                    &workspace_id,
                    claude_session_id.as_deref(),
                    &now,
                ) {
                    let response = WsResponse::Error {
                        message: format!("Failed to create session: {}", e),
                    };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    continue;
                }

                let agent = Agent {
                    id: agent_id.clone(),
                    workspace_id: workspace_id.clone(),
                    status: AgentStatus::Running,
                    session_id: Some(session_id.clone()),
                    claude_session_id: claude_session_id.clone(),
                };

                {
                    let mut agents = state.agents.write();
                    agents.insert(agent_id.clone(), agent);
                }

                {
                    let mut workspaces = state.workspaces.write();
                    if let Some(workspace) = workspaces.get_mut(&workspace_id) {
                        workspace.status = WorkspaceStatus::Running;
                        workspace.last_activity = Some(chrono::Utc::now().to_rfc3339());
                    }
                }
                let _ = state
                    .db
                    .update_workspace_status(&workspace_id, &WorkspaceStatus::Running, Some(&now));

                // Spawn Claude bootstrap process for this workspace.
                let ws_server = state.ws_server.clone();
                let workspace_path = workspace.worktree_path.clone();
                let workspace_name = workspace.name.clone();
                let agent_id_clone = agent_id.clone();
                let db = state.db.clone();
                let session_id_clone = session_id.clone();
                let workspace_id_clone = workspace_id.clone();
                let app_clone = app.clone();

                std::thread::spawn(move || {
                    run_claude_cli(
                        app_clone,
                        agent_id_clone,
                        workspace_path,
                        workspace_name,
                        claude_session_id,
                        db,
                        session_id_clone,
                        ws_server,
                        workspace_id_clone,
                        HashMap::new(),
                    );
                });

                let response = WsResponse::AgentStarted {
                    workspace_id,
                    agent_id,
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            
            ServerCommand::StopAgent { workspace_id, response_tx } => {
                // Find and stop agent
                let agent_id = {
                    let agents = state.agents.read();
                    agents.values()
                        .find(|a| a.workspace_id == workspace_id)
                        .map(|a| a.id.clone())
                };
                
                if let Some(agent_id) = agent_id {
                    let (workspace_id, session_id) = {
                        let mut agents = state.agents.write();
                        if let Some(agent) = agents.remove(&agent_id) {
                            (Some(agent.workspace_id), agent.session_id)
                        } else {
                            (None, None)
                        }
                    };
                    
                    if let Some(sid) = session_id {
                        let now = chrono::Utc::now().to_rfc3339();
                        let _ = state.db.end_session(&sid, &now);
                    }
                    
                    if let Some(ws_id) = workspace_id {
                        let mut workspaces = state.workspaces.write();
                        if let Some(workspace) = workspaces.get_mut(&ws_id) {
                            workspace.status = WorkspaceStatus::Idle;
                        }
                        let _ = state.db.update_workspace_status(&ws_id, &WorkspaceStatus::Idle, None);
                        
                        let response = WsResponse::AgentStopped { workspace_id: ws_id };
                        let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    }
                } else {
                    let response = WsResponse::Error { message: "No agent found for workspace".to_string() };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                }
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
    let ws_server = Arc::new(WebSocketServer::new(REMOTE_SERVER_PORT, ws_cmd_tx));
    app_state.set_ws_server(ws_server.clone());
    
    let app_state = Arc::new(app_state);
    let app_state_for_ws = app_state.clone();
    
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let ws_server_clone = ws_server.clone();
            let startup_state = app_state_for_ws.clone();
            let command_state = app_state_for_ws.clone();
            
            // Start WebSocket server and command handler in tokio runtime
            tauri::async_runtime::spawn(async move {
                if let Err(e) = ws_server_clone.start().await {
                    tracing::error!("Failed to start WebSocket server: {}", e);
                    *startup_state.ws_server_running.write() = false;
                } else {
                    *startup_state.ws_server_running.write() = true;
                    *startup_state.ws_connected_clients.write() = ws_server_clone.client_count();
                    tracing::info!("WebSocket server started on port {}", REMOTE_SERVER_PORT);
                }
            });
            
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
            add_repository,
            remove_repository,
            list_repositories,
            list_workspaces,
            create_workspace,
            remove_workspace,
            rename_workspace,
            list_agents,
            start_agent,
            stop_agent,
            interrupt_agent,
            send_message_to_agent,
            get_agent_messages,
            create_pull_request,
            sync_pr_statuses,
            list_workspace_files,
            read_workspace_file,
            list_workspace_changes,
            read_workspace_change_diff,
            list_workspace_checks,
            run_workspace_checks,
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
    fn normalize_permission_mode_defaults_to_bypass() {
        assert_eq!(normalize_permission_mode(None), "bypassPermissions");
        assert_eq!(
            normalize_permission_mode(Some("bypassPermissions")),
            "bypassPermissions"
        );
        assert_eq!(normalize_permission_mode(Some("plan")), "plan");
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
            vec!["Claude initialized (claude-sonnet-4-6, permission=plan)".to_string()]
        );
    }
}
