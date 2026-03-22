import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { MarketplaceSkill, SkillScope, SkillShortcut } from "../types";

const GITHUB_CONTENTS_URL =
  "https://api.github.com/repos/anthropics/skills/contents/skills";
const RAW_BASE_URL =
  "https://raw.githubusercontent.com/anthropics/skills/main/skills";

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

export default function SkillsMarketplace() {
  const params = new URLSearchParams(window.location.search);
  const scope = (params.get("scope") as SkillScope) || "user";
  const repoId = params.get("repoId") || undefined;

  const [skills, setSkills] = useState<MarketplaceSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installingSkill, setInstallingSkill] = useState<string | null>(null);
  const [installedSkills, setInstalledSkills] = useState<Set<string>>(
    new Set(),
  );
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);

  useEffect(() => {
    fetchSkills();
  }, []);

  async function fetchSkills() {
    setLoading(true);
    setError(null);
    try {
      const dirRes = await fetch(GITHUB_CONTENTS_URL);
      if (!dirRes.ok) throw new Error(`GitHub API error: ${dirRes.status}`);
      const entries: { name: string; type: string }[] = await dirRes.json();
      const dirs = entries.filter((e) => e.type === "dir");

      const results = await Promise.allSettled(
        dirs.map(async (dir) => {
          const res = await fetch(`${RAW_BASE_URL}/${dir.name}/SKILL.md`);
          if (!res.ok) return null;
          const raw = await res.text();
          const { name, description, body } = parseFrontmatter(raw);
          return {
            dirName: dir.name,
            name: name || dir.name,
            description,
            content: body,
          } as MarketplaceSkill;
        }),
      );

      const fetched = results
        .filter(
          (r): r is PromiseFulfilledResult<MarketplaceSkill | null> =>
            r.status === "fulfilled",
        )
        .map((r) => r.value)
        .filter((s): s is MarketplaceSkill => s !== null)
        .sort((a, b) => a.name.localeCompare(b.name));

      setSkills(fetched);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function installSkill(skill: MarketplaceSkill) {
    setInstallingSkill(skill.dirName);
    try {
      await invoke<SkillShortcut>("save_skill", {
        scope,
        repoId: scope === "project" ? repoId : undefined,
        relativePath: skill.dirName,
        name: skill.name,
        content: skill.content,
      });
      setInstalledSkills((prev) => new Set(prev).add(skill.dirName));
      await emit("skills-changed");
    } catch (err) {
      setError(`Failed to install "${skill.name}": ${String(err)}`);
    } finally {
      setInstallingSkill(null);
    }
  }

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
        <span className="rounded-full px-2 py-0.5 text-[11px] font-medium md-surface-container-high md-text-muted">
          {scope} skills
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {/* Error banner */}
        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <span className="material-symbols-rounded !text-[16px] mt-0.5 shrink-0">
              error
            </span>
            <span className="min-w-0">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="ml-auto shrink-0 opacity-60 hover:opacity-100"
            >
              <span className="material-symbols-rounded !text-[14px]">
                close
              </span>
            </button>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-16">
            <div className="mb-3 h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent opacity-50" />
            <p className="text-xs md-text-muted">
              Fetching skills from GitHub...
            </p>
          </div>
        )}

        {/* Empty state */}
        {!loading && skills.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center py-16">
            <span className="material-symbols-rounded !text-[32px] mb-2 md-text-muted">
              inventory_2
            </span>
            <p className="text-xs md-text-muted">No skills found.</p>
          </div>
        )}

        {/* Skills grid */}
        {!loading && skills.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {skills.map((skill) => {
              const isInstalled = installedSkills.has(skill.dirName);
              const isInstalling = installingSkill === skill.dirName;
              const isExpanded = expandedSkill === skill.dirName;

              return (
                <div
                  key={skill.dirName}
                  className="flex flex-col rounded-lg border p-3 transition md-outline md-surface-container hover:md-surface-container-high"
                >
                  <div className="mb-1 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium md-text-primary">
                        {skill.name}
                      </p>
                      <p className="text-[11px] md-text-muted">
                        {skill.dirName}
                      </p>
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
                        onClick={() => void installSkill(skill)}
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
                      onClick={() =>
                        setExpandedSkill(isExpanded ? null : skill.dirName)
                      }
                      className="mt-1 self-start text-[11px] md-text-muted hover:underline"
                    >
                      {isExpanded ? "Show less" : "Show more"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Footer info */}
        {!loading && skills.length > 0 && (
          <p className="mt-4 text-center text-[11px] md-text-muted">
            {skills.length} skills from{" "}
            <span className="font-medium">anthropics/skills</span>
          </p>
        )}
      </div>
    </div>
  );
}
