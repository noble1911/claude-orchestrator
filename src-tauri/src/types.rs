use serde::{Deserialize, Serialize};

// ─── Repository & Orchestrator Config ───────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub id: String,
    pub path: String,
    pub name: String,
    pub default_branch: String,
    pub added_at: String,
}

/// Configuration file for repository-specific scripts (orchestrator.json)
/// Inspired by Conductor's script system
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorConfig {
    /// Script to run when setting up a new workspace
    #[serde(default)]
    pub setup_script: Option<String>,
    /// Script to run for the "Run" command
    #[serde(default)]
    pub run_script: Option<String>,
    /// How to handle concurrent run scripts: "concurrent" or "sequential"
    #[serde(default = "default_run_mode")]
    pub run_mode: String,
    /// Script to run before archiving a workspace
    #[serde(default)]
    pub archive_script: Option<String>,
    /// Custom check commands (like lint, test, build)
    #[serde(default)]
    pub checks: Vec<OrchestratorCheck>,
}

fn default_run_mode() -> String {
    "concurrent".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorCheck {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub description: Option<String>,
}

// ─── Workspace ──────────────────────────────────────────────────────

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
    pub unread: i32,
    pub display_order: i32,
    pub pinned_at: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceStatus {
    Idle,
    Running,
    #[serde(rename = "inReview")]
    InReview,
    Merged,
    Initializing,
}

// ─── Agent ──────────────────────────────────────────────────────────

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

// ─── Server & App Status ────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    pub port: u16,
    pub connected_clients: usize,
    pub connect_url: String,
    pub web_url: String,
    pub pairing_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub repositories: Vec<Repository>,
    pub server_status: ServerStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub version: String,
    pub body: Option<String>,
    pub date: Option<String>,
}

// ─── Messages & Events ─────────────────────────────────────────────

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
pub struct AgentRunStateEvent {
    pub workspace_id: String,
    pub agent_id: String,
    pub running: bool,
    pub timestamp: String,
}

// ─── File & Change Entries ──────────────────────────────────────────

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

// ─── Checks ─────────────────────────────────────────────────────────

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

// ─── Skills ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    pub id: String,
    pub scope: String,
    pub name: String,
    pub command_name: String,
    pub relative_path: String,
    pub file_path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillListResponse {
    pub project_root: Option<String>,
    pub user_root: Option<String>,
    pub project_skills: Vec<SkillEntry>,
    pub user_skills: Vec<SkillEntry>,
}

// ─── Terminal ───────────────────────────────────────────────────────

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
