//! WebSocket server for mobile/web client connections
//!
//! Provides a WebSocket API for remote clients to interact with Claude agents.

use futures_util::{SinkExt, StreamExt};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::{accept_async, tungstenite::Message};

pub struct WebSocketServer {
    clients: Arc<RwLock<HashMap<String, ClientHandle>>>,
    subscriptions: Arc<RwLock<HashMap<String, HashSet<String>>>>, // workspace_id -> client_ids
    authenticated_clients: Arc<RwLock<HashSet<String>>>,
    pairing_code: Arc<RwLock<Option<String>>>,
    port: u16,
    message_tx: mpsc::UnboundedSender<ServerCommand>,
    accept_task: Arc<RwLock<Option<JoinHandle<()>>>>,
    connection_tasks: Arc<RwLock<Vec<JoinHandle<()>>>>,
}

struct ClientHandle {
    id: String,
    sender: mpsc::UnboundedSender<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsMessage {
    Authenticate { pairing_code: String },
    Connect { client_name: String },
    ListRepositories,
    AddRepository { path: String },
    RemoveRepository { repo_id: String },
    ListWorkspaces { repo_id: Option<String> },
    CreateWorkspace { repo_id: String, name: String },
    RenameWorkspace { workspace_id: String, name: String },
    RemoveWorkspace { workspace_id: String },
    GetMessages { workspace_id: String },
    ListFiles { workspace_id: String, relative_path: Option<String> },
    ReadFile { workspace_id: String, relative_path: String, max_bytes: Option<usize> },
    ListChanges { workspace_id: String },
    RunChecks { workspace_id: String },
    Subscribe { workspace_id: String },
    Unsubscribe { workspace_id: String },
    SendMessage {
        workspace_id: String,
        message: String,
        permission_mode: Option<String>,
        model: Option<String>,
        effort: Option<String>,
    },
    StartAgent { workspace_id: String },
    StopAgent { workspace_id: String },
    InterruptAgent { workspace_id: String },
    SetWorkspaceStatus { workspace_id: String, status: String },
    ToggleWorkspacePin { workspace_id: String },
    UpdateWorkspaceNotes { workspace_id: String, notes: String },
    UpdateWorkspaceOrder { workspace_id: String, display_order: i32 },
    ReadChangeDiff { workspace_id: String, file_path: String },
    RunTerminalCommand { workspace_id: String, command: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsResponse {
    Connected {
        server_name: String,
        features: Vec<String>,
    },
    RepositoryList {
        repositories: Vec<RepositoryInfo>,
    },
    RepositoryAdded {
        repository: RepositoryInfo,
    },
    RepositoryRemoved {
        repo_id: String,
    },
    WorkspaceList {
        workspaces: Vec<WorkspaceInfo>,
    },
    WorkspaceCreated {
        workspace: WorkspaceInfo,
    },
    WorkspaceRenamed {
        workspace: WorkspaceInfo,
    },
    WorkspaceRemoved {
        workspace_id: String,
    },
    MessageHistory {
        workspace_id: String,
        messages: Vec<MessageInfo>,
    },
    FilesList {
        workspace_id: String,
        relative_path: String,
        entries: Vec<FileEntryInfo>,
    },
    FileContent {
        workspace_id: String,
        path: String,
        content: String,
    },
    ChangesList {
        workspace_id: String,
        changes: Vec<ChangeInfo>,
    },
    ChecksResult {
        workspace_id: String,
        checks: Vec<CheckInfo>,
    },
    Subscribed {
        workspace_id: String,
    },
    Unsubscribed {
        workspace_id: String,
    },
    AgentMessage {
        workspace_id: String,
        role: String,
        content: String,
        is_error: bool,
        timestamp: String,
    },
    AgentStarted {
        workspace_id: String,
        agent_id: String,
    },
    AgentRunState {
        workspace_id: String,
        agent_id: String,
        running: bool,
        timestamp: String,
    },
    AgentStopped {
        workspace_id: String,
    },
    AgentInterrupted {
        workspace_id: String,
    },
    Authenticated {
        client_id: String,
    },
    AuthenticationFailed {
        reason: String,
    },
    WorkspaceUpdated {
        workspace: WorkspaceInfo,
    },
    ChangeDiff {
        workspace_id: String,
        file_path: String,
        diff: String,
    },
    TerminalOutput {
        workspace_id: String,
        stdout: String,
        stderr: String,
        exit_code: Option<i32>,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    pub id: String,
    pub repo_id: String,
    pub name: String,
    pub branch: String,
    pub status: String,
    pub has_agent: bool,
    pub pinned_at: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepositoryInfo {
    pub id: String,
    pub path: String,
    pub name: String,
    pub default_branch: String,
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageInfo {
    pub agent_id: String,
    pub role: String,
    pub content: String,
    pub is_error: bool,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeInfo {
    pub status: String,
    pub path: String,
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckInfo {
    pub name: String,
    pub command: String,
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u128,
    pub skipped: bool,
}

// Commands from WebSocket to main app
pub enum ServerCommand {
    ListRepositories { response_tx: mpsc::UnboundedSender<String> },
    AddRepository { path: String, response_tx: mpsc::UnboundedSender<String> },
    RemoveRepository { repo_id: String, response_tx: mpsc::UnboundedSender<String> },
    SendMessage {
        workspace_id: String,
        message: String,
        permission_mode: Option<String>,
        model: Option<String>,
        effort: Option<String>,
        response_tx: mpsc::UnboundedSender<String>,
    },
    CreateWorkspace { repo_id: String, name: String, response_tx: mpsc::UnboundedSender<String> },
    RenameWorkspace { workspace_id: String, name: String, response_tx: mpsc::UnboundedSender<String> },
    RemoveWorkspace { workspace_id: String, response_tx: mpsc::UnboundedSender<String> },
    StartAgent { workspace_id: String, response_tx: mpsc::UnboundedSender<String> },
    StopAgent { workspace_id: String, response_tx: mpsc::UnboundedSender<String> },
    ListWorkspaces { repo_id: Option<String>, response_tx: mpsc::UnboundedSender<String> },
    GetMessages { workspace_id: String, response_tx: mpsc::UnboundedSender<String> },
    ListFiles { workspace_id: String, relative_path: Option<String>, response_tx: mpsc::UnboundedSender<String> },
    ReadFile { workspace_id: String, relative_path: String, max_bytes: Option<usize>, response_tx: mpsc::UnboundedSender<String> },
    ListChanges { workspace_id: String, response_tx: mpsc::UnboundedSender<String> },
    RunChecks { workspace_id: String, response_tx: mpsc::UnboundedSender<String> },
    InterruptAgent { workspace_id: String, response_tx: mpsc::UnboundedSender<String> },
    SetWorkspaceStatus { workspace_id: String, status: String, response_tx: mpsc::UnboundedSender<String> },
    ToggleWorkspacePin { workspace_id: String, response_tx: mpsc::UnboundedSender<String> },
    UpdateWorkspaceNotes { workspace_id: String, notes: String, response_tx: mpsc::UnboundedSender<String> },
    UpdateWorkspaceOrder { workspace_id: String, display_order: i32, response_tx: mpsc::UnboundedSender<String> },
    ReadChangeDiff { workspace_id: String, file_path: String, response_tx: mpsc::UnboundedSender<String> },
    RunTerminalCommand { workspace_id: String, command: String, response_tx: mpsc::UnboundedSender<String> },
    ClientCountChanged { connected_clients: usize },
}

impl WebSocketServer {
    pub fn new(port: u16, message_tx: mpsc::UnboundedSender<ServerCommand>, pairing_code: Arc<RwLock<Option<String>>>) -> Self {
        Self {
            clients: Arc::new(RwLock::new(HashMap::new())),
            subscriptions: Arc::new(RwLock::new(HashMap::new())),
            authenticated_clients: Arc::new(RwLock::new(HashSet::new())),
            pairing_code,
            port,
            message_tx,
            accept_task: Arc::new(RwLock::new(None)),
            connection_tasks: Arc::new(RwLock::new(Vec::new())),
        }
    }

    pub async fn start(&self) -> Result<(), String> {
        if let Some(handle) = self.accept_task.read().as_ref() {
            if !handle.is_finished() {
                return Ok(());
            }
        }

        let addr = format!("0.0.0.0:{}", self.port);
        let listener = TcpListener::bind(&addr)
            .await
            .map_err(|e| format!("Failed to bind: {}", e))?;

        tracing::info!("WebSocket server listening on {}", addr);

        let clients = self.clients.clone();
        let subscriptions = self.subscriptions.clone();
        let authenticated_clients = self.authenticated_clients.clone();
        let pairing_code = self.pairing_code.clone();
        let message_tx = self.message_tx.clone();
        let connection_tasks = self.connection_tasks.clone();

        let accept_handle = tokio::spawn(async move {
            while let Ok((stream, addr)) = listener.accept().await {
                let clients = clients.clone();
                let subscriptions = subscriptions.clone();
                let authenticated_clients = authenticated_clients.clone();
                let pairing_code = pairing_code.clone();
                let message_tx = message_tx.clone();
                let handle = tokio::spawn(handle_connection(stream, addr, clients, subscriptions, authenticated_clients, pairing_code, message_tx));
                let mut tasks = connection_tasks.write();
                tasks.retain(|task| !task.is_finished());
                tasks.push(handle);
            }
        });
        *self.accept_task.write() = Some(accept_handle);

        Ok(())
    }

    pub fn stop(&self) {
        if let Some(handle) = self.accept_task.write().take() {
            handle.abort();
        }

        let mut tasks = self.connection_tasks.write();
        for task in tasks.drain(..) {
            task.abort();
        }

        self.subscriptions.write().clear();
        self.clients.write().clear();
        self.authenticated_clients.write().clear();
        let _ = self
            .message_tx
            .send(ServerCommand::ClientCountChanged { connected_clients: 0 });
        tracing::info!("WebSocket server stopped");
    }

    pub fn broadcast_to_workspace(&self, workspace_id: &str, message: &WsResponse) {
        let json = serde_json::to_string(message).unwrap();
        let subscriptions = self.subscriptions.read();
        let clients = self.clients.read();
        
        if let Some(subscriber_ids) = subscriptions.get(workspace_id) {
            for client_id in subscriber_ids {
                if let Some(client) = clients.get(client_id) {
                    let _ = client.sender.send(json.clone());
                }
            }
        }
    }

    pub fn broadcast_all(&self, message: &WsResponse) {
        let json = serde_json::to_string(message).unwrap();
        let clients = self.clients.read();
        for client in clients.values() {
            let _ = client.sender.send(json.clone());
        }
    }

    pub fn client_count(&self) -> usize {
        self.clients.read().len()
    }
}

async fn handle_connection(
    stream: TcpStream,
    addr: SocketAddr,
    clients: Arc<RwLock<HashMap<String, ClientHandle>>>,
    subscriptions: Arc<RwLock<HashMap<String, HashSet<String>>>>,
    authenticated_clients: Arc<RwLock<HashSet<String>>>,
    pairing_code: Arc<RwLock<Option<String>>>,
    message_tx: mpsc::UnboundedSender<ServerCommand>,
) {
    let ws_stream = match accept_async(stream).await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("WebSocket handshake failed: {}", e);
            return;
        }
    };

    let client_id = uuid::Uuid::new_v4().to_string();
    tracing::info!("Client {} connected from {}", client_id, addr);

    let (mut ws_sender, mut ws_receiver) = ws_stream.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // Register client
    {
        let mut clients = clients.write();
        clients.insert(
            client_id.clone(),
            ClientHandle {
                id: client_id.clone(),
                sender: tx.clone(),
            },
        );
    }
    {
        let connected_clients = clients.read().len();
        let _ = message_tx.send(ServerCommand::ClientCountChanged { connected_clients });
    }

    // Send welcome message
    let welcome = WsResponse::Connected {
        server_name: "Claude Orchestrator".to_string(),
        features: vec![
            "workspaces".to_string(),
            "streaming".to_string(),
            "agents".to_string(),
            "files".to_string(),
            "changes".to_string(),
            "checks".to_string(),
            "authentication".to_string(),
        ],
    };
    let _ = ws_sender
        .send(Message::Text(serde_json::to_string(&welcome).unwrap().into()))
        .await;

    // Handle outgoing messages
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sender.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    // Check if authentication is required (pairing code is set)
    let requires_auth = pairing_code.read().is_some();

    // Handle incoming messages
    let client_id_clone = client_id.clone();
    while let Some(msg) = ws_receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                if let Ok(ws_msg) = serde_json::from_str::<WsMessage>(&text) {
                    tracing::debug!("Received from {}: {:?}", client_id_clone, ws_msg);

                    // Authentication gate: if pairing code is set, require auth first
                    if requires_auth && !authenticated_clients.read().contains(&client_id_clone) {
                        match ws_msg {
                            WsMessage::Authenticate { pairing_code: code } => {
                                let expected = pairing_code.read().clone();
                                if expected.as_deref() == Some(&code) {
                                    authenticated_clients.write().insert(client_id_clone.clone());
                                    tracing::info!("Client {} authenticated successfully", client_id_clone);
                                    let response = WsResponse::Authenticated { client_id: client_id_clone.clone() };
                                    let _ = tx.send(serde_json::to_string(&response).unwrap());
                                } else {
                                    tracing::warn!("Client {} failed authentication", client_id_clone);
                                    let response = WsResponse::AuthenticationFailed {
                                        reason: "Invalid pairing code".to_string(),
                                    };
                                    let _ = tx.send(serde_json::to_string(&response).unwrap());
                                }
                                continue;
                            }
                            _ => {
                                let response = WsResponse::AuthenticationFailed {
                                    reason: "Authentication required. Send an authenticate message with your pairing code.".to_string(),
                                };
                                let _ = tx.send(serde_json::to_string(&response).unwrap());
                                continue;
                            }
                        }
                    }

                    match ws_msg {
                        WsMessage::Authenticate { .. } => {
                            // Already authenticated or no auth required
                            let response = WsResponse::Authenticated { client_id: client_id_clone.clone() };
                            let _ = tx.send(serde_json::to_string(&response).unwrap());
                        }

                        WsMessage::Connect { client_name } => {
                            tracing::info!("Client {} identified as: {}", client_id_clone, client_name);
                        }

                        WsMessage::ListRepositories => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx.send(ServerCommand::ListRepositories { response_tx }).is_ok() {
                                if let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::AddRepository { path } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx
                                .send(ServerCommand::AddRepository { path, response_tx })
                                .is_ok()
                            {
                                while let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::RemoveRepository { repo_id } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx
                                .send(ServerCommand::RemoveRepository { repo_id, response_tx })
                                .is_ok()
                            {
                                while let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::ListWorkspaces { repo_id } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx
                                .send(ServerCommand::ListWorkspaces { repo_id, response_tx })
                                .is_ok()
                            {
                                if let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::CreateWorkspace { repo_id, name } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx
                                .send(ServerCommand::CreateWorkspace {
                                    repo_id,
                                    name,
                                    response_tx,
                                })
                                .is_ok()
                            {
                                while let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::RenameWorkspace { workspace_id, name } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx
                                .send(ServerCommand::RenameWorkspace {
                                    workspace_id,
                                    name,
                                    response_tx,
                                })
                                .is_ok()
                            {
                                while let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::RemoveWorkspace { workspace_id } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx
                                .send(ServerCommand::RemoveWorkspace {
                                    workspace_id,
                                    response_tx,
                                })
                                .is_ok()
                            {
                                while let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::GetMessages { workspace_id } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx.send(ServerCommand::GetMessages { workspace_id, response_tx }).is_ok() {
                                if let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::ListFiles { workspace_id, relative_path } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx.send(ServerCommand::ListFiles { workspace_id, relative_path, response_tx }).is_ok() {
                                if let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::ReadFile { workspace_id, relative_path, max_bytes } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx.send(ServerCommand::ReadFile { workspace_id, relative_path, max_bytes, response_tx }).is_ok() {
                                if let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::ListChanges { workspace_id } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx.send(ServerCommand::ListChanges { workspace_id, response_tx }).is_ok() {
                                if let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::RunChecks { workspace_id } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx.send(ServerCommand::RunChecks { workspace_id, response_tx }).is_ok() {
                                if let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::Subscribe { workspace_id } => {
                            {
                                let mut subs = subscriptions.write();
                                subs.entry(workspace_id.clone())
                                    .or_insert_with(HashSet::new)
                                    .insert(client_id_clone.clone());
                            }
                            let response = WsResponse::Subscribed { workspace_id };
                            let _ = tx.send(serde_json::to_string(&response).unwrap());
                        }

                        WsMessage::Unsubscribe { workspace_id } => {
                            {
                                let mut subs = subscriptions.write();
                                if let Some(clients) = subs.get_mut(&workspace_id) {
                                    clients.remove(&client_id_clone);
                                }
                            }
                            let response = WsResponse::Unsubscribed { workspace_id };
                            let _ = tx.send(serde_json::to_string(&response).unwrap());
                        }

                        WsMessage::SendMessage {
                            workspace_id,
                            message,
                            permission_mode,
                            model,
                            effort,
                        } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx.send(ServerCommand::SendMessage {
                                workspace_id,
                                message,
                                permission_mode,
                                model,
                                effort,
                                response_tx
                            }).is_ok() {
                                // Response will come via broadcast
                                while let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::StartAgent { workspace_id } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx.send(ServerCommand::StartAgent {
                                workspace_id,
                                response_tx
                            }).is_ok() {
                                if let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::StopAgent { workspace_id } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx.send(ServerCommand::StopAgent {
                                workspace_id,
                                response_tx
                            }).is_ok() {
                                if let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::InterruptAgent { workspace_id } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx.send(ServerCommand::InterruptAgent {
                                workspace_id,
                                response_tx,
                            }).is_ok() {
                                if let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::SetWorkspaceStatus { workspace_id, status } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx.send(ServerCommand::SetWorkspaceStatus {
                                workspace_id,
                                status,
                                response_tx,
                            }).is_ok() {
                                if let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::ToggleWorkspacePin { workspace_id } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx.send(ServerCommand::ToggleWorkspacePin {
                                workspace_id,
                                response_tx,
                            }).is_ok() {
                                if let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::UpdateWorkspaceNotes { workspace_id, notes } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx.send(ServerCommand::UpdateWorkspaceNotes {
                                workspace_id,
                                notes,
                                response_tx,
                            }).is_ok() {
                                if let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::UpdateWorkspaceOrder { workspace_id, display_order } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx.send(ServerCommand::UpdateWorkspaceOrder {
                                workspace_id,
                                display_order,
                                response_tx,
                            }).is_ok() {
                                if let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::ReadChangeDiff { workspace_id, file_path } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx.send(ServerCommand::ReadChangeDiff {
                                workspace_id,
                                file_path,
                                response_tx,
                            }).is_ok() {
                                if let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }

                        WsMessage::RunTerminalCommand { workspace_id, command } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx.send(ServerCommand::RunTerminalCommand {
                                workspace_id,
                                command,
                                response_tx,
                            }).is_ok() {
                                if let Some(response) = response_rx.recv().await {
                                    let _ = tx.send(response);
                                }
                            }
                        }
                    }
                }
            }
            Ok(Message::Close(_)) => break,
            Err(e) => {
                tracing::error!("WebSocket error: {}", e);
                break;
            }
            _ => {}
        }
    }

    // Cleanup - remove from all subscriptions
    {
        let mut subs = subscriptions.write();
        for clients in subs.values_mut() {
            clients.remove(&client_id);
        }
    }

    // Remove client and authenticated status
    {
        let mut clients = clients.write();
        clients.remove(&client_id);
    }
    authenticated_clients.write().remove(&client_id);
    {
        let connected_clients = clients.read().len();
        let _ = message_tx.send(ServerCommand::ClientCountChanged { connected_clients });
    }

    send_task.abort();
    tracing::info!("Client {} disconnected", client_id);
}
