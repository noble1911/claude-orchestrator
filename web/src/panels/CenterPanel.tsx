import { useState, useRef, useEffect } from "react";
import { useWorkspaceStore } from "../stores/workspaces";
import { useAgentStore } from "../stores/agents";
import { useConnectionStore } from "../stores/connection";
import MarkdownMessage from "../components/MarkdownMessage";

function CenterPanel() {
  const selectedWorkspaceId = useWorkspaceStore((s) => s.selectedWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const messages = useAgentStore((s) => s.messages);
  const running = useAgentStore((s) => s.running);
  const wsClient = useConnectionStore((s) => s.wsClient);

  const [input, setInput] = useState("");
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
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

  // Clear queue when switching workspaces
  useEffect(() => {
    setQueuedMessages([]);
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

  const handleSend = () => {
    if (!input.trim() || !selectedWorkspaceId || !wsClient) return;

    const text = input.trim();
    setInput("");

    // If agent is busy, queue instead of sending
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

  const removeQueued = (idx: number) => {
    setQueuedMessages((prev) => prev.filter((_, i) => i !== idx));
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
        <span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: isRunning ? "#34d399" : "#71717a" }}
        />
        <h2 className="text-base font-medium md-text-strong">{workspace.name}</h2>
        <span className="text-xs md-text-faint">{workspace.branch}</span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {workspaceMessages.length === 0 && (
          <div className="text-center text-sm md-text-faint py-8">
            No messages yet. Send a prompt to get started.
          </div>
        )}
        {workspaceMessages.map((msg, i) => {
          if (msg.role === "system" && msg.content.startsWith("cli:")) return null;

          const isUser = msg.role === "user";
          const isError = msg.is_error;

          return (
            <div key={`${msg.timestamp}-${i}`} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                  isUser
                    ? "bg-[var(--md-sys-color-primary)]/15 border border-[var(--md-sys-color-primary)]/30"
                    : isError
                      ? "bg-red-500/10 border border-red-500/20"
                      : "md-surface-container-high border md-outline"
                }`}
              >
                {isUser ? (
                  <p className="text-sm md-text-primary whitespace-pre-wrap">{msg.content}</p>
                ) : (
                  <MarkdownMessage content={msg.content} />
                )}
              </div>
            </div>
          );
        })}
        {isRunning && (
          <div className="flex items-center gap-2 text-sm md-text-muted">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            Claude is thinking...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t md-outline px-4 py-3">
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
            <span className="text-[10px] md-text-faint select-none">Shift+Enter for newline</span>
            <div className="flex items-center gap-1">
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
