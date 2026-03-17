import { useState } from "react";
import { useWorkspaceStore } from "../stores/workspaces";
import { useConnectionStore } from "../stores/connection";
import { useFileStore } from "../stores/files";
import { statusLabel } from "../services/utils";

type RightTab = "files" | "changes" | "checks";

function RightPanel() {
  const [activeTab, setActiveTab] = useState<RightTab>("files");
  const selectedWorkspaceId = useWorkspaceStore((s) => s.selectedWorkspaceId);
  const wsClient = useConnectionStore((s) => s.wsClient);
  const files = useFileStore((s) => s.files);
  const currentPath = useFileStore((s) => s.currentPath);
  const fileContent = useFileStore((s) => s.fileContent);
  const fileContentPath = useFileStore((s) => s.fileContentPath);
  const clearFileContent = useFileStore((s) => s.clearFileContent);
  const changes = useFileStore((s) => s.changes);
  const checks = useFileStore((s) => s.checks);
  const workspaces = useWorkspaceStore((s) => s.workspaces);

  const workspace = workspaces.find((w) => w.id === selectedWorkspaceId);

  if (!selectedWorkspaceId || !workspace) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm md-text-faint">Select a workspace</p>
      </div>
    );
  }

  const navigateToDir = (path: string) => {
    clearFileContent();
    wsClient?.send({ type: "list_files", workspace_id: selectedWorkspaceId, relative_path: path || undefined });
  };

  const openFile = (path: string) => {
    wsClient?.send({ type: "read_file", workspace_id: selectedWorkspaceId, relative_path: path });
  };

  const runChecks = () => {
    wsClient?.send({ type: "run_checks", workspace_id: selectedWorkspaceId });
  };

  const refreshChanges = () => {
    wsClient?.send({ type: "list_changes", workspace_id: selectedWorkspaceId });
  };

  return (
    <div className="flex h-full flex-col md-surface-container">
      {/* Workspace info */}
      <div className="border-b md-outline px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-xs md-text-muted">{statusLabel(workspace.status)}</span>
          <span className="text-xs md-text-faint">{workspace.branch}</span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b md-outline">
        {(["files", "changes", "checks"] as RightTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            className={`flex-1 px-3 py-2.5 text-xs font-medium capitalize transition ${
              activeTab === tab
                ? "md-text-strong border-b-2 border-[var(--md-sys-color-primary)]"
                : "md-text-dim border-b-2 border-transparent hover:md-text-primary"
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
            {tab === "changes" && changes.length > 0 && (
              <span className="md-chip ml-1.5 !min-h-0 !px-1.5 !py-0 text-[10px]">
                {changes.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === "files" && (
          <div className="p-2">
            {fileContent !== null && fileContentPath ? (
              <div>
                <button
                  type="button"
                  className="mb-2 flex items-center gap-1 rounded-md px-2 py-1 text-xs md-text-muted transition hover:md-text-primary hover:md-surface-subtle"
                  onClick={clearFileContent}
                >
                  <span className="material-symbols-rounded !text-[14px]">arrow_back</span>
                  Back to files
                </button>
                <p className="mb-2 truncate px-2 text-xs md-text-faint">{fileContentPath}</p>
                <div className="md-card overflow-hidden">
                  <pre className="overflow-auto p-3 text-xs font-mono md-text-primary max-h-[70vh]">
                    {fileContent}
                  </pre>
                </div>
              </div>
            ) : (
              <div>
                {currentPath && (
                  <button
                    type="button"
                    className="mb-1 flex items-center gap-1 rounded-md px-2 py-1 text-xs md-text-muted transition hover:md-text-primary hover:md-surface-subtle"
                    onClick={() => {
                      const parent = currentPath.split("/").slice(0, -1).join("/");
                      navigateToDir(parent);
                    }}
                  >
                    <span className="material-symbols-rounded !text-[14px]">arrow_back</span>
                    ..
                  </button>
                )}
                {files.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition hover:md-surface-subtle ${
                      fileContentPath === entry.path ? "md-surface-strong md-text-strong" : entry.is_dir ? "" : "md-text-secondary"
                    }`}
                    onClick={() => entry.is_dir ? navigateToDir(entry.path) : openFile(entry.path)}
                  >
                    <span className={`material-symbols-rounded !text-[16px] ${entry.is_dir ? "md-text-primary" : "md-text-dim"}`}>
                      {entry.is_dir ? "folder" : "description"}
                    </span>
                    <span className="truncate">{entry.name}</span>
                  </button>
                ))}
                {files.length === 0 && (
                  <div className="p-4 text-center text-xs md-text-faint">Empty directory</div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === "changes" && (
          <div className="p-2">
            <div className="mb-2 flex justify-end">
              <button type="button" className="text-xs md-text-muted hover:md-text-primary" onClick={refreshChanges}>
                <span className="material-symbols-rounded !text-[14px]">refresh</span>
              </button>
            </div>
            {changes.map((change) => (
              <div key={change.path} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition hover:md-surface-subtle">
                <span className={`font-mono font-bold ${
                  change.status === "M" ? "text-sky-300"
                  : change.status === "A" || change.status === "??" ? "text-emerald-300"
                  : change.status === "D" ? "text-rose-300"
                  : change.status === "R" ? "text-amber-300"
                  : "md-text-muted"
                }`}>
                  {change.status.padEnd(2)}
                </span>
                <span className="truncate md-text-secondary">{change.path}</span>
              </div>
            ))}
            {changes.length === 0 && (
              <div className="p-4 text-center text-xs md-text-faint">No changes</div>
            )}
          </div>
        )}

        {activeTab === "checks" && (
          <div className="p-2">
            <div className="mb-2 flex justify-end">
              <button type="button" className="md-btn text-xs" onClick={runChecks}>
                Run checks
              </button>
            </div>
            {checks.map((check) => (
              <div key={check.name} className="md-card mb-2 p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`material-symbols-rounded !text-[16px] ${check.skipped ? "md-text-dim" : check.success ? "text-emerald-300" : "text-rose-300"}`}>
                    {check.skipped ? "remove" : check.success ? "check_circle" : "cancel"}
                  </span>
                  <span className="text-xs font-medium md-text-primary">{check.name}</span>
                  {check.duration_ms > 0 && (
                    <span className="text-[10px] md-text-faint ml-auto">{(check.duration_ms / 1000).toFixed(1)}s</span>
                  )}
                </div>
                {check.stdout && (
                  <pre className="mt-1 overflow-auto rounded-lg bg-black/20 p-2 text-[10px] font-mono md-text-muted max-h-32">
                    {check.stdout.slice(0, 2000)}
                  </pre>
                )}
                {check.stderr && (
                  <pre className="mt-1 overflow-auto rounded-lg bg-red-500/10 p-2 text-[10px] font-mono text-rose-300 max-h-32">
                    {check.stderr.slice(0, 2000)}
                  </pre>
                )}
              </div>
            ))}
            {checks.length === 0 && (
              <div className="p-4 text-center text-xs md-text-faint">Click &quot;Run checks&quot; to start</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default RightPanel;
