import { create } from "zustand";
import type { FileEntryInfo, ChangeInfo, CheckInfo, TerminalEntry } from "../types";

interface FileStore {
  files: FileEntryInfo[];
  currentPath: string;
  fileContent: string | null;
  fileContentPath: string | null;
  changes: ChangeInfo[];
  checks: CheckInfo[];
  // Diff viewer
  diffContent: string | null;
  diffFilePath: string | null;
  // Terminal
  terminalHistory: TerminalEntry[];
  terminalRunning: boolean;

  setFiles: (files: FileEntryInfo[], path: string) => void;
  setFileContent: (path: string, content: string) => void;
  clearFileContent: () => void;
  setChanges: (changes: ChangeInfo[]) => void;
  setChecks: (checks: CheckInfo[]) => void;
  setDiff: (filePath: string, diff: string) => void;
  clearDiff: () => void;
  addTerminalCommand: (command: string) => void;
  setTerminalOutput: (stdout: string, stderr: string, exitCode?: number | null) => void;
  clearTerminal: () => void;
}

let terminalIdCounter = 0;

export const useFileStore = create<FileStore>((set) => ({
  files: [],
  currentPath: "",
  fileContent: null,
  fileContentPath: null,
  changes: [],
  checks: [],
  diffContent: null,
  diffFilePath: null,
  terminalHistory: [],
  terminalRunning: false,

  setFiles: (files, currentPath) => set({ files, currentPath }),
  setFileContent: (fileContentPath, fileContent) => set({ fileContent, fileContentPath }),
  clearFileContent: () => set({ fileContent: null, fileContentPath: null }),
  setChanges: (changes) => set({ changes }),
  setChecks: (checks) => set({ checks }),
  setDiff: (diffFilePath, diffContent) => set({ diffContent, diffFilePath }),
  clearDiff: () => set({ diffContent: null, diffFilePath: null }),
  addTerminalCommand: (command) =>
    set((state) => ({
      terminalRunning: true,
      terminalHistory: [
        ...state.terminalHistory,
        { id: String(++terminalIdCounter), command, stdout: "", stderr: "", running: true },
      ],
    })),
  setTerminalOutput: (stdout, stderr, exitCode) =>
    set((state) => {
      const history = [...state.terminalHistory];
      if (history.length > 0) {
        const last = { ...history[history.length - 1] };
        last.stdout = stdout;
        last.stderr = stderr;
        last.exit_code = exitCode;
        last.running = false;
        history[history.length - 1] = last;
      }
      return { terminalHistory: history, terminalRunning: false };
    }),
  clearTerminal: () => set({ terminalHistory: [], terminalRunning: false }),
}));
