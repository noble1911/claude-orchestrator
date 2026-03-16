import { create } from "zustand";
import type { WorkspaceInfo } from "../types";

interface WorkspaceStore {
  workspaces: WorkspaceInfo[];
  selectedWorkspaceId: string | null;

  setWorkspaces: (workspaces: WorkspaceInfo[]) => void;
  setSelectedWorkspaceId: (id: string | null) => void;
  updateWorkspace: (workspace: WorkspaceInfo) => void;
  removeWorkspace: (id: string) => void;
  addWorkspace: (workspace: WorkspaceInfo) => void;
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
  workspaces: [],
  selectedWorkspaceId: null,

  setWorkspaces: (workspaces) => set({ workspaces }),
  setSelectedWorkspaceId: (selectedWorkspaceId) => set({ selectedWorkspaceId }),
  updateWorkspace: (workspace) =>
    set((state) => ({
      workspaces: state.workspaces.map((w) => (w.id === workspace.id ? workspace : w)),
    })),
  removeWorkspace: (id) =>
    set((state) => ({
      workspaces: state.workspaces.filter((w) => w.id !== id),
      selectedWorkspaceId: state.selectedWorkspaceId === id ? null : state.selectedWorkspaceId,
    })),
  addWorkspace: (workspace) =>
    set((state) => ({
      workspaces: [...state.workspaces, workspace],
    })),
}));
