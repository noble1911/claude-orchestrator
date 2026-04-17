import { useMemo } from "react";
import type { HtmlArtifact } from "../types";

interface CanvasPanelProps {
  artifact: HtmlArtifact | undefined;
  artifacts: HtmlArtifact[];
  onSelectArtifact: (artifactId: string) => void;
  onDeleteArtifact: (artifactId: string) => void;
}

/**
 * Renders an agent-emitted HTML artifact inside a sandboxed iframe.
 *
 * Security model: the iframe uses `srcdoc` with a `sandbox` attribute that
 * denies same-origin privileges. Scripts may run (needed for Chart.js, D3,
 * etc.) but cannot access localStorage, cookies, the parent document, or
 * anything outside the iframe. Form submission and popups are also denied.
 * `referrerpolicy="no-referrer"` prevents outbound CDN fetches from leaking
 * the orchestrator origin in a Referer header.
 *
 * Sidebar lists all artifacts in the workspace so the user can navigate
 * between versions. Artifact history is persisted in SQLite.
 */
export default function CanvasPanel({
  artifact,
  artifacts,
  onSelectArtifact,
  onDeleteArtifact,
}: CanvasPanelProps) {
  const sortedArtifacts = useMemo(
    () => [...artifacts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [artifacts],
  );

  return (
    <div className="flex h-full">
      <aside className="flex w-56 flex-col border-r md-border overflow-hidden">
        <div className="px-3 py-2 text-xs uppercase tracking-wide md-text-muted border-b md-border">
          Artifacts
        </div>
        <div className="flex-1 overflow-y-auto">
          {sortedArtifacts.length === 0 ? (
            <div className="p-3 text-xs md-text-muted">
              No artifacts yet. Ask the agent to render a chart, diagram, or
              mock-up.
            </div>
          ) : (
            sortedArtifacts.map((item) => {
              const isActive = artifact?.id === item.id;
              return (
                <div
                  key={item.id}
                  className={`group flex items-center gap-2 px-3 py-2 text-xs border-b md-border cursor-pointer hover:md-bg-hover ${
                    isActive ? "md-bg-selected" : ""
                  }`}
                  onClick={() => onSelectArtifact(item.id)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">{item.title}</div>
                    <div className="truncate text-[10px] md-text-muted">
                      {new Date(item.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <button
                    className="hidden group-hover:inline-flex text-[10px] md-text-muted hover:text-red-500"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteArtifact(item.id);
                    }}
                    title="Delete artifact"
                  >
                    ✕
                  </button>
                </div>
              );
            })
          )}
        </div>
      </aside>
      <main className="flex-1 min-w-0 bg-white">
        {artifact ? (
          <iframe
            key={artifact.id}
            title={artifact.title}
            srcDoc={artifact.html}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="h-full w-full border-0"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm md-text-muted">
            Select an artifact from the left to view it here.
          </div>
        )}
      </main>
    </div>
  );
}
