use std::path::PathBuf;
use std::process::Command;

use crate::helpers::*;
use crate::types::*;
use crate::AppState;

pub fn list_workspace_files(
    state: &AppState,
    workspace_id: String,
    relative_path: Option<String>,
) -> Result<Vec<WorkspaceFileEntry>, String> {
    let workspace_root = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces.get(&workspace_id).ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        workspace.worktree_path.clone()
    };

    let root = std::fs::canonicalize(&workspace_root)
        .map_err(|e| format!("Failed to resolve workspace path: {}", e))?;

    let requested_rel = relative_path.unwrap_or_default();
    let target = if requested_rel.is_empty() {
        root.clone()
    } else {
        root.join(&requested_rel)
    };

    let canonical_target = std::fs::canonicalize(&target)
        .map_err(|e| format!("Failed to resolve target path: {}", e))?;

    if !canonical_target.starts_with(&root) {
        return Err("Path is outside workspace root".to_string());
    }

    let read_dir = std::fs::read_dir(&canonical_target)
        .map_err(|e| format!("Failed to read directory: {}", e))?;

    let mut entries: Vec<WorkspaceFileEntry> = Vec::new();

    for item in read_dir {
        let entry = item.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to inspect directory entry: {}", e))?;
        let entry_path = entry.path();
        let relative = entry_path
            .strip_prefix(&root)
            .map_err(|e| format!("Failed to normalize file path: {}", e))?;
        let relative_str = relative.to_string_lossy().replace('\\', "/");
        let name = entry.file_name().to_string_lossy().to_string();

        entries.push(WorkspaceFileEntry {
            name,
            path: relative_str,
            is_dir: file_type.is_dir(),
        });
    }

    entries.sort_by(|a, b| {
        use std::cmp::Ordering;
        match (a.is_dir, b.is_dir) {
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(entries)
}

/// Read a file's contents up to `max_bytes`, returning the content as a UTF-8 string.
/// Appends `[truncated]` if the file exceeds the limit.
pub fn read_file_contents(path: &std::path::Path, max_bytes: usize) -> Result<String, String> {
    let metadata =
        std::fs::metadata(path).map_err(|e| format!("Failed to read file metadata: {}", e))?;
    if !metadata.is_file() {
        return Err("Path is not a file".to_string());
    }

    let bytes = std::fs::read(path).map_err(|e| format!("Failed to read file: {}", e))?;

    let (slice, truncated) = if bytes.len() > max_bytes {
        (&bytes[..max_bytes], true)
    } else {
        (&bytes[..], false)
    };

    // Reject binary files: check for nul bytes in the first 8KB.
    let check_len = slice.len().min(8192);
    if slice[..check_len].contains(&0u8) {
        return Err(format!(
            "Binary file cannot be attached: {}",
            path.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.display().to_string())
        ));
    }

    let mut content = String::from_utf8_lossy(slice).to_string();
    if truncated {
        content.push_str("\n\n[truncated]");
    }
    Ok(content)
}

pub fn read_workspace_file(
    state: &AppState,
    workspace_id: String,
    relative_path: String,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    let workspace_root = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces.get(&workspace_id).ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        workspace.worktree_path.clone()
    };

    let root = std::fs::canonicalize(&workspace_root)
        .map_err(|e| format!("Failed to resolve workspace path: {}", e))?;
    let target = root.join(&relative_path);
    let canonical_target = std::fs::canonicalize(&target)
        .map_err(|e| format!("Failed to resolve file path: {}", e))?;

    if !canonical_target.starts_with(&root) {
        return Err("Path is outside workspace root".to_string());
    }

    read_file_contents(&canonical_target, max_bytes.unwrap_or(MAX_FILE_READ_BYTES))
}

pub fn write_workspace_file(
    state: &AppState,
    workspace_id: String,
    relative_path: String,
    content: String,
) -> Result<(), String> {
    let workspace_root = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces.get(&workspace_id).ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        workspace.worktree_path.clone()
    };

    let root = std::fs::canonicalize(&workspace_root)
        .map_err(|e| format!("Failed to resolve workspace path: {}", e))?;
    let target = root.join(&relative_path);

    let parent = target
        .parent()
        .ok_or_else(|| "Invalid file path".to_string())?;
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|e| format!("Failed to resolve parent directory: {}", e))?;
    if !canonical_parent.starts_with(&root) {
        return Err("Path is outside workspace root".to_string());
    }

    std::fs::write(&target, content.as_bytes())
        .map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(())
}

pub fn read_file_by_path(file_path: String, max_bytes: Option<usize>) -> Result<String, String> {
    let canonical = std::fs::canonicalize(&file_path)
        .map_err(|e| format!("Failed to resolve file path: {}", e))?;
    read_file_contents(&canonical, max_bytes.unwrap_or(MAX_FILE_READ_BYTES))
}

pub fn list_workspace_changes(
    state: &AppState,
    workspace_id: String,
) -> Result<Vec<WorkspaceChangeEntry>, String> {
    let (workspace_root, default_branch) = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces.get(&workspace_id).ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        let repos = state.repositories.read();
        let repo = repos.get(&workspace.repo_id).ok_or("Repository not found")?;
        (workspace.worktree_path.clone(), repo.default_branch.clone())
    };

    let compare_ref = format!("origin/{}", default_branch);
    let mut changes = Vec::new();

    let diff_output = Command::new("git")
        .args(["diff", "--name-status", &compare_ref])
        .current_dir(&workspace_root)
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;

    if diff_output.status.success() {
        let stdout = String::from_utf8_lossy(&diff_output.stdout);
        for line in stdout.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let parts: Vec<&str> = line.splitn(3, '\t').collect();
            if parts.len() >= 2 {
                let status_code = parts[0].to_string();
                if status_code.starts_with('R') && parts.len() == 3 {
                    changes.push(WorkspaceChangeEntry {
                        status: "R ".to_string(),
                        path: parts[2].to_string(),
                        old_path: Some(parts[1].to_string()),
                    });
                } else {
                    let status = match status_code.as_str() {
                        "M" => " M".to_string(),
                        "A" => "A ".to_string(),
                        "D" => " D".to_string(),
                        other => format!("{: <2}", other),
                    };
                    changes.push(WorkspaceChangeEntry {
                        status,
                        path: parts[1].to_string(),
                        old_path: None,
                    });
                }
            }
        }
    }

    let untracked_output = Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(&workspace_root)
        .output()
        .map_err(|e| format!("Failed to list untracked files: {}", e))?;

    if untracked_output.status.success() {
        let stdout = String::from_utf8_lossy(&untracked_output.stdout);
        for line in stdout.lines() {
            let path = line.trim().to_string();
            if !path.is_empty() && !changes.iter().any(|c| c.path == path) {
                changes.push(WorkspaceChangeEntry {
                    status: "??".to_string(),
                    path,
                    old_path: None,
                });
            }
        }
    }

    Ok(changes)
}

pub fn read_workspace_change_diff(
    state: &AppState,
    workspace_id: String,
    path: String,
    old_path: Option<String>,
    status: Option<String>,
) -> Result<String, String> {
    let (workspace_root, default_branch) = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces.get(&workspace_id).ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        let repos = state.repositories.read();
        let repo = repos.get(&workspace.repo_id).ok_or("Repository not found")?;
        (workspace.worktree_path.clone(), repo.default_branch.clone())
    };

    let compare_ref = format!("origin/{}", default_branch);
    let status_trimmed = status.unwrap_or_default().trim().to_string();

    if status_trimmed == "??" {
        let full_path = PathBuf::from(&workspace_root).join(&path);
        let bytes = std::fs::read(&full_path)
            .map_err(|e| format!("Failed to read untracked file for diff: {}", e))?;
        let limit = MAX_FILE_READ_BYTES;
        let (slice, truncated) = if bytes.len() > limit {
            (&bytes[..limit], true)
        } else {
            (&bytes[..], false)
        };
        let content = String::from_utf8_lossy(slice).to_string();

        let mut output = String::new();
        output.push_str(&format!("diff --git a/{0} b/{0}\n", path));
        output.push_str("new file mode 100644\n");
        output.push_str("--- /dev/null\n");
        output.push_str(&format!("+++ b/{}\n", path));
        output.push_str("@@ -0,0 +1 @@\n");

        if content.is_empty() {
            output.push_str("+\n");
        } else {
            for line in content.lines() {
                output.push('+');
                output.push_str(line);
                output.push('\n');
            }
            if truncated {
                output.push_str("+\n+[truncated]\n");
            }
        }
        return Ok(output);
    }

    let mut cmd = Command::new("git");
    cmd.current_dir(&workspace_root);
    cmd.args(["diff", "--no-color", &compare_ref, "--"]);
    if let Some(old) = old_path
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        cmd.arg(old);
    }
    cmd.arg(&path);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run git diff: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git diff failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if stdout.trim().is_empty() {
        return Ok("No textual diff output for this change.".to_string());
    }

    Ok(stdout)
}
