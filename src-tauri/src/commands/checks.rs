use std::path::PathBuf;
use std::process::Command;
use std::time::Instant;

use crate::helpers::*;
use crate::types::*;
use crate::AppState;

pub fn detect_workspace_checks(workspace_root: &str) -> Vec<WorkspaceCheckDefinition> {
    let root_path = PathBuf::from(workspace_root);
    let mut checks: Vec<WorkspaceCheckDefinition> = Vec::new();

    if root_path.join("Cargo.toml").exists() {
        checks.push(WorkspaceCheckDefinition {
            name: "Cargo Check".to_string(),
            command: "cargo check".to_string(),
            description: "Rust compile and type checks without producing binaries.".to_string(),
        });
    }
    if root_path.join("package.json").exists() {
        checks.push(WorkspaceCheckDefinition {
            name: "NPM Lint".to_string(),
            command: "npm run lint --if-present".to_string(),
            description: "Runs JavaScript/TypeScript linting when configured.".to_string(),
        });
        checks.push(WorkspaceCheckDefinition {
            name: "NPM Build".to_string(),
            command: "npm run build --if-present".to_string(),
            description: "Build verification for frontend or Node projects.".to_string(),
        });
    }

    let has_gradle_project = root_path.join("build.gradle").exists()
        || root_path.join("build.gradle.kts").exists()
        || root_path.join("settings.gradle").exists()
        || root_path.join("settings.gradle.kts").exists();
    if root_path.join("gradlew").exists() {
        checks.push(WorkspaceCheckDefinition {
            name: "Gradle Check".to_string(),
            command: "./gradlew check --console=plain".to_string(),
            description: "Runs Gradle's standard verification lifecycle.".to_string(),
        });
        checks.push(WorkspaceCheckDefinition {
            name: "Gradle Build".to_string(),
            command: "./gradlew build --console=plain".to_string(),
            description: "Runs full Gradle build including tests and packaging tasks.".to_string(),
        });
    } else if has_gradle_project {
        checks.push(WorkspaceCheckDefinition {
            name: "Gradle Check".to_string(),
            command: "gradle check --console=plain".to_string(),
            description: "Runs Gradle verification using a system Gradle install.".to_string(),
        });
        checks.push(WorkspaceCheckDefinition {
            name: "Gradle Build".to_string(),
            command: "gradle build --console=plain".to_string(),
            description: "Runs full Gradle build using a system Gradle install.".to_string(),
        });
    }

    checks
}

pub fn list_workspace_checks(
    state: &AppState,
    workspace_id: String,
) -> Result<Vec<WorkspaceCheckDefinition>, String> {
    let workspace_root = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces.get(&workspace_id).ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        workspace.worktree_path.clone()
    };
    Ok(detect_workspace_checks(&workspace_root))
}

fn run_check_command(
    name: &str,
    command: &str,
    workspace_root: &str,
) -> WorkspaceCheckResult {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return WorkspaceCheckResult {
            name: name.to_string(),
            command: command.to_string(),
            success: false,
            exit_code: None,
            stdout: String::new(),
            stderr: "Invalid check command configuration.".to_string(),
            duration_ms: 0,
            skipped: false,
        };
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let started = Instant::now();

    match Command::new(&shell)
        .args(["-lc", trimmed])
        .current_dir(workspace_root)
        .output()
    {
        Ok(output) => WorkspaceCheckResult {
            name: name.to_string(),
            command: command.to_string(),
            success: output.status.success(),
            exit_code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            duration_ms: started.elapsed().as_millis(),
            skipped: false,
        },
        Err(e) => WorkspaceCheckResult {
            name: name.to_string(),
            command: command.to_string(),
            success: false,
            exit_code: None,
            stdout: String::new(),
            stderr: format!("Failed to execute check: {}", e),
            duration_ms: started.elapsed().as_millis(),
            skipped: false,
        },
    }
}

pub fn run_workspace_checks(
    state: &AppState,
    workspace_id: String,
) -> Result<Vec<WorkspaceCheckResult>, String> {
    let workspace_root = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces.get(&workspace_id).ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        workspace.worktree_path.clone()
    };

    let checks = detect_workspace_checks(&workspace_root);

    if checks.is_empty() {
        return Ok(vec![WorkspaceCheckResult {
            name: "No configured checks".to_string(),
            command: "-".to_string(),
            success: true,
            exit_code: Some(0),
            stdout: "No known check commands were detected for this workspace.".to_string(),
            stderr: String::new(),
            duration_ms: 0,
            skipped: true,
        }]);
    }

    let mut results = Vec::new();
    for check in checks {
        results.push(run_check_command(&check.name, &check.command, &workspace_root));
    }
    Ok(results)
}

pub fn run_single_workspace_check(
    state: &AppState,
    workspace_id: String,
    check_name: String,
    check_command: String,
) -> Result<WorkspaceCheckResult, String> {
    let workspace_root = {
        let workspaces = state.workspaces.read();
        let workspace = workspaces.get(&workspace_id).ok_or(ERR_WORKSPACE_NOT_FOUND)?;
        workspace.worktree_path.clone()
    };
    Ok(run_check_command(&check_name, &check_command, &workspace_root))
}
