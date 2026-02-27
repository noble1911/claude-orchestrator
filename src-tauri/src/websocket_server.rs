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
use tokio_tungstenite::{accept_async, tungstenite::Message};

pub struct WebSocketServer {
    clients: Arc<RwLock<HashMap<String, ClientHandle>>>,
    subscriptions: Arc<RwLock<HashMap<String, HashSet<String>>>>, // workspace_id -> client_ids
    port: u16,
    message_tx: mpsc::UnboundedSender<ServerCommand>,
}

struct ClientHandle {
    id: String,
    sender: mpsc::UnboundedSender<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsMessage {
    Connect { client_name: String },
    ListWorkspaces,
    GetMessages { workspace_id: String },
    ListFiles { workspace_id: String, relative_path: Option<String> },
    ReadFile { workspace_id: String, relative_path: String, max_bytes: Option<usize> },
    ListChanges { workspace_id: String },
    RunChecks { workspace_id: String },
    Subscribe { workspace_id: String },
    Unsubscribe { workspace_id: String },
    SendMessage { workspace_id: String, message: String },
    StartAgent { workspace_id: String },
    StopAgent { workspace_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WsResponse {
    Connected {
        server_name: String,
        features: Vec<String>,
    },
    WorkspaceList {
        workspaces: Vec<WorkspaceInfo>,
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
        content: String,
        is_error: bool,
        timestamp: String,
    },
    AgentStarted {
        workspace_id: String,
        agent_id: String,
    },
    AgentStopped {
        workspace_id: String,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    pub branch: String,
    pub status: String,
    pub has_agent: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageInfo {
    pub agent_id: String,
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
    SendMessage { workspace_id: String, message: String, response_tx: mpsc::UnboundedSender<String> },
    StartAgent { workspace_id: String, response_tx: mpsc::UnboundedSender<String> },
    StopAgent { workspace_id: String, response_tx: mpsc::UnboundedSender<String> },
    ListWorkspaces { response_tx: mpsc::UnboundedSender<String> },
    GetMessages { workspace_id: String, response_tx: mpsc::UnboundedSender<String> },
    ListFiles { workspace_id: String, relative_path: Option<String>, response_tx: mpsc::UnboundedSender<String> },
    ReadFile { workspace_id: String, relative_path: String, max_bytes: Option<usize>, response_tx: mpsc::UnboundedSender<String> },
    ListChanges { workspace_id: String, response_tx: mpsc::UnboundedSender<String> },
    RunChecks { workspace_id: String, response_tx: mpsc::UnboundedSender<String> },
}

impl WebSocketServer {
    pub fn new(port: u16, message_tx: mpsc::UnboundedSender<ServerCommand>) -> Self {
        Self {
            clients: Arc::new(RwLock::new(HashMap::new())),
            subscriptions: Arc::new(RwLock::new(HashMap::new())),
            port,
            message_tx,
        }
    }

    pub async fn start(&self) -> Result<(), String> {
        let addr = format!("0.0.0.0:{}", self.port);
        let listener = TcpListener::bind(&addr)
            .await
            .map_err(|e| format!("Failed to bind: {}", e))?;

        tracing::info!("WebSocket server listening on {}", addr);

        let clients = self.clients.clone();
        let subscriptions = self.subscriptions.clone();
        let message_tx = self.message_tx.clone();

        tokio::spawn(async move {
            while let Ok((stream, addr)) = listener.accept().await {
                let clients = clients.clone();
                let subscriptions = subscriptions.clone();
                let message_tx = message_tx.clone();
                tokio::spawn(handle_connection(stream, addr, clients, subscriptions, message_tx));
            }
        });

        Ok(())
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

    // Handle incoming messages
    let client_id_clone = client_id.clone();
    while let Some(msg) = ws_receiver.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                if let Ok(ws_msg) = serde_json::from_str::<WsMessage>(&text) {
                    tracing::debug!("Received from {}: {:?}", client_id_clone, ws_msg);
                    
                    match ws_msg {
                        WsMessage::Connect { client_name } => {
                            tracing::info!("Client {} identified as: {}", client_id_clone, client_name);
                        }
                        
                        WsMessage::ListWorkspaces => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx.send(ServerCommand::ListWorkspaces { response_tx }).is_ok() {
                                if let Some(response) = response_rx.recv().await {
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
                        
                        WsMessage::SendMessage { workspace_id, message } => {
                            let (response_tx, mut response_rx) = mpsc::unbounded_channel();
                            if message_tx.send(ServerCommand::SendMessage { 
                                workspace_id, 
                                message,
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
    
    // Remove client
    {
        let mut clients = clients.write();
        clients.remove(&client_id);
    }
    
    send_task.abort();
    tracing::info!("Client {} disconnected", client_id);
}
