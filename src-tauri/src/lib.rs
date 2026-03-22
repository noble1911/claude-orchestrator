use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::net::{IpAddr, UdpSocket};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::mpsc;
use uuid::Uuid;

mod database;
mod http_server;
pub mod types;
mod websocket_server;

use database::Database;
use http_server::HttpServer;
pub use types::*;
use websocket_server::{
    ChangeInfo, CheckInfo, FileEntryInfo, MessageInfo, RepositoryInfo, ServerCommand, WebSocketServer,
    WorkspaceInfo, WsResponse,
};

static CLAUDE_HELP_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
const REMOTE_SERVER_PORT: u16 = 3001;
const HTTP_SERVER_PORT: u16 = 3002;

/// Maximum number of bytes to read from a workspace file.
const MAX_FILE_READ_BYTES: usize = 200_000;

/// Error message returned when a workspace ID is not found in state.
const ERR_WORKSPACE_NOT_FOUND: &str = "Workspace not found";

/// Generate a new RFC 3339 timestamp string for the current instant.
fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Generate a new random UUID string.
fn new_id() -> String {
    Uuid::new_v4().to_string()
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
    http_server: Option<Arc<HttpServer>>,
    ws_server_running: RwLock<bool>,
    ws_connected_clients: RwLock<usize>,
    pairing_code: Arc<RwLock<Option<String>>>,
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
            http_server: None,
            ws_server_running: RwLock::new(false),
            ws_connected_clients: RwLock::new(0),
            pairing_code: Arc::new(RwLock::new(None)),
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

    fn set_http_server(&mut self, server: Arc<HttpServer>) {
        self.http_server = Some(server);
    }
}

fn workspace_status_to_ws(status: &WorkspaceStatus) -> String {
    match status {
        WorkspaceStatus::Idle => "idle".to_string(),
        WorkspaceStatus::Running => "running".to_string(),
        WorkspaceStatus::InReview => "inReview".to_string(),
        WorkspaceStatus::Merged => "merged".to_string(),
        WorkspaceStatus::Initializing => "initializing".to_string(),
    }
}

fn status_for_agent_start(current: &WorkspaceStatus) -> WorkspaceStatus {
    if matches!(current, WorkspaceStatus::InReview | WorkspaceStatus::Merged) {
        current.clone()
    } else {
        WorkspaceStatus::Running
    }
}

fn status_for_agent_stop(current: &WorkspaceStatus) -> WorkspaceStatus {
    if matches!(current, WorkspaceStatus::InReview | WorkspaceStatus::Merged) {
        current.clone()
    } else {
        WorkspaceStatus::Idle
    }
}

fn to_workspace_info(workspace: &Workspace, has_agent: bool) -> WorkspaceInfo {
    WorkspaceInfo {
        id: workspace.id.clone(),
        repo_id: workspace.repo_id.clone(),
        name: workspace.name.clone(),
        branch: workspace.branch.clone(),
        status: workspace_status_to_ws(&workspace.status),
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

/// Check if a git repository has an operation in progress that would prevent commits.
/// Returns "clean" if safe, or "busy:<reason>" if an operation is in progress.
/// Pattern from Conductor's git-busy-check.sh
fn git_busy_check(repo_path: &str) -> String {
    let git_dir = {
        let output = Command::new("git")
            .args(["rev-parse", "--git-dir"])
            .current_dir(repo_path)
            .output();
        match output {
            Ok(o) if o.status.success() => {
                let dir = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if dir.starts_with('/') {
                    PathBuf::from(dir)
                } else {
                    PathBuf::from(repo_path).join(dir)
                }
            }
            _ => return "error:not_a_git_repo".to_string(),
        }
    };

    // Check for rebase (directory-based, more reliable than REBASE_HEAD)
    if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        return "busy:rebase".to_string();
    }

    // Check for merge
    if git_dir.join("MERGE_HEAD").exists() {
        return "busy:merge".to_string();
    }

    // Check for cherry-pick
    if git_dir.join("CHERRY_PICK_HEAD").exists() {
        return "busy:cherry-pick".to_string();
    }

    // Check for revert
    if git_dir.join("REVERT_HEAD").exists() {
        return "busy:revert".to_string();
    }

    "clean".to_string()
}

/// Read conductor.json or orchestrator.json configuration from a repository or workspace path
/// Checks conductor.json first, then orchestrator.json as fallback
fn read_orchestrator_config(path: &str) -> OrchestratorConfig {
    let base = PathBuf::from(path);

    // Check conductor.json first (Conductor compatibility)
    for filename in ["conductor.json", "orchestrator.json"] {
        let config_path = base.join(filename);
        if config_path.exists() {
            if let Ok(contents) = std::fs::read_to_string(&config_path) {
                if let Ok(config) = serde_json::from_str::<OrchestratorConfig>(&contents) {
                    return config;
                }
            }
        }
    }
    OrchestratorConfig::default()
}

/// Run a script in a workspace with environment variables set
fn run_script_in_workspace(
    workspace_path: &str,
    workspace_name: &str,
    script: &str,
) -> Result<(String, String, i32), String> {
    let output = Command::new("sh")
        .args(["-c", script])
        .current_dir(workspace_path)
        .env("ORCHESTRATOR_WORKSPACE_NAME", workspace_name)
        .env("ORCHESTRATOR_WORKSPACE_PATH", workspace_path)
        .output()
        .map_err(|e| format!("Failed to run script: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code().unwrap_or(-1);

    Ok((stdout, stderr, exit_code))
}

fn create_worktree(repo_path: &str, worktree_path: &str, branch: &str, default_branch: &str) -> Result<(), String> {
    // Fetch latest from origin so the worktree starts from the remote HEAD
    // rather than the (potentially stale) local main branch.
    let fetch = Command::new("git")
        .args(["fetch", "origin", default_branch])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to fetch origin: {}", e))?;
    if !fetch.status.success() {
        let stderr = String::from_utf8_lossy(&fetch.stderr);
        return Err(format!("Git fetch failed: {}", stderr));
    }

    let start_point = format!("origin/{}", default_branch);
    let output = Command::new("git")
        .args(["worktree", "add", "-b", branch, worktree_path, &start_point])
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
async fn start_remote_server(state: State<'_, Arc<AppState>>) -> Result<ServerStatus, String> {
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

    // Start HTTP server for web client
    if let Some(http) = &state.http_server {
        if let Err(e) = http.start().await {
            tracing::warn!("Failed to start HTTP server: {}", e);
        }
    }

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
    *state.pairing_code.write() = None;

    // Stop HTTP server
    if let Some(http) = &state.http_server {
        http.stop();
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
        id: new_id(),
        path,
        name,
        default_branch,
        added_at: now_rfc3339(),
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

/// Check if a repository has a git operation in progress (Conductor pattern)
#[tauri::command]
async fn check_git_busy(
    repo_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let repo = {
        let repos = state.repositories.read();
        repos.get(&repo_id).cloned()
            .ok_or("Repository not found")?
    };
    Ok(git_busy_check(&repo.path))
}

/// Get orchestrator.json configuration for a repository
#[tauri::command]
async fn get_orchestrator_config(
    repo_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<OrchestratorConfig, String> {
    let repo = {
        let repos = state.repositories.read();
        repos.get(&repo_id).cloned()
            .ok_or("Repository not found")?
    };
    Ok(read_orchestrator_config(&repo.path))
}

/// Get orchestrator.json configuration for a workspace
#[tauri::command]
async fn get_workspace_config(
    workspace_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<OrchestratorConfig, String> {
    let workspace = {
        let workspaces = state.workspaces.read();
        workspaces.get(&workspace_id).cloned()
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?
    };
    // First check workspace path, then fall back to repo path
    let config = read_orchestrator_config(&workspace.worktree_path);
    if config.setup_script.is_some() || config.run_script.is_some() || !config.checks.is_empty() {
        return Ok(config);
    }
    // Fall back to repo config
    let repo = {
        let repos = state.repositories.read();
        repos.get(&workspace.repo_id).cloned()
            .ok_or("Repository not found")?
    };
    Ok(read_orchestrator_config(&repo.path))
}

/// Run a script from orchestrator.json in a workspace
#[tauri::command]
async fn run_orchestrator_script(
    workspace_id: String,
    script_type: String, // "setup", "run", or "archive"
    state: State<'_, Arc<AppState>>,
) -> Result<(String, String, i32), String> {
    let workspace = {
        let workspaces = state.workspaces.read();
        workspaces.get(&workspace_id).cloned()
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?
    };

    let config = read_orchestrator_config(&workspace.worktree_path);
    let script = match script_type.as_str() {
        "setup" => config.setup_script,
        "run" => config.run_script,
        "archive" => config.archive_script,
        _ => return Err(format!("Unknown script type: {}", script_type)),
    };

    let script = script.ok_or(format!("No {} script configured", script_type))?;
    run_script_in_workspace(&workspace.worktree_path, &workspace.name, &script)
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
    
    create_worktree(&repo.path, &worktree_path_str, &branch, &repo.default_branch)?;

    let workspace = Workspace {
        id: new_id(),
        repo_id,
        name,
        branch,
        worktree_path: worktree_path_str,
        status: WorkspaceStatus::Idle,
        last_activity: None,
        pr_url: None,
        unread: 0,
        display_order: 0,
        pinned_at: None,
        notes: None,
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
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        
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
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
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
async fn update_workspace_unread(
    workspace_id: String,
    unread: i32,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    {
        let mut workspaces = state.workspaces.write();
        let workspace = workspaces.get_mut(&workspace_id).ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        workspace.unread = unread;
    }
    state.db.update_workspace_unread(&workspace_id, unread)
        .map_err(|e| format!("Failed to update unread: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn update_workspace_display_order(
    workspace_id: String,
    display_order: i32,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    {
        let mut workspaces = state.workspaces.write();
        let workspace = workspaces.get_mut(&workspace_id).ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        workspace.display_order = display_order;
    }
    state.db.update_workspace_display_order(&workspace_id, display_order)
        .map_err(|e| format!("Failed to update display order: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn toggle_workspace_pinned(
    workspace_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Workspace, String> {
    let updated = {
        let mut workspaces = state.workspaces.write();
        let workspace = workspaces.get_mut(&workspace_id).ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        if workspace.pinned_at.is_some() {
            workspace.pinned_at = None;
        } else {
            workspace.pinned_at = Some(now_rfc3339());
        }
        workspace.clone()
    };
    state.db.update_workspace_pinned(&workspace_id, updated.pinned_at.as_deref())
        .map_err(|e| format!("Failed to toggle pin: {}", e))?;
    Ok(updated)
}

#[tauri::command]
async fn update_workspace_notes(
    workspace_id: String,
    notes: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let notes_opt = if notes.trim().is_empty() { None } else { Some(notes.as_str()) };
    {
        let mut workspaces = state.workspaces.write();
        let workspace = workspaces.get_mut(&workspace_id).ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        workspace.notes = notes_opt.map(String::from);
    }
    state.db.update_workspace_notes(&workspace_id, notes_opt)
        .map_err(|e| format!("Failed to update notes: {}", e))?;
    Ok(())
}

#[tauri::command]
async fn set_workspace_status(
    workspace_id: String,
    status: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Workspace, String> {
    let new_status = match status.as_str() {
        "idle" => WorkspaceStatus::Idle,
        "running" => WorkspaceStatus::Running,
        "inReview" => WorkspaceStatus::InReview,
        "merged" => WorkspaceStatus::Merged,
        _ => return Err(format!("Unknown status: {}", status)),
    };
    let updated = {
        let mut workspaces = state.workspaces.write();
        let workspace = workspaces.get_mut(&workspace_id).ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        workspace.status = new_status;
        workspace.last_activity = Some(now_rfc3339());
        workspace.clone()
    };
    let now = now_rfc3339();
    state.db.update_workspace_status(&workspace_id, &updated.status, Some(&now))
        .map_err(|e| format!("Failed to update status: {}", e))?;
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
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?
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

fn reset_agent_claude_session(
    app_state: &Arc<AppState>,
    db: &Database,
    session_id: &str,
    agent_id: &str,
) {
    {
        let mut agents = app_state.agents.write();
        if let Some(agent) = agents.get_mut(agent_id) {
            agent.claude_session_id = None;
        }
    }
    let _ = db.clear_session_claude_id(session_id);
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
        let now = now_rfc3339();
        let _ = state.db.end_session(&sid, &now);
    }
    
    // Update workspace status if no more agents
    if let Some(ws_id) = workspace_id.clone() {
        let agents = state.agents.read();
        let has_running = agents.values().any(|a| a.workspace_id == ws_id);
        
        if !has_running {
            let next_status = {
                let mut workspaces = state.workspaces.write();
                if let Some(workspace) = workspaces.get_mut(&ws_id) {
                    let next = status_for_agent_stop(&workspace.status);
                    workspace.status = next.clone();
                    Some(next)
                } else {
                    None
                }
            };
            if let Some(status) = next_status {
                let _ = state.db.update_workspace_status(&ws_id, &status, None);
            }
            
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
        let workspace = workspaces.get(&agent.workspace_id).ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        (agent.workspace_id.clone(), workspace.worktree_path.clone(), agent.session_id.clone(), agent.claude_session_id.clone())
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
    let env_overrides = env_overrides.unwrap_or_default();
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
                emit_agent_run_state(
                    &app,
                    &ws_server,
                    &workspace_id,
                    &agent_id_clone,
                    false,
                );
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
        debug_env.sort_by_key(|(k, _)| k.as_str());
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
                emit_agent_run_state(
                    &app,
                    &ws_server,
                    &workspace_id,
                    &agent_id_clone,
                    false,
                );
                return;
            }
        };

        // Store child PID so we can send SIGINT to interrupt
        app_state_for_pids.child_pids.write().insert(agent_id_clone.clone(), child.id());

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
                                let mut agents = app_state.agents.write();
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

                    if let Some(stream_error) = extract_stream_error_text(payload) {
                        if missing_conversation_session_id.is_none() {
                            missing_conversation_session_id =
                                extract_missing_conversation_session_id(&stream_error);
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
                    }
                } else {
                    // Forward non-JSON runtime output so authentication/runtime issues are visible.
                    let cli_line = format!("cli: {}", line);
                    if missing_conversation_session_id.is_none() {
                        missing_conversation_session_id =
                            extract_missing_conversation_session_id(&line);
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
                emit_agent_run_state(
                    &app,
                    &ws_server,
                    &workspace_id,
                    &agent_id_clone,
                    false,
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
async fn get_agent_messages(
    workspace_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<AgentMessage>, String> {
    state.db.get_messages_by_workspace(&workspace_id)
        .map_err(|e| format!("Failed to get messages: {}", e))
}

fn try_launch_editor(binary: &str, args: &[&str]) -> bool {
    Command::new(binary)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn open_workspace_in_vscode(path: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        if try_launch_editor("open", &["-b", "com.microsoft.VSCode", path]) {
            return true;
        }
        if try_launch_editor("open", &["-b", "com.microsoft.VSCodeInsiders", path]) {
            return true;
        }
        if try_launch_editor("open", &["-a", "Visual Studio Code", path]) {
            return true;
        }
    }

    try_launch_editor("code", &[path])
}

fn open_workspace_in_intellij(path: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        if try_launch_editor("open", &["-b", "com.jetbrains.intellij", path]) {
            return true;
        }
        if try_launch_editor("open", &["-b", "com.jetbrains.intellij.ce", path]) {
            return true;
        }
        if try_launch_editor("open", &["-a", "IntelliJ IDEA", path]) {
            return true;
        }
        if try_launch_editor("open", &["-a", "IntelliJ IDEA CE", path]) {
            return true;
        }
    }

    if try_launch_editor("idea", &[path]) {
        return true;
    }

    #[cfg(target_os = "windows")]
    {
        if try_launch_editor("idea64.exe", &[path]) {
            return true;
        }
    }

    false
}

#[tauri::command]
async fn open_workspace_in_editor(
    workspace_id: String,
    editor: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let worktree_path = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces
            .get(&workspace_id)
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        workspace.worktree_path.clone()
    };

    let opened = match editor.trim().to_lowercase().as_str() {
        "vscode" | "vs_code" | "code" => open_workspace_in_vscode(&worktree_path),
        "intellij" | "idea" => open_workspace_in_intellij(&worktree_path),
        _ => {
            return Err(
                "Unsupported editor. Use 'vscode' or 'intellij'.".to_string(),
            );
        }
    };

    if opened {
        Ok(())
    } else {
        Err(format!(
            "Could not open '{}' in {}. Ensure the editor is installed and available on this machine.",
            worktree_path, editor
        ))
    }
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
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        
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

fn lookup_branch_pr_state(repo_path: &str, branch: &str, shell_path: &str) -> Option<(String, String)> {
    let output = Command::new("gh")
        .args([
            "pr",
            "list",
            "--head",
            branch,
            "--state",
            "all",
            "--json",
            "url,state",
            "--limit",
            "1",
        ])
        .current_dir(repo_path)
        .env("PATH", shell_path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let items = serde_json::from_slice::<Vec<Value>>(&output.stdout).ok()?;
    let first = items.first()?;
    let url = first
        .get("url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let state = first
        .get("state")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("")
        .to_lowercase();
    if url.is_empty() || state.is_empty() {
        return None;
    }
    Some((url, state))
}

fn lookup_pr_state_by_url(repo_path: &str, pr_url: &str, shell_path: &str) -> Option<(String, String)> {
    let output = Command::new("gh")
        .args(["pr", "view", pr_url, "--json", "url,state"])
        .current_dir(repo_path)
        .env("PATH", shell_path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let parsed = serde_json::from_slice::<Value>(&output.stdout).ok()?;
    let url = parsed
        .get("url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let state = parsed
        .get("state")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("")
        .to_lowercase();
    if url.is_empty() || state.is_empty() {
        return None;
    }
    Some((url, state))
}

#[tauri::command]
async fn mark_workspace_in_review(
    workspace_id: String,
    pr_url: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let trimmed_pr_url = pr_url.trim();
    if trimmed_pr_url.is_empty() {
        return Err("PR URL cannot be empty.".to_string());
    }

    {
        let mut workspaces = state.workspaces.write();
        let workspace = workspaces
            .get_mut(&workspace_id)
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        if !matches!(workspace.status, WorkspaceStatus::Merged) {
            workspace.status = WorkspaceStatus::InReview;
        }
        workspace.pr_url = Some(trimmed_pr_url.to_string());
    }

    state
        .db
        .update_workspace_pr_url(&workspace_id, trimmed_pr_url, &WorkspaceStatus::InReview)
        .map_err(|e| format!("Failed to persist PR URL: {}", e))?;

    Ok(())
}

/// Sync workspace review state from GitHub PR state.
/// - OPEN PR => InReview
/// - MERGED PR => Merged
/// Returns workspace IDs that transitioned to Merged.
#[tauri::command]
async fn sync_pr_statuses(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<String>, String> {
    // Collect all non-merged workspaces and discover PRs by branch.
    let to_check: Vec<(String, String, String, WorkspaceStatus, Option<String>)> = {
        let workspaces = state.workspaces.read();
        let repos = state.repositories.read();
        workspaces.values()
            .filter(|ws| !matches!(ws.status, WorkspaceStatus::Merged))
            .filter_map(|ws| {
                let repo = repos.get(&ws.repo_id)?;
                Some((
                    ws.id.clone(),
                    repo.path.clone(),
                    ws.branch.clone(),
                    ws.status.clone(),
                    ws.pr_url.clone(),
                ))
            })
            .collect()
    };

    // Resolve the user's shell PATH once so `gh` can be found even when
    // the app is launched as a GUI (macOS Finder / launchd) where the
    // default PATH is minimal and won't include Homebrew etc.
    let shell_env = load_cli_shell_env();
    let shell_path = shell_env
        .get("PATH")
        .cloned()
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());

    let mut merged_ids = Vec::new();
    for (ws_id, repo_path, branch, current_status, current_pr_url) in to_check {
        let discovered = lookup_branch_pr_state(&repo_path, &branch, &shell_path).or_else(|| {
            current_pr_url
                .as_deref()
                .and_then(|url| lookup_pr_state_by_url(&repo_path, url, &shell_path))
        });
        let Some((pr_url, state_str)) = discovered else {
            continue;
        };

        if state_str == "open" {
            let should_update = !matches!(current_status, WorkspaceStatus::InReview)
                || current_pr_url.as_deref() != Some(pr_url.as_str());
            if should_update {
                {
                    let mut workspaces = state.workspaces.write();
                    if let Some(ws) = workspaces.get_mut(&ws_id) {
                        ws.status = WorkspaceStatus::InReview;
                        ws.pr_url = Some(pr_url.clone());
                    }
                }
                let _ = state
                    .db
                    .update_workspace_pr_url(&ws_id, &pr_url, &WorkspaceStatus::InReview);
            }
            continue;
        }

        if state_str == "merged" {
            let should_update = !matches!(current_status, WorkspaceStatus::Merged)
                || current_pr_url.as_deref() != Some(pr_url.as_str());
            if should_update {
                {
                    let mut workspaces = state.workspaces.write();
                    if let Some(ws) = workspaces.get_mut(&ws_id) {
                        ws.status = WorkspaceStatus::Merged;
                        ws.pr_url = Some(pr_url.clone());
                    }
                }
                let _ = state
                    .db
                    .update_workspace_pr_url(&ws_id, &pr_url, &WorkspaceStatus::Merged);
                merged_ids.push(ws_id);
            }
        }
    }
    Ok(merged_ids)
}

fn normalize_skill_relative_path(path: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    for component in path.components() {
        if let Component::Normal(part) = component {
            parts.push(part.to_string_lossy().to_string());
        }
    }
    parts.join("/")
}

fn normalize_skill_directory_input(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Skill path cannot be empty.".to_string());
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        return Err("Skill path must be relative.".to_string());
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            _ => return Err("Skill path cannot contain '..' or absolute segments.".to_string()),
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err("Skill path cannot be empty.".to_string());
    }
    Ok(normalized)
}

fn sanitize_skill_dir_name(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in name.chars() {
        let next = if ch.is_ascii_alphanumeric() {
            ch.to_ascii_lowercase()
        } else if matches!(ch, ' ' | '-' | '_' | '/') {
            '-'
        } else {
            continue;
        };
        if next == '-' {
            if last_dash {
                continue;
            }
            last_dash = true;
        } else {
            last_dash = false;
        }
        out.push(next);
    }
    out.trim_matches('-').to_string()
}

fn infer_skill_name(content: &str, fallback: &str) -> String {
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("# ") {
            let heading = rest.trim();
            if !heading.is_empty() {
                return heading.to_string();
            }
        }
    }
    fallback.to_string()
}

fn build_skill_entry(scope: &str, root: &Path, skill_file: &Path) -> Result<SkillEntry, String> {
    let content = std::fs::read_to_string(skill_file)
        .map_err(|e| format!("Failed to read skill file '{}': {}", skill_file.display(), e))?;

    let skill_dir = skill_file.parent().unwrap_or(root);
    let relative_dir = skill_dir
        .strip_prefix(root)
        .map(normalize_skill_relative_path)
        .map_err(|_| "Failed to normalize skill path.".to_string())?;

    let fallback_name = if relative_dir.is_empty() {
        "Skill".to_string()
    } else {
        relative_dir
            .rsplit('/')
            .next()
            .map(|value| value.replace('-', " "))
            .unwrap_or_else(|| "Skill".to_string())
    };
    let name = infer_skill_name(&content, &fallback_name);

    let command_target = if relative_dir.is_empty() {
        sanitize_skill_dir_name(&name)
    } else {
        relative_dir.clone()
    };
    let command_name = format!("{}:{}", scope, command_target);
    let id = format!("{}::{}", scope, command_target);

    Ok(SkillEntry {
        id,
        scope: scope.to_string(),
        name,
        command_name,
        relative_path: command_target,
        file_path: skill_file.to_string_lossy().to_string(),
        content,
    })
}

fn collect_skills_from_root(scope: &str, root: &Path) -> Result<Vec<SkillEntry>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    if !root.is_dir() {
        return Err(format!(
            "Skills root is not a directory: {}",
            root.to_string_lossy()
        ));
    }

    let mut stack = vec![root.to_path_buf()];
    let mut files: Vec<PathBuf> = Vec::new();

    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir)
            .map_err(|e| format!("Failed to read '{}': {}", dir.to_string_lossy(), e))?;
        for item in entries {
            let entry = item.map_err(|e| format!("Failed to inspect directory entry: {}", e))?;
            let file_type = entry
                .file_type()
                .map_err(|e| format!("Failed to inspect entry type: {}", e))?;
            let path = entry.path();
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if file_type.is_file()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("SKILL.md")
            {
                files.push(path);
            }
        }
    }

    files.sort();
    let mut skills = Vec::new();
    for file in files {
        skills.push(build_skill_entry(scope, root, &file)?);
    }
    Ok(skills)
}

fn resolve_project_skills_root(repo_id: &str, state: &Arc<AppState>) -> Result<PathBuf, String> {
    let repo_path = {
        let repos = state.repositories.read();
        repos.get(repo_id)
            .ok_or("Repository not found")?
            .path
            .clone()
    };
    Ok(PathBuf::from(repo_path).join(".claude").join("skills"))
}

fn resolve_user_skills_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not resolve user home directory.")?;
    Ok(home.join(".claude").join("skills"))
}

#[tauri::command]
async fn list_skills(
    repo_id: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<SkillListResponse, String> {
    let user_root = resolve_user_skills_root()?;
    let user_skills = collect_skills_from_root("user", &user_root)?;

    let (project_root, project_skills) = if let Some(repo_id) = repo_id {
        let root = resolve_project_skills_root(&repo_id, &state)?;
        let skills = collect_skills_from_root("project", &root)?;
        (Some(root), skills)
    } else {
        (None, Vec::new())
    };

    Ok(SkillListResponse {
        project_root: project_root.map(|path| path.to_string_lossy().to_string()),
        user_root: Some(user_root.to_string_lossy().to_string()),
        project_skills,
        user_skills,
    })
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
    let scope = scope.trim().to_lowercase();
    if scope != "project" && scope != "user" {
        return Err("Unsupported skill scope. Use 'project' or 'user'.".to_string());
    }

    let trimmed_content = content.trim();
    if trimmed_content.is_empty() {
        return Err("Skill content cannot be empty.".to_string());
    }

    let root = if scope == "project" {
        let repo_id = repo_id.ok_or("Repository is required for project skills.")?;
        resolve_project_skills_root(&repo_id, &state)?
    } else {
        resolve_user_skills_root()?
    };

    std::fs::create_dir_all(&root).map_err(|e| {
        format!(
            "Failed to create skills directory '{}': {}",
            root.to_string_lossy(),
            e
        )
    })?;

    let relative_dir = if let Some(existing_relative) = relative_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        normalize_skill_directory_input(existing_relative)?
    } else {
        let source = if name.trim().is_empty() {
            infer_skill_name(trimmed_content, "skill")
        } else {
            name.trim().to_string()
        };
        let dir_name = sanitize_skill_dir_name(&source);
        if dir_name.is_empty() {
            return Err("Skill name must contain letters or numbers.".to_string());
        }
        let next = PathBuf::from(dir_name);
        if root.join(&next).exists() {
            return Err("A skill with this name already exists.".to_string());
        }
        next
    };

    let skill_dir = root.join(&relative_dir);
    let skill_file = skill_dir.join("SKILL.md");

    std::fs::create_dir_all(&skill_dir).map_err(|e| {
        format!(
            "Failed to create skill directory '{}': {}",
            skill_dir.to_string_lossy(),
            e
        )
    })?;
    let mut persisted = trimmed_content.to_string();
    if !persisted.ends_with('\n') {
        persisted.push('\n');
    }
    std::fs::write(&skill_file, persisted).map_err(|e| {
        format!(
            "Failed to write skill file '{}': {}",
            skill_file.to_string_lossy(),
            e
        )
    })?;

    build_skill_entry(&scope, &root, &skill_file)
}

#[tauri::command]
async fn delete_skill(
    scope: String,
    repo_id: Option<String>,
    relative_path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let scope = scope.trim().to_lowercase();
    if scope != "project" && scope != "user" {
        return Err("Unsupported skill scope. Use 'project' or 'user'.".to_string());
    }

    let root = if scope == "project" {
        let repo_id = repo_id.ok_or("Repository is required for project skills.")?;
        resolve_project_skills_root(&repo_id, &state)?
    } else {
        resolve_user_skills_root()?
    };

    let skill_dir = root.join(&relative_path);
    if !skill_dir.exists() {
        return Err("Skill not found.".to_string());
    }

    // Canonicalize both paths to prevent directory traversal
    let canonical_root = root.canonicalize().map_err(|e| {
        format!("Failed to resolve skills root: {}", e)
    })?;
    let canonical_dir = skill_dir.canonicalize().map_err(|e| {
        format!("Failed to resolve skill path: {}", e)
    })?;
    if !canonical_dir.starts_with(&canonical_root) {
        return Err("Invalid skill path.".to_string());
    }

    std::fs::remove_dir_all(&canonical_dir).map_err(|e| {
        format!(
            "Failed to delete skill directory '{}': {}",
            skill_dir.to_string_lossy(),
            e
        )
    })?;
    Ok(())
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
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
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

/// Read a file's contents up to `max_bytes`, returning the content as a UTF-8 string.
/// Appends `[truncated]` if the file exceeds the limit.
fn read_file_contents(path: &std::path::Path, max_bytes: usize) -> Result<String, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;
    if !metadata.is_file() {
        return Err("Path is not a file".to_string());
    }

    let bytes = std::fs::read(path)
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let (slice, truncated) = if bytes.len() > max_bytes {
        (&bytes[..max_bytes], true)
    } else {
        (&bytes[..], false)
    };

    // Reject binary files: check for nul bytes in the first 8KB (or full slice if smaller).
    // Nul bytes are valid UTF-8 but cannot appear in CLI arguments (C strings),
    // and indicate binary content (images, compiled files, etc.) that isn't useful as text.
    let check_len = slice.len().min(8192);
    if slice[..check_len].contains(&0u8) {
        return Err(format!(
            "Binary file cannot be attached: {}",
            path.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.display().to_string())
        ));
    }

    let mut content = String::from_utf8_lossy(slice).to_string();
    if truncated {
        content.push_str("\n\n[truncated]");
    }
    Ok(content)
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
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
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

    read_file_contents(&canonical_target, max_bytes.unwrap_or(MAX_FILE_READ_BYTES))
}

/// Write content to a file inside a workspace. Path-traversal guarded.
#[tauri::command]
async fn write_workspace_file(
    workspace_id: String,
    relative_path: String,
    content: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let workspace_root = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces
            .get(&workspace_id)
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        workspace.worktree_path.clone()
    };

    let root = std::fs::canonicalize(&workspace_root)
        .map_err(|e| format!("Failed to resolve workspace path: {}", e))?;
    let target = root.join(&relative_path);

    // For new files the target may not exist yet, so canonicalize the parent instead.
    let parent = target
        .parent()
        .ok_or_else(|| "Invalid file path".to_string())?;
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|e| format!("Failed to resolve parent directory: {}", e))?;
    if !canonical_parent.starts_with(&root) {
        return Err("Path is outside workspace root".to_string());
    }

    std::fs::write(&target, content.as_bytes())
        .map_err(|e| format!("Failed to write file: {}", e))?;

    Ok(())
}

/// Read any file by absolute path. No workspace restriction.
#[tauri::command]
async fn read_file_by_path(
    file_path: String,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    let canonical = std::fs::canonicalize(&file_path)
        .map_err(|e| format!("Failed to resolve file path: {}", e))?;

    read_file_contents(&canonical, max_bytes.unwrap_or(MAX_FILE_READ_BYTES))
}

#[tauri::command]
async fn list_workspace_changes(
    workspace_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<WorkspaceChangeEntry>, String> {
    let (workspace_root, default_branch) = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces
            .get(&workspace_id)
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        let repos = state.repositories.read();
        let repo = repos
            .get(&workspace.repo_id)
            .ok_or("Repository not found")?;
        (workspace.worktree_path.clone(), repo.default_branch.clone())
    };

    let compare_ref = format!("origin/{}", default_branch);
    let mut changes = Vec::new();

    // Get all changes (committed + staged + unstaged) relative to origin/<default_branch>
    let diff_output = Command::new("git")
        .args(["diff", "--name-status", &compare_ref])
        .current_dir(&workspace_root)
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    if diff_output.status.success() {
        let stdout = String::from_utf8_lossy(&diff_output.stdout);
        for line in stdout.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            // Format: "M\tpath" or "R100\told_path\tnew_path"
            let parts: Vec<&str> = line.splitn(3, '\t').collect();
            if parts.len() >= 2 {
                let status_code = parts[0].to_string();
                if status_code.starts_with('R') && parts.len() == 3 {
                    changes.push(WorkspaceChangeEntry {
                        status: format!("R "),
                        path: parts[2].to_string(),
                        old_path: Some(parts[1].to_string()),
                    });
                } else {
                    // Map git diff status codes to two-char codes matching git status format
                    let status = match status_code.as_str() {
                        "M" => " M".to_string(),
                        "A" => "A ".to_string(),
                        "D" => " D".to_string(),
                        other => format!("{: <2}", other),
                    };
                    changes.push(WorkspaceChangeEntry {
                        status,
                        path: parts[1].to_string(),
                        old_path: None,
                    });
                }
            }
        }
    }

    // Also pick up untracked files (not yet committed)
    let untracked_output = Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(&workspace_root)
        .output()
        .map_err(|e| format!("Failed to list untracked files: {}", e))?;

    if untracked_output.status.success() {
        let stdout = String::from_utf8_lossy(&untracked_output.stdout);
        for line in stdout.lines() {
            let path = line.trim().to_string();
            if !path.is_empty() && !changes.iter().any(|c| c.path == path) {
                changes.push(WorkspaceChangeEntry {
                    status: "??".to_string(),
                    path,
                    old_path: None,
                });
            }
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
    let (workspace_root, default_branch) = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces
            .get(&workspace_id)
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        let repos = state.repositories.read();
        let repo = repos
            .get(&workspace.repo_id)
            .ok_or("Repository not found")?;
        (workspace.worktree_path.clone(), repo.default_branch.clone())
    };

    let compare_ref = format!("origin/{}", default_branch);

    let status_trimmed = status.unwrap_or_default().trim().to_string();
    if status_trimmed == "??" {
        let full_path = PathBuf::from(&workspace_root).join(&path);
        let bytes = std::fs::read(&full_path)
            .map_err(|e| format!("Failed to read untracked file for diff: {}", e))?;
        let limit = MAX_FILE_READ_BYTES;
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
    cmd.args(["diff", "--no-color", &compare_ref, "--"]);
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
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
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
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
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

#[tauri::command]
async fn run_single_workspace_check(
    workspace_id: String,
    check_name: String,
    check_command: String,
    state: State<'_, Arc<AppState>>,
) -> Result<WorkspaceCheckResult, String> {
    let workspace_root = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces
            .get(&workspace_id)
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        workspace.worktree_path.clone()
    };

    let mut parts = check_command.split_whitespace();
    let bin = parts.next().ok_or("Invalid check command")?;
    let args: Vec<String> = parts.map(|arg| arg.to_string()).collect();
    let started = Instant::now();

    match Command::new(bin).args(&args).current_dir(&workspace_root).output() {
        Ok(output) => Ok(WorkspaceCheckResult {
            name: check_name,
            command: check_command,
            success: output.status.success(),
            exit_code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            duration_ms: started.elapsed().as_millis(),
            skipped: false,
        }),
        Err(e) => Ok(WorkspaceCheckResult {
            name: check_name,
            command: check_command,
            success: false,
            exit_code: None,
            stdout: String::new(),
            stderr: format!("Failed to execute check: {}", e),
            duration_ms: started.elapsed().as_millis(),
            skipped: false,
        }),
    }
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
                let path_buf = PathBuf::from(&path);
                if !path_buf.exists() {
                    let response = WsResponse::Error {
                        message: format!("Path does not exist: {}", path),
                    };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    continue;
                }
                if !path_buf.is_dir() {
                    let response = WsResponse::Error {
                        message: format!("Path is not a directory: {}", path),
                    };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    continue;
                }
                if !is_git_repo(&path) {
                    let response = WsResponse::Error {
                        message:
                            "Not a git repository. Please select a folder containing a .git directory."
                                .to_string(),
                    };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    continue;
                }

                let name = path_buf
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("Repository")
                    .to_string();
                let default_branch = match get_default_branch(&path) {
                    Ok(branch) => branch,
                    Err(err) => {
                        let response = WsResponse::Error {
                            message: format!("Failed to detect default branch: {}", err),
                        };
                        let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                        continue;
                    }
                };

                let repository = Repository {
                    id: new_id(),
                    path,
                    name,
                    default_branch,
                    added_at: now_rfc3339(),
                };

                if let Err(err) = state.db.insert_repository(&repository) {
                    let response = WsResponse::Error {
                        message: format!("Failed to save repository: {}", err),
                    };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    continue;
                }
                {
                    let mut repos = state.repositories.write();
                    repos.insert(repository.id.clone(), repository.clone());
                }

                let response = WsResponse::RepositoryAdded {
                    repository: to_repository_info(&repository),
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            ServerCommand::RemoveRepository { repo_id, response_tx } => {
                let repo_path = {
                    let repos = state.repositories.read();
                    repos.get(&repo_id).map(|r| r.path.clone())
                };

                if let Some(repo_path) = repo_path {
                    let workspaces_to_remove: Vec<Workspace> = {
                        let workspaces = state.workspaces.read();
                        workspaces
                            .values()
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
                        if let Err(e) = remove_workspace_directory(&repo_path, &workspace.worktree_path)
                        {
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

                if let Err(err) = state.db.delete_repository(&repo_id) {
                    let response = WsResponse::Error {
                        message: format!("Failed to delete repository: {}", err),
                    };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    continue;
                }
                {
                    let mut repos = state.repositories.write();
                    repos.remove(&repo_id);
                }

                let response = WsResponse::RepositoryRemoved { repo_id };
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
            ServerCommand::CreateWorkspace {
                repo_id,
                name,
                response_tx,
            } => {
                let trimmed = name.trim();
                if trimmed.is_empty() {
                    let response = WsResponse::Error {
                        message: "Workspace name cannot be empty".to_string(),
                    };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    continue;
                }

                let repo = {
                    let repos = state.repositories.read();
                    match repos.get(&repo_id).cloned() {
                        Some(repo) => repo,
                        None => {
                            let response = WsResponse::Error {
                                message: "Repository not found".to_string(),
                            };
                            let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                            continue;
                        }
                    }
                };

                let branch = format!("workspace/{}", trimmed.to_lowercase().replace(' ', "-"));
                let worktrees_dir = PathBuf::from(&repo.path).join(".worktrees");
                if let Err(err) = std::fs::create_dir_all(&worktrees_dir) {
                    let response = WsResponse::Error {
                        message: format!("Failed to create worktrees directory: {}", err),
                    };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    continue;
                }
                let worktree_path = worktrees_dir.join(trimmed);
                let worktree_path_str = worktree_path.to_string_lossy().to_string();
                if let Err(err) = create_worktree(&repo.path, &worktree_path_str, &branch, &repo.default_branch) {
                    let response = WsResponse::Error {
                        message: format!("Failed to create workspace: {}", err),
                    };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    continue;
                }

                let workspace = Workspace {
                    id: new_id(),
                    repo_id: repo_id.clone(),
                    name: trimmed.to_string(),
                    branch,
                    worktree_path: worktree_path_str,
                    status: WorkspaceStatus::Idle,
                    last_activity: None,
                    pr_url: None,
                    unread: 0,
                    display_order: 0,
                    pinned_at: None,
                    notes: None,
                };
                if let Err(err) = state.db.insert_workspace(&workspace) {
                    let response = WsResponse::Error {
                        message: format!("Failed to save workspace: {}", err),
                    };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    continue;
                }
                {
                    let mut workspaces = state.workspaces.write();
                    workspaces.insert(workspace.id.clone(), workspace.clone());
                }

                let response = WsResponse::WorkspaceCreated {
                    workspace: to_workspace_info(&workspace, false),
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            ServerCommand::RenameWorkspace {
                workspace_id,
                name,
                response_tx,
            } => {
                let trimmed = name.trim();
                if trimmed.is_empty() {
                    let response = WsResponse::Error {
                        message: "Workspace name cannot be empty".to_string(),
                    };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    continue;
                }

                let updated = {
                    let mut workspaces = state.workspaces.write();
                    match workspaces.get_mut(&workspace_id) {
                        Some(workspace) => {
                            workspace.name = trimmed.to_string();
                            workspace.clone()
                        }
                        None => {
                            let response = WsResponse::Error {
                                message: ERR_WORKSPACE_NOT_FOUND.to_string(),
                            };
                            let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                            continue;
                        }
                    }
                };

                if let Err(err) = state.db.update_workspace_name(&workspace_id, trimmed) {
                    let response = WsResponse::Error {
                        message: format!("Failed to rename workspace: {}", err),
                    };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    continue;
                }

                let has_agent = {
                    let agents = state.agents.read();
                    agents.values().any(|a| a.workspace_id == workspace_id)
                };
                let response = WsResponse::WorkspaceRenamed {
                    workspace: to_workspace_info(&updated, has_agent),
                };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            ServerCommand::RemoveWorkspace {
                workspace_id,
                response_tx,
            } => {
                let (repo_path, worktree_path) = {
                    let workspaces = state.workspaces.read();
                    let workspace = match workspaces.get(&workspace_id) {
                        Some(workspace) => workspace,
                        None => {
                            let response = WsResponse::Error {
                                message: ERR_WORKSPACE_NOT_FOUND.to_string(),
                            };
                            let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                            continue;
                        }
                    };

                    let repos = state.repositories.read();
                    let repo = match repos.get(&workspace.repo_id) {
                        Some(repo) => repo,
                        None => {
                            let response = WsResponse::Error {
                                message: "Repository not found".to_string(),
                            };
                            let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                            continue;
                        }
                    };

                    (repo.path.clone(), workspace.worktree_path.clone())
                };

                if let Err(e) = remove_worktree(&repo_path, &worktree_path) {
                    tracing::warn!("git worktree remove failed for {}: {}", worktree_path, e);
                }
                if let Err(err) = remove_workspace_directory(&repo_path, &worktree_path) {
                    let response = WsResponse::Error {
                        message: format!("Failed to remove workspace directory: {}", err),
                    };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    continue;
                }
                if let Err(err) = state.db.delete_workspace(&workspace_id) {
                    let response = WsResponse::Error {
                        message: format!("Failed to delete workspace: {}", err),
                    };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    continue;
                }
                {
                    let mut workspaces = state.workspaces.write();
                    workspaces.remove(&workspace_id);
                }
                {
                    let mut agents = state.agents.write();
                    let dead: Vec<String> = agents
                        .iter()
                        .filter_map(|(id, agent)| {
                            if agent.workspace_id == workspace_id {
                                Some(id.clone())
                            } else {
                                None
                            }
                        })
                        .collect();
                    for agent_id in dead {
                        agents.remove(&agent_id);
                    }
                }

                let response = WsResponse::WorkspaceRemoved { workspace_id };
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
                            let response = WsResponse::Error { message: ERR_WORKSPACE_NOT_FOUND.to_string() };
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
                            let response = WsResponse::Error { message: ERR_WORKSPACE_NOT_FOUND.to_string() };
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
                let limit = max_bytes.unwrap_or(MAX_FILE_READ_BYTES);
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
                let (workspace_root, default_branch) = {
                    let workspaces = state.workspaces.read();
                    match workspaces.get(&workspace_id) {
                        Some(ws) => {
                            let repos = state.repositories.read();
                            match repos.get(&ws.repo_id) {
                                Some(repo) => (ws.worktree_path.clone(), repo.default_branch.clone()),
                                None => {
                                    let response = WsResponse::Error { message: "Repository not found".to_string() };
                                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                                    continue;
                                }
                            }
                        }
                        None => {
                            let response = WsResponse::Error { message: ERR_WORKSPACE_NOT_FOUND.to_string() };
                            let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                            continue;
                        }
                    }
                };
                let compare_ref = format!("origin/{}", default_branch);
                let mut changes = Vec::new();

                // Get all changes relative to origin/<default_branch>
                let diff_output = match Command::new("git")
                    .args(["diff", "--name-status", &compare_ref])
                    .current_dir(&workspace_root)
                    .output()
                {
                    Ok(o) => o,
                    Err(e) => {
                        let response = WsResponse::Error { message: format!("Failed to run git diff: {}", e) };
                        let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                        continue;
                    }
                };
                if diff_output.status.success() {
                    let stdout = String::from_utf8_lossy(&diff_output.stdout);
                    for line in stdout.lines() {
                        let line = line.trim();
                        if line.is_empty() {
                            continue;
                        }
                        let parts: Vec<&str> = line.splitn(3, '\t').collect();
                        if parts.len() >= 2 {
                            let status_code = parts[0].to_string();
                            if status_code.starts_with('R') && parts.len() == 3 {
                                changes.push(ChangeInfo { status: "R ".to_string(), path: parts[2].to_string(), old_path: Some(parts[1].to_string()) });
                            } else {
                                let status = match status_code.as_str() {
                                    "M" => " M".to_string(),
                                    "A" => "A ".to_string(),
                                    "D" => " D".to_string(),
                                    other => format!("{: <2}", other),
                                };
                                changes.push(ChangeInfo { status, path: parts[1].to_string(), old_path: None });
                            }
                        }
                    }
                }

                // Also pick up untracked files
                if let Ok(untracked_output) = Command::new("git")
                    .args(["ls-files", "--others", "--exclude-standard"])
                    .current_dir(&workspace_root)
                    .output()
                {
                    if untracked_output.status.success() {
                        let stdout = String::from_utf8_lossy(&untracked_output.stdout);
                        for line in stdout.lines() {
                            let path = line.trim().to_string();
                            if !path.is_empty() && !changes.iter().any(|c| c.path == path) {
                                changes.push(ChangeInfo { status: "??".to_string(), path, old_path: None });
                            }
                        }
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
                            let response = WsResponse::Error { message: ERR_WORKSPACE_NOT_FOUND.to_string() };
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
                        let now = now_rfc3339();
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
                            emit_agent_run_state(
                                &app_clone,
                                &ws_server,
                                &workspace_id_clone,
                                &agent_id_clone,
                                true,
                            );
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
                                        emit_agent_run_state(
                                            &app_clone,
                                            &ws_server,
                                            &workspace_id_clone,
                                            &agent_id_clone,
                                            false,
                                        );
                                        return;
                                    }
                                };

                                // Store child PID for interrupt support
                                app_state_clone.child_pids.write().insert(agent_id_clone.clone(), child.id());

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

                                            let payload_type = payload
                                                .get("type")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("");

                                            if payload_type == "ping" {
                                                continue;
                                            }

                                            if let Some(stream_error) = extract_stream_error_text(payload) {
                                                if missing_conversation_session_id.is_none() {
                                                    missing_conversation_session_id =
                                                        extract_missing_conversation_session_id(&stream_error);
                                                }
                                                emit_agent_message(
                                                    &app_clone,
                                                    &db,
                                                    &session_id,
                                                    &agent_id_clone,
                                                    &workspace_id_clone,
                                                    &ws_server,
                                                    stream_error,
                                                    true,
                                                    "error",
                                                );
                                                error_emitted = true;
                                                continue;
                                            }

                                            if update_text_blocks_from_stream_event(
                                                payload,
                                                &mut assistant_text_blocks,
                                            ) {
                                                // Updated in-memory streaming text blocks.
                                            }

                                            for event_item in parse_stream_event_for_activity(
                                                &event,
                                                &mut tool_names,
                                                &mut tool_inputs,
                                            ) {
                                                match event_item {
                                                    ActivityEvent::Activity(activity) => {
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
                                                    ActivityEvent::Question(json_content) => {
                                                        if last_question.as_deref()
                                                            == Some(json_content.as_str())
                                                        {
                                                            continue;
                                                        }
                                                        emit_agent_message(
                                                            &app_clone,
                                                            &db,
                                                            &session_id,
                                                            &agent_id_clone,
                                                            &workspace_id_clone,
                                                            &ws_server,
                                                            json_content.clone(),
                                                            false,
                                                            "question",
                                                        );
                                                        last_question = Some(json_content);
                                                    }
                                                    ActivityEvent::Plan(plan_content) => {
                                                        let normalized_plan =
                                                            normalize_text_for_dedupe(&plan_content);
                                                        if normalized_plan.is_empty()
                                                            || last_plan.as_deref()
                                                                == Some(normalized_plan.as_str())
                                                        {
                                                            continue;
                                                        }
                                                        emit_agent_message(
                                                            &app_clone,
                                                            &db,
                                                            &session_id,
                                                            &agent_id_clone,
                                                            &workspace_id_clone,
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
                                                let normalized_stream =
                                                    normalize_text_for_dedupe(&stream_text);
                                                if !normalized_stream.is_empty()
                                                    && assistant_stream_last_emitted.as_deref()
                                                        != Some(normalized_stream.as_str())
                                                    && last_plan.as_deref()
                                                        != Some(normalized_stream.as_str())
                                                {
                                                    if assistant_stream_timestamp.is_none() {
                                                        assistant_stream_timestamp =
                                                            Some(now_rfc3339());
                                                    }
                                                    emit_agent_message_with_options(
                                                        &app_clone,
                                                        &db,
                                                        &session_id,
                                                        &agent_id_clone,
                                                        &workspace_id_clone,
                                                        &ws_server,
                                                        stream_text,
                                                        false,
                                                        "assistant",
                                                        assistant_stream_timestamp.as_deref(),
                                                        false,
                                                    );
                                                    assistant_stream_last_emitted =
                                                        Some(normalized_stream);
                                                }
                                            }

                                            if payload_type == "result" {
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
                                                    if missing_conversation_session_id.is_none() {
                                                        missing_conversation_session_id =
                                                            extract_missing_conversation_session_id(&errors);
                                                    }
                                                    if detect_credential_error(&errors) {
                                                        saw_credential_error = true;
                                                        emit_agent_message(
                                                            &app_clone,
                                                            &db,
                                                            &session_id,
                                                            &agent_id_clone,
                                                            &workspace_id_clone,
                                                            &ws_server,
                                                            credential_error_message(&errors),
                                                            true,
                                                            "credential_error",
                                                        );
                                                    }
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
                                            let cli_line = format!("cli: {}", line);
                                            if missing_conversation_session_id.is_none() {
                                                missing_conversation_session_id =
                                                    extract_missing_conversation_session_id(&line);
                                            }
                                            let line_has_credential_error = detect_credential_error(&cli_line);
                                            if line_has_credential_error {
                                                saw_credential_error = true;
                                                emit_agent_message(
                                                    &app_clone,
                                                    &db,
                                                    &session_id,
                                                    &agent_id_clone,
                                                    &workspace_id_clone,
                                                    &ws_server,
                                                    credential_error_message(&cli_line),
                                                    true,
                                                    "credential_error",
                                                );
                                            }
                                            let line_is_error =
                                                line_has_credential_error || missing_conversation_session_id.is_some();
                                            emit_agent_message(
                                                &app_clone,
                                                &db,
                                                &session_id,
                                                &agent_id_clone,
                                                &workspace_id_clone,
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
                                        emit_agent_run_state(
                                            &app_clone,
                                            &ws_server,
                                            &workspace_id_clone,
                                            &agent_id_clone,
                                            false,
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
                                    missing_conversation_session_id =
                                        extract_missing_conversation_session_id(&stderr_buf);
                                }

                                app_state_clone.child_pids.write().remove(&agent_id_clone);

                                if let Some(stale_session_id) = missing_conversation_session_id.clone() {
                                    if saw_credential_error {
                                        emit_agent_message(
                                            &app_clone,
                                            &db,
                                            &session_id,
                                            &agent_id_clone,
                                            &workspace_id_clone,
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
                                            &app_state_clone,
                                            &db,
                                            &session_id,
                                            &agent_id_clone,
                                        );
                                        emit_agent_message(
                                            &app_clone,
                                            &db,
                                            &session_id,
                                            &agent_id_clone,
                                            &workspace_id_clone,
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

                                if let Some(assistant_text) =
                                    choose_streaming_assistant_text(
                                        &assistant_text_blocks,
                                        &assistant_delta_text,
                                        latest_assistant_snapshot.as_ref(),
                                    )
                                {
                                    let normalized_assistant = normalize_text_for_dedupe(&assistant_text);
                                    if !normalized_assistant.is_empty()
                                        && last_plan.as_deref()
                                            != Some(normalized_assistant.as_str())
                                    {
                                        if assistant_stream_timestamp.is_some() {
                                            emit_agent_message_with_options(
                                                &app_clone,
                                                &db,
                                                &session_id,
                                                &agent_id_clone,
                                                &workspace_id_clone,
                                                &ws_server,
                                                assistant_text,
                                                false,
                                                "assistant",
                                                assistant_stream_timestamp.as_deref(),
                                                true,
                                            );
                                        } else {
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
                                        }
                                    }
                                } else if let Some(fallback) = result_text_fallback {
                                    let normalized_fallback = normalize_text_for_dedupe(&fallback);
                                    if !normalized_fallback.is_empty()
                                        && last_plan.as_deref()
                                            != Some(normalized_fallback.as_str())
                                    {
                                        if assistant_stream_timestamp.is_some() {
                                            emit_agent_message_with_options(
                                                &app_clone,
                                                &db,
                                                &session_id,
                                                &agent_id_clone,
                                                &workspace_id_clone,
                                                &ws_server,
                                                fallback,
                                                false,
                                                "assistant",
                                                assistant_stream_timestamp.as_deref(),
                                                true,
                                            );
                                        } else {
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
                                        }
                                    }
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
                                    if detect_credential_error(&error_content) {
                                        saw_credential_error = true;
                                        emit_agent_message(
                                            &app_clone,
                                            &db,
                                            &session_id,
                                            &agent_id_clone,
                                            &workspace_id_clone,
                                            &ws_server,
                                            credential_error_message(&error_content),
                                            true,
                                            "credential_error",
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

                                if saw_credential_error {
                                    if let Some(refresh_result) = run_aws_auth_refresh(&effective_env) {
                                        match refresh_result {
                                            Ok(message) => emit_agent_message(
                                                &app_clone,
                                                &db,
                                                &session_id,
                                                &agent_id_clone,
                                                &workspace_id_clone,
                                                &ws_server,
                                                format!(
                                                    "{} Resend your last message once browser authentication completes.",
                                                    message
                                                ),
                                                false,
                                                "system",
                                            ),
                                            Err(message) => emit_agent_message(
                                                &app_clone,
                                                &db,
                                                &session_id,
                                                &agent_id_clone,
                                                &workspace_id_clone,
                                                &ws_server,
                                                message,
                                                true,
                                                "error",
                                            ),
                                        }
                                    }
                                }
                                emit_agent_run_state(
                                    &app_clone,
                                    &ws_server,
                                    &workspace_id_clone,
                                    &agent_id_clone,
                                    false,
                                );
                            } else {
                                emit_agent_message(
                                    &app_clone,
                                    &db,
                                    &session_id,
                                    &agent_id_clone,
                                    &workspace_id_clone,
                                    &ws_server,
                                    "Error: Claude CLI not found".to_string(),
                                    true,
                                    "error",
                                );
                                emit_agent_run_state(
                                    &app_clone,
                                    &ws_server,
                                    &workspace_id_clone,
                                    &agent_id_clone,
                                    false,
                                );
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
                                message: ERR_WORKSPACE_NOT_FOUND.to_string(),
                            };
                            let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                            continue;
                        }
                    }
                };

                let agent_id = new_id();
                let session_id = new_id();
                let claude_session_id: Option<String> = None;
                let now = now_rfc3339();

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
                if let Some(status) = next_status {
                    let _ = state
                        .db
                        .update_workspace_status(&workspace_id, &status, Some(&now));
                }

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
                        let now = now_rfc3339();
                        let _ = state.db.end_session(&sid, &now);
                    }

                    if let Some(ws_id) = workspace_id {
                        let next_status = {
                            let mut workspaces = state.workspaces.write();
                            if let Some(workspace) = workspaces.get_mut(&ws_id) {
                                let next = status_for_agent_stop(&workspace.status);
                                workspace.status = next.clone();
                                Some(next)
                            } else {
                                None
                            }
                        };
                        if let Some(status) = next_status {
                            let _ = state.db.update_workspace_status(&ws_id, &status, None);
                        }

                        let response = WsResponse::AgentStopped { workspace_id: ws_id };
                        let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    }
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

            ServerCommand::SetWorkspaceStatus { workspace_id, status, response_tx } => {
                let new_status = match status.as_str() {
                    "idle" => WorkspaceStatus::Idle,
                    "running" => WorkspaceStatus::Running,
                    "inReview" => WorkspaceStatus::InReview,
                    "merged" => WorkspaceStatus::Merged,
                    _ => {
                        let response = WsResponse::Error { message: format!("Unknown status: {}", status) };
                        let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                        continue;
                    }
                };
                let workspace_info = {
                    let mut workspaces = state.workspaces.write();
                    if let Some(workspace) = workspaces.get_mut(&workspace_id) {
                        workspace.status = new_status.clone();
                        workspace.last_activity = Some(now_rfc3339());
                        let has_agent = state.agents.read().values().any(|a| a.workspace_id == workspace_id);
                        Some(to_workspace_info(workspace, has_agent))
                    } else {
                        None
                    }
                };
                if let Some(info) = workspace_info {
                    let now = now_rfc3339();
                    let _ = state.db.update_workspace_status(&workspace_id, &new_status, Some(&now));
                    let response = WsResponse::WorkspaceUpdated { workspace: info.clone() };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                    // Broadcast to other clients
                    if let Some(ws_server) = &state.ws_server {
                        ws_server.broadcast_all(&WsResponse::WorkspaceUpdated { workspace: info });
                    }
                } else {
                    let response = WsResponse::Error { message: ERR_WORKSPACE_NOT_FOUND.to_string() };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                }
            }

            ServerCommand::ToggleWorkspacePin { workspace_id, response_tx } => {
                let workspace_info = {
                    let mut workspaces = state.workspaces.write();
                    if let Some(workspace) = workspaces.get_mut(&workspace_id) {
                        if workspace.pinned_at.is_some() {
                            workspace.pinned_at = None;
                        } else {
                            workspace.pinned_at = Some(now_rfc3339());
                        }
                        let has_agent = state.agents.read().values().any(|a| a.workspace_id == workspace_id);
                        Some(to_workspace_info(workspace, has_agent))
                    } else {
                        None
                    }
                };
                if let Some(info) = workspace_info {
                    let _ = state.db.update_workspace_pinned(&workspace_id, info.pinned_at.as_deref());
                    let response = WsResponse::WorkspaceUpdated { workspace: info };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                } else {
                    let response = WsResponse::Error { message: ERR_WORKSPACE_NOT_FOUND.to_string() };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                }
            }

            ServerCommand::UpdateWorkspaceNotes { workspace_id, notes, response_tx } => {
                let notes_opt = if notes.trim().is_empty() { None } else { Some(notes.as_str()) };
                {
                    let mut workspaces = state.workspaces.write();
                    if let Some(workspace) = workspaces.get_mut(&workspace_id) {
                        workspace.notes = notes_opt.map(String::from);
                    }
                }
                let _ = state.db.update_workspace_notes(&workspace_id, notes_opt);
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
                {
                    let mut workspaces = state.workspaces.write();
                    if let Some(workspace) = workspaces.get_mut(&workspace_id) {
                        workspace.display_order = display_order;
                    }
                }
                let _ = state.db.update_workspace_display_order(&workspace_id, display_order);
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
                let workspace_root = {
                    let workspaces = state.workspaces.read();
                    workspaces.get(&workspace_id).map(|ws| ws.worktree_path.clone())
                };
                if let Some(root) = workspace_root {
                    let output = Command::new("git")
                        .args(["diff", "HEAD", "--", &file_path])
                        .current_dir(&root)
                        .output();
                    let diff = match output {
                        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
                        Err(e) => format!("Failed to get diff: {}", e),
                    };
                    let response = WsResponse::ChangeDiff { workspace_id, file_path, diff };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                } else {
                    let response = WsResponse::Error { message: ERR_WORKSPACE_NOT_FOUND.to_string() };
                    let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                }
            }

            ServerCommand::RunTerminalCommand { workspace_id, command, response_tx } => {
                let workspace_root = {
                    let workspaces = state.workspaces.read();
                    workspaces.get(&workspace_id).map(|ws| ws.worktree_path.clone())
                };
                if let Some(root) = workspace_root {
                    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
                    let output = Command::new(shell)
                        .args(["-lc", &command])
                        .current_dir(&root)
                        .output();
                    match output {
                        Ok(o) => {
                            let response = WsResponse::TerminalOutput {
                                workspace_id,
                                stdout: String::from_utf8_lossy(&o.stdout).to_string(),
                                stderr: String::from_utf8_lossy(&o.stderr).to_string(),
                                exit_code: o.status.code(),
                            };
                            let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                        }
                        Err(e) => {
                            let response = WsResponse::Error { message: format!("Failed to execute: {}", e) };
                            let _ = response_tx.send(serde_json::to_string(&response).unwrap());
                        }
                    }
                } else {
                    let response = WsResponse::Error { message: ERR_WORKSPACE_NOT_FOUND.to_string() };
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
            list_agents,
            start_agent,
            stop_agent,
            interrupt_agent,
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
