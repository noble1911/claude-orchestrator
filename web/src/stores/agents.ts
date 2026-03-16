import { create } from "zustand";
import type { MessageInfo } from "../types";

interface AgentStore {
  // Messages per workspace
  messages: Record<string, MessageInfo[]>;
  // Running state per workspace
  running: Record<string, boolean>;
  // Subscribed workspace IDs
  subscriptions: Set<string>;

  setMessages: (workspaceId: string, messages: MessageInfo[]) => void;
  appendMessage: (workspaceId: string, message: MessageInfo) => void;
  upsertMessage: (workspaceId: string, message: MessageInfo) => void;
  setRunning: (workspaceId: string, isRunning: boolean) => void;
  addSubscription: (workspaceId: string) => void;
  removeSubscription: (workspaceId: string) => void;
}

function messageIdentity(m: MessageInfo): string {
  return `${m.timestamp}::${m.agent_id}::${m.role}`;
}

export const useAgentStore = create<AgentStore>((set) => ({
  messages: {},
  running: {},
  subscriptions: new Set(),

  setMessages: (workspaceId, messages) =>
    set((state) => ({
      messages: { ...state.messages, [workspaceId]: messages },
    })),

  appendMessage: (workspaceId, message) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [workspaceId]: [...(state.messages[workspaceId] ?? []), message],
      },
    })),

  upsertMessage: (workspaceId, message) =>
    set((state) => {
      const existing = state.messages[workspaceId] ?? [];
      const key = messageIdentity(message);
      let idx = -1;
      for (let i = existing.length - 1; i >= 0; i--) {
        if (messageIdentity(existing[i]) === key) {
          idx = i;
          break;
        }
      }
      if (idx < 0) {
        return { messages: { ...state.messages, [workspaceId]: [...existing, message] } };
      }
      const updated = [...existing];
      updated[idx] = message;
      return { messages: { ...state.messages, [workspaceId]: updated } };
    }),

  setRunning: (workspaceId, isRunning) =>
    set((state) => ({
      running: { ...state.running, [workspaceId]: isRunning },
    })),

  addSubscription: (workspaceId) =>
    set((state) => {
      const next = new Set(state.subscriptions);
      next.add(workspaceId);
      return { subscriptions: next };
    }),

  removeSubscription: (workspaceId) =>
    set((state) => {
      const next = new Set(state.subscriptions);
      next.delete(workspaceId);
      return { subscriptions: next };
    }),
}));
