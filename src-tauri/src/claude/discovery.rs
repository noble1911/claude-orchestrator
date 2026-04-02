use std::collections::HashMap;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use super::CLAUDE_HELP_CACHE;

pub fn find_claude_cli_in_path(path_value: &str) -> Option<String> {
    for dir in std::env::split_paths(path_value) {
        let candidate = dir.join("claude");
        if candidate.exists() && candidate.is_file() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

pub fn find_claude_cli_with_env(env_map: Option<&HashMap<String, String>>) -> Option<String> {
    let home = env_map
        .and_then(|map| map.get("HOME").cloned())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_default();
    let preferred_paths = [
        format!("{}/.local/bin/claude", home),
        format!("{}/.claude/local/claude", home),
    ];

    for path in preferred_paths {
        if std::path::Path::new(&path).exists() {
            return Some(path);
        }
    }

    if let Some(map) = env_map {
        if let Some(found) = map
            .get("PATH")
            .and_then(|path_value| find_claude_cli_in_path(path_value))
        {
            return Some(found);
        }
    }

    if let Ok(path_value) = std::env::var("PATH") {
        if let Some(found) = find_claude_cli_in_path(&path_value) {
            return Some(found);
        }
    }

    let paths = [
        "/usr/local/bin/claude".to_string(),
        "/opt/homebrew/bin/claude".to_string(),
    ];

    paths.iter()
        .find(|p| std::path::Path::new(p).exists())
        .cloned()
}

pub fn claude_help_text(claude_path: &str) -> Option<String> {
    let cache = CLAUDE_HELP_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(cached) = guard.get(claude_path) {
            return Some(cached.clone());
        }
    }

    let output = Command::new(claude_path).arg("--help").output().ok()?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    if text.trim().is_empty() {
        tracing::warn!(claude_path = %claude_path, "claude --help returned empty output");
        return None;
    }
    tracing::info!(
        claude_path = %claude_path,
        help_len = text.len(),
        has_model_flag = text.contains("--model"),
        "claude --help output captured"
    );

    if let Ok(mut guard) = cache.lock() {
        guard.insert(claude_path.to_string(), text.clone());
    }
    Some(text)
}

pub fn claude_supports_option(claude_path: &str, option: &str) -> bool {
    claude_help_text(claude_path)
        .map(|help| help.contains(option))
        .unwrap_or(false)
}

pub fn claude_supports_stream_json(claude_path: &str) -> bool {
    claude_supports_option(claude_path, "--output-format")
}

pub fn claude_supports_permission_mode(claude_path: &str) -> bool {
    claude_supports_option(claude_path, "--permission-mode")
}

pub fn claude_supports_permission_prompt_tool(claude_path: &str) -> bool {
    // Fast path: check help text first (in case a future CLI version lists it).
    if claude_supports_option(claude_path, "--permission-prompt-tool") {
        return true;
    }
    // The flag is hidden from --help in current CLI versions.  Probe it
    // directly: "argument missing" means the flag exists but needs a value;
    // "unknown option" (or no output) means it doesn't exist at all.
    static PROBE_CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    let cache = PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(&cached) = guard.get(claude_path) {
            return cached;
        }
    }
    let result = match Command::new(claude_path)
        .args(["--print", "--permission-prompt-tool"])
        .output()
    {
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            let stdout = String::from_utf8_lossy(&o.stdout);
            let combined = format!("{}{}", stderr, stdout);
            combined.contains("argument missing")
        }
        Err(_) => false,
    };
    if let Ok(mut guard) = cache.lock() {
        guard.insert(claude_path.to_string(), result);
    }
    tracing::info!(
        claude_path = %claude_path,
        supported = result,
        "probed --permission-prompt-tool support"
    );
    result
}

pub fn claude_supports_model_option(claude_path: &str) -> bool {
    claude_supports_option(claude_path, "--model")
}

pub fn claude_supports_resume_option(claude_path: &str) -> bool {
    claude_supports_option(claude_path, "--resume")
}

/// Locate the bundled MCP permission bridge script.
/// Returns the path to `mcp-permission-bridge/dist/index.js` in dev,
/// or from the Tauri resource bundle in production.
pub fn find_permission_bridge_path() -> Option<String> {
    // Dev: relative to Cargo manifest dir
    let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../mcp-permission-bridge/dist/index.js");
    if dev_path.exists() {
        return Some(dev_path.to_string_lossy().to_string());
    }
    // Prod: resolve from macOS bundle -> Contents/Resources/
    if let Ok(exe_path) = std::env::current_exe() {
        let prod_path = exe_path
            .parent()
            .unwrap_or(&exe_path)
            .join("../Resources/mcp-permission-bridge/dist/index.js");
        if prod_path.exists() {
            return Some(prod_path.to_string_lossy().to_string());
        }
    }
    tracing::warn!("MCP permission bridge not found — interactive permissions unavailable");
    None
}
