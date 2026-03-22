import { useState } from "react";
import type { PermissionRequestEvent } from "../types";

interface Props {
  request: PermissionRequestEvent;
  onAllow: () => void;
  onDeny: () => void;
}

/** Summarise the tool input in a human-readable way. */
function summariseInput(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === "Write" || toolName === "Edit" || toolName === "Read") {
    const p = input.file_path ?? input.filePath;
    if (typeof p === "string") return p;
  }
  if (toolName === "Bash") {
    const cmd = input.command;
    if (typeof cmd === "string") return cmd.length > 120 ? cmd.slice(0, 120) + "\u2026" : cmd;
  }
  return null;
}

export default function PermissionCard({ request, onAllow, onDeny }: Props) {
  const [expanded, setExpanded] = useState(false);
  const summary = summariseInput(request.toolName, request.toolInput);

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3">
      <div className="mb-1.5 flex items-center gap-2 text-[11px] uppercase tracking-wide text-amber-400/80">
        <span className="material-symbols-rounded !text-[16px]">shield</span>
        Permission Request
      </div>

      <div className="text-sm md-text-primary font-medium">
        {request.toolName}
      </div>

      {summary && (
        <div className="mt-1 truncate text-xs md-text-muted font-mono">
          {summary}
        </div>
      )}

      <button
        type="button"
        className="mt-1.5 text-[11px] md-text-faint hover:md-text-muted transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? "Hide details" : "Show details"}
      </button>

      {expanded && (
        <pre className="mt-1.5 max-h-48 overflow-auto rounded-lg bg-black/20 p-2 text-[11px] md-text-muted font-mono whitespace-pre-wrap break-all">
          {JSON.stringify(request.toolInput, null, 2)}
        </pre>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/20"
          onClick={onAllow}
        >
          Allow
        </button>
        <button
          type="button"
          className="rounded-md border md-outline px-3 py-1.5 text-xs font-medium md-text-secondary transition hover:border-white/35"
          onClick={() => onDeny()}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
