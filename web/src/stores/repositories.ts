import { create } from "zustand";
import type { Repository } from "../types";

interface RepositoryStore {
  repositories: Repository[];
  selectedRepoId: string | null;

  setRepositories: (repos: Repository[]) => void;
  setSelectedRepoId: (id: string | null) => void;
}

export const useRepositoryStore = create<RepositoryStore>((set) => ({
  repositories: [],
  selectedRepoId: null,

  setRepositories: (repositories) => set({ repositories }),
  setSelectedRepoId: (selectedRepoId) => set({ selectedRepoId }),
}));
