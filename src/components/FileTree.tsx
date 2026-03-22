import type { WorkspaceFileEntry } from "../types";

interface FileTreeProps {
  filesByPath: Record<string, WorkspaceFileEntry[]>;
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  activeCenterTabId: string;
  onToggleDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
}

function FileTreeNodes({
  path,
  depth,
  filesByPath,
  expandedPaths,
  loadingPaths,
  activeCenterTabId,
  onToggleDirectory,
  onOpenFile,
}: FileTreeProps & { path: string; depth: number }) {
  const entries = filesByPath[path] || [];

  return (
    <>
      {entries.map((entry) => {
        const isExpanded = expandedPaths.has(entry.path);
        const isLoading = loadingPaths.has(entry.path);
        const childrenLoaded = filesByPath[entry.path] !== undefined;

        return (
          <div key={entry.path}>
            <button
              onClick={() => {
                if (entry.isDir) {
                  onToggleDirectory(entry.path);
                } else {
                  onOpenFile(entry.path);
                }
              }}
              className={`flex w-full items-center gap-2 rounded-md md-px-2 md-py-1.5 text-left text-xs transition ${
                activeCenterTabId === `file:${entry.path}`
                  ? "md-surface-strong md-text-strong"
                  : entry.isDir
                    ? "hover:md-surface-subtle"
                    : "hover:md-surface-subtle md-text-secondary"
              }`}
              style={{ paddingLeft: `${depth * 14 + 8}px` }}
            >
              <span className="w-3 md-text-muted">{entry.isDir ? (isExpanded ? "▾" : "▸") : " "}</span>
              <span
                className={`material-symbols-rounded !text-base ${
                  entry.isDir ? "md-text-primary" : "md-text-dim"
                }`}
              >
                {entry.isDir ? (isExpanded ? "folder_open" : "folder") : "description"}
              </span>
              <span className="truncate">{entry.name}</span>
            </button>

            {entry.isDir && isExpanded && (
              <>
                {isLoading && (
                  <div
                    className="md-px-2 md-py-1 text-xs md-text-muted"
                    style={{ paddingLeft: `${(depth + 1) * 14 + 14}px` }}
                  >
                    Loading...
                  </div>
                )}
                {!isLoading && childrenLoaded && (
                  <FileTreeNodes
                    path={entry.path}
                    depth={depth + 1}
                    filesByPath={filesByPath}
                    expandedPaths={expandedPaths}
                    loadingPaths={loadingPaths}
                    activeCenterTabId={activeCenterTabId}
                    onToggleDirectory={onToggleDirectory}
                    onOpenFile={onOpenFile}
                  />
                )}
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

export default function FileTree(props: FileTreeProps) {
  return <FileTreeNodes path="" depth={0} {...props} />;
}
