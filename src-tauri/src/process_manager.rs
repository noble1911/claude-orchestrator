//! Claude CLI process management
//!
//! Handles spawning, monitoring, and communication with Claude CLI processes.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClaudeMessage {
    #[serde(rename = "assistant")]
    Assistant {
        message: AssistantMessage,
        #[serde(default)]
        session_id: Option<String>,
    },
    #[serde(rename = "user")]
    User {
        message: UserMessage,
        #[serde(default)]
        session_id: Option<String>,
    },
    #[serde(rename = "system")]
    System {
        #[serde(default)]
        message: Option<String>,
        #[serde(default)]
        session_id: Option<String>,
    },
    #[serde(rename = "result")]
    Result {
        #[serde(default)]
        result: Option<String>,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        is_error: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantMessage {
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub partial: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserMessage {
    #[serde(default)]
    pub content: String,
}

pub struct ProcessManager {
    processes: Arc<RwLock<HashMap<String, ManagedProcess>>>,
    output_tx: mpsc::UnboundedSender<ProcessOutput>,
}

pub struct ManagedProcess {
    pub id: String,
    pub workspace_path: String,
    pub session_id: String,
    stdin_tx: mpsc::UnboundedSender<String>,
    #[allow(dead_code)]
    child_handle: tokio::task::JoinHandle<()>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcessOutput {
    pub agent_id: String,
    pub session_id: String,
    pub content: String,
    pub is_partial: bool,
    pub is_error: bool,
}

impl ProcessManager {
    pub fn new(output_tx: mpsc::UnboundedSender<ProcessOutput>) -> Self {
        Self {
            processes: Arc::new(RwLock::new(HashMap::new())),
            output_tx,
        }
    }

    /// Find the Claude CLI executable
    fn find_claude_cli() -> Option<String> {
        let home = std::env::var("HOME").ok()?;
        
        // Check common locations
        let paths = [
            format!("{}/.claude/local/claude", home),
            "/usr/local/bin/claude".to_string(),
            "/opt/homebrew/bin/claude".to_string(),
        ];

        for path in paths {
            if Path::new(&path).exists() {
                return Some(path);
            }
        }

        // Try PATH via which
        std::process::Command::new("which")
            .arg("claude")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    }

    /// Spawn a new Claude CLI process for a workspace
    pub async fn spawn(
        &self,
        agent_id: String,
        workspace_path: String,
        session_id: String,
        initial_prompt: Option<String>,
    ) -> Result<(), String> {
        let claude_path = Self::find_claude_cli()
            .ok_or("Claude CLI not found. Please ensure 'claude' is installed.")?;

        tracing::info!(
            "Spawning Claude CLI: {} in {}",
            claude_path,
            workspace_path
        );

        let mut cmd = Command::new(&claude_path);
        cmd.args([
            "--print",
            "--output-format", "stream-json",
            "--input-format", "stream-json",
            "--verbose",
        ])
        .current_dir(&workspace_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn Claude CLI: {}", e))?;

        let mut stdin = child.stdin.take().ok_or("Failed to capture stdin")?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // Create channel for sending messages to stdin
        let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<String>();

        let output_tx = self.output_tx.clone();
        let agent_id_clone = agent_id.clone();
        let session_id_clone = session_id.clone();
        let processes = self.processes.clone();

        // Send initial prompt if provided
        if let Some(prompt) = initial_prompt {
            let msg = serde_json::json!({
                "type": "user",
                "message": {
                    "content": prompt
                }
            });
            let mut line = serde_json::to_string(&msg).unwrap();
            line.push('\n');
            stdin.write_all(line.as_bytes()).await.ok();
            stdin.flush().await.ok();
        }

        // Spawn task to handle stdin writes
        let stdin_handle = tokio::spawn(async move {
            while let Some(msg) = stdin_rx.recv().await {
                if stdin.write_all(msg.as_bytes()).await.is_err() {
                    break;
                }
                if stdin.flush().await.is_err() {
                    break;
                }
            }
        });

        // Spawn task to read stdout/stderr
        let child_handle = tokio::spawn(async move {
            Self::read_output(
                child,
                stdout,
                stderr,
                output_tx,
                agent_id_clone.clone(),
                session_id_clone.clone(),
            )
            .await;

            stdin_handle.abort();

            // Remove process when done
            let mut procs = processes.write();
            procs.remove(&agent_id_clone);
            tracing::info!("Claude process {} ended", agent_id_clone);
        });

        let process = ManagedProcess {
            id: agent_id.clone(),
            workspace_path,
            session_id,
            stdin_tx,
            child_handle,
        };

        let mut procs = self.processes.write();
        procs.insert(agent_id, process);

        Ok(())
    }

    async fn read_output(
        mut child: Child,
        stdout: Option<tokio::process::ChildStdout>,
        stderr: Option<tokio::process::ChildStderr>,
        output_tx: mpsc::UnboundedSender<ProcessOutput>,
        agent_id: String,
        session_id: String,
    ) {
        // Read stdout
        if let Some(stdout) = stdout {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();

            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!("Claude output: {}", line);

                // Try to parse as JSON
                if let Ok(msg) = serde_json::from_str::<ClaudeMessage>(&line) {
                    let (content, is_partial, is_error) = match msg {
                        ClaudeMessage::Assistant { message, .. } => {
                            (message.content, message.partial, false)
                        }
                        ClaudeMessage::Result { result, is_error, .. } => {
                            (result.unwrap_or_default(), false, is_error)
                        }
                        ClaudeMessage::System { message, .. } => {
                            (message.unwrap_or_default(), false, false)
                        }
                        ClaudeMessage::User { message, .. } => {
                            (message.content, false, false)
                        }
                    };

                    if !content.is_empty() {
                        let _ = output_tx.send(ProcessOutput {
                            agent_id: agent_id.clone(),
                            session_id: session_id.clone(),
                            content,
                            is_partial,
                            is_error,
                        });
                    }
                } else {
                    // Send raw line if not valid JSON
                    let _ = output_tx.send(ProcessOutput {
                        agent_id: agent_id.clone(),
                        session_id: session_id.clone(),
                        content: line,
                        is_partial: false,
                        is_error: false,
                    });
                }
            }
        }

        // Read stderr for errors
        if let Some(stderr) = stderr {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();

            while let Ok(Some(line)) = lines.next_line().await {
                tracing::warn!("Claude stderr: {}", line);
                let _ = output_tx.send(ProcessOutput {
                    agent_id: agent_id.clone(),
                    session_id: session_id.clone(),
                    content: format!("[stderr] {}", line),
                    is_partial: false,
                    is_error: true,
                });
            }
        }

        // Wait for child to exit
        let _ = child.wait().await;
    }

    /// Send a message to a running process (non-async, uses channel)
    pub async fn send_message(&self, agent_id: &str, message: &str) -> Result<(), String> {
        // Get the stdin sender without holding lock across await
        let stdin_tx = {
            let procs = self.processes.read();
            let process = procs
                .get(agent_id)
                .ok_or("Process not found")?;
            process.stdin_tx.clone()
        };

        let msg = serde_json::json!({
            "type": "user",
            "message": {
                "content": message
            }
        });

        let mut line = serde_json::to_string(&msg)
            .map_err(|e| format!("Failed to serialize message: {}", e))?;
        line.push('\n');

        stdin_tx
            .send(line)
            .map_err(|e| format!("Failed to send message: {}", e))?;

        Ok(())
    }

    /// Kill a running process
    pub async fn kill(&self, agent_id: &str) -> Result<(), String> {
        let handle = {
            let mut procs = self.processes.write();
            procs.remove(agent_id).map(|p| p.child_handle)
        };
        
        if let Some(handle) = handle {
            handle.abort();
        }
        Ok(())
    }

    /// Check if a process is running
    pub fn is_running(&self, agent_id: &str) -> bool {
        self.processes.read().contains_key(agent_id)
    }

    /// Get list of running process IDs
    pub fn running_agents(&self) -> Vec<String> {
        self.processes.read().keys().cloned().collect()
    }
}
