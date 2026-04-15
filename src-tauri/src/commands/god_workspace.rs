use std::path::PathBuf;

use crate::git::{create_worktree, remove_worktree, remove_workspace_directory};
use crate::helpers::*;
use crate::types::*;
use crate::AppState;

/// The God workspace skill is embedded at compile time and installed into
/// the user-level `~/.claude/skills/` directory so the agent can discover
/// the orchestrator API. User-level placement avoids polluting the worktree's
/// git status with untracked files that could be accidentally committed.
const GOD_WORKSPACE_SKILL: &str = include_str!("../../resources/god-workspace-skill.md");

/// Resolve the path to the God workspace skill directory: `~/.claude/skills/god-workspace/`.
fn god_skill_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".claude").join("skills").join("god-workspace"))
}

/// Install the bundled God workspace skill into `~/.claude/skills/god-workspace/SKILL.md`.
/// Idempotent — overwrites on every god workspace creation to ensure the skill stays current.
fn install_god_skill() -> Result<(), String> {
    let skill_dir = god_skill_dir()?;
    std::fs::create_dir_all(&skill_dir)
        .map_err(|e| format!("Failed to create skill directory: {}", e))?;
    std::fs::write(skill_dir.join("SKILL.md"), GOD_WORKSPACE_SKILL)
        .map_err(|e| format!("Failed to write skill file: {}", e))?;
    Ok(())
}

/// Remove the God workspace skill directory if no god workspaces remain.
/// Called after a god workspace is deleted to avoid leaking the skill into
/// regular workspace contexts.
fn uninstall_god_skill_if_unused(state: &AppState) {
    let any_remaining = {
        let workspaces = state.workspaces.read();
        workspaces.values().any(|w| w.is_god)
    };
    if any_remaining {
        return;
    }
    if let Ok(skill_dir) = god_skill_dir() {
        if skill_dir.exists() {
            if let Err(e) = std::fs::remove_dir_all(&skill_dir) {
                tracing::warn!("Failed to remove god workspace skill directory: {}", e);
            }
        }
    }
}

/// Create a new god workspace using the default (favourited) repository.
/// Returns a regular Workspace with is_god = true.
pub fn create_god_workspace(
    state: &AppState,
    repo_id: String,
    name: String,
) -> Result<Workspace, String> {
    super::workspace::validate_workspace_name(&name)?;

    let repo = {
        let repos = state.repositories.read();
        repos
            .get(&repo_id)
            .cloned()
            .ok_or("Repository not found")?
    };

    let sanitized = name.to_lowercase().replace(' ', "-");
    let branch = format!("god/{}", sanitized);
    let worktrees_dir = PathBuf::from(&repo.path).join(".worktrees");
    std::fs::create_dir_all(&worktrees_dir)
        .map_err(|e| format!("Failed to create worktrees directory: {}", e))?;

    let worktree_path = worktrees_dir.join(format!("god-{}", sanitized));
    let worktree_path_str = worktree_path.to_string_lossy().to_string();
    create_worktree(&repo.path, &worktree_path_str, &branch, &repo.default_branch)?;

    // Keep a clone for cleanup since worktree_path_str moves into the Workspace struct
    let worktree_path_str_clone = worktree_path_str.clone();

    // Run the remaining fallible steps. If any fail, clean up the worktree.
    let result = (|| -> Result<Workspace, String> {
        // Install the bundled orchestrator skill so the God agent can discover the API
        install_god_skill()?;

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
            parent_god_workspace_id: None,
            is_god: true,
        };

        state
            .db
            .insert_workspace(&workspace)
            .map_err(|e| format!("Failed to save god workspace: {}", e))?;

        // Insert into in-memory state so start_agent can find it
        {
            let mut workspaces = state.workspaces.write();
            workspaces.insert(workspace.id.clone(), workspace.clone());
        }

        Ok(workspace)
    })();

    if result.is_err() {
        let _ = remove_worktree(&repo.path, &worktree_path_str_clone);
        let _ = remove_workspace_directory(&repo.path, &worktree_path_str_clone);
    }

    result
}

pub fn list_god_workspaces(state: &AppState) -> Result<Vec<Workspace>, String> {
    let workspaces = state.workspaces.read();
    let mut god_workspaces: Vec<Workspace> = workspaces
        .values()
        .filter(|w| w.is_god)
        .cloned()
        .collect();
    god_workspaces.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(god_workspaces)
}

pub fn remove_god_workspace(state: &AppState, id: String) -> Result<(), String> {
    // Look up the god workspace from in-memory state
    let gw = {
        let workspaces = state.workspaces.read();
        workspaces
            .get(&id)
            .filter(|w| w.is_god)
            .cloned()
            .ok_or("God workspace not found")?
    };

    let repo_path = {
        let repos = state.repositories.read();
        repos
            .get(&gw.repo_id)
            .map(|r| r.path.clone())
            .ok_or("Repository not found")?
    };

    // Stop the god workspace's own agent. Child agents are handled by
    // remove_workspace below (which calls interrupt_agent + stop_agent internally).
    let god_agent_ids: Vec<String> = {
        let agents = state.agents.read();
        agents
            .values()
            .filter(|a| a.workspace_id == id)
            .map(|a| a.id.clone())
            .collect()
    };
    for agent_id in &god_agent_ids {
        if let Err(e) = super::agent::interrupt_agent(state, agent_id.clone()) {
            tracing::warn!("Failed to interrupt god agent {} during removal: {}", agent_id, e);
        }
        if let Err(e) = super::agent::stop_agent(state, agent_id.clone()) {
            tracing::warn!("Failed to stop god agent {} during removal: {}", agent_id, e);
        }
    }
    {
        let mut pids = state.child_pids.write();
        let mut stdin = state.agent_stdin.write();
        for agent_id in &god_agent_ids {
            pids.remove(agent_id);
            stdin.remove(agent_id);
        }
    }

    // Remove child workspaces (each call handles its own agent cleanup + worktree + DB)
    let child_ids: Vec<String> = {
        let workspaces = state.workspaces.read();
        workspaces
            .values()
            .filter(|w| w.parent_god_workspace_id.as_deref() == Some(&id))
            .map(|w| w.id.clone())
            .collect()
    };
    for child_id in &child_ids {
        if let Err(e) = super::workspace::remove_workspace(state, child_id.clone()) {
            tracing::warn!("Failed to remove child workspace {} during god workspace removal: {}", child_id, e);
        }
    }

    // Collect all affected IDs for final in-memory cleanup
    let mut affected_workspace_ids = vec![id.clone()];
    affected_workspace_ids.extend(child_ids);

    // Remove the god workspace's own worktree (best-effort — don't bail on filesystem errors
    // since children are already deleted and we must proceed to DB + in-memory cleanup)
    if let Err(e) = remove_worktree(&repo_path, &gw.worktree_path) {
        tracing::warn!("git worktree remove failed for god workspace {}: {}", gw.worktree_path, e);
    }
    if let Err(e) = remove_workspace_directory(&repo_path, &gw.worktree_path) {
        tracing::warn!("Failed to remove god workspace directory {}: {}", gw.worktree_path, e);
    }

    // Delete from database (cascades child workspace records)
    state
        .db
        .delete_god_workspace(&id)
        .map_err(|e| format!("Failed to delete god workspace: {}", e))?;

    // Unconditionally remove all affected IDs from in-memory state.
    // This ensures no ghost entries remain even if remove_workspace failed
    // for some children above (the DB cascade already deleted them).
    {
        let mut workspaces = state.workspaces.write();
        for affected_id in &affected_workspace_ids {
            workspaces.remove(affected_id);
        }
    }
    // Clean up ephemeral state — each lock acquired and dropped independently
    {
        let mut reasons = state.last_completion_reason.write();
        for affected_id in &affected_workspace_ids {
            reasons.remove(affected_id);
        }
    }
    state.artifacts.write().remove(&id);
    {
        let mut patterns = state.completion_patterns.write();
        for affected_id in &affected_workspace_ids {
            patterns.remove(affected_id);
        }
    }
    // Also purge any orphaned agent entries for workspaces that failed to
    // remove cleanly above — without this, ghost agents with no backing
    // workspace linger in state.agents indefinitely.
    {
        let mut agents = state.agents.write();
        agents.retain(|_, a| !affected_workspace_ids.contains(&a.workspace_id));
    }

    // Clean up the user-level skill file if this was the last god workspace.
    // This prevents the god-workspace skill from leaking into regular workspace contexts.
    uninstall_god_skill_if_unused(state);

    Ok(())
}

pub fn list_god_child_workspaces(
    state: &AppState,
    god_workspace_id: String,
) -> Result<Vec<Workspace>, String> {
    // Read from in-memory state (not DB) to return live workspace status.
    // The DB can lag behind on status transitions, which matters because
    // the god agent polls this endpoint to decide when workspaces are idle.
    let workspaces = state.workspaces.read();
    let mut children: Vec<Workspace> = workspaces
        .values()
        .filter(|w| w.parent_god_workspace_id.as_deref() == Some(&god_workspace_id))
        .cloned()
        .collect();
    children.sort_by(|a, b| {
        a.pinned_at
            .is_none()
            .cmp(&b.pinned_at.is_none())
            .then_with(|| b.pinned_at.cmp(&a.pinned_at))
            .then_with(|| a.display_order.cmp(&b.display_order))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(children)
}

/// Create a child workspace owned by a god workspace.
/// The child lives in the specified repo but is linked to the god workspace.
pub fn create_god_child_workspace(
    state: &AppState,
    god_workspace_id: String,
    repo_id: String,
    name: String,
) -> Result<Workspace, String> {
    // Verify the god workspace exists in the workspaces table
    {
        let workspaces = state.workspaces.read();
        if !workspaces.get(&god_workspace_id).map_or(false, |w| w.is_god) {
            return Err("God workspace not found".to_string());
        }
    }

    // Create the workspace using existing logic (inserts into DB + in-memory)
    let mut workspace = super::workspace::create_workspace(state, repo_id, name)?;

    // Re-verify the god workspace still exists (guards against concurrent deletion)
    {
        let workspaces = state.workspaces.read();
        if !workspaces.get(&god_workspace_id).map_or(false, |w| w.is_god) {
            drop(workspaces);
            if let Err(cleanup_err) = super::workspace::remove_workspace(state, workspace.id) {
                tracing::warn!("Failed to roll back child workspace after god workspace deletion: {}", cleanup_err);
            }
            return Err("God workspace was deleted while creating child workspace".to_string());
        }
    }

    // Link it to the god workspace with a targeted UPDATE (not a full re-insert).
    // If this fails, roll back the child workspace to avoid an orphaned regular workspace.
    let workspace_id_for_rollback = workspace.id.clone();
    workspace.parent_god_workspace_id = Some(god_workspace_id);
    if let Err(e) = state
        .db
        .update_workspace_parent_god(&workspace.id, workspace.parent_god_workspace_id.as_deref())
    {
        if let Err(cleanup_err) = super::workspace::remove_workspace(state, workspace_id_for_rollback) {
            tracing::warn!("Failed to roll back child workspace after parent-link failure: {}", cleanup_err);
        }
        return Err(format!("Failed to link workspace to god parent: {}", e));
    }

    // Patch the in-memory entry, re-checking the child count under the write lock
    // to close the TOCTOU race between the HTTP handler's read-lock check and this insert.
    {
        let mut workspaces = state.workspaces.write();
        let god_id = workspace.parent_god_workspace_id.as_deref();
        let child_count = workspaces.values()
            .filter(|w| w.parent_god_workspace_id.as_deref() == god_id && w.id != workspace.id)
            .count();
        if child_count >= MAX_CHILD_WORKSPACES {
            drop(workspaces);
            if let Err(e) = super::workspace::remove_workspace(state, workspace.id) {
                tracing::warn!("Failed to roll back child workspace after limit hit: {}", e);
            }
            return Err(format!("Child workspace limit ({}) reached", MAX_CHILD_WORKSPACES));
        }
        if let Some(ws) = workspaces.get_mut(&workspace.id) {
            ws.parent_god_workspace_id.clone_from(&workspace.parent_god_workspace_id);
        }
    }

    Ok(workspace)
}
