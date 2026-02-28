//! SQLite database operations for persisting workspaces, sessions, and messages

use rusqlite::{Connection, Result, params};
use std::path::PathBuf;
use parking_lot::Mutex;

use crate::{Repository, Workspace, WorkspaceStatus, AgentMessage};

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn new(path: PathBuf) -> Result<Self> {
        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }

        let conn = Connection::open(path)?;
        let db = Self { conn: Mutex::new(conn) };
        db.init_schema()?;
        Ok(db)
    }

    fn init_schema(&self) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS repositories (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                default_branch TEXT NOT NULL,
                added_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS workspaces (
                id TEXT PRIMARY KEY,
                repo_id TEXT NOT NULL,
                name TEXT NOT NULL,
                branch TEXT NOT NULL,
                worktree_path TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL DEFAULT 'idle',
                last_activity TEXT,
                FOREIGN KEY (repo_id) REFERENCES repositories(id)
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                claude_session_id TEXT,
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL,
                ended_at TEXT,
                FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                is_error INTEGER NOT NULL DEFAULT 0,
                timestamp TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id)
            );
            "#,
        )?;
        Ok(())
    }

    // Repository CRUD
    pub fn insert_repository(&self, repo: &Repository) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO repositories (id, path, name, default_branch, added_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![repo.id, repo.path, repo.name, repo.default_branch, repo.added_at],
        )?;
        Ok(())
    }

    pub fn get_all_repositories(&self) -> Result<Vec<Repository>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, path, name, default_branch, added_at FROM repositories ORDER BY added_at DESC"
        )?;

        let repos = stmt.query_map([], |row| {
            Ok(Repository {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                default_branch: row.get(3)?,
                added_at: row.get(4)?,
            })
        })?.collect::<Result<Vec<_>>>()?;

        Ok(repos)
    }

    pub fn delete_repository(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        // Delete associated messages first
        conn.execute(
            "DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id IN (SELECT id FROM workspaces WHERE repo_id = ?1))",
            params![id],
        )?;
        // Delete associated sessions
        conn.execute(
            "DELETE FROM sessions WHERE workspace_id IN (SELECT id FROM workspaces WHERE repo_id = ?1)",
            params![id],
        )?;
        // Delete associated workspaces
        conn.execute("DELETE FROM workspaces WHERE repo_id = ?1", params![id])?;
        // Delete repository
        conn.execute("DELETE FROM repositories WHERE id = ?1", params![id])?;
        Ok(())
    }

    // Workspace CRUD
    pub fn insert_workspace(&self, ws: &Workspace) -> Result<()> {
        let conn = self.conn.lock();
        let status_str = match ws.status {
            WorkspaceStatus::Idle => "idle",
            WorkspaceStatus::Running => "running",
            WorkspaceStatus::Error => "error",
        };
        conn.execute(
            "INSERT OR REPLACE INTO workspaces (id, repo_id, name, branch, worktree_path, status, last_activity) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![ws.id, ws.repo_id, ws.name, ws.branch, ws.worktree_path, status_str, ws.last_activity],
        )?;
        Ok(())
    }

    pub fn get_workspaces_by_repo(&self, repo_id: &str) -> Result<Vec<Workspace>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, repo_id, name, branch, worktree_path, status, last_activity FROM workspaces WHERE repo_id = ?1 ORDER BY name"
        )?;

        let workspaces = stmt.query_map(params![repo_id], |row| {
            let status_str: String = row.get(5)?;
            let status = match status_str.as_str() {
                "running" => WorkspaceStatus::Running,
                "error" => WorkspaceStatus::Error,
                _ => WorkspaceStatus::Idle,
            };
            Ok(Workspace {
                id: row.get(0)?,
                repo_id: row.get(1)?,
                name: row.get(2)?,
                branch: row.get(3)?,
                worktree_path: row.get(4)?,
                status,
                last_activity: row.get(6)?,
            })
        })?.collect::<Result<Vec<_>>>()?;

        Ok(workspaces)
    }

    pub fn get_all_workspaces(&self) -> Result<Vec<Workspace>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, repo_id, name, branch, worktree_path, status, last_activity FROM workspaces ORDER BY name"
        )?;

        let workspaces = stmt.query_map([], |row| {
            let status_str: String = row.get(5)?;
            let status = match status_str.as_str() {
                "running" => WorkspaceStatus::Running,
                "error" => WorkspaceStatus::Error,
                _ => WorkspaceStatus::Idle,
            };
            Ok(Workspace {
                id: row.get(0)?,
                repo_id: row.get(1)?,
                name: row.get(2)?,
                branch: row.get(3)?,
                worktree_path: row.get(4)?,
                status,
                last_activity: row.get(6)?,
            })
        })?.collect::<Result<Vec<_>>>()?;

        Ok(workspaces)
    }

    pub fn update_workspace_status(&self, id: &str, status: &WorkspaceStatus, last_activity: Option<&str>) -> Result<()> {
        let conn = self.conn.lock();
        let status_str = match status {
            WorkspaceStatus::Idle => "idle",
            WorkspaceStatus::Running => "running",
            WorkspaceStatus::Error => "error",
        };
        conn.execute(
            "UPDATE workspaces SET status = ?1, last_activity = ?2 WHERE id = ?3",
            params![status_str, last_activity, id],
        )?;
        Ok(())
    }

    pub fn update_workspace_name(&self, id: &str, name: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE workspaces SET name = ?1 WHERE id = ?2",
            params![name, id],
        )?;
        Ok(())
    }

    pub fn delete_workspace(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        // Delete associated messages
        conn.execute(
            "DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?1)",
            params![id],
        )?;
        // Delete associated sessions
        conn.execute("DELETE FROM sessions WHERE workspace_id = ?1", params![id])?;
        // Delete workspace
        conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        Ok(())
    }

    // Session CRUD
    pub fn insert_session(&self, id: &str, workspace_id: &str, claude_session_id: Option<&str>, created_at: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO sessions (id, workspace_id, claude_session_id, status, created_at) VALUES (?1, ?2, ?3, 'active', ?4)",
            params![id, workspace_id, claude_session_id, created_at],
        )?;
        Ok(())
    }

    pub fn get_active_session(&self, workspace_id: &str) -> Result<Option<(String, Option<String>)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, claude_session_id FROM sessions WHERE workspace_id = ?1 AND status = 'active' ORDER BY created_at DESC LIMIT 1"
        )?;

        let result = stmt.query_row(params![workspace_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        });

        match result {
            Ok(session) => Ok(Some(session)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn update_session_claude_id(&self, session_id: &str, claude_session_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE sessions SET claude_session_id = ?1 WHERE id = ?2",
            params![claude_session_id, session_id],
        )?;
        Ok(())
    }

    pub fn end_session(&self, id: &str, ended_at: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE sessions SET status = 'ended', ended_at = ?1 WHERE id = ?2",
            params![ended_at, id],
        )?;
        Ok(())
    }

    // Message CRUD
    pub fn insert_message(&self, session_id: &str, agent_id: &str, role: &str, content: &str, is_error: bool, timestamp: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO messages (session_id, agent_id, role, content, is_error, timestamp) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![session_id, agent_id, role, content, is_error as i32, timestamp],
        )?;
        Ok(())
    }

    pub fn get_messages_by_session(&self, session_id: &str, limit: Option<u32>) -> Result<Vec<AgentMessage>> {
        let conn = self.conn.lock();
        let query = match limit {
            Some(l) => format!(
                "SELECT agent_id, role, content, is_error, timestamp FROM messages WHERE session_id = ?1 ORDER BY id DESC LIMIT {}",
                l
            ),
            None => "SELECT agent_id, role, content, is_error, timestamp FROM messages WHERE session_id = ?1 ORDER BY id".to_string(),
        };

        let mut stmt = conn.prepare(&query)?;
        let messages = stmt.query_map(params![session_id], |row| {
            let role: String = row.get(1)?;
            let agent_id: String = if role == "user" {
                "user".to_string()
            } else {
                row.get(0)?
            };
            Ok(AgentMessage {
                agent_id,
                workspace_id: None,
                role,
                content: row.get(2)?,
                is_error: row.get::<_, i32>(3)? != 0,
                timestamp: row.get(4)?,
            })
        })?.collect::<Result<Vec<_>>>()?;

        Ok(messages)
    }

    pub fn get_messages_by_workspace(&self, workspace_id: &str) -> Result<Vec<AgentMessage>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT m.agent_id, m.role, m.content, m.is_error, m.timestamp FROM messages m
             JOIN sessions s ON m.session_id = s.id
             WHERE s.workspace_id = ?1
             ORDER BY m.id"
        )?;

        let messages = stmt.query_map(params![workspace_id], |row| {
            let role: String = row.get(1)?;
            let agent_id: String = if role == "user" {
                "user".to_string()
            } else {
                row.get(0)?
            };
            Ok(AgentMessage {
                agent_id,
                workspace_id: Some(workspace_id.to_string()),
                role,
                content: row.get(2)?,
                is_error: row.get::<_, i32>(3)? != 0,
                timestamp: row.get(4)?,
            })
        })?.collect::<Result<Vec<_>>>()?;

        Ok(messages)
    }
}
