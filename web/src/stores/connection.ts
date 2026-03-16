import { create } from "zustand";
import type { ConnectionState } from "../types";
import { WsClient } from "../services/ws-client";

interface ConnectionStore {
  state: ConnectionState;
  clientId: string | null;
  wsClient: WsClient | null;
  error: string | null;

  setState: (state: ConnectionState) => void;
  setClientId: (id: string) => void;
  setWsClient: (client: WsClient | null) => void;
  setError: (error: string | null) => void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  state: "disconnected",
  clientId: null,
  wsClient: null,
  error: null,

  setState: (state) => set({ state, error: state === "connected" ? null : undefined }),
  setClientId: (clientId) => set({ clientId }),
  setWsClient: (wsClient) => set({ wsClient }),
  setError: (error) => set({ error }),
}));
