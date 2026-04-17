//! SQLite database operations for persisting workspaces, sessions, and messages

use rusqlite::{Connection, Result, params};
use std::path::PathBuf;
use parking_lot::Mutex;

use crate::{Repository, Workspace, WorkspaceStatus, AgentMessage, HtmlArtifact};

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
        db.migrate()?;
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
                pr_url TEXT,
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

            -- Legacy table: kept only so the Phase 3 migration can copy
            -- existing rows into the workspaces table (is_god = 1).
            -- New god workspaces are created directly in `workspaces`.
            CREATE TABLE IF NOT EXISTS god_workspaces (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                repo_id TEXT NOT NULL,
                worktree_path TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL DEFAULT 'idle',
                created_at TEXT NOT NULL,
                FOREIGN KEY (repo_id) REFERENCES repositories(id)
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

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS html_artifacts (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                identifier TEXT,
                title TEXT NOT NULL,
                html TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
            );

            CREATE INDEX IF NOT EXISTS idx_html_artifacts_workspace
                ON html_artifacts(workspace_id, created_at DESC);

            CREATE UNIQUE INDEX IF NOT EXISTS idx_html_artifacts_identifier
                ON html_artifacts(workspace_id, identifier)
                WHERE identifier IS NOT NULL;
            "#,
        )?;
        Ok(())
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock();
        // Add pr_url column if missing (existing databases)
        let has_pr_url = conn
            .prepare("SELECT pr_url FROM workspaces LIMIT 0")
            .is_ok();
        if !has_pr_url {
            conn.execute_batch("ALTER TABLE workspaces ADD COLUMN pr_url TEXT")?;
        }
        // Normalize legacy 'error' status to 'idle'
        conn.execute("UPDATE workspaces SET status = 'idle' WHERE status = 'error'", [])?;

        // Conductor-inspired schema enhancements
        // Add unread column for activity tracking
        if conn.prepare("SELECT unread FROM workspaces LIMIT 0").is_err() {
            conn.execute_batch("ALTER TABLE workspaces ADD COLUMN unread INTEGER DEFAULT 0")?;
        }
        // Add display_order for drag-and-drop reordering
        if conn.prepare("SELECT display_order FROM workspaces LIMIT 0").is_err() {
            conn.execute_batch("ALTER TABLE workspaces ADD COLUMN display_order INTEGER DEFAULT 0")?;
        }
        // Add pinned_at for pinning workspaces
        if conn.prepare("SELECT pinned_at FROM workspaces LIMIT 0").is_err() {
            conn.execute_batch("ALTER TABLE workspaces ADD COLUMN pinned_at TEXT")?;
        }
        // Add notes for user annotations
        if conn.prepare("SELECT notes FROM workspaces LIMIT 0").is_err() {
            conn.execute_batch("ALTER TABLE workspaces ADD COLUMN notes TEXT")?;
        }

        // God workspace support: link child workspaces to their parent god workspace
        if conn.prepare("SELECT parent_god_workspace_id FROM workspaces LIMIT 0").is_err() {
            conn.execute_batch("ALTER TABLE workspaces ADD COLUMN parent_god_workspace_id TEXT")?;
        }

        // God workspace unification: is_god flag on workspaces table
        if conn.prepare("SELECT is_god FROM workspaces LIMIT 0").is_err() {
            conn.execute_batch("ALTER TABLE workspaces ADD COLUMN is_god INTEGER DEFAULT 0")?;
        }

        // Migrate any existing god_workspaces into the workspaces table
        let has_god_table = conn
            .prepare("SELECT id FROM god_workspaces LIMIT 0")
            .is_ok();
        if has_god_table {
            // Copy god_workspaces that aren't already in workspaces
            conn.execute_batch(
                r#"
                INSERT OR IGNORE INTO workspaces (id, repo_id, name, branch, worktree_path, status, is_god)
                SELECT id, repo_id, name, 'god/' || REPLACE(LOWER(name), ' ', '-'), worktree_path, status, 1
                FROM god_workspaces
                WHERE id NOT IN (SELECT id FROM workspaces);
                "#,
            )?;
        }

        // Backfill: normalize NULL is_god to 0 so queries can use simple `is_god = 0`
        conn.execute("UPDATE workspaces SET is_god = 0 WHERE is_god IS NULL", [])?;

        // Cross-workspace session continuity
        if conn.prepare("SELECT source_claude_session_id FROM workspaces LIMIT 0").is_err() {
            conn.execute_batch("ALTER TABLE workspaces ADD COLUMN source_claude_session_id TEXT")?;
        }

        // Session enhancements
        if conn.prepare("SELECT unread_count FROM sessions LIMIT 0").is_err() {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN unread_count INTEGER DEFAULT 0")?;
        }
        if conn.prepare("SELECT model FROM sessions LIMIT 0").is_err() {
            conn.execute_batch("ALTER TABLE sessions ADD COLUMN model TEXT")?;
        }

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
        let status_str = workspace_status_to_str(&ws.status);
        conn.execute(
            "INSERT OR REPLACE INTO workspaces (id, repo_id, name, branch, worktree_path, status, last_activity, pr_url, unread, display_order, pinned_at, notes, parent_god_workspace_id, is_god, source_claude_session_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![ws.id, ws.repo_id, ws.name, ws.branch, ws.worktree_path, status_str, ws.last_activity, ws.pr_url, ws.unread, ws.display_order, ws.pinned_at, ws.notes, ws.parent_god_workspace_id, ws.is_god as i32, ws.source_claude_session_id],
        )?;
        Ok(())
    }

    fn workspace_from_row(row: &rusqlite::Row) -> rusqlite::Result<Workspace> {
        let status_str: String = row.get(5)?;
        let is_god_int: i32 = row.get(13).unwrap_or(0);
        Ok(Workspace {
            id: row.get(0)?,
            repo_id: row.get(1)?,
            name: row.get(2)?,
            branch: row.get(3)?,
            worktree_path: row.get(4)?,
            status: workspace_status_from_str(&status_str),
            last_activity: row.get(6)?,
            pr_url: row.get(7)?,
            unread: row.get(8)?,
            display_order: row.get(9)?,
            pinned_at: row.get(10)?,
            notes: row.get(11)?,
            parent_god_workspace_id: row.get(12)?,
            is_god: is_god_int != 0,
            source_claude_session_id: row.get(14).unwrap_or(None),
        })
    }

    pub fn get_workspaces_by_repo(&self, repo_id: &str) -> Result<Vec<Workspace>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, repo_id, name, branch, worktree_path, status, last_activity, pr_url, unread, display_order, pinned_at, notes, parent_god_workspace_id, is_god, source_claude_session_id FROM workspaces WHERE repo_id = ?1 AND parent_god_workspace_id IS NULL AND is_god = 0 ORDER BY pinned_at IS NULL, pinned_at DESC, display_order, name"
        )?;

        let workspaces = stmt.query_map(params![repo_id], Self::workspace_from_row)?.collect::<Result<Vec<_>>>()?;

        Ok(workspaces)
    }

    /// Returns all workspaces from the database without any filtering.
    /// Used by `load_from_db` to populate the full in-memory state.
    pub fn get_all_workspaces_unfiltered(&self) -> Result<Vec<Workspace>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, repo_id, name, branch, worktree_path, status, last_activity, pr_url, unread, display_order, pinned_at, notes, parent_god_workspace_id, is_god, source_claude_session_id FROM workspaces ORDER BY pinned_at IS NULL, pinned_at DESC, display_order, name"
        )?;
        let workspaces = stmt.query_map([], Self::workspace_from_row)?.collect::<Result<Vec<_>>>()?;
        Ok(workspaces)
    }

    /// Returns only regular (non-god, non-child) workspaces.
    pub fn get_regular_workspaces(&self) -> Result<Vec<Workspace>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, repo_id, name, branch, worktree_path, status, last_activity, pr_url, unread, display_order, pinned_at, notes, parent_god_workspace_id, is_god, source_claude_session_id FROM workspaces WHERE parent_god_workspace_id IS NULL AND is_god = 0 ORDER BY pinned_at IS NULL, pinned_at DESC, display_order, name"
        )?;

        let workspaces = stmt.query_map([], Self::workspace_from_row)?.collect::<Result<Vec<_>>>()?;

        Ok(workspaces)
    }

    pub fn get_child_workspaces(&self, god_workspace_id: &str) -> Result<Vec<Workspace>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, repo_id, name, branch, worktree_path, status, last_activity, pr_url, unread, display_order, pinned_at, notes, parent_god_workspace_id, is_god, source_claude_session_id FROM workspaces WHERE parent_god_workspace_id = ?1 ORDER BY pinned_at IS NULL, pinned_at DESC, display_order, name"
        )?;

        let workspaces = stmt.query_map(params![god_workspace_id], Self::workspace_from_row)?.collect::<Result<Vec<_>>>()?;

        Ok(workspaces)
    }

    pub fn update_workspace_status(&self, id: &str, status: &WorkspaceStatus, last_activity: Option<&str>) -> Result<()> {
        let conn = self.conn.lock();
        let status_str = workspace_status_to_str(status);
        conn.execute(
            "UPDATE workspaces SET status = ?1, last_activity = ?2 WHERE id = ?3",
            params![status_str, last_activity, id],
        )?;
        Ok(())
    }

    pub fn update_workspace_pr_url(&self, id: &str, pr_url: &str, status: &WorkspaceStatus) -> Result<()> {
        let conn = self.conn.lock();
        let status_str = workspace_status_to_str(status);
        conn.execute(
            "UPDATE workspaces SET pr_url = ?1, status = ?2 WHERE id = ?3",
            params![pr_url, status_str, id],
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

    pub fn update_workspace_unread(&self, id: &str, unread: i32) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("UPDATE workspaces SET unread = ?1 WHERE id = ?2", params![unread, id])?;
        Ok(())
    }

    pub fn update_workspace_display_order(&self, id: &str, display_order: i32) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("UPDATE workspaces SET display_order = ?1 WHERE id = ?2", params![display_order, id])?;
        Ok(())
    }

    pub fn update_workspace_pinned(&self, id: &str, pinned_at: Option<&str>) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("UPDATE workspaces SET pinned_at = ?1 WHERE id = ?2", params![pinned_at, id])?;
        Ok(())
    }

    pub fn update_workspace_notes(&self, id: &str, notes: Option<&str>) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("UPDATE workspaces SET notes = ?1 WHERE id = ?2", params![notes, id])?;
        Ok(())
    }

    pub fn update_workspace_parent_god(&self, id: &str, parent_god_workspace_id: Option<&str>) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("UPDATE workspaces SET parent_god_workspace_id = ?1 WHERE id = ?2", params![parent_god_workspace_id, id])?;
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
        // Delete associated html artifacts
        conn.execute("DELETE FROM html_artifacts WHERE workspace_id = ?1", params![id])?;
        // Delete workspace
        conn.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        Ok(())
    }

    // God Workspace queries (unified — god workspaces live in the workspaces table with is_god = 1)
    pub fn get_god_workspaces(&self) -> Result<Vec<Workspace>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, repo_id, name, branch, worktree_path, status, last_activity, pr_url, unread, display_order, pinned_at, notes, parent_god_workspace_id, is_god, source_claude_session_id FROM workspaces WHERE is_god = 1 ORDER BY name"
        )?;
        let workspaces = stmt.query_map([], Self::workspace_from_row)?.collect::<Result<Vec<_>>>()?;
        Ok(workspaces)
    }

    pub fn delete_god_workspace(&self, id: &str) -> Result<()> {
        let mut conn = self.conn.lock();
        // Wrap in a transaction so the cascade is atomic — a partial failure
        // won't leave orphaned child records in the database.
        let tx = conn.transaction()?;
        // Safety net: clean up any child records that weren't already deleted by
        // the per-child remove_workspace calls. These are typically no-ops but
        // guard against partial failures during god workspace removal.
        tx.execute(
            "DELETE FROM messages WHERE session_id IN (SELECT s.id FROM sessions s JOIN workspaces w ON s.workspace_id = w.id WHERE w.parent_god_workspace_id = ?1)",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM sessions WHERE workspace_id IN (SELECT id FROM workspaces WHERE parent_god_workspace_id = ?1)",
            params![id],
        )?;
        tx.execute(
            "DELETE FROM html_artifacts WHERE workspace_id IN (SELECT id FROM workspaces WHERE parent_god_workspace_id = ?1)",
            params![id],
        )?;
        tx.execute("DELETE FROM workspaces WHERE parent_god_workspace_id = ?1", params![id])?;
        // Delete the god workspace's own messages, sessions, and artifacts
        tx.execute(
            "DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ?1)",
            params![id],
        )?;
        tx.execute("DELETE FROM sessions WHERE workspace_id = ?1", params![id])?;
        tx.execute("DELETE FROM html_artifacts WHERE workspace_id = ?1", params![id])?;
        // Delete the god workspace itself
        tx.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        tx.commit()
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

    /// Return the claude_session_id from the most recent session for a workspace
    /// that actually has one (i.e. Claude responded at least once).
    pub fn get_latest_claude_session_id(&self, workspace_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT claude_session_id FROM sessions WHERE workspace_id = ?1 AND claude_session_id IS NOT NULL ORDER BY created_at DESC LIMIT 1"
        )?;
        let result = stmt.query_row(params![workspace_id], |row| row.get::<_, String>(0));
        match result {
            Ok(sid) => Ok(Some(sid)),
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

    pub fn clear_session_claude_id(&self, session_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE sessions SET claude_session_id = NULL WHERE id = ?1",
            params![session_id],
        )?;
        Ok(())
    }

    pub fn update_session_model(&self, session_id: &str, model: Option<&str>) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("UPDATE sessions SET model = ?1 WHERE id = ?2", params![model, session_id])?;
        Ok(())
    }

    pub fn update_session_unread_count(&self, session_id: &str, unread_count: i32) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("UPDATE sessions SET unread_count = ?1 WHERE id = ?2", params![unread_count, session_id])?;
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
            // Fetch the N most recent messages (DESC) then re-sort ascending so
            // callers always receive chronological order regardless of limit.
            Some(l) => format!(
                "SELECT agent_id, role, content, is_error, timestamp FROM (SELECT id, agent_id, role, content, is_error, timestamp FROM messages WHERE session_id = ?1 ORDER BY id DESC LIMIT {}) ORDER BY id ASC",
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

    pub fn get_workspace_message_count(&self, workspace_id: &str) -> Result<i64> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT COUNT(*) FROM messages m
             JOIN sessions s ON m.session_id = s.id
             WHERE s.workspace_id = ?1"
        )?;
        stmt.query_row(params![workspace_id], |row| row.get(0))
    }

    pub fn get_last_assistant_message(&self, workspace_id: &str) -> Result<Option<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT m.content FROM messages m
             JOIN sessions s ON m.session_id = s.id
             WHERE s.workspace_id = ?1 AND m.role = 'assistant'
             ORDER BY m.id DESC LIMIT 1"
        )?;
        let result = stmt.query_row(params![workspace_id], |row| row.get::<_, String>(0));
        match result {
            Ok(content) => Ok(Some(content)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Combined query: message count + last assistant message in a single DB round-trip.
    pub fn get_workspace_message_stats(&self, workspace_id: &str) -> Result<(i64, Option<String>)> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT
               (SELECT COUNT(*) FROM messages m JOIN sessions s ON m.session_id = s.id WHERE s.workspace_id = ?1),
               (SELECT m.content FROM messages m JOIN sessions s ON m.session_id = s.id WHERE s.workspace_id = ?1 AND m.role = 'assistant' ORDER BY m.id DESC LIMIT 1)"
        )?;
        stmt.query_row(params![workspace_id], |row| {
            let count: i64 = row.get(0)?;
            let last_msg: Option<String> = row.get(1)?;
            Ok((count, last_msg))
        })
    }

    // App Settings
    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT value FROM app_settings WHERE key = ?1")?;
        let result = stmt.query_row(params![key], |row| row.get::<_, String>(0));
        match result {
            Ok(value) => Ok(Some(value)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }

    // HTML Artifact CRUD
    //
    // Upsert semantics: when `identifier` is Some, an existing artifact with the
    // same (workspace_id, identifier) is replaced in place (same id retained).
    // When `identifier` is None, every call creates a fresh row.
    pub fn upsert_html_artifact(
        &self,
        workspace_id: &str,
        identifier: Option<&str>,
        title: &str,
        html: &str,
    ) -> Result<HtmlArtifact> {
        let conn = self.conn.lock();
        let created_at = chrono::Utc::now().to_rfc3339();

        // Check for an existing row when identifier is provided — if present,
        // reuse its id (stable URL + stable React key for updates in place).
        let existing_id: Option<String> = if let Some(ident) = identifier {
            conn.query_row(
                "SELECT id FROM html_artifacts WHERE workspace_id = ?1 AND identifier = ?2",
                params![workspace_id, ident],
                |row| row.get(0),
            ).ok()
        } else {
            None
        };

        let id = existing_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        conn.execute(
            "INSERT OR REPLACE INTO html_artifacts (id, workspace_id, identifier, title, html, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, workspace_id, identifier, title, html, created_at],
        )?;
        Ok(HtmlArtifact {
            id,
            workspace_id: workspace_id.to_string(),
            identifier: identifier.map(str::to_owned),
            title: title.to_string(),
            html: html.to_string(),
            created_at,
        })
    }

    pub fn get_html_artifacts_by_workspace(&self, workspace_id: &str) -> Result<Vec<HtmlArtifact>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, identifier, title, html, created_at
             FROM html_artifacts WHERE workspace_id = ?1 ORDER BY created_at DESC"
        )?;
        let rows = stmt.query_map(params![workspace_id], |row| {
            Ok(HtmlArtifact {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                identifier: row.get(2)?,
                title: row.get(3)?,
                html: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?.collect::<Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn delete_html_artifact(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM html_artifacts WHERE id = ?1", params![id])?;
        Ok(())
    }
}

fn workspace_status_to_str(status: &WorkspaceStatus) -> &'static str {
    match status {
        WorkspaceStatus::Idle => "idle",
        WorkspaceStatus::Running => "running",
        WorkspaceStatus::InReview => "inReview",
        WorkspaceStatus::Merged => "merged",
        WorkspaceStatus::Initializing => "initializing",
    }
}

fn workspace_status_from_str(s: &str) -> WorkspaceStatus {
    match s {
        "running" => WorkspaceStatus::Running,
        "inReview" | "in_review" => WorkspaceStatus::InReview,
        "merged" => WorkspaceStatus::Merged,
        "initializing" => WorkspaceStatus::Initializing,
        _ => WorkspaceStatus::Idle,
    }
}
