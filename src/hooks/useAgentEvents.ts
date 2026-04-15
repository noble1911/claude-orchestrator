import { useEffect, type Dispatch, type SetStateAction, type RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type {
  AgentMessage,
  AgentRunStateEvent,
  PermissionRequestEvent,
  Workspace,
  QueuedMessage,
} from "../types";
import { upsertMessageByIdentity, isUnreadCandidateMessage, extractPullRequestUrl } from "../utils";

interface UseAgentEventsParams {
  selectedWorkspaceRef: RefObject<string | null>;
  thinkingSinceByWorkspaceRef: RefObject<Record<string, number | null>>;
  pendingUnreadByWorkspaceRef: RefObject<Record<string, boolean>>;
  detectedPrUrlByWorkspaceRef: RefObject<Record<string, string>>;
  queuedMessagesByWorkspaceRef: RefObject<Record<string, QueuedMessage[]>>;
  sendMessageRef: RefObject<(rawMessage?: string, visibleOverride?: string, targetWorkspaceId?: string) => Promise<boolean>>;
  setMessages: Dispatch<SetStateAction<AgentMessage[]>>;
  setThinkingSinceByWorkspace: Dispatch<SetStateAction<Record<string, number | null>>>;
  setPendingUnreadByWorkspace: Dispatch<SetStateAction<Record<string, boolean>>>;
  setUnreadByWorkspace: Dispatch<SetStateAction<Record<string, number>>>;
  setCredentialErrorWorkspaces: Dispatch<SetStateAction<Set<string>>>;
  setWorkspaces: Dispatch<SetStateAction<Workspace[]>>;
  setGodChildWorkspaces: Dispatch<SetStateAction<Workspace[]>>;
  setGodWorkspaces: Dispatch<SetStateAction<Workspace[]>>;
  setPendingPermissions: Dispatch<SetStateAction<Record<string, PermissionRequestEvent[]>>>;
  setQueuedMessagesByWorkspace: Dispatch<SetStateAction<Record<string, QueuedMessage[]>>>;
  persistUnread: (workspaceId: string, count: number) => void;
}

/**
 * Subscribes to Tauri agent-related events:
 * - `agent-message`: upserts messages, tracks unread counts, detects PR URLs
 * - `agent-run-state`: tracks thinking state, drains message queues, finalizes unread
 * - `permission-request`: queues permission prompts for the UI
 *
 * All handlers use refs for cross-workspace state to avoid stale closures.
 */
export function useAgentEvents(params: UseAgentEventsParams): void {
  const {
    selectedWorkspaceRef,
    thinkingSinceByWorkspaceRef,
    pendingUnreadByWorkspaceRef,
    detectedPrUrlByWorkspaceRef,
    queuedMessagesByWorkspaceRef,
    sendMessageRef,
    setMessages,
    setThinkingSinceByWorkspace,
    setPendingUnreadByWorkspace,
    setUnreadByWorkspace,
    setCredentialErrorWorkspaces,
    setWorkspaces,
    setGodChildWorkspaces,
    setGodWorkspaces,
    setPendingPermissions,
    setQueuedMessagesByWorkspace,
    persistUnread,
  } = params;

  useEffect(() => {
    const unlisten = listen<AgentMessage>("agent-message", (event) => {
      const messageWorkspaceId = event.payload.workspaceId ?? selectedWorkspaceRef.current;
      if (messageWorkspaceId && selectedWorkspaceRef.current === messageWorkspaceId) {
        setMessages((prev) => upsertMessageByIdentity(prev, event.payload));
      }
      if (
        messageWorkspaceId &&
        selectedWorkspaceRef.current !== messageWorkspaceId &&
        isUnreadCandidateMessage(event.payload)
      ) {
        const isWorkspaceRunning = (thinkingSinceByWorkspaceRef.current[messageWorkspaceId] ?? null) !== null;
        if (isWorkspaceRunning) {
          setPendingUnreadByWorkspace((prev) => {
            if (prev[messageWorkspaceId]) return prev;
            const next = { ...prev, [messageWorkspaceId]: true };
            pendingUnreadByWorkspaceRef.current = next;
            return next;
          });
        } else {
          setUnreadByWorkspace((prev) => {
            const next = (prev[messageWorkspaceId] || 0) + 1;
            persistUnread(messageWorkspaceId, next);
            return { ...prev, [messageWorkspaceId]: next };
          });
        }
      }
      if (event.payload.role === "credential_error" && messageWorkspaceId) {
        setCredentialErrorWorkspaces((prev) => new Set(prev).add(messageWorkspaceId));
      }
      if (
        messageWorkspaceId &&
        event.payload.agentId !== "user" &&
        (event.payload.role ?? "") !== "user"
      ) {
        const prUrl = extractPullRequestUrl(event.payload.content);
        if (prUrl && detectedPrUrlByWorkspaceRef.current[messageWorkspaceId] !== prUrl) {
          detectedPrUrlByWorkspaceRef.current[messageWorkspaceId] = prUrl;
          const prUpdater = (prev: Workspace[]) =>
            prev.map((workspace) =>
              workspace.id === messageWorkspaceId
                ? { ...workspace, status: workspace.status === "merged" ? "merged" : "inReview" as Workspace["status"], prUrl }
                : workspace,
            );
          setWorkspaces(prUpdater);
          setGodChildWorkspaces(prUpdater);
          setGodWorkspaces(prUpdater);
          invoke("mark_workspace_in_review", { workspaceId: messageWorkspaceId, prUrl }).catch((err) => {
            console.error("Failed to mark workspace in review:", err);
          });
        }
      }
    });

    const unlistenRunState = listen<AgentRunStateEvent>("agent-run-state", (event) => {
      const { workspaceId, running, timestamp } = event.payload;
      if (!workspaceId) return;

      setThinkingSinceByWorkspace((prev) => {
        const current = prev[workspaceId] ?? null;
        if (running) {
          if (current !== null) return prev;
          const parsedTimestamp = Date.parse(timestamp);
          const startedAt = Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now();
          const next = { ...prev, [workspaceId]: startedAt };
          thinkingSinceByWorkspaceRef.current = next;
          return next;
        }
        if (current === null) return prev;
        const next = { ...prev, [workspaceId]: null };
        thinkingSinceByWorkspaceRef.current = next;
        return next;
      });

      if (running) {
        return;
      }

      // Clear any pending permission requests when agent stops
      setPendingPermissions((prev) => {
        if (!prev[workspaceId]) return prev;
        const next = { ...prev };
        delete next[workspaceId];
        return next;
      });

      // Drain the next queued message for this workspace
      const queue = queuedMessagesByWorkspaceRef.current[workspaceId];
      if (queue && queue.length > 0) {
        const [next, ...rest] = queue;
        setQueuedMessagesByWorkspace((prev) => ({
          ...prev,
          [workspaceId]: rest,
        }));
        void sendMessageRef.current(next.text, next.visible, workspaceId);
      }

      if (selectedWorkspaceRef.current === workspaceId) {
        setPendingUnreadByWorkspace((prev) => {
          if (!prev[workspaceId]) return prev;
          const next = { ...prev };
          delete next[workspaceId];
          pendingUnreadByWorkspaceRef.current = next;
          return next;
        });
        return;
      }
      if (pendingUnreadByWorkspaceRef.current[workspaceId]) {
        setUnreadByWorkspace((prev) => {
          const next = (prev[workspaceId] || 0) + 1;
          persistUnread(workspaceId, next);
          return { ...prev, [workspaceId]: next };
        });
        setPendingUnreadByWorkspace((prev) => {
          if (!prev[workspaceId]) return prev;
          const next = { ...prev };
          delete next[workspaceId];
          pendingUnreadByWorkspaceRef.current = next;
          return next;
        });
      }
    });

    const unlistenPermission = listen<PermissionRequestEvent>("permission-request", (event) => {
      const req = event.payload;
      if (req.workspaceId) {
        setPendingPermissions((prev) => ({
          ...prev,
          [req.workspaceId]: [...(prev[req.workspaceId] || []), req],
        }));
      }
    });

    return () => {
      void unlisten.then((fn) => fn());
      void unlistenRunState.then((fn) => fn());
      void unlistenPermission.then((fn) => fn());
    };
  // All params are refs or dispatch functions (stable references) — [] is correct
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
