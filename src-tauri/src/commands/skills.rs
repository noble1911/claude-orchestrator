use std::path::{Component, Path, PathBuf};

use crate::types::*;
use crate::AppState;

fn normalize_skill_relative_path(path: &Path) -> String {
    let mut parts: Vec<String> = Vec::new();
    for component in path.components() {
        if let Component::Normal(part) = component {
            parts.push(part.to_string_lossy().to_string());
        }
    }
    parts.join("/")
}

fn normalize_skill_directory_input(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Skill path cannot be empty.".to_string());
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        return Err("Skill path must be relative.".to_string());
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            _ => {
                return Err(
                    "Skill path cannot contain '..' or absolute segments.".to_string(),
                )
            }
        }
    }
    if normalized.as_os_str().is_empty() {
        return Err("Skill path cannot be empty.".to_string());
    }
    Ok(normalized)
}

fn sanitize_skill_dir_name(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in name.chars() {
        let next = if ch.is_ascii_alphanumeric() {
            ch.to_ascii_lowercase()
        } else if matches!(ch, ' ' | '-' | '_' | '/') {
            '-'
        } else {
            continue;
        };
        if next == '-' {
            if last_dash {
                continue;
            }
            last_dash = true;
        } else {
            last_dash = false;
        }
        out.push(next);
    }
    out.trim_matches('-').to_string()
}

fn infer_skill_name(content: &str, fallback: &str) -> String {
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("# ") {
            let heading = rest.trim();
            if !heading.is_empty() {
                return heading.to_string();
            }
        }
    }
    fallback.to_string()
}

fn build_skill_entry(scope: &str, root: &Path, skill_file: &Path) -> Result<SkillEntry, String> {
    let content = std::fs::read_to_string(skill_file)
        .map_err(|e| format!("Failed to read skill file '{}': {}", skill_file.display(), e))?;

    let skill_dir = skill_file.parent().unwrap_or(root);
    let relative_dir = skill_dir
        .strip_prefix(root)
        .map(normalize_skill_relative_path)
        .map_err(|_| "Failed to normalize skill path.".to_string())?;

    let fallback_name = if relative_dir.is_empty() {
        "Skill".to_string()
    } else {
        relative_dir
            .rsplit('/')
            .next()
            .map(|value| value.replace('-', " "))
            .unwrap_or_else(|| "Skill".to_string())
    };
    let name = infer_skill_name(&content, &fallback_name);

    let command_target = if relative_dir.is_empty() {
        sanitize_skill_dir_name(&name)
    } else {
        relative_dir.clone()
    };
    let command_name = format!("{}:{}", scope, command_target);
    let id = format!("{}::{}", scope, command_target);

    Ok(SkillEntry {
        id,
        scope: scope.to_string(),
        name,
        command_name,
        relative_path: command_target,
        file_path: skill_file.to_string_lossy().to_string(),
        content,
    })
}

fn collect_skills_from_root(scope: &str, root: &Path) -> Result<Vec<SkillEntry>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    if !root.is_dir() {
        return Err(format!(
            "Skills root is not a directory: {}",
            root.to_string_lossy()
        ));
    }

    let mut stack = vec![root.to_path_buf()];
    let mut files: Vec<PathBuf> = Vec::new();

    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir)
            .map_err(|e| format!("Failed to read '{}': {}", dir.to_string_lossy(), e))?;
        for item in entries {
            let entry =
                item.map_err(|e| format!("Failed to inspect directory entry: {}", e))?;
            let file_type = entry
                .file_type()
                .map_err(|e| format!("Failed to inspect entry type: {}", e))?;
            let path = entry.path();
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if file_type.is_file()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("SKILL.md")
            {
                files.push(path);
            }
        }
    }

    files.sort();
    let mut skills = Vec::new();
    for file in files {
        skills.push(build_skill_entry(scope, root, &file)?);
    }
    Ok(skills)
}

fn resolve_project_skills_root(repo_id: &str, state: &AppState) -> Result<PathBuf, String> {
    let repo_path = {
        let repos = state.repositories.read();
        repos
            .get(repo_id)
            .ok_or("Repository not found")?
            .path
            .clone()
    };
    Ok(PathBuf::from(repo_path).join(".claude").join("skills"))
}

fn resolve_user_skills_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not resolve user home directory.")?;
    Ok(home.join(".claude").join("skills"))
}

pub fn list_skills(
    state: &AppState,
    repo_id: Option<String>,
) -> Result<SkillListResponse, String> {
    let user_root = resolve_user_skills_root()?;
    let user_skills = collect_skills_from_root("user", &user_root)?;

    let (project_root, project_skills) = if let Some(repo_id) = repo_id {
        let root = resolve_project_skills_root(&repo_id, state)?;
        let skills = collect_skills_from_root("project", &root)?;
        (Some(root), skills)
    } else {
        (None, Vec::new())
    };

    Ok(SkillListResponse {
        project_root: project_root.map(|path| path.to_string_lossy().to_string()),
        user_root: Some(user_root.to_string_lossy().to_string()),
        project_skills,
        user_skills,
    })
}

pub fn save_skill(
    state: &AppState,
    scope: String,
    repo_id: Option<String>,
    relative_path: Option<String>,
    name: String,
    content: String,
) -> Result<SkillEntry, String> {
    let scope = scope.trim().to_lowercase();
    if scope != "project" && scope != "user" {
        return Err("Unsupported skill scope. Use 'project' or 'user'.".to_string());
    }

    let trimmed_content = content.trim();
    if trimmed_content.is_empty() {
        return Err("Skill content cannot be empty.".to_string());
    }

    let root = if scope == "project" {
        let repo_id = repo_id.ok_or("Repository is required for project skills.")?;
        resolve_project_skills_root(&repo_id, state)?
    } else {
        resolve_user_skills_root()?
    };

    std::fs::create_dir_all(&root).map_err(|e| {
        format!(
            "Failed to create skills directory '{}': {}",
            root.to_string_lossy(),
            e
        )
    })?;

    let relative_dir = if let Some(existing_relative) = relative_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        normalize_skill_directory_input(existing_relative)?
    } else {
        let source = if name.trim().is_empty() {
            infer_skill_name(trimmed_content, "skill")
        } else {
            name.trim().to_string()
        };
        let dir_name = sanitize_skill_dir_name(&source);
        if dir_name.is_empty() {
            return Err("Skill name must contain letters or numbers.".to_string());
        }
        let next = PathBuf::from(dir_name);
        if root.join(&next).exists() {
            return Err("A skill with this name already exists.".to_string());
        }
        next
    };

    let skill_dir = root.join(&relative_dir);
    let skill_file = skill_dir.join("SKILL.md");

    std::fs::create_dir_all(&skill_dir).map_err(|e| {
        format!(
            "Failed to create skill directory '{}': {}",
            skill_dir.to_string_lossy(),
            e
        )
    })?;
    let mut persisted = trimmed_content.to_string();
    if !persisted.ends_with('\n') {
        persisted.push('\n');
    }
    std::fs::write(&skill_file, persisted).map_err(|e| {
        format!(
            "Failed to write skill file '{}': {}",
            skill_file.to_string_lossy(),
            e
        )
    })?;

    build_skill_entry(&scope, &root, &skill_file)
}

pub fn delete_skill(
    state: &AppState,
    scope: String,
    repo_id: Option<String>,
    relative_path: String,
) -> Result<(), String> {
    let scope = scope.trim().to_lowercase();
    if scope != "project" && scope != "user" {
        return Err("Unsupported skill scope. Use 'project' or 'user'.".to_string());
    }

    let root = if scope == "project" {
        let repo_id = repo_id.ok_or("Repository is required for project skills.")?;
        resolve_project_skills_root(&repo_id, state)?
    } else {
        resolve_user_skills_root()?
    };

    let skill_dir = root.join(&relative_path);
    if !skill_dir.exists() {
        return Err("Skill not found.".to_string());
    }

    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("Failed to resolve skills root: {}", e))?;
    let canonical_dir = skill_dir
        .canonicalize()
        .map_err(|e| format!("Failed to resolve skill path: {}", e))?;
    if !canonical_dir.starts_with(&canonical_root) {
        return Err("Invalid skill path.".to_string());
    }

    std::fs::remove_dir_all(&canonical_dir).map_err(|e| {
        format!(
            "Failed to delete skill directory '{}': {}",
            skill_dir.to_string_lossy(),
            e
        )
    })?;
    Ok(())
}
