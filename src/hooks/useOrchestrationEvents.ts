import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  OrchestrationEvent,
  OrchestrationChildStatus,
  OrchestrationArtifact,
  OrchestrationSnapshot,
} from "../types";

const MAX_EVENTS = 200;

export interface OrchestrationState {
  events: OrchestrationEvent[];
  children: Map<string, OrchestrationChildStatus>;
  artifacts: OrchestrationArtifact[];
  isLoading: boolean;
}

export function useOrchestrationEvents(
  godWorkspaceId: string | null,
): OrchestrationState {
  const [events, setEvents] = useState<OrchestrationEvent[]>([]);
  const [children, setChildren] = useState<Map<string, OrchestrationChildStatus>>(new Map());
  const [artifacts, setArtifacts] = useState<OrchestrationArtifact[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const genRef = useRef(0);

  useEffect(() => {
    if (!godWorkspaceId) {
      setEvents([]);
      setChildren(new Map());
      setArtifacts([]);
      return;
    }

    const gen = ++genRef.current;
    setIsLoading(true);

    invoke<OrchestrationSnapshot>("get_orchestration_state", { godWorkspaceId })
      .then((snapshot) => {
        if (gen !== genRef.current) return;
        const map = new Map<string, OrchestrationChildStatus>();
        for (const child of snapshot.children) {
          map.set(child.workspaceId, child);
        }
        setChildren(map);
        setArtifacts(snapshot.artifacts);
        setEvents([]);
      })
      .catch(console.error)
      .finally(() => {
        if (gen === genRef.current) setIsLoading(false);
      });
  }, [godWorkspaceId]);

  useEffect(() => {
    if (!godWorkspaceId) return;

    const unlisten = listen<OrchestrationEvent>("orchestration-event", (event) => {
      const e = event.payload;
      if (e.godWorkspaceId !== godWorkspaceId) return;

      setEvents((prev) => {
        const next = [...prev, e];
        return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next;
      });

      if (e.childWorkspaceId) {
        const childId = e.childWorkspaceId;
        setChildren((prev) => {
          const existing = prev.get(childId) ?? {
            workspaceId: childId,
            name: e.childWorkspaceName ?? childId,
            workspaceStatus: "idle",
            agentStatus: null,
            processing: false,
            completionReason: null,
            messageCount: 0,
            lastActivity: null,
          };

          const updated: OrchestrationChildStatus = {
            ...existing,
            name: e.childWorkspaceName ?? existing.name,
            processing:
              e.kind === "messageSent" || e.kind === "waitStarted"
                ? true
                : e.kind === "waitCompleted" || e.kind === "agentStopped"
                  ? false
                  : existing.processing,
            agentStatus:
              e.kind === "agentStarted"
                ? "running"
                : e.kind === "agentStopped"
                  ? "stopped"
                  : existing.agentStatus,
            lastActivity: e.timestamp,
            messageCount:
              e.kind === "messageSent"
                ? existing.messageCount + 1
                : existing.messageCount,
          };

          const next = new Map(prev);
          next.set(childId, updated);
          return next;
        });
      }

      if (e.kind === "artifactWritten" && e.artifactKey) {
        const key = e.artifactKey;
        setArtifacts((prev) => {
          const filtered = prev.filter((a) => a.key !== key);
          return [{ key, value: "", updatedAt: e.timestamp }, ...filtered];
        });
      } else if (e.kind === "artifactDeleted" && e.artifactKey) {
        const key = e.artifactKey;
        setArtifacts((prev) => prev.filter((a) => a.key !== key));
      }
    });

    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [godWorkspaceId]);

  return { events, children, artifacts, isLoading };
}
