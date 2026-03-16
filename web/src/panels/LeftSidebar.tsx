import { useRepositoryStore } from "../stores/repositories";
import { useWorkspaceStore } from "../stores/workspaces";
import { useAgentStore } from "../stores/agents";
import { useConnectionStore } from "../stores/connection";
import { statusColor } from "../services/utils";
import type { WorkspaceGroup } from "../types";

const WORKSPACE_GROUPS: WorkspaceGroup[] = [
  { id: "in-progress", label: "In progress", statuses: ["running"] },
  { id: "in-review", label: "In review", statuses: ["inReview"] },
  { id: "ready", label: "Ready", statuses: ["idle", "initializing"] },
  { id: "done", label: "Done", statuses: ["merged"] },
];

function LeftSidebar() {
  const repositories = useRepositoryStore((s) => s.repositories);
  const selectedRepoId = useRepositoryStore((s) => s.selectedRepoId);
  const setSelectedRepoId = useRepositoryStore((s) => s.setSelectedRepoId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const selectedWorkspaceId = useWorkspaceStore((s) => s.selectedWorkspaceId);
  const setSelectedWorkspaceId = useWorkspaceStore((s) => s.setSelectedWorkspaceId);
  const running = useAgentStore((s) => s.running);
  const wsClient = useConnectionStore((s) => s.wsClient);

  const filteredWorkspaces = selectedRepoId
    ? workspaces.filter((w) => w.repo_id === selectedRepoId)
    : workspaces;

  const handleSelectWorkspace = (wsId: string) => {
    setSelectedWorkspaceId(wsId);
    // Subscribe for streaming and fetch messages
    wsClient?.send({ type: "subscribe", workspace_id: wsId });
    wsClient?.send({ type: "get_messages", workspace_id: wsId });
    wsClient?.send({ type: "list_files", workspace_id: wsId });
    wsClient?.send({ type: "list_changes", workspace_id: wsId });
  };

  return (
    <div className="flex h-full flex-col md-surface-container">
      {/* Repo selector */}
      <div className="border-b md-outline p-3">
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
                    className={`md-list-item flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                      selectedWorkspaceId === ws.id ? "md-list-item-active" : ""
                    }`}
                    onClick={() => handleSelectWorkspace(ws.id)}
                  >
                    <span
                      className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
                      style={{ backgroundColor: running[ws.id] ? "#34d399" : statusColor(ws.status) }}
                    />
                    <span className="truncate md-text-primary">{ws.name}</span>
                    {ws.pinned_at && (
                      <span className="material-symbols-rounded !text-[14px] md-text-faint ml-auto">push_pin</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          );
        })}

        {filteredWorkspaces.length === 0 && (
          <div className="p-4 text-center text-sm md-text-faint">No workspaces</div>
        )}
      </div>
    </div>
  );
}

export default LeftSidebar;
