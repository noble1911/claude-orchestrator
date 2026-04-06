use std::process::{Command, Stdio};

use serde_json::Value;

use crate::claude::env::load_cli_shell_env;
use crate::helpers::*;
use crate::types::*;
use crate::AppState;

fn try_launch_editor(binary: &str, args: &[&str]) -> bool {
    Command::new(binary)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn open_workspace_in_vscode(path: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        if try_launch_editor("open", &["-b", "com.microsoft.VSCode", path]) {
            return true;
        }
        if try_launch_editor("open", &["-b", "com.microsoft.VSCodeInsiders", path]) {
            return true;
        }
        if try_launch_editor("open", &["-a", "Visual Studio Code", path]) {
            return true;
        }
    }
    try_launch_editor("code", &[path])
}

fn open_workspace_in_intellij(path: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        if try_launch_editor("open", &["-b", "com.jetbrains.intellij", path]) {
            return true;
        }
        if try_launch_editor("open", &["-b", "com.jetbrains.intellij.ce", path]) {
            return true;
        }
        if try_launch_editor("open", &["-a", "IntelliJ IDEA", path]) {
            return true;
        }
        if try_launch_editor("open", &["-a", "IntelliJ IDEA CE", path]) {
            return true;
        }
    }

    if try_launch_editor("idea", &[path]) {
        return true;
    }

    #[cfg(target_os = "windows")]
    {
        if try_launch_editor("idea64.exe", &[path]) {
            return true;
        }
    }

    false
}

pub fn open_workspace_in_editor(
    state: &AppState,
    workspace_id: String,
    editor: String,
) -> Result<(), String> {
    let worktree_path = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces.get(&workspace_id).ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        workspace.worktree_path.clone()
    };

    let opened = match editor.trim().to_lowercase().as_str() {
        "vscode" | "vs_code" | "code" => open_workspace_in_vscode(&worktree_path),
        "intellij" | "idea" => open_workspace_in_intellij(&worktree_path),
        _ => return Err("Unsupported editor. Use 'vscode' or 'intellij'.".to_string()),
    };

    if opened {
        Ok(())
    } else {
        Err(format!(
            "Could not open '{}' in {}. Ensure the editor is installed and available on this machine.",
            worktree_path, editor
        ))
    }
}

pub fn create_pull_request(
    state: &AppState,
    workspace_id: String,
    title: String,
    body: String,
) -> Result<String, String> {
    let (repo_path, worktree_path, branch) = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces.get(&workspace_id).ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        let repos = state.repositories.read();
        let repo = repos.get(&workspace.repo_id).ok_or("Repository not found")?;
        (
            repo.path.clone(),
            workspace.worktree_path.clone(),
            workspace.branch.clone(),
        )
    };

    let push_output = Command::new("git")
        .args(["push", "-u", "origin", &branch])
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| format!("Failed to push: {}", e))?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        return Err(format!("Git push failed: {}", stderr));
    }

    let pr_output = Command::new("gh")
        .args([
            "pr", "create", "--title", &title, "--body", &body, "--head", &branch,
        ])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("Failed to create PR: {}", e))?;

    if !pr_output.status.success() {
        let stderr = String::from_utf8_lossy(&pr_output.stderr);
        return Err(format!("PR creation failed: {}", stderr));
    }

    let pr_url = String::from_utf8_lossy(&pr_output.stdout)
        .trim()
        .to_string();

    {
        let mut workspaces = state.workspaces.write();
        if let Some(workspace) = workspaces.get_mut(&workspace_id) {
            workspace.status = WorkspaceStatus::InReview;
            workspace.pr_url = Some(pr_url.clone());
        }
    }
    let _ = state
        .db
        .update_workspace_pr_url(&workspace_id, &pr_url, &WorkspaceStatus::InReview);

    Ok(pr_url)
}

fn lookup_branch_pr_state(
    repo_path: &str,
    branch: &str,
    shell_path: &str,
) -> Option<(String, String)> {
    let output = Command::new("gh")
        .args([
            "pr", "list", "--head", branch, "--state", "all", "--json", "url,state", "--limit",
            "1",
        ])
        .current_dir(repo_path)
        .env("PATH", shell_path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let items = serde_json::from_slice::<Vec<Value>>(&output.stdout).ok()?;
    let first = items.first()?;
    let url = first
        .get("url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let state = first
        .get("state")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("")
        .to_lowercase();
    if url.is_empty() || state.is_empty() {
        return None;
    }
    Some((url, state))
}

fn lookup_pr_state_by_url(
    repo_path: &str,
    pr_url: &str,
    shell_path: &str,
) -> Option<(String, String)> {
    let output = Command::new("gh")
        .args(["pr", "view", pr_url, "--json", "url,state"])
        .current_dir(repo_path)
        .env("PATH", shell_path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let parsed = serde_json::from_slice::<Value>(&output.stdout).ok()?;
    let url = parsed
        .get("url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let state = parsed
        .get("state")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("")
        .to_lowercase();
    if url.is_empty() || state.is_empty() {
        return None;
    }
    Some((url, state))
}

pub fn mark_workspace_in_review(
    state: &AppState,
    workspace_id: String,
    pr_url: String,
) -> Result<(), String> {
    let trimmed_pr_url = pr_url.trim();
    if trimmed_pr_url.is_empty() {
        return Err("PR URL cannot be empty.".to_string());
    }

    let final_status = {
        let mut workspaces = state.workspaces.write();
        let workspace = workspaces
            .get_mut(&workspace_id)
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        if !matches!(workspace.status, WorkspaceStatus::Merged) {
            workspace.status = WorkspaceStatus::InReview;
        }
        workspace.pr_url = Some(trimmed_pr_url.to_string());
        workspace.status.clone()
    };

    state
        .db
        .update_workspace_pr_url(&workspace_id, trimmed_pr_url, &final_status)
        .map_err(|e| format!("Failed to persist PR URL: {}", e))?;

    Ok(())
}

pub fn sync_pr_statuses(state: &AppState) -> Result<Vec<String>, String> {
    let to_check: Vec<(String, String, String, WorkspaceStatus, Option<String>)> = {
        let workspaces = state.workspaces.read();
        let repos = state.repositories.read();
        workspaces
            .values()
            .filter(|ws| !matches!(ws.status, WorkspaceStatus::Merged))
            .filter_map(|ws| {
                let repo = repos.get(&ws.repo_id)?;
                Some((
                    ws.id.clone(),
                    repo.path.clone(),
                    ws.branch.clone(),
                    ws.status.clone(),
                    ws.pr_url.clone(),
                ))
            })
            .collect()
    };

    let shell_env = load_cli_shell_env();
    let shell_path = shell_env
        .get("PATH")
        .cloned()
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());

    let mut merged_ids = Vec::new();
    for (ws_id, repo_path, branch, current_status, current_pr_url) in to_check {
        let discovered = lookup_branch_pr_state(&repo_path, &branch, &shell_path).or_else(|| {
            current_pr_url
                .as_deref()
                .and_then(|url| lookup_pr_state_by_url(&repo_path, url, &shell_path))
        });
        let Some((pr_url, state_str)) = discovered else {
            continue;
        };

        if state_str == "open" {
            let should_update = !matches!(current_status, WorkspaceStatus::InReview)
                || current_pr_url.as_deref() != Some(pr_url.as_str());
            if should_update {
                {
                    let mut workspaces = state.workspaces.write();
                    if let Some(ws) = workspaces.get_mut(&ws_id) {
                        ws.status = WorkspaceStatus::InReview;
                        ws.pr_url = Some(pr_url.clone());
                    }
                }
                let _ = state
                    .db
                    .update_workspace_pr_url(&ws_id, &pr_url, &WorkspaceStatus::InReview);
            }
            continue;
        }

        if state_str == "merged" {
            let should_update = !matches!(current_status, WorkspaceStatus::Merged)
                || current_pr_url.as_deref() != Some(pr_url.as_str());
            if should_update {
                {
                    let mut workspaces = state.workspaces.write();
                    if let Some(ws) = workspaces.get_mut(&ws_id) {
                        ws.status = WorkspaceStatus::Merged;
                        ws.pr_url = Some(pr_url.clone());
                    }
                }
                let _ = state
                    .db
                    .update_workspace_pr_url(&ws_id, &pr_url, &WorkspaceStatus::Merged);
                merged_ids.push(ws_id);
            }
        }
    }
    Ok(merged_ids)
}
