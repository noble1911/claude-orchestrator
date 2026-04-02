use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;

use tauri::Emitter;

use crate::database::Database;
use crate::helpers::now_rfc3339;
use crate::types::{AgentMessage, AgentRunStateEvent};
use crate::websocket_server::{WebSocketServer, WsResponse};

pub fn stream_event_payload<'a>(event: &'a Value) -> &'a Value {
    if event.get("type").and_then(|v| v.as_str()) == Some("stream_event") {
        event.get("event").unwrap_or(event)
    } else {
        event
    }
}

pub fn extract_stream_session_id(event: &Value) -> Option<String> {
    event
        .get("session_id")
        .and_then(|v| v.as_str())
        .or_else(|| stream_event_payload(event).get("session_id").and_then(|v| v.as_str()))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

pub fn choose_assistant_text(delta_text: &str, snapshot_text: Option<&String>) -> Option<String> {
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

pub fn normalize_text_for_dedupe(text: &str) -> String {
    text.replace("\r\n", "\n").trim().to_string()
}

pub fn emit_agent_message_with_options(
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
        .unwrap_or_else(now_rfc3339);
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

pub fn emit_agent_message(
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

pub fn emit_agent_run_state(
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

pub fn summarize_tool_call(tool_name: &str, input_json: &str) -> Option<String> {
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

pub fn extract_exit_plan_text(tool_name: &str, input_json: &str) -> Option<String> {
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
pub enum ActivityEvent {
    Activity(String),
    Question(String),
    Plan(String),
}

pub fn parse_stream_event_for_activity(
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

pub fn extract_result_text(event: &Value) -> Option<String> {
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

pub fn extract_assistant_message_text(event: &Value) -> Option<String> {
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

pub fn extract_stream_error_text(payload: &Value) -> Option<String> {
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

pub fn update_text_blocks_from_stream_event(payload: &Value, text_blocks: &mut HashMap<i64, String>) -> bool {
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

pub fn build_text_from_blocks(text_blocks: &HashMap<i64, String>) -> Option<String> {
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

pub fn choose_streaming_assistant_text(
    text_blocks: &HashMap<i64, String>,
    delta_text: &str,
    snapshot_text: Option<&String>,
) -> Option<String> {
    build_text_from_blocks(text_blocks).or_else(|| choose_assistant_text(delta_text, snapshot_text))
}
