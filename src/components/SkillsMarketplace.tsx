import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type {
  CustomSkillRepo,
  MarketplaceSkill,
  SkillScope,
  SkillShortcut,
} from "../types";
import { CUSTOM_SKILL_REPOS_STORAGE_KEY } from "../constants";

function parseFrontmatter(raw: string): {
  name: string;
  description: string;
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { name: "", description: "", body: raw };
  const meta = match[1];
  const body = match[2];
  const nameMatch = meta.match(/^name:\s*(.+)$/m);
  const descMatch = meta.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "",
    description: descMatch?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "",
    body,
  };
}

/** Parse "owner/repo" from various GitHub URL formats or plain owner/repo */
function parseGitHubRepo(input: string): { repo: string; path: string | null } | null {
  const trimmed = input.trim().replace(/\/+$/, "");

  // Try URL patterns: https://github.com/owner/repo[/tree/branch/path]
  const urlMatch = trimmed.match(
    /github\.com\/([^/]+\/[^/]+?)(?:\/tree\/[^/]+\/(.+))?(?:\.git)?$/,
  );
  if (urlMatch) {
    return { repo: urlMatch[1], path: urlMatch[2] || null };
  }

  // Plain owner/repo format
  const plainMatch = trimmed.match(/^([^/]+\/[^/]+)$/);
  if (plainMatch) {
    return { repo: plainMatch[1], path: null };
  }

  return null;
}

/** Fetch the default branch name for a GitHub repo */
async function fetchDefaultBranch(repo: string): Promise<string> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`);
    if (res.ok) {
      const data = await res.json();
      if (data.default_branch) return data.default_branch;
    }
  } catch {
    // Fall back to "main"
  }
  return "main";
}

/** Manifest plugin entry from .claude-plugin/marketplace.json */
interface ManifestPlugin {
  name: string;
  source: string;
  description?: string;
  category?: string;
  keywords?: string[];
  /** Explicit list of skill directory paths (e.g., ["./skills/xlsx", "./skills/pdf"]).
   *  Used by the official Anthropic repo where source is "./" and skills are listed individually. */
  skills?: string[];
}

/** Try to fetch .claude-plugin/marketplace.json from the repo */
async function fetchManifest(
  repo: string,
  branch: string,
): Promise<ManifestPlugin[] | null> {
  try {
    const url = `https://raw.githubusercontent.com/${repo}/${branch}/.claude-plugin/marketplace.json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.plugins && Array.isArray(data.plugins)) {
      return data.plugins as ManifestPlugin[];
    }
  } catch {
    // No manifest available
  }
  return null;
}

/**
 * Fetch the complete file tree for a repo using the Git Trees API (single API call).
 * This dramatically reduces GitHub API usage compared to per-directory Contents API calls.
 * Returns an empty array if the API call fails (e.g., rate-limited).
 */
async function fetchRepoTree(
  repo: string,
  branch: string,
): Promise<{ path: string; type: string }[]> {
  try {
    const url = `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.tree || []) as { path: string; type: string }[];
  } catch {
    return [];
  }
}

/**
 * Fetch a single SKILL.md from raw.githubusercontent.com and parse it.
 * Raw content fetches are NOT subject to the GitHub API rate limit (60/hr).
 */
async function fetchSkillMd(
  repo: string,
  branch: string,
  skillDirPath: string,
): Promise<MarketplaceSkill | null> {
  try {
    const url = `https://raw.githubusercontent.com/${repo}/${branch}/${skillDirPath}/SKILL.md`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const raw = await res.text();
    const { name, description, body } = parseFrontmatter(raw);
    const dirBaseName = skillDirPath.split("/").pop() || skillDirPath;
    return {
      dirName: skillDirPath,
      name: name || dirBaseName,
      description,
      content: body,
      repoSource: repo,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch skills using the manifest's plugin list.
 * Supports two manifest formats:
 * 1. Plugins with explicit `skills` arrays listing skill directory paths
 *    (e.g., Anthropic official repo where all plugins have source: "./" and skills: [...])
 * 2. Plugins with `source` paths pointing to directories containing sub-skills
 *    (e.g., community repos where source: "./engineering" contains skill subdirectories)
 *
 * Uses the Git Trees API for efficient directory scanning (1 API call instead of N).
 */
async function fetchSkillsFromManifest(
  repo: string,
  branch: string,
  plugins: ManifestPlugin[],
): Promise<MarketplaceSkill[]> {
  // Separate plugins into two groups:
  // 1. Plugins with explicit `skills` arrays (fetch each path directly — no API calls needed)
  // 2. Plugins with `source` paths to scan for sub-skills (use tree API)
  const explicitDirPaths: string[] = [];
  const sourcePaths: string[] = [];

  for (const plugin of plugins) {
    if (plugin.skills && plugin.skills.length > 0) {
      // Plugin explicitly lists its skill directories (e.g., Anthropic official repo)
      for (const s of plugin.skills) {
        explicitDirPaths.push(s.replace(/^\.\//, ""));
      }
    } else if (plugin.source !== "./" && plugin.source !== ".") {
      // Plugin points to a directory to scan for sub-skills (e.g., community repos)
      sourcePaths.push(plugin.source.replace(/^\.\//, ""));
    }
    // Plugins with source: "./" and no skills array are skipped —
    // they can't be resolved to individual skills without explicit paths.
    // The caller (fetchSkillsFromRepo) will fall through to tree-based scanning.
  }

  // Fetch explicitly listed skills (raw.githubusercontent.com only — no API rate limit)
  const explicitResults = await Promise.allSettled(
    explicitDirPaths.map((p) => fetchSkillMd(repo, branch, p)),
  );
  const explicitSkills = explicitResults
    .filter(
      (r): r is PromiseFulfilledResult<MarketplaceSkill | null> =>
        r.status === "fulfilled",
    )
    .map((r) => r.value)
    .filter((s): s is MarketplaceSkill => s !== null);

  // For source-path plugins, use the tree API to discover sub-skills efficiently
  let scannedSkills: MarketplaceSkill[] = [];
  if (sourcePaths.length > 0) {
    const tree = await fetchRepoTree(repo, branch);
    // Find all SKILL.md files under any of the source paths
    const skillDirPaths = tree
      .filter((f) => {
        if (f.type !== "blob" || !f.path.endsWith("/SKILL.md")) return false;
        return sourcePaths.some((sp) => f.path.startsWith(sp + "/"));
      })
      .map((f) => f.path.replace(/\/SKILL\.md$/, ""));

    if (skillDirPaths.length > 0) {
      // Tree API found SKILL.md files — fetch them from raw.githubusercontent.com
      const scannedResults = await Promise.allSettled(
        skillDirPaths.map((p) => fetchSkillMd(repo, branch, p)),
      );
      scannedSkills = scannedResults
        .filter(
          (r): r is PromiseFulfilledResult<MarketplaceSkill | null> =>
            r.status === "fulfilled",
        )
        .map((r) => r.value)
        .filter((s): s is MarketplaceSkill => s !== null);
    } else {
      // Tree API failed or found no matches — fall back to per-directory scanning
      const fallbackResults = await Promise.allSettled(
        sourcePaths.map((sp) => scanDirectoryForSkills(repo, branch, sp)),
      );
      for (const r of fallbackResults) {
        if (r.status === "fulfilled") scannedSkills.push(...r.value);
      }
    }
  }

  // Combine and deduplicate by dirName (a skill may appear via multiple plugins)
  const allSkills = [...explicitSkills, ...scannedSkills];
  const seen = new Set<string>();
  return allSkills
    .filter((s) => {
      if (seen.has(s.dirName)) return false;
      seen.add(s.dirName);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Scan a directory for subdirs containing SKILL.md (one level deep) */
async function scanDirectoryForSkills(
  repo: string,
  branch: string,
  path: string,
): Promise<MarketplaceSkill[]> {
  const contentsUrl = `https://api.github.com/repos/${repo}/contents/${path}`;
  const rawBaseUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;

  const dirRes = await fetch(contentsUrl);
  if (!dirRes.ok) return [];
  const entries: { name: string; type: string }[] = await dirRes.json();
  const dirs = entries.filter(
    (e) => e.type === "dir" && !e.name.startsWith("."),
  );

  const results = await Promise.allSettled(
    dirs.map(async (dir) => {
      // Try SKILL.md in this subdirectory
      const res = await fetch(`${rawBaseUrl}/${dir.name}/SKILL.md`);
      if (!res.ok) return null;
      const raw = await res.text();
      const { name, description, body } = parseFrontmatter(raw);
      return {
        dirName: path ? `${path}/${dir.name}` : dir.name,
        name: name || dir.name,
        description,
        content: body,
        repoSource: repo,
      } as MarketplaceSkill;
    }),
  );

  return results
    .filter(
      (r): r is PromiseFulfilledResult<MarketplaceSkill | null> =>
        r.status === "fulfilled",
    )
    .map((r) => r.value)
    .filter((s): s is MarketplaceSkill => s !== null);
}

/**
 * Fetch skills from a GitHub repo using a multi-strategy approach:
 * 1. Check for .claude-plugin/marketplace.json manifest
 *    - If plugins have `skills` arrays → fetch those paths directly (no API calls)
 *    - If plugins have `source` paths → use tree API to find SKILL.md files
 * 2. Use Git Trees API to find all SKILL.md files under the specified path
 * 3. Fall back to per-directory Contents API scanning (if tree API fails)
 *
 * Total GitHub API calls: typically 2 per repo (default branch + tree),
 * vs. the old approach which could make 100+ calls and hit rate limits.
 */
async function fetchSkillsFromRepo(
  repo: string,
  path: string | null,
): Promise<MarketplaceSkill[]> {
  const branch = await fetchDefaultBranch(repo);

  // Strategy 1: Check for .claude-plugin/marketplace.json
  // Pass ALL plugins to fetchSkillsFromManifest — it handles both `skills` arrays
  // and `source` paths internally, including plugins with source: "./" that have skills arrays
  const manifest = await fetchManifest(repo, branch);
  if (manifest && manifest.length > 0) {
    const skills = await fetchSkillsFromManifest(repo, branch, manifest);
    if (skills.length > 0) return skills;
  }

  // Strategy 2: Use Git Trees API to find SKILL.md files efficiently (1 API call)
  const tree = await fetchRepoTree(repo, branch);
  if (tree.length > 0) {
    const basePath = path || "";
    const skillDirPaths = tree
      .filter((f) => {
        if (f.type !== "blob" || !f.path.endsWith("/SKILL.md")) return false;
        if (basePath) return f.path.startsWith(basePath + "/");
        return true;
      })
      .map((f) => f.path.replace(/\/SKILL\.md$/, ""));

    if (skillDirPaths.length > 0) {
      const results = await Promise.allSettled(
        skillDirPaths.map((p) => fetchSkillMd(repo, branch, p)),
      );
      const skills = results
        .filter(
          (r): r is PromiseFulfilledResult<MarketplaceSkill | null> =>
            r.status === "fulfilled",
        )
        .map((r) => r.value)
        .filter((s): s is MarketplaceSkill => s !== null);
      if (skills.length > 0)
        return skills.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  // Strategy 3: Fall back to per-directory scanning (if tree API failed, e.g., rate-limited)
  const pathsToTry = path != null ? [path] : ["skills", ""];
  for (const tryPath of pathsToTry) {
    const skills = await scanDirectoryForSkills(repo, branch, tryPath);
    if (skills.length > 0)
      return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  throw new Error(
    "No skills found. The repository needs a .claude-plugin/marketplace.json manifest or directories containing SKILL.md files.",
  );
}

interface RepoSection {
  id: string;
  label: string;
  repo: string;
  skills: MarketplaceSkill[];
  loading: boolean;
  error: string | null;
}

function loadCustomRepos(): CustomSkillRepo[] {
  try {
    const raw = localStorage.getItem(CUSTOM_SKILL_REPOS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CustomSkillRepo[]) : [];
  } catch {
    return [];
  }
}

function saveCustomRepos(repos: CustomSkillRepo[]) {
  localStorage.setItem(CUSTOM_SKILL_REPOS_STORAGE_KEY, JSON.stringify(repos));
}

/**
 * Group skills by their top-level directory (category).
 * Skills with paths like "engineering/agent-designer" → category "engineering".
 * Flat skills like "frontend-design" → category "" (ungrouped).
 */
function groupSkillsByCategory(
  skills: MarketplaceSkill[],
): { category: string; label: string; skills: MarketplaceSkill[] }[] {
  const groups = new Map<string, MarketplaceSkill[]>();
  for (const skill of skills) {
    const slashIdx = skill.dirName.indexOf("/");
    const category = slashIdx !== -1 ? skill.dirName.slice(0, slashIdx) : "";
    const list = groups.get(category);
    if (list) {
      list.push(skill);
    } else {
      groups.set(category, [skill]);
    }
  }

  return Array.from(groups.entries())
    .map(([category, catSkills]) => ({
      category,
      label: category
        ? category
            .replace(/[-_]/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase())
        : "",
      skills: catSkills.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => {
      // Ungrouped skills first, then alphabetical
      if (!a.category) return -1;
      if (!b.category) return 1;
      return a.label.localeCompare(b.label);
    });
}

// ─── Skill Card ──────────────────────────────────────────────────────────────

function SkillCard({
  skill,
  isInstalled,
  isInstalling,
  isExpanded,
  onInstall,
  onToggleExpand,
}: {
  skill: MarketplaceSkill;
  isInstalled: boolean;
  isInstalling: boolean;
  isExpanded: boolean;
  onInstall: () => void;
  onToggleExpand: () => void;
}) {
  return (
    <div className="flex flex-col rounded-lg border p-3 transition md-outline md-surface-container hover:md-surface-container-high">
      <div className="mb-1 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium md-text-primary">
            {skill.name}
          </p>
          <p className="text-[11px] md-text-muted">{skill.dirName}</p>
        </div>
        {isInstalled ? (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-green-400"
            title="Installed"
          >
            <span className="material-symbols-rounded !text-[14px]">
              check_circle
            </span>
            Installed
          </span>
        ) : (
          <button
            type="button"
            onClick={onInstall}
            disabled={isInstalling}
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition md-surface-container-high hover:brightness-125 disabled:opacity-50"
          >
            {isInstalling ? (
              <>
                <div className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
                Installing...
              </>
            ) : (
              <>
                <span className="material-symbols-rounded !text-[14px]">
                  download
                </span>
                Install
              </>
            )}
          </button>
        )}
      </div>

      {skill.description && (
        <p
          className={`mt-1 text-xs leading-relaxed md-text-muted ${isExpanded ? "" : "line-clamp-2"}`}
        >
          {skill.description}
        </p>
      )}

      {skill.description && skill.description.length > 120 && (
        <button
          type="button"
          onClick={onToggleExpand}
          className="mt-1 self-start text-[11px] md-text-muted hover:underline"
        >
          {isExpanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

// ─── Section Header ──────────────────────────────────────────────────────────

function SectionHeader({
  label,
  repo,
  skillCount,
  onRemove,
}: {
  label: string;
  repo: string;
  skillCount: number;
  onRemove?: () => void;
}) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <div className="min-w-0">
        <h2 className="text-xs font-semibold md-text-primary">{label}</h2>
        <p className="truncate text-[11px] md-text-muted">
          {repo} &middot; {skillCount} skill{skillCount !== 1 ? "s" : ""}
        </p>
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-red-400 transition hover:bg-red-500/10"
          title="Remove this repository"
        >
          <span className="material-symbols-rounded !text-[14px]">
            delete
          </span>
          Remove
        </button>
      )}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function SkillsMarketplace() {
  const params = new URLSearchParams(window.location.search);
  const scope = (params.get("scope") as SkillScope) || "user";
  const repoId = params.get("repoId") || undefined;

  const [customRepos, setCustomRepos] = useState<CustomSkillRepo[]>(
    loadCustomRepos,
  );
  const [sections, setSections] = useState<RepoSection[]>([]);
  const [installingSkill, setInstallingSkill] = useState<string | null>(null);
  const [installedSkills, setInstalledSkills] = useState<Set<string>>(
    new Set(),
  );
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(
    new Set(),
  );
  const [globalError, setGlobalError] = useState<string | null>(null);

  // Add-repo form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [addRepoInput, setAddRepoInput] = useState("");
  const [addRepoLabel, setAddRepoLabel] = useState("");
  const [addRepoError, setAddRepoError] = useState<string | null>(null);
  const [addingRepo, setAddingRepo] = useState(false);

  // Fetch all sections on mount and when customRepos change
  useEffect(() => {
    void fetchAllSections();
  }, [customRepos]);

  async function fetchAllSections() {
    // Build the list of repos to fetch: official first, then custom
    const repoList: { id: string; label: string; repo: string; path: string | null }[] = [
      {
        id: "__official__",
        label: "Official Skills",
        repo: "anthropics/skills",
        path: "skills",
      },
      ...customRepos.map((r) => ({
        id: r.id,
        label: r.label || r.repo,
        repo: r.repo,
        path: r.path || null,
      })),
    ];

    // Initialize sections with loading state
    setSections(
      repoList.map((r) => ({
        id: r.id,
        label: r.label,
        repo: r.repo,
        skills: [],
        loading: true,
        error: null,
      })),
    );

    // Fetch all in parallel
    const results = await Promise.allSettled(
      repoList.map((r) => fetchSkillsFromRepo(r.repo, r.path)),
    );

    setSections(
      repoList.map((r, i) => {
        const result = results[i];
        if (result.status === "fulfilled") {
          return {
            id: r.id,
            label: r.label,
            repo: r.repo,
            skills: result.value,
            loading: false,
            error: null,
          };
        }
        return {
          id: r.id,
          label: r.label,
          repo: r.repo,
          skills: [],
          loading: false,
          error: String(result.reason),
        };
      }),
    );
  }

  async function handleAddRepo() {
    setAddRepoError(null);
    const parsed = parseGitHubRepo(addRepoInput);
    if (!parsed) {
      setAddRepoError(
        'Enter a GitHub URL or owner/repo (e.g., "myuser/my-skills")',
      );
      return;
    }

    // Check for duplicate
    if (
      customRepos.some((r) => r.repo === parsed.repo) ||
      parsed.repo === "anthropics/skills"
    ) {
      setAddRepoError("This repository is already added.");
      return;
    }

    setAddingRepo(true);
    try {
      // Validate the repo is accessible by fetching its contents
      await fetchSkillsFromRepo(parsed.repo, parsed.path);

      const newRepo: CustomSkillRepo = {
        id: crypto.randomUUID(),
        repo: parsed.repo,
        path: parsed.path ?? "",
        label: addRepoLabel.trim() || parsed.repo,
      };

      const updated = [...customRepos, newRepo];
      setCustomRepos(updated);
      saveCustomRepos(updated);

      // Reset form
      setAddRepoInput("");
      setAddRepoLabel("");
      setShowAddForm(false);
    } catch (err) {
      setAddRepoError(
        `Could not fetch skills from ${parsed.repo}: ${String(err)}`,
      );
    } finally {
      setAddingRepo(false);
    }
  }

  function handleRemoveRepo(repoId: string) {
    const updated = customRepos.filter((r) => r.id !== repoId);
    setCustomRepos(updated);
    saveCustomRepos(updated);
  }

  async function installSkill(skill: MarketplaceSkill) {
    const key = `${skill.repoSource || "official"}/${skill.dirName}`;
    setInstallingSkill(key);
    try {
      await invoke<SkillShortcut>("save_skill", {
        scope,
        repoId: scope === "project" ? repoId : undefined,
        relativePath: skill.dirName,
        name: skill.name,
        content: skill.content,
      });
      setInstalledSkills((prev) => new Set(prev).add(key));
      await emit("skills-changed");
    } catch (err) {
      setGlobalError(`Failed to install "${skill.name}": ${String(err)}`);
    } finally {
      setInstallingSkill(null);
    }
  }

  const isLoading = sections.length > 0 && sections.every((s) => s.loading);
  const totalSkills = sections.reduce((sum, s) => sum + s.skills.length, 0);

  return (
    <div className="flex h-screen flex-col md-surface">
      {/* Title bar */}
      <div
        className="flex shrink-0 items-center justify-between border-b px-4 py-3 md-outline md-surface-container"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-2">
          <span className="material-symbols-rounded !text-[20px] md-text-primary">
            storefront
          </span>
          <h1 className="text-sm font-semibold md-text-primary">
            Skills Marketplace
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowAddForm((v) => !v)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition md-surface-container-high hover:brightness-125"
            title="Add custom skill repository"
          >
            <span className="material-symbols-rounded !text-[14px]">
              add
            </span>
            Add Repo
          </button>
          <span className="rounded-full px-2 py-0.5 text-[11px] font-medium md-surface-container-high md-text-muted">
            {scope} skills
          </span>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* Global error banner */}
        {globalError && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <span className="material-symbols-rounded !text-[16px] mt-0.5 shrink-0">
              error
            </span>
            <span className="min-w-0">{globalError}</span>
            <button
              type="button"
              onClick={() => setGlobalError(null)}
              className="ml-auto shrink-0 opacity-60 hover:opacity-100"
            >
              <span className="material-symbols-rounded !text-[14px]">
                close
              </span>
            </button>
          </div>
        )}

        {/* Add repo form */}
        {showAddForm && (
          <div className="mb-4 rounded-lg border p-3 md-outline md-surface-container">
            <h3 className="mb-2 text-xs font-semibold md-text-primary">
              Add Custom Repository
            </h3>
            <p className="mb-3 text-[11px] leading-relaxed md-text-muted">
              Enter a GitHub repository URL or owner/repo. Supports repos with a{" "}
              <code className="rounded px-1 py-0.5 md-surface-container-high">
                .claude-plugin/marketplace.json
              </code>{" "}
              manifest or directories containing SKILL.md files.
            </p>
            <div className="flex flex-col gap-2">
              <input
                type="text"
                value={addRepoInput}
                onChange={(e) => setAddRepoInput(e.target.value)}
                placeholder="e.g., myuser/my-skills or https://github.com/myuser/my-skills"
                className="w-full rounded-md border px-3 py-1.5 text-xs md-outline md-surface-container-high md-text-primary placeholder:md-text-muted focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !addingRepo) void handleAddRepo();
                }}
              />
              <input
                type="text"
                value={addRepoLabel}
                onChange={(e) => setAddRepoLabel(e.target.value)}
                placeholder="Display label (optional)"
                className="w-full rounded-md border px-3 py-1.5 text-xs md-outline md-surface-container-high md-text-primary placeholder:md-text-muted focus:outline-none focus:ring-1 focus:ring-blue-500/50"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !addingRepo) void handleAddRepo();
                }}
              />
              {addRepoError && (
                <p className="text-[11px] text-red-400">{addRepoError}</p>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowAddForm(false);
                    setAddRepoInput("");
                    setAddRepoLabel("");
                    setAddRepoError(null);
                  }}
                  className="rounded-md px-3 py-1 text-[11px] font-medium transition md-text-muted hover:md-text-primary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleAddRepo()}
                  disabled={!addRepoInput.trim() || addingRepo}
                  className="flex items-center gap-1 rounded-md px-3 py-1 text-[11px] font-medium transition md-surface-container-high hover:brightness-125 disabled:opacity-50"
                >
                  {addingRepo ? (
                    <>
                      <div className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
                      Validating...
                    </>
                  ) : (
                    <>
                      <span className="material-symbols-rounded !text-[14px]">
                        add
                      </span>
                      Add Repository
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Loading state */}
        {isLoading && (
          <div className="flex flex-col items-center justify-center py-16">
            <div className="mb-3 h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent opacity-50" />
            <p className="text-xs md-text-muted">
              Fetching skills from GitHub...
            </p>
          </div>
        )}

        {/* Empty state */}
        {!isLoading && totalSkills === 0 && !sections.some((s) => s.error) && (
          <div className="flex flex-col items-center justify-center py-16">
            <span className="material-symbols-rounded !text-[32px] mb-2 md-text-muted">
              inventory_2
            </span>
            <p className="text-xs md-text-muted">No skills found.</p>
          </div>
        )}

        {/* Skill sections */}
        {!isLoading &&
          sections.map((section) => (
            <div key={section.id} className="mb-6">
              <SectionHeader
                label={section.label}
                repo={section.repo}
                skillCount={section.skills.length}
                onRemove={
                  section.id !== "__official__"
                    ? () => handleRemoveRepo(section.id)
                    : undefined
                }
              />

              {/* Section error */}
              {section.error && (
                <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                  <span className="material-symbols-rounded !text-[16px] mt-0.5 shrink-0">
                    error
                  </span>
                  <span className="min-w-0">
                    Failed to load from {section.repo}: {section.error}
                  </span>
                </div>
              )}

              {/* Section loading */}
              {section.loading && (
                <div className="flex items-center gap-2 py-4">
                  <div className="h-4 w-4 animate-spin rounded-full border border-current border-t-transparent opacity-50" />
                  <p className="text-[11px] md-text-muted">Loading...</p>
                </div>
              )}

              {/* Section skills — grouped by category when applicable */}
              {!section.loading && section.skills.length > 0 && (() => {
                const groups = groupSkillsByCategory(section.skills);
                // Show category grouping only when there are multiple groups —
                // a single category (e.g., all skills under "skills/") is redundant
                const hasCategories = groups.length > 1;
                // Default to collapsed when section has many skills
                const defaultCollapsed = section.skills.length > 12;

                // No category structure — flat grid (e.g., official repo)
                if (!hasCategories) {
                  return (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {section.skills.map((skill) => {
                        const key = `${skill.repoSource || "official"}/${skill.dirName}`;
                        return (
                          <SkillCard
                            key={key}
                            skill={skill}
                            isInstalled={installedSkills.has(key)}
                            isInstalling={installingSkill === key}
                            isExpanded={expandedSkill === key}
                            onInstall={() => void installSkill(skill)}
                            onToggleExpand={() =>
                              setExpandedSkill(
                                expandedSkill === key ? null : key,
                              )
                            }
                          />
                        );
                      })}
                    </div>
                  );
                }

                // Grouped by category with collapsible headers
                return (
                  <div className="space-y-3">
                    {groups.map((group) => {
                      const catKey = `${section.id}/${group.category}`;
                      const isCollapsed = collapsedCategories.has(catKey)
                        ? true
                        : defaultCollapsed && !collapsedCategories.has(`${catKey}:expanded`);

                      const toggleCategory = () => {
                        setCollapsedCategories((prev) => {
                          const next = new Set(prev);
                          if (isCollapsed) {
                            next.delete(catKey);
                            next.add(`${catKey}:expanded`);
                          } else {
                            next.add(catKey);
                            next.delete(`${catKey}:expanded`);
                          }
                          return next;
                        });
                      };

                      // Ungrouped skills (no category) render flat
                      if (!group.category) {
                        return (
                          <div key="__ungrouped__" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            {group.skills.map((skill) => {
                              const key = `${skill.repoSource || "official"}/${skill.dirName}`;
                              return (
                                <SkillCard
                                  key={key}
                                  skill={skill}
                                  isInstalled={installedSkills.has(key)}
                                  isInstalling={installingSkill === key}
                                  isExpanded={expandedSkill === key}
                                  onInstall={() => void installSkill(skill)}
                                  onToggleExpand={() =>
                                    setExpandedSkill(
                                      expandedSkill === key ? null : key,
                                    )
                                  }
                                />
                              );
                            })}
                          </div>
                        );
                      }

                      return (
                        <div key={group.category} className="rounded-lg border md-outline">
                          <button
                            type="button"
                            onClick={toggleCategory}
                            className="flex w-full items-center justify-between px-3 py-2 text-left transition hover:md-surface-container-high"
                          >
                            <div className="flex items-center gap-2">
                              <span className="material-symbols-rounded !text-[16px] md-text-muted">
                                {isCollapsed ? "expand_more" : "expand_less"}
                              </span>
                              <span className="text-xs font-semibold md-text-primary">
                                {group.label}
                              </span>
                            </div>
                            <span className="rounded-full px-2 py-0.5 text-[10px] font-medium md-surface-container-high md-text-muted">
                              {group.skills.length} skill{group.skills.length !== 1 ? "s" : ""}
                            </span>
                          </button>
                          {!isCollapsed && (
                            <div className="grid grid-cols-1 gap-3 border-t px-3 py-3 md-outline sm:grid-cols-2">
                              {group.skills.map((skill) => {
                                const key = `${skill.repoSource || "official"}/${skill.dirName}`;
                                return (
                                  <SkillCard
                                    key={key}
                                    skill={skill}
                                    isInstalled={installedSkills.has(key)}
                                    isInstalling={installingSkill === key}
                                    isExpanded={expandedSkill === key}
                                    onInstall={() => void installSkill(skill)}
                                    onToggleExpand={() =>
                                      setExpandedSkill(
                                        expandedSkill === key ? null : key,
                                      )
                                    }
                                  />
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              {/* Section empty (no error) */}
              {!section.loading &&
                section.skills.length === 0 &&
                !section.error && (
                  <p className="py-4 text-center text-[11px] md-text-muted">
                    No skills found in this repository.
                  </p>
                )}
            </div>
          ))}

        {/* Footer info */}
        {!isLoading && totalSkills > 0 && (
          <p className="mt-2 text-center text-[11px] md-text-muted">
            {totalSkills} skill{totalSkills !== 1 ? "s" : ""} from{" "}
            {sections.length} {sections.length === 1 ? "repository" : "repositories"}
          </p>
        )}
      </div>
    </div>
  );
}
