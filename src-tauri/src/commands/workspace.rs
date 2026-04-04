use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::time::Instant;

use crate::claude::env::{build_effective_cli_env, configure_cli_env};
use crate::git::{
    create_worktree, read_orchestrator_config, remove_worktree, remove_workspace_directory,
    run_script_in_workspace,
};
use crate::helpers::*;
use crate::types::*;
use crate::AppState;

pub fn list_workspaces(state: &AppState, repo_id: Option<String>) -> Result<Vec<Workspace>, String> {
    let workspaces = state.workspaces.read();
    let result: Vec<Workspace> = workspaces
        .values()
        .filter(|w| repo_id.as_ref().map_or(true, |id| &w.repo_id == id))
        .cloned()
        .collect();
    Ok(result)
}

pub fn check_git_busy(state: &AppState, repo_id: String) -> Result<String, String> {
    let repo = {
        let repos = state.repositories.read();
        repos.get(&repo_id).cloned().ok_or("Repository not found")?
    };
    Ok(crate::git::git_busy_check(&repo.path))
}

pub fn get_orchestrator_config(
    state: &AppState,
    repo_id: String,
) -> Result<OrchestratorConfig, String> {
    let repo = {
        let repos = state.repositories.read();
        repos.get(&repo_id).cloned().ok_or("Repository not found")?
    };
    Ok(read_orchestrator_config(&repo.path))
}

pub fn get_workspace_config(
    state: &AppState,
    workspace_id: String,
) -> Result<OrchestratorConfig, String> {
    let workspace = {
        let workspaces = state.workspaces.read();
        workspaces
            .get(&workspace_id)
            .cloned()
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?
    };
    let config = read_orchestrator_config(&workspace.worktree_path);
    if config.setup_script.is_some() || config.run_script.is_some() || !config.checks.is_empty() {
        return Ok(config);
    }
    let repo = {
        let repos = state.repositories.read();
        repos
            .get(&workspace.repo_id)
            .cloned()
            .ok_or("Repository not found")?
    };
    Ok(read_orchestrator_config(&repo.path))
}

pub fn run_orchestrator_script(
    state: &AppState,
    workspace_id: String,
    script_type: String,
) -> Result<(String, String, i32), String> {
    let workspace = {
        let workspaces = state.workspaces.read();
        workspaces
            .get(&workspace_id)
            .cloned()
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?
    };
    let config = read_orchestrator_config(&workspace.worktree_path);
    let script = match script_type.as_str() {
        "setup" => config.setup_script,
        "run" => config.run_script,
        "archive" => config.archive_script,
        _ => return Err(format!("Unknown script type: {}", script_type)),
    };
    let script = script.ok_or(format!("No {} script configured", script_type))?;
    run_script_in_workspace(&workspace.worktree_path, &workspace.name, &script)
}

pub fn create_workspace(
    state: &AppState,
    repo_id: String,
    name: String,
) -> Result<Workspace, String> {
    let repo = {
        let repos = state.repositories.read();
        repos.get(&repo_id).cloned().ok_or("Repository not found")?
    };

    let branch = format!("workspace/{}", name.to_lowercase().replace(' ', "-"));
    let worktrees_dir = PathBuf::from(&repo.path).join(".worktrees");
    std::fs::create_dir_all(&worktrees_dir)
        .map_err(|e| format!("Failed to create worktrees directory: {}", e))?;

    let worktree_path = worktrees_dir.join(&name);
    let worktree_path_str = worktree_path.to_string_lossy().to_string();
    create_worktree(&repo.path, &worktree_path_str, &branch, &repo.default_branch)?;

    let workspace = Workspace {
        id: new_id(),
        repo_id,
        name,
        branch,
        worktree_path: worktree_path_str,
        status: WorkspaceStatus::Idle,
        last_activity: None,
        pr_url: None,
        unread: 0,
        display_order: 0,
        pinned_at: None,
        notes: None,
    };

    state
        .db
        .insert_workspace(&workspace)
        .map_err(|e| format!("Failed to save workspace: {}", e))?;

    let mut workspaces = state.workspaces.write();
    workspaces.insert(workspace.id.clone(), workspace.clone());
    Ok(workspace)
}

/// Remove a workspace. Cleans up agents, worktree, and database record.
/// Bug fix: the original Tauri command was missing agent cleanup.
pub fn remove_workspace(state: &AppState, workspace_id: String) -> Result<(), String> {
    let (repo_path, worktree_path) = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces
            .get(&workspace_id)
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        let repos = state.repositories.read();
        let repo = repos
            .get(&workspace.repo_id)
            .ok_or("Repository not found")?;
        (repo.path.clone(), workspace.worktree_path.clone())
    };

    // Clean up agents for this workspace
    {
        let mut agents = state.agents.write();
        let dead: Vec<String> = agents
            .iter()
            .filter_map(|(id, agent)| {
                if agent.workspace_id == workspace_id {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect();
        for agent_id in dead {
            agents.remove(&agent_id);
        }
    }

    if let Err(e) = remove_worktree(&repo_path, &worktree_path) {
        tracing::warn!("git worktree remove failed for {}: {}", worktree_path, e);
    }
    remove_workspace_directory(&repo_path, &worktree_path)?;

    state
        .db
        .delete_workspace(&workspace_id)
        .map_err(|e| format!("Failed to delete workspace: {}", e))?;

    let mut workspaces = state.workspaces.write();
    workspaces.remove(&workspace_id);
    Ok(())
}

pub fn rename_workspace(
    state: &AppState,
    workspace_id: String,
    name: String,
) -> Result<Workspace, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Workspace name cannot be empty".to_string());
    }
    let updated = {
        let mut workspaces = state.workspaces.write();
        let workspace = workspaces
            .get_mut(&workspace_id)
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        workspace.name = trimmed.to_string();
        workspace.clone()
    };
    state
        .db
        .update_workspace_name(&workspace_id, trimmed)
        .map_err(|e| format!("Failed to rename workspace: {}", e))?;
    Ok(updated)
}

pub fn update_workspace_unread(
    state: &AppState,
    workspace_id: String,
    unread: i32,
) -> Result<(), String> {
    {
        let mut workspaces = state.workspaces.write();
        let workspace = workspaces
            .get_mut(&workspace_id)
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        workspace.unread = unread;
    }
    state
        .db
        .update_workspace_unread(&workspace_id, unread)
        .map_err(|e| format!("Failed to update unread: {}", e))?;
    Ok(())
}

pub fn update_workspace_display_order(
    state: &AppState,
    workspace_id: String,
    display_order: i32,
) -> Result<(), String> {
    {
        let mut workspaces = state.workspaces.write();
        let workspace = workspaces
            .get_mut(&workspace_id)
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        workspace.display_order = display_order;
    }
    state
        .db
        .update_workspace_display_order(&workspace_id, display_order)
        .map_err(|e| format!("Failed to update display order: {}", e))?;
    Ok(())
}

pub fn toggle_workspace_pinned(
    state: &AppState,
    workspace_id: String,
) -> Result<Workspace, String> {
    let updated = {
        let mut workspaces = state.workspaces.write();
        let workspace = workspaces
            .get_mut(&workspace_id)
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        if workspace.pinned_at.is_some() {
            workspace.pinned_at = None;
        } else {
            workspace.pinned_at = Some(now_rfc3339());
        }
        workspace.clone()
    };
    state
        .db
        .update_workspace_pinned(&workspace_id, updated.pinned_at.as_deref())
        .map_err(|e| format!("Failed to toggle pin: {}", e))?;
    Ok(updated)
}

pub fn update_workspace_notes(
    state: &AppState,
    workspace_id: String,
    notes: String,
) -> Result<(), String> {
    let notes_opt = if notes.trim().is_empty() {
        None
    } else {
        Some(notes.as_str())
    };
    {
        let mut workspaces = state.workspaces.write();
        let workspace = workspaces
            .get_mut(&workspace_id)
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        workspace.notes = notes_opt.map(String::from);
    }
    state
        .db
        .update_workspace_notes(&workspace_id, notes_opt)
        .map_err(|e| format!("Failed to update notes: {}", e))?;
    Ok(())
}

pub fn set_workspace_status(
    state: &AppState,
    workspace_id: String,
    status: String,
) -> Result<Workspace, String> {
    let new_status = match status.as_str() {
        "idle" => WorkspaceStatus::Idle,
        "running" => WorkspaceStatus::Running,
        "inReview" => WorkspaceStatus::InReview,
        "merged" => WorkspaceStatus::Merged,
        _ => return Err(format!("Unknown status: {}", status)),
    };
    let updated = {
        let mut workspaces = state.workspaces.write();
        let workspace = workspaces
            .get_mut(&workspace_id)
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        workspace.status = new_status;
        workspace.last_activity = Some(now_rfc3339());
        workspace.clone()
    };
    let now = now_rfc3339();
    state
        .db
        .update_workspace_status(&workspace_id, &updated.status, Some(&now))
        .map_err(|e| format!("Failed to update status: {}", e))?;
    Ok(updated)
}

pub fn run_workspace_terminal_command(
    state: &AppState,
    workspace_id: String,
    command: String,
    env_overrides: Option<HashMap<String, String>>,
) -> Result<TerminalCommandResult, String> {
    let cmd = command.trim();
    if cmd.is_empty() {
        return Err("Command cannot be empty".to_string());
    }

    let workspace = {
        let workspaces = state.workspaces.read();
        workspaces
            .get(&workspace_id)
            .cloned()
            .ok_or(ERR_WORKSPACE_NOT_FOUND)?
    };

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let started = Instant::now();
    let mut process = Command::new(shell);
    process.current_dir(&workspace.worktree_path);
    process.args(["-lc", cmd]);
    let overrides = env_overrides.unwrap_or_default();
    let effective_env = build_effective_cli_env(&overrides);
    configure_cli_env(&mut process, &effective_env);
    let output = process
        .output()
        .map_err(|e| format!("Failed to execute command: {}", e))?;

    Ok(TerminalCommandResult {
        command: cmd.to_string(),
        cwd: workspace.worktree_path,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
        duration_ms: started.elapsed().as_millis(),
    })
}
