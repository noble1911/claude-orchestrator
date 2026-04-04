use std::path::PathBuf;
use std::process::Command;

use crate::types::OrchestratorConfig;

pub fn get_default_branch(repo_path: &str) -> Result<String, String> {
    let output = Command::new("git")
        .args(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout)
            .trim()
            .replace("origin/", "");
        Ok(branch)
    } else {
        Ok("main".to_string())
    }
}

pub fn is_git_repo(path: &str) -> bool {
    Command::new("git")
        .args(["rev-parse", "--git-dir"])
        .current_dir(path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Check if a git repository has an operation in progress that would prevent commits.
/// Returns "clean" if safe, or "busy:<reason>" if an operation is in progress.
pub fn git_busy_check(repo_path: &str) -> String {
    let git_dir = {
        let output = Command::new("git")
            .args(["rev-parse", "--git-dir"])
            .current_dir(repo_path)
            .output();
        match output {
            Ok(o) if o.status.success() => {
                let dir = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if dir.starts_with('/') {
                    PathBuf::from(dir)
                } else {
                    PathBuf::from(repo_path).join(dir)
                }
            }
            _ => return "error:not_a_git_repo".to_string(),
        }
    };

    if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        return "busy:rebase".to_string();
    }

    if git_dir.join("MERGE_HEAD").exists() {
        return "busy:merge".to_string();
    }

    if git_dir.join("CHERRY_PICK_HEAD").exists() {
        return "busy:cherry-pick".to_string();
    }

    if git_dir.join("REVERT_HEAD").exists() {
        return "busy:revert".to_string();
    }

    "clean".to_string()
}

/// Read conductor.json or orchestrator.json configuration from a repository or workspace path.
pub fn read_orchestrator_config(path: &str) -> OrchestratorConfig {
    let base = PathBuf::from(path);

    for filename in ["conductor.json", "orchestrator.json"] {
        let config_path = base.join(filename);
        if config_path.exists() {
            if let Ok(contents) = std::fs::read_to_string(&config_path) {
                if let Ok(config) = serde_json::from_str::<OrchestratorConfig>(&contents) {
                    return config;
                }
            }
        }
    }
    OrchestratorConfig::default()
}

/// Run a script in a workspace with environment variables set.
pub fn run_script_in_workspace(
    workspace_path: &str,
    workspace_name: &str,
    script: &str,
) -> Result<(String, String, i32), String> {
    let output = Command::new("sh")
        .args(["-c", script])
        .current_dir(workspace_path)
        .env("ORCHESTRATOR_WORKSPACE_NAME", workspace_name)
        .env("ORCHESTRATOR_WORKSPACE_PATH", workspace_path)
        .output()
        .map_err(|e| format!("Failed to run script: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code().unwrap_or(-1);

    Ok((stdout, stderr, exit_code))
}

pub fn create_worktree(repo_path: &str, worktree_path: &str, branch: &str, default_branch: &str) -> Result<(), String> {
    let fetch = Command::new("git")
        .args(["fetch", "origin", default_branch])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to fetch origin: {}", e))?;
    if !fetch.status.success() {
        let stderr = String::from_utf8_lossy(&fetch.stderr);
        return Err(format!("Git fetch failed: {}", stderr));
    }

    let start_point = format!("origin/{}", default_branch);
    let output = Command::new("git")
        .args(["worktree", "add", "-b", branch, worktree_path, &start_point])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to create worktree: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git worktree failed: {}", stderr));
    }

    Ok(())
}

pub fn remove_worktree(repo_path: &str, worktree_path: &str) -> Result<(), String> {
    let output = Command::new("git")
        .args(["worktree", "remove", worktree_path, "--force"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("Failed to remove worktree: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git worktree remove failed: {}", stderr));
    }

    Ok(())
}

pub fn remove_workspace_directory(repo_path: &str, worktree_path: &str) -> Result<(), String> {
    let repo_root = PathBuf::from(repo_path);
    let allowed_root = repo_root.join(".worktrees");
    let workspace_path = PathBuf::from(worktree_path);

    if !workspace_path.starts_with(&allowed_root) {
        return Err(format!(
            "Refusing to delete workspace path outside .worktrees: {}",
            worktree_path
        ));
    }

    if workspace_path.exists() {
        std::fs::remove_dir_all(&workspace_path)
            .map_err(|e| format!("Failed to delete workspace files: {}", e))?;
    }

    Ok(())
}
