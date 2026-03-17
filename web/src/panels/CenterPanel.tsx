import { useState, useRef, useEffect, useMemo } from "react";
import { useWorkspaceStore } from "../stores/workspaces";
import { useAgentStore } from "../stores/agents";
import { useConnectionStore } from "../stores/connection";
import MarkdownMessage from "../components/MarkdownMessage";
import LinkifiedInlineText from "../components/LinkifiedInlineText";
import QuestionCard from "../components/QuestionCard";
import { compactActivityLines } from "../services/utils";
import type { ChatRow } from "../types";

interface CenterPanelProps {
  /** Mobile: navigate back to workspace list */
  onBack?: () => void;
  /** Mobile: open the tools (files/changes/checks) panel */
  onOpenTools?: () => void;
}

function CenterPanel({ onBack, onOpenTools }: CenterPanelProps) {
  const selectedWorkspaceId = useWorkspaceStore((s) => s.selectedWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const messages = useAgentStore((s) => s.messages);
  const running = useAgentStore((s) => s.running);
  const wsClient = useConnectionStore((s) => s.wsClient);

  const [input, setInput] = useState("");
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  const [expandedActivityIds, setExpandedActivityIds] = useState<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const workspace = workspaces.find((w) => w.id === selectedWorkspaceId);
  const workspaceMessages = selectedWorkspaceId ? (messages[selectedWorkspaceId] ?? []) : [];
  const isRunning = selectedWorkspaceId ? (running[selectedWorkspaceId] ?? false) : false;

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [workspaceMessages.length]);

  // Auto-resize textarea to fit content
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // Clear queue and expanded activity when switching workspaces
  useEffect(() => {
    setQueuedMessages([]);
    setExpandedActivityIds(new Set());
  }, [selectedWorkspaceId]);

  // Drain one queued message when agent becomes idle
  useEffect(() => {
    if (!isRunning && queuedMessages.length > 0 && selectedWorkspaceId && wsClient) {
      const [next, ...rest] = queuedMessages;
      setQueuedMessages(rest);
      wsClient.send({
        type: "send_message",
        workspace_id: selectedWorkspaceId,
        message: next,
      });
    }
  }, [isRunning, selectedWorkspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build collapsed activity groups from flat message list
  const chatRows = useMemo<ChatRow[]>(() => {
    const rows: ChatRow[] = [];
    let systemBuffer: typeof workspaceMessages = [];
    let sequence = 0;

    const flushSystemBuffer = () => {
      if (systemBuffer.length === 0) return;
      const first = systemBuffer[0];
      const rowId = `activity-${first.timestamp}-${sequence}`;
      rows.push({
        kind: "activity",
        id: rowId,
        group: {
          id: rowId,
          messages: systemBuffer,
          lines: compactActivityLines(systemBuffer),
        },
      });
      sequence += 1;
      systemBuffer = [];
    };

    for (const message of workspaceMessages) {
      const isSystemActivity = message.role === "system" && !message.is_error;
      if (isSystemActivity) {
        systemBuffer.push(message);
        continue;
      }
      flushSystemBuffer();
      rows.push({
        kind: "message",
        id: `message-${message.timestamp}-${sequence}`,
        message,
      });
      sequence += 1;
    }

    flushSystemBuffer();
    return rows;
  }, [workspaceMessages]);

  // Track which question messages have been answered
  const answeredQuestionTimestamps = useMemo(() => {
    const answered = new Set<string>();
    let pendingQuestionTimestamp: string | null = null;

    for (const message of workspaceMessages) {
      if (message.role === "question") {
        if (pendingQuestionTimestamp) answered.add(pendingQuestionTimestamp);
        pendingQuestionTimestamp = message.timestamp;
        continue;
      }
      if (pendingQuestionTimestamp && (message.role === "user" || message.agent_id === "user")) {
        answered.add(pendingQuestionTimestamp);
        pendingQuestionTimestamp = null;
      }
    }

    return answered;
  }, [workspaceMessages]);

  const handleSend = () => {
    if (!input.trim() || !selectedWorkspaceId || !wsClient) return;

    const text = input.trim();
    setInput("");

    if (isRunning) {
      setQueuedMessages((prev) => [...prev, text]);
      return;
    }

    if (!workspace?.has_agent) {
      wsClient.send({ type: "start_agent", workspace_id: selectedWorkspaceId });
    }

    wsClient.send({
      type: "send_message",
      workspace_id: selectedWorkspaceId,
      message: text,
    });
  };

  const handleStop = () => {
    if (!selectedWorkspaceId || !wsClient) return;
    wsClient.send({ type: "interrupt_agent", workspace_id: selectedWorkspaceId });
  };

  const handleQuestionAnswer = (answer: string) => {
    if (!selectedWorkspaceId || !wsClient) return;
    wsClient.send({
      type: "send_message",
      workspace_id: selectedWorkspaceId,
      message: answer,
    });
  };

  const removeQueued = (idx: number) => {
    setQueuedMessages((prev) => prev.filter((_, i) => i !== idx));
  };

  const toggleActivityRow = (rowId: string) => {
    setExpandedActivityIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) {
        next.delete(rowId);
      } else {
        next.add(rowId);
      }
      return next;
    });
  };

  if (!selectedWorkspaceId || !workspace) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center space-y-2">
          <span className="material-symbols-rounded !text-[48px] md-text-faint">chat</span>
          <p className="text-sm md-text-muted">Select a workspace to start chatting</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b md-outline px-4 py-3">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="flex-shrink-0 -ml-1 p-1 rounded-lg hover:bg-white/5 transition-colors"
            title="Back to workspaces"
          >
            <span className="material-symbols-rounded !text-[20px] md-text-muted">arrow_back</span>
          </button>
        )}
        <span
          className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
          style={{ backgroundColor: isRunning ? "#34d399" : "#71717a" }}
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-medium md-text-strong truncate">{workspace.name}</h2>
          <span className="text-xs md-text-faint">{workspace.branch}</span>
        </div>
        {onOpenTools && (
          <button
            type="button"
            onClick={onOpenTools}
            className="flex-shrink-0 p-1 rounded-lg hover:bg-white/5 transition-colors"
            title="Files & tools"
          >
            <span className="material-symbols-rounded !text-[20px] md-text-muted">folder_open</span>
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {chatRows.length === 0 && (
          <div className="text-center text-sm md-text-faint py-8">
            No messages yet. Send a prompt to get started.
          </div>
        )}

        {chatRows.map((row, rowIdx) => {
          if (row.kind === "activity") {
            const isLatestRunningActivity = isRunning && rowIdx === chatRows.length - 1;
            const expanded = expandedActivityIds.has(row.id);
            return (
              <div key={row.id}>
                <button
                  type="button"
                  onClick={() => toggleActivityRow(row.id)}
                  className="flex w-full items-center gap-2 py-1.5 text-left transition hover:bg-white/5"
                >
                  <span className="text-xs md-text-faint">
                    Agent activity ({row.group.messages.length} events)
                  </span>
                  {isLatestRunningActivity && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-700/60 bg-amber-950/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
                      running
                    </span>
                  )}
                  <span className="material-symbols-rounded ml-auto !text-sm md-text-faint">
                    {expanded ? "expand_more" : "chevron_right"}
                  </span>
                </button>

                {expanded && (
                  <div className="space-y-1.5 pl-2 pt-1 pb-1">
                    {row.group.lines.map((line, lineIdx) => (
                      <div key={`${row.id}-line-${lineIdx}`} className="flex items-start gap-2 text-xs md-text-faint">
                        <span className="mt-1 h-1 w-1 flex-none rounded-full bg-white/20" />
                        <span className="break-all font-mono">
                          <LinkifiedInlineText
                            text={line.text}
                            className="underline decoration-white/35 underline-offset-2 hover:decoration-white/70"
                          />
                        </span>
                        {line.count > 1 && (
                          <span className="text-[10px] md-text-faint">x{line.count}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          }

          const msg = row.message;
          const isUser =
            msg.role === "user" ||
            msg.agent_id === "user" ||
            msg.content.trimStart().startsWith(">");

          if (msg.is_error) {
            if (msg.role === "credential_error") {
              return (
                <div key={row.id} className="rounded-xl border border-amber-700/60 bg-amber-950/25 px-3 py-2">
                  <div className="mb-1 text-[11px] uppercase tracking-wide text-amber-300">Credential Error</div>
                  <pre className="select-text overflow-x-auto whitespace-pre-wrap text-sm text-amber-200">{msg.content}</pre>
                </div>
              );
            }
            return (
              <div key={row.id} className="rounded-xl border border-rose-700/60 bg-rose-950/20 px-3 py-2">
                <div className="mb-1 text-[11px] uppercase tracking-wide text-rose-300">Error</div>
                <pre className="select-text overflow-x-auto whitespace-pre-wrap text-sm text-rose-200">{msg.content}</pre>
              </div>
            );
          }

          if (msg.role === "question") {
            return (
              <QuestionCard
                key={row.id}
                message={msg}
                rowId={row.id}
                isAnswered={answeredQuestionTimestamps.has(msg.timestamp)}
                onAnswer={handleQuestionAnswer}
              />
            );
          }

          if (isUser) {
            return (
              <div key={row.id} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-sky-900/40 px-4 py-3">
                  <pre className="select-text overflow-x-auto whitespace-pre-wrap text-sm leading-relaxed md-text-strong">
                    {msg.content.replace(/^>\s?/, "")}
                  </pre>
                </div>
              </div>
            );
          }

          return (
            <div key={row.id}>
              <MarkdownMessage content={msg.content} />
            </div>
          );
        })}

        {isRunning && chatRows.length > 0 && chatRows[chatRows.length - 1].kind !== "activity" && (
          <div className="flex items-center gap-2 text-sm md-text-muted">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            Claude is thinking...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t md-outline px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]">
        {/* Queued messages */}
        {queuedMessages.length > 0 && (
          <div className="mb-2 space-y-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider md-text-faint">
              Queued ({queuedMessages.length})
            </div>
            {queuedMessages.map((msg, idx) => (
              <div
                key={idx}
                className="flex items-start gap-2 rounded-lg border border-dashed border-sky-500/30 bg-sky-950/20 px-3 py-2"
              >
                <span className="mt-0.5 shrink-0 text-[10px] font-mono text-sky-400/70">#{idx + 1}</span>
                <p className="min-w-0 flex-1 text-xs md-text-secondary line-clamp-2">{msg}</p>
                <button
                  type="button"
                  onClick={() => removeQueued(idx)}
                  className="shrink-0 opacity-60 hover:opacity-100 transition-opacity"
                  title="Remove from queue"
                >
                  <span className="material-symbols-rounded !text-[14px] md-text-faint">close</span>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Composer card */}
        <div className="rounded-xl border md-outline overflow-hidden">
          <textarea
            ref={textareaRef}
            className="w-full bg-transparent px-3 pt-2.5 pb-1 text-sm leading-relaxed outline-none md-text-primary placeholder:md-text-muted resize-none overflow-y-auto"
            style={{ minHeight: "96px", maxHeight: "45vh" }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Ask to make changes..."
          />

          {/* Toolbar */}
          <div className="flex items-center justify-between px-3 py-2 border-t border-[var(--md-sys-color-outline)]/30">
            <span className="text-[10px] md-text-faint select-none hidden sm:inline">Shift+Enter for newline</span>
            <div className="flex items-center gap-1 ml-auto">
              {isRunning && (
                <button
                  type="button"
                  onClick={handleStop}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
                  title="Interrupt agent"
                >
                  <span className="material-symbols-rounded !text-[15px]">stop</span>
                  <span>Stop</span>
                </button>
              )}
              <button
                type="button"
                onClick={handleSend}
                disabled={!input.trim()}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-sky-400 hover:bg-sky-500/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                title={isRunning ? "Queue message (sent after current run)" : "Send message"}
              >
                <span className="material-symbols-rounded !text-[15px]">
                  {isRunning ? "queue" : "send"}
                </span>
                <span>{isRunning ? "Queue" : "Send"}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default CenterPanel;
