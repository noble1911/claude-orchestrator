import { create } from "zustand";
import type { FileEntryInfo, ChangeInfo, CheckInfo } from "../types";

interface FileStore {
  files: FileEntryInfo[];
  currentPath: string;
  fileContent: string | null;
  fileContentPath: string | null;
  changes: ChangeInfo[];
  checks: CheckInfo[];

  setFiles: (files: FileEntryInfo[], path: string) => void;
  setFileContent: (path: string, content: string) => void;
  clearFileContent: () => void;
  setChanges: (changes: ChangeInfo[]) => void;
  setChecks: (checks: CheckInfo[]) => void;
}

export const useFileStore = create<FileStore>((set) => ({
  files: [],
  currentPath: "",
  fileContent: null,
  fileContentPath: null,
  changes: [],
  checks: [],

  setFiles: (files, currentPath) => set({ files, currentPath }),
  setFileContent: (fileContentPath, fileContent) => set({ fileContent, fileContentPath }),
  clearFileContent: () => set({ fileContent: null, fileContentPath: null }),
  setChanges: (changes) => set({ changes }),
  setChecks: (checks) => set({ checks }),
}));
