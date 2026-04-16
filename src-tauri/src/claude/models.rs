use std::process::Command;

use super::discovery::{
    claude_supports_permission_mode, claude_supports_permission_prompt_tool,
    claude_supports_stream_json, find_permission_bridge_path,
};

pub fn normalize_permission_mode(mode: Option<&str>) -> &'static str {
    match mode.map(|v| v.trim()) {
        Some("dangerouslySkipPermissions") => "dangerouslySkipPermissions",
        Some("bypassPermissions") => "bypassPermissions",
        Some("plan") => "plan",
        Some("default") => "default",
        Some("acceptEdits") => "acceptEdits",
        Some("dontAsk") => "dontAsk",
        Some("auto") => "auto",
        _ => "dangerouslySkipPermissions",
    }
}

pub fn normalize_model(model: Option<&str>) -> Option<String> {
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

pub fn normalize_effort(effort: Option<&str>) -> Option<&'static str> {
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
pub fn resolve_model_for_runtime(requested_model: Option<&str>, is_bedrock: bool) -> Option<String> {
    let value = requested_model
        .map(str::trim)
        .filter(|v| !v.is_empty())?;

    if is_bedrock {
        match value {
            "opus" => return Some("global.anthropic.claude-opus-4-7-v1".to_string()),
            "sonnet" => return Some("global.anthropic.claude-sonnet-4-6".to_string()),
            "haiku" => return Some("global.anthropic.claude-haiku-4-5-20251001-v1:0".to_string()),
            _ => {}
        }
    } else {
        match value {
            "opus" => return Some("claude-opus-4-7".to_string()),
            "sonnet" => return Some("claude-sonnet-4-6".to_string()),
            "haiku" => return Some("claude-haiku-4-5".to_string()),
            _ => {}
        }
    }

    Some(value.to_string())
}

/// Permission modes that require interactive stdin for tool-approval control messages.
/// All modes can produce permission prompts except those that explicitly skip or
/// auto-approve everything.
pub fn needs_interactive_permissions(permission_mode: &str) -> bool {
    !matches!(permission_mode, "dangerouslySkipPermissions" | "bypassPermissions" | "dontAsk")
}

/// Build the CLI arguments for a Claude request.  Returns `true` when the
/// caller must send the prompt via stdin (interactive permission mode) rather
/// than as a `-p` CLI arg.
pub fn append_claude_request_args(
    cmd: &mut Command,
    claude_path: &str,
    permission_mode: &str,
    model: Option<&str>,
    effort: Option<&str>,
    claude_session_id: Option<&str>,
    prompt: &str,
    workspace_id: &str,
    agent_id: &str,
    http_port: u16,
) -> bool {
    let supports_stream = claude_supports_stream_json(claude_path);
    let has_permission_prompt_tool = claude_supports_permission_prompt_tool(claude_path);
    let wants_interactive = needs_interactive_permissions(permission_mode) && supports_stream;

    // When --permission-prompt-tool is available AND the bridge script exists,
    // delegate permission handling to the MCP bridge (HTTP-based) instead of
    // using stdin control_request/control_response.
    let bridge_path = if wants_interactive && has_permission_prompt_tool {
        find_permission_bridge_path()
    } else {
        None
    };
    let _use_mcp_bridge = bridge_path.is_some();
    // Stdin must be piped whenever the CLI supports stream-json, regardless of
    // permission mode.  Question answers (AskUserQuestion) and follow-up messages
    // are always sent via stdin — this is orthogonal to permission handling.
    let interactive = supports_stream;

    cmd.arg("--print");
    if supports_stream {
        cmd.arg("--verbose");
        cmd.args(["--output-format", "stream-json"]);
    }
    if permission_mode == "dangerouslySkipPermissions" {
        cmd.arg("--dangerously-skip-permissions");
    } else if claude_supports_permission_mode(claude_path) {
        cmd.args(["--permission-mode", permission_mode]);
    }
    if let Some(bridge_path) = bridge_path {
        let mcp_config = serde_json::json!({
            "mcpServers": {
                "perm_bridge": {
                    "command": "node",
                    "args": [bridge_path],
                    "env": {
                        "ORCHESTRATOR_HTTP_PORT": http_port.to_string(),
                        "ORCHESTRATOR_WORKSPACE_ID": workspace_id,
                        "ORCHESTRATOR_AGENT_ID": agent_id
                    }
                }
            }
        });
        cmd.args(["--mcp-config", &mcp_config.to_string()]);
        cmd.args(["--permission-prompt-tool", "mcp__perm_bridge__check_permission"]);
    }
    if interactive {
        // Legacy fallback: bidirectional stream-json for control_request/control_response.
        cmd.args(["--input-format", "stream-json"]);
    }
    if let Some(model) = model {
        cmd.args(["--model", model]);
    }
    if let Some(effort) = effort {
        cmd.args(["--effort", effort]);
    }
    if let Some(claude_sid) = claude_session_id {
        cmd.args(["--resume", claude_sid]);
    }
    if !interactive {
        cmd.args(["-p", prompt]);
    }
    interactive
}

/// Write a JSON user message to the Claude CLI stdin (for --input-format stream-json).
pub fn write_stdin_user_message(stdin: &mut std::process::ChildStdin, prompt: &str) -> std::io::Result<()> {
    use std::io::Write;
    let msg = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": prompt },
    });
    writeln!(stdin, "{}", msg)?;
    stdin.flush()
}

/// Write a permission control_response to the Claude CLI stdin.
pub fn write_stdin_permission_response(
    stdin: &mut std::process::ChildStdin,
    request_id: &str,
    allow: bool,
    original_input: Option<&serde_json::Value>,
) -> std::io::Result<()> {
    use std::io::Write;
    let response_body = if allow {
        let mut r = serde_json::json!({ "behavior": "allow" });
        if let Some(input) = original_input {
            r.as_object_mut()
                .unwrap()
                .insert("updatedInput".to_string(), input.clone());
        }
        r
    } else {
        serde_json::json!({ "behavior": "deny", "message": "User denied this action" })
    };
    let msg = serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": response_body,
        }
    });
    writeln!(stdin, "{}", msg)?;
    stdin.flush()
}
