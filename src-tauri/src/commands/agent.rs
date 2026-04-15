use crate::helpers::*;
use crate::types::*;
use crate::websocket_server::WsResponse;
use crate::AppState;

/// Transition workspace status when an agent starts.
pub fn status_for_agent_start(current: &WorkspaceStatus) -> WorkspaceStatus {
    match current {
        WorkspaceStatus::InReview | WorkspaceStatus::Merged => current.clone(),
        _ => WorkspaceStatus::Running,
    }
}

/// Transition workspace status when an agent stops.
pub fn status_for_agent_stop(current: &WorkspaceStatus) -> WorkspaceStatus {
    match current {
        WorkspaceStatus::InReview | WorkspaceStatus::Merged => current.clone(),
        _ => WorkspaceStatus::Idle,
    }
}

pub fn list_agents(state: &AppState) -> Result<Vec<Agent>, String> {
    let agents = state.agents.read();
    Ok(agents.values().cloned().collect())
}

pub fn stop_agent(state: &AppState, agent_id: String) -> Result<(), String> {
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

    // Drop pending permission requests that belong to *this* agent's workspace.
    // Dropping the oneshot senders causes the HTTP handler to auto-deny (channel recv error).
    // Other agents' permissions are left intact.
    if let Some(ref ws_id) = workspace_id {
        let mut pending = state.pending_permission_requests.write();
        pending.retain(|_req_id, (pending_ws_id, _sender)| pending_ws_id != ws_id);
    }

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

            if let Some(ws) = &state.ws_server {
                ws.broadcast_to_workspace(
                    &ws_id,
                    &WsResponse::AgentStopped {
                        workspace_id: ws_id.clone(),
                    },
                );
            }
        }
    }

    // Broadcast completion AFTER all state mutations are done so wait
    // subscribers see the final workspace status (idle) and agent state.
    if let Some(ref ws_id) = workspace_id {
        state.last_completion_reason.write()
            .insert(ws_id.clone(), crate::helpers::CompletionReason::Interrupted);
        let _ = state.agent_completions.send(ws_id.clone());
    }

    Ok(())
}

pub fn interrupt_agent(state: &AppState, agent_id: String) -> Result<(), String> {
    let pid = {
        let pids = state.child_pids.read();
        pids.get(&agent_id).copied()
    };
    match pid {
        Some(pid) => {
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGINT);
            }
            Ok(())
        }
        None => Err("No running process found for this agent".into()),
    }
}

/// Shared helper: send a permission control_response to the Claude CLI stdin.
pub fn send_permission_response(
    app_state: &AppState,
    agent_id: &str,
    request_id: &str,
    allow: bool,
    deny_message: Option<String>,
    updated_input: Option<serde_json::Value>,
) -> Result<(), String> {
    let handle = {
        let stdins = app_state.agent_stdin.read();
        stdins.get(agent_id).cloned()
    };
    let handle = handle.ok_or("No active CLI process for this agent")?;

    let response_body = if allow {
        let mut r = serde_json::json!({ "behavior": "allow" });
        if let Some(input) = updated_input {
            r.as_object_mut()
                .unwrap()
                .insert("updatedInput".to_string(), input);
        }
        r
    } else {
        serde_json::json!({
            "behavior": "deny",
            "message": deny_message.unwrap_or_else(|| "User denied this action".to_string())
        })
    };
    let msg = serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": response_body,
        }
    });

    let mut stdin = handle
        .lock()
        .map_err(|e| format!("Stdin lock poisoned: {}", e))?;
    use std::io::Write;
    writeln!(stdin, "{}", msg).map_err(|e| format!("Failed to write to stdin: {}", e))?;
    stdin
        .flush()
        .map_err(|e| format!("Failed to flush stdin: {}", e))?;

    Ok(())
}

pub fn respond_to_permission(
    state: &AppState,
    agent_id: String,
    request_id: String,
    allow: bool,
    deny_message: Option<String>,
    updated_input: Option<serde_json::Value>,
) -> Result<(), String> {
    // Try the MCP bridge path first (permission requested via HTTP long-poll).
    let pending_entry = state
        .pending_permission_requests
        .write()
        .remove(&request_id);
    if let Some((_ws_id, tx)) = pending_entry {
        let response = if allow {
            let mut r = serde_json::json!({ "behavior": "allow" });
            if let Some(ref input) = updated_input {
                r.as_object_mut()
                    .unwrap()
                    .insert("updatedInput".to_string(), input.clone());
            }
            r
        } else {
            serde_json::json!({
                "behavior": "deny",
                "message": deny_message.as_deref().unwrap_or("User denied this action")
            })
        };
        let _ = tx.send(response);
        return Ok(());
    }
    // Fall back to stdin control_response.
    send_permission_response(state, &agent_id, &request_id, allow, deny_message, updated_input)
}

pub fn get_agent_messages(
    state: &AppState,
    workspace_id: String,
) -> Result<Vec<AgentMessage>, String> {
    state
        .db
        .get_messages_by_workspace(&workspace_id)
        .map_err(|e| format!("Failed to get messages: {}", e))
}
