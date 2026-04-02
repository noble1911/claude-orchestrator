use std::path::PathBuf;

use crate::git::{get_default_branch, is_git_repo, remove_worktree, remove_workspace_directory};
use crate::helpers::{new_id, now_rfc3339};
use crate::types::Repository;
use crate::AppState;

pub fn add_repository(state: &AppState, path: String) -> Result<Repository, String> {
    let path_buf = PathBuf::from(&path);

    if !path_buf.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    if !path_buf.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    if !is_git_repo(&path) {
        return Err(
            "Not a git repository. Please select a folder containing a .git directory.".to_string(),
        );
    }

    let name = path_buf
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Repository")
        .to_string();

    let default_branch = get_default_branch(&path)?;

    let repo = Repository {
        id: new_id(),
        path,
        name,
        default_branch,
        added_at: now_rfc3339(),
    };

    state
        .db
        .insert_repository(&repo)
        .map_err(|e| format!("Failed to save repository: {}", e))?;

    let mut repos = state.repositories.write();
    repos.insert(repo.id.clone(), repo.clone());

    Ok(repo)
}

pub fn remove_repository(state: &AppState, repo_id: String) -> Result<(), String> {
    let repo_path = {
        let repos = state.repositories.read();
        repos.get(&repo_id).map(|r| r.path.clone())
    };

    if let Some(repo_path) = repo_path {
        let workspaces_to_remove: Vec<_> = {
            let workspaces = state.workspaces.read();
            workspaces
                .values()
                .filter(|w| w.repo_id == repo_id)
                .cloned()
                .collect()
        };

        // Do all filesystem ops first without holding a write lock.
        for workspace in &workspaces_to_remove {
            if let Err(e) = remove_worktree(&repo_path, &workspace.worktree_path) {
                tracing::warn!(
                    "git worktree remove failed for {}: {}",
                    workspace.worktree_path,
                    e
                );
            }
            if let Err(e) = remove_workspace_directory(&repo_path, &workspace.worktree_path) {
                tracing::warn!(
                    "workspace directory cleanup failed for {}: {}",
                    workspace.worktree_path,
                    e
                );
            }
        }
        // Take write lock once for all in-memory removals.
        {
            let mut workspaces = state.workspaces.write();
            for workspace in &workspaces_to_remove {
                workspaces.remove(&workspace.id);
            }
        }
    }

    state
        .db
        .delete_repository(&repo_id)
        .map_err(|e| format!("Failed to delete repository: {}", e))?;

    let mut repos = state.repositories.write();
    repos.remove(&repo_id);
    Ok(())
}

pub fn list_repositories(state: &AppState) -> Result<Vec<Repository>, String> {
    let repos = state.repositories.read();
    Ok(repos.values().cloned().collect())
}
