import { useState, useRef, useEffect } from "react";
import { useWorkspaceStore } from "../stores/workspaces";
import { useConnectionStore } from "../stores/connection";
import { useFileStore } from "../stores/files";
import { statusLabel, openExternalHref } from "../services/utils";

type RightTab = "files" | "changes" | "checks" | "terminal";

interface RightPanelProps {
  /** Mobile: navigate back to chat view */
  onBack?: () => void;
}

function RightPanel({ onBack }: RightPanelProps) {
  const [activeTab, setActiveTab] = useState<RightTab>("files");
  const [terminalInput, setTerminalInput] = useState("");
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesValue, setNotesValue] = useState("");
  const terminalEndRef = useRef<HTMLDivElement>(null);

  const selectedWorkspaceId = useWorkspaceStore((s) => s.selectedWorkspaceId);
  const wsClient = useConnectionStore((s) => s.wsClient);
  const files = useFileStore((s) => s.files);
  const currentPath = useFileStore((s) => s.currentPath);
  const fileContent = useFileStore((s) => s.fileContent);
  const fileContentPath = useFileStore((s) => s.fileContentPath);
  const clearFileContent = useFileStore((s) => s.clearFileContent);
  const changes = useFileStore((s) => s.changes);
  const checks = useFileStore((s) => s.checks);
  const diffContent = useFileStore((s) => s.diffContent);
  const diffFilePath = useFileStore((s) => s.diffFilePath);
  const clearDiff = useFileStore((s) => s.clearDiff);
  const terminalHistory = useFileStore((s) => s.terminalHistory);
  const terminalRunning = useFileStore((s) => s.terminalRunning);
  const addTerminalCommand = useFileStore((s) => s.addTerminalCommand);
  const clearTerminal = useFileStore((s) => s.clearTerminal);
  const workspaces = useWorkspaceStore((s) => s.workspaces);

  const workspace = workspaces.find((w) => w.id === selectedWorkspaceId);

  // Scroll terminal to bottom on new output
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [terminalHistory.length]);

  // Sync notes value when workspace changes
  useEffect(() => {
    setNotesValue(workspace?.notes ?? "");
    setEditingNotes(false);
  }, [selectedWorkspaceId, workspace?.notes]);

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

  const viewDiff = (filePath: string) => {
    wsClient?.send({ type: "read_change_diff", workspace_id: selectedWorkspaceId, file_path: filePath });
  };

  const runChecks = () => {
    wsClient?.send({ type: "run_checks", workspace_id: selectedWorkspaceId });
  };

  const refreshChanges = () => {
    wsClient?.send({ type: "list_changes", workspace_id: selectedWorkspaceId });
  };

  const runTerminalCommand = () => {
    const cmd = terminalInput.trim();
    if (!cmd || terminalRunning) return;
    addTerminalCommand(cmd);
    wsClient?.send({ type: "run_terminal_command", workspace_id: selectedWorkspaceId, command: cmd });
    setTerminalInput("");
  };

  const saveNotes = () => {
    wsClient?.send({ type: "update_workspace_notes", workspace_id: selectedWorkspaceId, notes: notesValue });
    setEditingNotes(false);
  };

  return (
    <div className="flex h-full flex-col md-surface-container">
      {/* Header */}
      <div className="border-b md-outline px-3 py-2">
        <div className="flex items-center gap-2">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="flex-shrink-0 p-1 rounded-lg hover:bg-white/5 transition-colors"
              title="Back to chat"
            >
              <span className="material-symbols-rounded !text-[20px] md-text-muted">arrow_back</span>
            </button>
          )}
          <span className="text-xs md-text-muted flex-1">{statusLabel(workspace.status)}</span>
          <span className="text-xs md-text-faint">{workspace.branch}</span>
        </div>
        {/* PR badge */}
        {workspace.pr_url && (
          <button
            type="button"
            onClick={() => openExternalHref(workspace.pr_url)}
            className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-purple-500/30 bg-purple-500/10 px-2.5 py-0.5 text-[11px] text-purple-300 hover:bg-purple-500/20 transition-colors"
          >
            <span className="material-symbols-rounded !text-[13px]">link</span>
            Pull Request
          </button>
        )}
        {/* Notes */}
        <div className="mt-2">
          {editingNotes ? (
            <div className="space-y-1">
              <textarea
                className="w-full rounded-lg border md-outline bg-black/20 px-2 py-1.5 text-xs md-text-primary outline-none resize-none"
                rows={3}
                value={notesValue}
                onChange={(e) => setNotesValue(e.target.value)}
                placeholder="Workspace notes..."
                autoFocus
              />
              <div className="flex gap-1 justify-end">
                <button type="button" className="text-[10px] md-text-faint hover:md-text-primary px-2 py-0.5" onClick={() => { setNotesValue(workspace.notes ?? ""); setEditingNotes(false); }}>Cancel</button>
                <button type="button" className="text-[10px] text-sky-400 hover:text-sky-300 px-2 py-0.5" onClick={saveNotes}>Save</button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="w-full text-left rounded-lg px-2 py-1 text-xs hover:bg-white/5 transition-colors"
              onClick={() => setEditingNotes(true)}
            >
              {workspace.notes ? (
                <p className="md-text-secondary line-clamp-2">{workspace.notes}</p>
              ) : (
                <p className="md-text-faint italic">Add notes...</p>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b md-outline">
        {(["files", "changes", "checks", "terminal"] as RightTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            className={`flex-1 px-2 py-3 text-[11px] font-medium capitalize transition ${
              activeTab === tab ? "md-text-strong border-b-2 border-[var(--md-sys-color-primary)]" : "md-text-muted hover:md-text-primary"
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === "terminal" ? (
              <span className="material-symbols-rounded !text-[14px]">terminal</span>
            ) : (
              tab
            )}
            {tab === "changes" && changes.length > 0 && (
              <span className="ml-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-white/10 px-1 text-[10px]">
                {changes.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* ── Files tab ── */}
        {activeTab === "files" && (
          <div className="p-2">
            {fileContent !== null && fileContentPath ? (
              <div>
                <button
                  type="button"
                  className="mb-2 flex items-center gap-1 text-xs md-text-muted hover:md-text-primary"
                  onClick={clearFileContent}
                >
                  <span className="material-symbols-rounded !text-[14px]">arrow_back</span>
                  Back to files
                </button>
                <div className="text-xs md-text-faint mb-2 truncate">{fileContentPath}</div>
                <pre className="overflow-auto rounded-lg border md-outline bg-black/30 p-3 text-xs font-mono md-text-primary max-h-[70vh]">
                  {fileContent}
                </pre>
              </div>
            ) : (
              <div>
                {currentPath && (
                  <button
                    type="button"
                    className="mb-1 flex items-center gap-1 px-2 py-2 text-xs md-text-muted hover:md-text-primary"
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
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2.5 text-left text-sm hover:bg-white/5"
                    onClick={() => entry.is_dir ? navigateToDir(entry.path) : openFile(entry.path)}
                  >
                    <span className="material-symbols-rounded !text-[18px] md-text-muted">
                      {entry.is_dir ? "folder" : "description"}
                    </span>
                    <span className="truncate md-text-primary">{entry.name}</span>
                  </button>
                ))}
                {files.length === 0 && (
                  <div className="p-4 text-center text-xs md-text-faint">Empty directory</div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Changes tab with diff viewer ── */}
        {activeTab === "changes" && (
          <div className="p-2">
            {diffContent !== null && diffFilePath ? (
              <div>
                <button
                  type="button"
                  className="mb-2 flex items-center gap-1 text-xs md-text-muted hover:md-text-primary"
                  onClick={clearDiff}
                >
                  <span className="material-symbols-rounded !text-[14px]">arrow_back</span>
                  Back to changes
                </button>
                <div className="text-xs md-text-faint mb-2 truncate">{diffFilePath}</div>
                <pre className="overflow-auto rounded-lg border md-outline bg-black/30 p-3 text-xs font-mono max-h-[70vh] leading-relaxed">
                  {diffContent.split("\n").map((line, i) => {
                    let color = "md-text-primary";
                    if (line.startsWith("+") && !line.startsWith("+++")) color = "text-green-400";
                    else if (line.startsWith("-") && !line.startsWith("---")) color = "text-red-400";
                    else if (line.startsWith("@@")) color = "text-cyan-400";
                    else if (line.startsWith("diff") || line.startsWith("index")) color = "md-text-faint";
                    return <div key={i} className={color}>{line || "\u00A0"}</div>;
                  })}
                </pre>
              </div>
            ) : (
              <>
                <div className="mb-2 flex justify-end">
                  <button type="button" className="p-1 rounded-lg text-xs md-text-muted hover:md-text-primary hover:bg-white/5" onClick={refreshChanges}>
                    <span className="material-symbols-rounded !text-[16px]">refresh</span>
                  </button>
                </div>
                {changes.map((change) => (
                  <button
                    key={change.path}
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm hover:bg-white/5 text-left"
                    onClick={() => viewDiff(change.path)}
                  >
                    <span className={`font-mono font-bold text-xs flex-shrink-0 ${
                      change.status === "M" ? "text-yellow-400"
                      : change.status === "A" || change.status === "??" ? "text-green-400"
                      : change.status === "D" ? "text-red-400"
                      : "md-text-muted"
                    }`}>
                      {change.status.padEnd(2)}
                    </span>
                    <span className="truncate md-text-primary">{change.path}</span>
                    <span className="material-symbols-rounded !text-[14px] md-text-faint ml-auto flex-shrink-0">chevron_right</span>
                  </button>
                ))}
                {changes.length === 0 && (
                  <div className="p-4 text-center text-xs md-text-faint">No changes</div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Checks tab ── */}
        {activeTab === "checks" && (
          <div className="p-2">
            <div className="mb-2 flex justify-end">
              <button type="button" className="md-btn text-xs" onClick={runChecks}>
                Run checks
              </button>
            </div>
            {checks.map((check) => (
              <div key={check.name} className="mb-2 rounded-lg border md-outline p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`material-symbols-rounded !text-[16px] ${check.success ? "text-green-400" : "text-red-400"}`}>
                    {check.skipped ? "remove" : check.success ? "check_circle" : "cancel"}
                  </span>
                  <span className="text-xs font-medium md-text-primary">{check.name}</span>
                  {check.duration_ms > 0 && (
                    <span className="text-[10px] md-text-faint ml-auto">{(check.duration_ms / 1000).toFixed(1)}s</span>
                  )}
                </div>
                {check.stdout && (
                  <pre className="mt-1 overflow-auto rounded bg-black/20 p-2 text-[10px] font-mono md-text-muted max-h-32">
                    {check.stdout.slice(0, 2000)}
                  </pre>
                )}
                {check.stderr && (
                  <pre className="mt-1 overflow-auto rounded bg-red-500/10 p-2 text-[10px] font-mono text-red-300 max-h-32">
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

        {/* ── Terminal tab ── */}
        {activeTab === "terminal" && (
          <div className="flex h-full flex-col">
            <div className="flex-1 overflow-y-auto p-2 font-mono text-xs">
              {terminalHistory.length === 0 && (
                <div className="p-4 text-center text-xs md-text-faint font-sans">Run shell commands in workspace context</div>
              )}
              {terminalHistory.map((entry) => (
                <div key={entry.id} className="mb-3">
                  <div className="flex items-center gap-1.5 text-sky-400 mb-1">
                    <span className="text-sky-400/60">$</span>
                    <span>{entry.command}</span>
                    {entry.running && <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400 ml-1" />}
                  </div>
                  {entry.stdout && (
                    <pre className="whitespace-pre-wrap text-green-300/80 leading-relaxed">{entry.stdout}</pre>
                  )}
                  {entry.stderr && (
                    <pre className="whitespace-pre-wrap text-red-300/80 leading-relaxed">{entry.stderr}</pre>
                  )}
                  {entry.exit_code != null && entry.exit_code !== 0 && (
                    <div className="text-[10px] text-red-400/70 mt-0.5">exit {entry.exit_code}</div>
                  )}
                </div>
              ))}
              <div ref={terminalEndRef} />
            </div>
            <div className="border-t md-outline p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))]">
              <div className="flex items-center gap-2">
                <span className="text-xs text-sky-400/60 font-mono">$</span>
                <input
                  type="text"
                  className="flex-1 bg-transparent text-xs font-mono md-text-primary outline-none placeholder:md-text-faint"
                  value={terminalInput}
                  onChange={(e) => setTerminalInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      runTerminalCommand();
                    }
                  }}
                  placeholder="command..."
                  disabled={terminalRunning}
                />
                {terminalHistory.length > 0 && (
                  <button
                    type="button"
                    onClick={clearTerminal}
                    className="text-[10px] md-text-faint hover:md-text-muted px-1"
                    title="Clear terminal"
                  >
                    <span className="material-symbols-rounded !text-[14px]">delete</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default RightPanel;
