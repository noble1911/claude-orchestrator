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
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const workspace = workspaces.find((w) => w.id === selectedWorkspaceId);
  const workspaceMessages = selectedWorkspaceId ? (messages[selectedWorkspaceId] ?? []) : [];
  const isRunning = selectedWorkspaceId ? running[selectedWorkspaceId] ?? false : false;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [workspaceMessages.length]);

  const handleSend = () => {
    if (!input.trim() || !selectedWorkspaceId || !wsClient) return;

    // Start agent if not running
    if (!isRunning && !workspace?.has_agent) {
      wsClient.send({ type: "start_agent", workspace_id: selectedWorkspaceId });
    }

    wsClient.send({
      type: "send_message",
      workspace_id: selectedWorkspaceId,
      message: input.trim(),
    });
    setInput("");
  };

  const handleStop = () => {
    if (!selectedWorkspaceId || !wsClient) return;
    wsClient.send({ type: "interrupt_agent", workspace_id: selectedWorkspaceId });
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
      <div className="flex items-center gap-3 border-b md-outline px-4 py-3 md-surface-container">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full transition-colors ${isRunning ? "md-status-running" : "md-status-idle"}`}
        />
        <h2 className="md-title-small">{workspace.name}</h2>
        <span className="md-chip !text-[10px]">{workspace.branch}</span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {workspaceMessages.length === 0 && (
          <div className="text-center text-sm md-text-faint py-8">
            No messages yet. Send a prompt to get started.
          </div>
        )}
        {workspaceMessages.map((msg, i) => {
          // Skip activity/system lines that are just CLI noise
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
                      : "md-card"
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

      {/* Input */}
      <div className="border-t md-outline px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            className="md-field flex-1 resize-none"
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Send a message..."
          />
          {isRunning ? (
            <button type="button" className="md-btn" onClick={handleStop} title="Interrupt">
              <span className="material-symbols-rounded !text-[18px]">stop</span>
            </button>
          ) : (
            <button
              type="button"
              className="md-btn md-btn-tonal"
              onClick={handleSend}
              disabled={!input.trim()}
            >
              <span className="material-symbols-rounded !text-[18px]">send</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default CenterPanel;
