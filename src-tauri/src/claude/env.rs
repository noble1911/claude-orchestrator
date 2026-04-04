use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

/// Environment variable prefixes that override the CLI's built-in model
/// resolution.  Stripping them lets `--model opus` (etc.) resolve to the
/// latest model ID the CLI itself knows about, instead of stale values
/// baked into the user's shell profile.
pub const MODEL_OVERRIDE_ENV_PREFIXES: &[&str] = &[
    "CLAUDE_MODEL_",
    "CLAUDE_BEDROCK_MODEL_",
];

pub fn load_cli_shell_env() -> HashMap<String, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = Command::new(&shell)
        .args(["-lic", "printenv"])
        .env("DISABLE_AUTO_UPDATE", "true")
        .env("DISABLE_UPDATE_PROMPT", "true")
        .env("ZSH_DISABLE_COMPFIX", "true")
        .env("ZSH_COMPDUMP", "/tmp/.zcompdump-claude-orchestrator")
        .output();

    let env_map: HashMap<String, String> = match output {
        Ok(ref out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let mut map = HashMap::new();
            for line in stdout.lines() {
                if let Some((key, value)) = line.split_once('=') {
                    if !key.trim().is_empty() {
                        map.insert(key.to_string(), value.to_string());
                    }
                }
            }
            if map.is_empty() {
                std::env::vars().collect()
            } else {
                map
            }
        }
        Err(_) => std::env::vars().collect(),
    };

    env_map
}

pub fn env_truthy(value: Option<&String>) -> bool {
    match value.map(|s| s.trim().to_lowercase()) {
        Some(v) if v == "1" || v == "true" || v == "yes" || v == "on" => true,
        _ => false,
    }
}

pub fn env_nonempty(env_map: &HashMap<String, String>, key: &str) -> bool {
    env_map
        .get(key)
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

#[derive(Debug, Deserialize, Default)]
pub struct ClaudeSettingsFile {
    pub env: Option<HashMap<String, String>>,
    #[serde(rename = "model")]
    pub _model: Option<String>,
    #[serde(rename = "awsAuthRefresh")]
    pub aws_auth_refresh: Option<String>,
}

pub fn parse_claude_settings(raw: &str) -> ClaudeSettingsFile {
    serde_json::from_str::<ClaudeSettingsFile>(raw).unwrap_or_default()
}

#[cfg(test)]
pub fn parse_claude_settings_env(raw: &str) -> HashMap<String, String> {
    parse_claude_settings(raw)
        .env
        .unwrap_or_default()
        .into_iter()
        .filter(|(key, value)| !key.trim().is_empty() && !value.trim().is_empty())
        .collect()
}

pub fn load_claude_settings() -> ClaudeSettingsFile {
    let home = match std::env::var("HOME") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => return ClaudeSettingsFile::default(),
    };

    let settings_path = PathBuf::from(home).join(".claude").join("settings.json");
    let raw = match std::fs::read_to_string(settings_path) {
        Ok(content) => content,
        Err(_) => return ClaudeSettingsFile::default(),
    };

    parse_claude_settings(&raw)
}

pub fn load_claude_settings_env() -> HashMap<String, String> {
    load_claude_settings()
        .env
        .unwrap_or_default()
        .into_iter()
        .filter(|(key, value)| !key.trim().is_empty() && !value.trim().is_empty())
        .collect()
}

pub fn load_claude_settings_auth_refresh_command() -> Option<String> {
    load_claude_settings()
        .aws_auth_refresh
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn summarize_command_output(raw: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(raw);
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

pub fn run_aws_auth_refresh(env_map: &HashMap<String, String>) -> Option<Result<String, String>> {
    if !env_truthy(env_map.get("CLAUDE_CODE_USE_BEDROCK")) {
        return None;
    }

    let refresh_cmd = load_claude_settings_auth_refresh_command()?;
    let shell = env_map
        .get("SHELL")
        .cloned()
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/zsh".to_string());
    let mut cmd = Command::new(shell);
    cmd.args(["-lc", &refresh_cmd]);
    configure_cli_env(&mut cmd, env_map);

    let output = match cmd.output() {
        Ok(value) => value,
        Err(e) => {
            return Some(Err(format!(
                "Failed to execute awsAuthRefresh command: {}",
                e
            )));
        }
    };

    if output.status.success() {
        if let Some(line) = summarize_command_output(&output.stdout) {
            Some(Ok(format!("awsAuthRefresh completed: {}", line)))
        } else {
            Some(Ok("awsAuthRefresh completed successfully.".to_string()))
        }
    } else {
        let detail = summarize_command_output(&output.stderr)
            .or_else(|| summarize_command_output(&output.stdout))
            .unwrap_or_else(|| "No error output from command.".to_string());
        let code = output
            .status
            .code()
            .map(|value| value.to_string())
            .unwrap_or_else(|| "signal".to_string());
        Some(Err(format!(
            "awsAuthRefresh failed (exit {}): {}",
            code, detail
        )))
    }
}

pub fn aws_shared_profile_exists(profile: &str) -> bool {
    let home = match std::env::var("HOME") {
        Ok(value) if !value.trim().is_empty() => value,
        _ => return false,
    };

    let aws_dir = PathBuf::from(home).join(".aws");
    let candidates = [aws_dir.join("config"), aws_dir.join("credentials")];
    let profile_header = format!("[{}]", profile);
    let config_profile_header = format!("[profile {}]", profile);

    for candidate in candidates {
        let content = match std::fs::read_to_string(candidate) {
            Ok(text) => text,
            Err(_) => continue,
        };

        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.eq_ignore_ascii_case(&profile_header)
                || trimmed.eq_ignore_ascii_case(&config_profile_header)
            {
                return true;
            }
        }
    }

    false
}

pub fn build_effective_cli_env(env_overrides: &HashMap<String, String>) -> HashMap<String, String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut env_map = load_cli_shell_env();

    let existing = env_map
        .get("PATH")
        .cloned()
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
    let extra = format!(
        "{}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        home
    );
    let merged = if existing.is_empty() {
        extra
    } else {
        format!("{}:{}", extra, existing)
    };
    env_map.insert("PATH".to_string(), merged);

    for (key, value) in load_claude_settings_env() {
        env_map.insert(key, value);
    }

    for (key, value) in env_overrides {
        if !key.trim().is_empty() {
            env_map.insert(key.clone(), value.clone());
        }
    }

    if env_truthy(env_map.get("CLAUDE_CODE_USE_BEDROCK")) {
        if !env_nonempty(&env_map, "AWS_SDK_LOAD_CONFIG") {
            env_map.insert("AWS_SDK_LOAD_CONFIG".to_string(), "1".to_string());
        }

        let has_profile_env =
            env_nonempty(&env_map, "AWS_PROFILE") || env_nonempty(&env_map, "AWS_DEFAULT_PROFILE");
        let has_static_keys =
            env_nonempty(&env_map, "AWS_ACCESS_KEY_ID") && env_nonempty(&env_map, "AWS_SECRET_ACCESS_KEY");
        if !has_profile_env && !has_static_keys && aws_shared_profile_exists("default") {
            env_map.insert("AWS_PROFILE".to_string(), "default".to_string());
        }
    }

    env_map
}

pub fn configure_cli_env(cmd: &mut Command, env_map: &HashMap<String, String>) {
    cmd.env_clear();
    for (key, value) in env_map {
        let dominated = MODEL_OVERRIDE_ENV_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix));
        if !dominated {
            cmd.env(key, value);
        }
    }
}

pub fn auth_env_feedback(env_map: &HashMap<String, String>) -> (String, Option<String>) {
    let bedrock = env_truthy(env_map.get("CLAUDE_CODE_USE_BEDROCK"));
    let aws_key = env_nonempty(env_map, "AWS_ACCESS_KEY_ID");
    let aws_secret = env_nonempty(env_map, "AWS_SECRET_ACCESS_KEY");
    let aws_session = env_nonempty(env_map, "AWS_SESSION_TOKEN");
    let aws_profile = env_nonempty(env_map, "AWS_PROFILE");
    let aws_default_profile = env_nonempty(env_map, "AWS_DEFAULT_PROFILE");
    let aws_default_profile_config = aws_shared_profile_exists("default");
    let anthropic_key = env_nonempty(env_map, "ANTHROPIC_API_KEY");
    let has_profile_chain = aws_profile || aws_default_profile || aws_default_profile_config;

    let summary = format!(
        "env mode: bedrock={}, aws_key={}, aws_secret={}, aws_session={}, aws_profile={}, aws_default_profile={}, aws_default_profile_config={}, anthropic_key={}",
        bedrock,
        aws_key,
        aws_secret,
        aws_session,
        aws_profile,
        aws_default_profile,
        aws_default_profile_config,
        anthropic_key
    );

    let hint = if bedrock {
        if !(has_profile_chain || (aws_key && aws_secret)) {
            Some(
                "Bedrock mode is enabled but no AWS auth chain was detected. Run `aws sso login` for your profile (or default), or set AWS_PROFILE / AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY."
                    .to_string(),
            )
        } else {
            None
        }
    } else if !anthropic_key {
        Some(
            "ANTHROPIC_API_KEY is not set. Claude may fail with login/API key errors unless your CLI session is already authenticated."
                .to_string(),
        )
    } else {
        None
    };

    (summary, hint)
}

pub fn extract_model_suggestion(error_text: &str) -> Option<String> {
    let needle = "Try --model to switch to ";
    let start = error_text.find(needle)?;
    let tail = &error_text[start + needle.len()..];
    let token = tail
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_matches(|c: char| c == '.' || c == ',' || c == '"' || c == '\'' || c == '`');
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

pub fn detect_credential_error(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    const PATTERNS: &[&str] = &[
        "expiredtoken",
        "expiredtokenexception",
        "the security token included in the request is expired",
        "invalidclienttokenid",
        "unrecognizedclientexception",
        "accessdeniedexception",
        "not authorized to perform",
        "unable to locate credentials",
        "no credentials found",
        "invalid identity token",
        "token has expired",
        "request has expired",
        "signing error",
        "unauthorizedexception",
        "forbidden",
        "access denied",
        "invalidsignatureexception",
        "signaturedoesnotmatch",
        "request signature we calculated does not match",
        "could not load credentials",
        "nocredentialproviders",
        "the security token included in the request is invalid",
        "invalid security token",
        "missing authentication token",
        "status code: 401",
        "status code: 403",
        "http 401",
        "http 403",
    ];
    if PATTERNS.iter().any(|p| lower.contains(p)) {
        return true;
    }
    if lower.contains("credentials") && (lower.contains("expired") || lower.contains("invalid")) {
        return true;
    }
    false
}

pub fn extract_http_status_code(text: &str) -> Option<u16> {
    for token in text.split(|c: char| !c.is_ascii_digit()) {
        if token.len() != 3 {
            continue;
        }
        if let Ok(code) = token.parse::<u16>() {
            if (400..=599).contains(&code) {
                return Some(code);
            }
        }
    }
    None
}

pub fn credential_error_message(details: &str) -> String {
    if let Some(status) = extract_http_status_code(details) {
        format!(
            "AWS authentication failed (HTTP {}). Your credentials appear invalid or expired. Run `aws sso login` for your profile, or update environment overrides in Setup.",
            status
        )
    } else {
        "AWS authentication failed. Your credentials appear invalid or expired. Run `aws sso login` for your profile, or update environment overrides in Setup.".to_string()
    }
}

pub fn extract_missing_conversation_session_id(text: &str) -> Option<String> {
    let marker = "No conversation found with session ID:";
    let start = text.find(marker)?;
    let tail = &text[start + marker.len()..];
    let session_id = tail
        .trim()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_');
    if session_id.is_empty() {
        None
    } else {
        Some(session_id.to_string())
    }
}
