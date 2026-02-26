use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use tauri::{Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::mpsc;
use uuid::Uuid;

mod database;
mod process_manager;
mod websocket_server;

use database::Database;
use websocket_server::{WebSocketServer, WsResponse, WorkspaceInfo, ServerCommand};

// Types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Repository {
    pub id: String,
    pub path: String,
    pub name: String,
    pub default_branch: String,
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub repo_id: String,
    pub name: String,
    pub branch: String,
    pub worktree_path: String,
    pub status: WorkspaceStatus,
    pub last_activity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceStatus {
    Idle,
    Running,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub content: String,
    pub is_error: bool,
    pub timestamp: String,
}

// Application State
pub struct AppState {
    db: Arc<Database>,
    repositories: RwLock<HashMap<String, Repository>>,
    workspaces: RwLock<HashMap<String, Workspace>>,
    agents: RwLock<HashMap<String, Agent>>,
    ws_server: Option<Arc<WebSocketServer>>,
    ws_server_running: RwLock<bool>,
}

impl AppState {
    fn new(db: Database) -> Self {
        let db = Arc::new(db);
        let mut state = Self {
            db: db.clone(),
            repositories: RwLock::new(HashMap::new()),
            workspaces: RwLock::new(HashMap::new()),
            agents: RwLock::new(HashMap::new()),
            ws_server: None,
            ws_server_running: RwLock::new(false),
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
        *self.ws_server_running.write() = true;
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
    let running = *state.ws_server_running.read();
    let client_count = state.ws_server.as_ref().map(|s| s.client_count()).unwrap_or(0);
    
    Ok(AppStatus {
        repositories,
        server_status: ServerStatus {
            running,
            port: 3001,
            connected_clients: client_count,
        },
    })
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
            let _ = remove_worktree(&repo_path, &workspace.worktree_path);
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
    
    remove_worktree(&repo_path, &worktree_path)?;
    
    // Delete from database
    state.db.delete_workspace(&workspace_id)
        .map_err(|e| format!("Failed to delete workspace: {}", e))?;
    
    let mut workspaces = state.workspaces.write();
    workspaces.remove(&workspace_id);
    
    Ok(())
}

#[tauri::command]
async fn list_agents(state: State<'_, Arc<AppState>>) -> Result<Vec<Agent>, String> {
    let agents = state.agents.read();
    Ok(agents.values().cloned().collect())
}

#[tauri::command]
async fn start_agent(
    workspace_id: String,
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
    
    // Check for existing Claude session
    let claude_session_id = state.db.get_active_session(&workspace_id)
        .ok()
        .flatten()
        .and_then(|(_, claude_id)| claude_id);
    
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
    
    std::thread::spawn(move || {
        run_claude_cli(app, agent_id_clone, workspace_path, workspace_name, claude_session_id, db, session_id_clone, ws_server, workspace_id_clone);
    });
    
    Ok(agent)
}

fn find_claude_cli() -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let paths = [
        format!("{}/.claude/local/claude", home),
        "/usr/local/bin/claude".to_string(),
        "/opt/homebrew/bin/claude".to_string(),
    ];
    
    paths.iter()
        .find(|p| std::path::Path::new(p).exists())
        .cloned()
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
) {
    let claude_path = match find_claude_cli() {
        Some(p) => p,
        None => {
            let msg = AgentMessage {
                agent_id: agent_id.clone(),
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
        content: format!("Starting Claude in workspace: {}", workspace_name),
        is_error: false,
        timestamp: chrono::Utc::now().to_rfc3339(),
    };
    let _ = db.insert_message(&session_id, &agent_id, "system", &init_msg.content, false, &init_msg.timestamp);
    let _ = app.emit("agent-message", init_msg.clone());
    
    // Broadcast to WebSocket clients
    if let Some(ws) = &ws_server {
        ws.broadcast_to_workspace(&workspace_id, &WsResponse::AgentMessage {
            workspace_id: workspace_id.clone(),
            content: init_msg.content,
            is_error: false,
            timestamp: init_msg.timestamp,
        });
    }
    
    // Build command
    let mut cmd = Command::new(&claude_path);
    cmd.current_dir(&workspace_path);
    
    // Use --resume if we have an existing session, otherwise create new
    if let Some(ref session) = existing_session {
        cmd.args(["--print", "--resume", session, "-p"]);
        cmd.arg("Continue working on this codebase. What's the current status?");
    } else {
        // Create new session with session-id
        let new_session_id = Uuid::new_v4().to_string();
        cmd.args(["--print", "--session-id", &new_session_id, "-p"]);
        cmd.arg(format!("You are working in the {} workspace at {}. Briefly describe what you see in this codebase (2-3 sentences max).", 
            workspace_name, workspace_path));
        
        // Store the new Claude session ID
        let _ = db.update_session_claude_id(&session_id, &new_session_id);
    }
    
    let output = cmd.output();
    
    match output {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            
            if !stdout.is_empty() {
                let msg = AgentMessage {
                    agent_id: agent_id.clone(),
                    content: stdout.clone(),
                    is_error: false,
                    timestamp: chrono::Utc::now().to_rfc3339(),
                };
                let _ = db.insert_message(&session_id, &agent_id, "assistant", &msg.content, false, &msg.timestamp);
                let _ = app.emit("agent-message", msg.clone());
                
                // Broadcast to WebSocket clients
                if let Some(ws) = &ws_server {
                    ws.broadcast_to_workspace(&workspace_id, &WsResponse::AgentMessage {
                        workspace_id: workspace_id.clone(),
                        content: msg.content,
                        is_error: false,
                        timestamp: msg.timestamp,
                    });
                }
            }
            
            if !stderr.is_empty() && !output.status.success() {
                let msg = AgentMessage {
                    agent_id: agent_id.clone(),
                    content: stderr.clone(),
                    is_error: true,
                    timestamp: chrono::Utc::now().to_rfc3339(),
                };
                let _ = db.insert_message(&session_id, &agent_id, "error", &msg.content, true, &msg.timestamp);
                let _ = app.emit("agent-message", msg.clone());
                
                // Broadcast to WebSocket clients
                if let Some(ws) = &ws_server {
                    ws.broadcast_to_workspace(&workspace_id, &WsResponse::AgentMessage {
                        workspace_id: workspace_id.clone(),
                        content: msg.content,
                        is_error: true,
                        timestamp: msg.timestamp,
                    });
                }
            }
        }
        Err(e) => {
            let msg = AgentMessage {
                agent_id: agent_id.clone(),
                content: format!("Error running Claude: {}", e),
                is_error: true,
                timestamp: chrono::Utc::now().to_rfc3339(),
            };
            let _ = db.insert_message(&session_id, &agent_id, "error", &msg.content, true, &msg.timestamp);
            let _ = app.emit("agent-message", msg.clone());
            
            // Broadcast to WebSocket clients
            if let Some(ws) = &ws_server {
                ws.broadcast_to_workspace(&workspace_id, &WsResponse::AgentMessage {
                    workspace_id: workspace_id.clone(),
                    content: msg.content,
                    is_error: true,
                    timestamp: msg.timestamp,
                });
            }
        }
    }
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

#[tauri::command]
async fn send_message_to_agent(
    agent_id: String,
    message: String,
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    // Get workspace path and session info for this agent
    let (workspace_id, workspace_path, session_id, claude_session_id) = {
        let agents = state.agents.read();
        let agent = agents.get(&agent_id).ok_or("Agent not found")?;
        
        let workspaces = state.workspaces.read();
        let workspace = workspaces.get(&agent.workspace_id).ok_or("Workspace not found")?;
        (agent.workspace_id.clone(), workspace.worktree_path.clone(), agent.session_id.clone(), agent.claude_session_id.clone())
    };
    
    let session_id = session_id.ok_or("No active session")?;
    
    // Save user message to database
    let now = chrono::Utc::now().to_rfc3339();
    let _ = state.db.insert_message(&session_id, &agent_id, "user", &message, false, &now);
    
    // Get WebSocket server for broadcasting
    let ws_server = state.ws_server.clone();
    
    // Run claude with the message in a background thread
    let agent_id_clone = agent_id.clone();
    let message_clone = message.clone();
    let db = state.db.clone();
    
    std::thread::spawn(move || {
        let claude_path = match find_claude_cli() {
            Some(p) => p,
            None => {
                let msg = AgentMessage {
                    agent_id: agent_id_clone.clone(),
                    content: "Error: Claude CLI not found".to_string(),
                    is_error: true,
                    timestamp: chrono::Utc::now().to_rfc3339(),
                };
                let _ = app.emit("agent-message", msg.clone());
                
                if let Some(ws) = &ws_server {
                    ws.broadcast_to_workspace(&workspace_id, &WsResponse::AgentMessage {
                        workspace_id: workspace_id.clone(),
                        content: msg.content,
                        is_error: true,
                        timestamp: msg.timestamp,
                    });
                }
                return;
            }
        };
        
        // Build command - always use --resume if we have a session
        let mut cmd = Command::new(&claude_path);
        cmd.current_dir(&workspace_path);
        
        if let Some(ref claude_sid) = claude_session_id {
            cmd.args(["--print", "--resume", claude_sid, "-p", &message_clone]);
        } else {
            cmd.args(["--print", "-p", &message_clone]);
        }
        
        let output = cmd.output();
        
        match output {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                if !stdout.is_empty() {
                    let msg = AgentMessage {
                        agent_id: agent_id_clone.clone(),
                        content: stdout.clone(),
                        is_error: false,
                        timestamp: chrono::Utc::now().to_rfc3339(),
                    };
                    let _ = db.insert_message(&session_id, &agent_id_clone, "assistant", &msg.content, false, &msg.timestamp);
                    let _ = app.emit("agent-message", msg.clone());
                    
                    if let Some(ws) = &ws_server {
                        ws.broadcast_to_workspace(&workspace_id, &WsResponse::AgentMessage {
                            workspace_id: workspace_id.clone(),
                            content: msg.content,
                            is_error: false,
                            timestamp: msg.timestamp,
                        });
                    }
                }
            }
            Err(e) => {
                let msg = AgentMessage {
                    agent_id: agent_id_clone.clone(),
                    content: format!("Error: {}", e),
                    is_error: true,
                    timestamp: chrono::Utc::now().to_rfc3339(),
                };
                let _ = db.insert_message(&session_id, &agent_id_clone, "error", &msg.content, true, &msg.timestamp);
                let _ = app.emit("agent-message", msg.clone());
                
                if let Some(ws) = &ws_server {
                    ws.broadcast_to_workspace(&workspace_id, &WsResponse::AgentMessage {
                        workspace_id: workspace_id.clone(),
                        content: msg.content,
                        is_error: true,
                        timestamp: msg.timestamp,
                    });
                }
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
    Ok(pr_url)
}

// WebSocket command handler
async fn handle_ws_commands(
    mut rx: mpsc::UnboundedReceiver<ServerCommand>,
    state: Arc<AppState>,
    app: tauri::AppHandle,
) {
    while let Some(cmd) = rx.recv().await {
        match cmd {
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
                            WorkspaceStatus::Error => "error".to_string(),
                        },
                        has_agent,
                    }
                }).collect();
                
                let response = WsResponse::WorkspaceList { workspaces: workspace_list };
                let _ = response_tx.send(serde_json::to_string(&response).unwrap());
            }
            
            ServerCommand::SendMessage { workspace_id, message, response_tx: _ } => {
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
                        let workspace_id_clone = workspace_id.clone();
                        let agent_id_clone = agent_id.clone();
                        
                        std::thread::spawn(move || {
                            if let Some(claude_path) = find_claude_cli() {
                                let mut cmd = Command::new(&claude_path);
                                cmd.current_dir(&workspace_path);
                                
                                if let Some(ref claude_sid) = claude_session_id {
                                    cmd.args(["--print", "--resume", claude_sid, "-p", &message]);
                                } else {
                                    cmd.args(["--print", "-p", &message]);
                                }
                                
                                if let Ok(output) = cmd.output() {
                                    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                                    if !stdout.is_empty() {
                                        let msg = AgentMessage {
                                            agent_id: agent_id_clone.clone(),
                                            content: stdout.clone(),
                                            is_error: false,
                                            timestamp: chrono::Utc::now().to_rfc3339(),
                                        };
                                        let _ = db.insert_message(&session_id, &agent_id_clone, "assistant", &msg.content, false, &msg.timestamp);
                                        let _ = app_clone.emit("agent-message", msg.clone());
                                        
                                        if let Some(ws) = &ws_server {
                                            ws.broadcast_to_workspace(&workspace_id_clone, &WsResponse::AgentMessage {
                                                workspace_id: workspace_id_clone.clone(),
                                                content: msg.content,
                                                is_error: false,
                                                timestamp: msg.timestamp,
                                            });
                                        }
                                    }
                                }
                            }
                        });
                    }
                }
            }
            
            ServerCommand::StartAgent { workspace_id, response_tx } => {
                // This would need to call start_agent logic
                // For now, send an error that this should be done via the UI
                let response = WsResponse::Error { 
                    message: "Agent start via WebSocket not yet implemented - use the desktop UI".to_string() 
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
    let ws_server = Arc::new(WebSocketServer::new(3001, ws_cmd_tx));
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
            let app_state_clone = app_state_for_ws.clone();
            
            // Start WebSocket server and command handler in tokio runtime
            tauri::async_runtime::spawn(async move {
                if let Err(e) = ws_server_clone.start().await {
                    tracing::error!("Failed to start WebSocket server: {}", e);
                } else {
                    tracing::info!("WebSocket server started on port 3001");
                }
            });
            
            // Start command handler
            tauri::async_runtime::spawn(async move {
                handle_ws_commands(ws_cmd_rx, app_state_clone, app_handle).await;
            });
            
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            get_app_status,
            add_repository,
            remove_repository,
            list_repositories,
            list_workspaces,
            create_workspace,
            remove_workspace,
            list_agents,
            start_agent,
            stop_agent,
            send_message_to_agent,
            get_agent_messages,
            create_pull_request,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
