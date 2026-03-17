import { useState } from "react";
import { useRepositoryStore } from "../stores/repositories";
import { useWorkspaceStore } from "../stores/workspaces";
import { useAgentStore } from "../stores/agents";
import { useConnectionStore } from "../stores/connection";
import { statusColor, openExternalHref } from "../services/utils";
import type { WorkspaceGroup } from "../types";

const WORKSPACE_GROUPS: WorkspaceGroup[] = [
  { id: "in-progress", label: "In progress", statuses: ["running"] },
  { id: "in-review", label: "In review", statuses: ["inReview"] },
  { id: "ready", label: "Ready", statuses: ["idle", "initializing"] },
  { id: "done", label: "Done", statuses: ["merged"] },
];

interface LeftSidebarProps {
  onSelectWorkspace?: () => void;
}

function LeftSidebar({ onSelectWorkspace }: LeftSidebarProps) {
  const [search, setSearch] = useState("");

  const repositories = useRepositoryStore((s) => s.repositories);
  const selectedRepoId = useRepositoryStore((s) => s.selectedRepoId);
  const setSelectedRepoId = useRepositoryStore((s) => s.setSelectedRepoId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const selectedWorkspaceId = useWorkspaceStore((s) => s.selectedWorkspaceId);
  const setSelectedWorkspaceId = useWorkspaceStore((s) => s.setSelectedWorkspaceId);
  const running = useAgentStore((s) => s.running);
  const wsClient = useConnectionStore((s) => s.wsClient);

  const filteredWorkspaces = workspaces.filter((w) => {
    if (selectedRepoId && w.repo_id !== selectedRepoId) return false;
    if (search) {
      const q = search.toLowerCase();
      return w.name.toLowerCase().includes(q) || w.branch.toLowerCase().includes(q);
    }
    return true;
  });

  const handleSelectWorkspace = (wsId: string) => {
    setSelectedWorkspaceId(wsId);
    wsClient?.send({ type: "subscribe", workspace_id: wsId });
    wsClient?.send({ type: "get_messages", workspace_id: wsId });
    wsClient?.send({ type: "list_files", workspace_id: wsId });
    wsClient?.send({ type: "list_changes", workspace_id: wsId });
    onSelectWorkspace?.();
  };

  return (
    <div className="flex h-full flex-col md-surface-container">
      {/* Repo selector */}
      <div className="border-b md-outline p-3 space-y-2">
        <select
          className="md-field text-sm"
          value={selectedRepoId ?? ""}
          onChange={(e) => setSelectedRepoId(e.target.value || null)}
        >
          <option value="">All repositories</option>
          {repositories.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        {/* Search */}
        <div className="relative">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 material-symbols-rounded !text-[16px] md-text-faint">search</span>
          <input
            type="text"
            className="w-full rounded-lg border md-outline bg-black/20 pl-8 pr-2 py-2 text-xs md-text-primary outline-none placeholder:md-text-faint"
            placeholder="Filter workspaces..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              type="button"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-white/10"
              onClick={() => setSearch("")}
            >
              <span className="material-symbols-rounded !text-[14px] md-text-faint">close</span>
            </button>
          )}
        </div>
      </div>

      {/* Workspace groups */}
      <div className="flex-1 overflow-y-auto p-2 space-y-4">
        {WORKSPACE_GROUPS.map((group) => {
          const groupWorkspaces = filteredWorkspaces.filter((w) =>
            group.statuses.includes(w.status)
          );
          if (groupWorkspaces.length === 0) return null;

          return (
            <div key={group.id}>
              <div className="px-2 py-1 md-label-medium">{group.label}</div>
              <div className="space-y-0.5">
                {groupWorkspaces.map((ws) => (
                  <button
                    key={ws.id}
                    type="button"
                    className={`md-list-item flex w-full items-center gap-3 px-3 py-3 text-left text-sm ${
                      selectedWorkspaceId === ws.id ? "md-list-item-active" : ""
                    }`}
                    onClick={() => handleSelectWorkspace(ws.id)}
                  >
                    <span
                      className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
                      style={{ backgroundColor: running[ws.id] ? "#34d399" : statusColor(ws.status) }}
                    />
                    <div className="min-w-0 flex-1">
                      <span className="block truncate md-text-primary">{ws.name}</span>
                      {ws.pr_url && (
                        <span
                          className="inline-flex items-center gap-0.5 text-[10px] text-purple-400 mt-0.5"
                          onClick={(e) => { e.stopPropagation(); openExternalHref(ws.pr_url); }}
                        >
                          <span className="material-symbols-rounded !text-[11px]">link</span>
                          PR
                        </span>
                      )}
                    </div>
                    {ws.pinned_at && (
                      <span className="material-symbols-rounded !text-[14px] md-text-faint ml-auto flex-shrink-0">push_pin</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          );
        })}

        {filteredWorkspaces.length === 0 && (
          <div className="p-4 text-center text-sm md-text-faint">
            {search ? "No matching workspaces" : "No workspaces"}
          </div>
        )}
      </div>
    </div>
  );
}

export default LeftSidebar;
