import {
  useCallback,
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import {
  COLOR_TOKEN_KEYS,
  DEFAULT_THEME_ID,
  THEME_STORAGE_KEY,
  THEME_COLOR_FIELDS,
  type ThemeColorTokenKey,
  type ThemeDefinition,
  type ThemeMap,
  applyTheme,
  createThemeId,
  getAllThemes,
  getStoredThemeId,
  getThemeOptions,
  isBuiltInTheme,
  isHexColor,
  loadCustomThemes,
  normalizeThemeId,
  saveCustomThemes,
} from "./themes";
import {
  NAME_ADJECTIVES,
  NAME_NOUNS,
  MODEL_OPTIONS,
  DEFAULT_MODEL_ID,
  PROMPT_SHORTCUTS_STORAGE_KEY,
  ENV_OVERRIDES_STORAGE_KEY,
  CLAUDE_MODE_STORAGE_KEY,
  MODEL_STORAGE_KEY,
  MODEL_BY_WORKSPACE_STORAGE_KEY,
  THINKING_MODE_STORAGE_KEY,
  DEFAULT_REPOSITORY_STORAGE_KEY,
  BEDROCK_ENV_KEY,
  WORKSPACE_GROUPS_STORAGE_KEY,
  WORKSPACE_GROUP_OVERRIDES_STORAGE_KEY,
  DEFAULT_WORKSPACE_GROUPS,
  LEFT_PANEL_OPEN_STORAGE_KEY,
  RIGHT_PANEL_OPEN_STORAGE_KEY,
} from "./constants";
import {
  compactActivityLines,
  upsertMessageByIdentity,
  shortText,
  toWorkspaceRelativePath,
  statusForGroup,
  cloneThemeColors,
  createThemeDraftFromTheme,
  isTruthyEnvValue,
  upsertEnvOverrideLine,
} from "./utils";
import type {
  Repository,
  Workspace,
  Agent,
  AgentMessage,
  AgentRunStateEvent,
  ServerStatus,
  AppStatus,
  UpdateInfo,
  OrchestratorConfig,
  WorkspaceFileEntry,
  WorkspaceChangeEntry,
  WorkspaceCheckResult,
  WorkspaceCheckDefinition,
  TerminalCommandResult,
  TerminalLine,
  PromptShortcut,
  SkillShortcut,
  SkillCatalogResponse,
  CenterTab,
  ClaudeMode,
  EditorKind,
  WorkspaceOpenTarget,
  SkillScope,
  QueuedMessage,
  ThemeDraft,
  ChatRow,
  WorkspaceGroup,
} from "./types";
import LinkifiedInlineText from "./components/LinkifiedInlineText";
import MarkdownMessage from "./components/MarkdownMessage";
import QuestionCard from "./components/QuestionCard";
import SortableWorkspaceItem from "./components/SortableWorkspaceItem";
import GroupDropZone from "./components/GroupDropZone";


function App() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [defaultRepoId, setDefaultRepoId] = useState<string | null>(null);
  const [defaultRepoInitialized, setDefaultRepoInitialized] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availableUpdate, setAvailableUpdate] = useState<UpdateInfo | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [inputMessageByWorkspace, setInputMessageByWorkspace] = useState<Record<string, string>>({});
  const [activeRightTab, setActiveRightTab] = useState<"prompts" | "files" | "changes" | "checks">("prompts");
  const [workspaceFilesByPath, setWorkspaceFilesByPath] = useState<Record<string, WorkspaceFileEntry[]>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileContentsByPath, setFileContentsByPath] = useState<Record<string, string>>({});
  const [isLoadingFileContent, setIsLoadingFileContent] = useState(false);
  const [diffContentsByTab, setDiffContentsByTab] = useState<Record<string, string>>({});
  const [loadingDiffTabId, setLoadingDiffTabId] = useState<string | null>(null);
  const [centerTabs, setCenterTabs] = useState<CenterTab[]>([{ id: "chat", type: "chat", title: "Chat" }]);
  const [activeCenterTabId, setActiveCenterTabId] = useState("chat");
  const [workspaceChanges, setWorkspaceChanges] = useState<WorkspaceChangeEntry[]>([]);
  const [isLoadingChanges, setIsLoadingChanges] = useState(false);
  const [checkResults, setCheckResults] = useState<WorkspaceCheckResult[]>([]);
  const [detectedChecks, setDetectedChecks] = useState<WorkspaceCheckDefinition[]>([]);
  const [isLoadingDetectedChecks, setIsLoadingDetectedChecks] = useState(false);
  const [isRunningChecks, setIsRunningChecks] = useState(false);
  const [promptShortcuts, setPromptShortcuts] = useState<PromptShortcut[]>([]);
  const [showAddPromptForm, setShowAddPromptForm] = useState(false);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [newPromptName, setNewPromptName] = useState("");
  const [newPromptBody, setNewPromptBody] = useState("");
  const [newPromptAutoRunOnCreate, setNewPromptAutoRunOnCreate] = useState(false);
  const [projectSkills, setProjectSkills] = useState<SkillShortcut[]>([]);
  const [userSkills, setUserSkills] = useState<SkillShortcut[]>([]);
  const [projectSkillsRoot, setProjectSkillsRoot] = useState<string | null>(null);
  const [userSkillsRoot, setUserSkillsRoot] = useState<string | null>(null);
  const [isSkillsLoading, setIsSkillsLoading] = useState(false);
  const [projectSkillsExpanded, setProjectSkillsExpanded] = useState(true);
  const [userSkillsExpanded, setUserSkillsExpanded] = useState(true);
  const [showSkillForm, setShowSkillForm] = useState(false);
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [skillScopeDraft, setSkillScopeDraft] = useState<SkillScope>("project");
  const [skillRelativePathDraft, setSkillRelativePathDraft] = useState<string | null>(null);
  const [skillNameDraft, setSkillNameDraft] = useState("");
  const [skillBodyDraft, setSkillBodyDraft] = useState("");
  const [customThemes, setCustomThemes] = useState<ThemeMap>(() => loadCustomThemes());
  const [selectedTheme, setSelectedTheme] = useState<string>(() => {
    const themes = getAllThemes(loadCustomThemes());
    return getStoredThemeId(themes);
  });
  const [showThemeForm, setShowThemeForm] = useState(false);
  const [editingThemeId, setEditingThemeId] = useState<string | null>(null);
  const [themeDraft, setThemeDraft] = useState<ThemeDraft>(() => {
    const themes = getAllThemes(loadCustomThemes());
    const baseTheme = themes[DEFAULT_THEME_ID];
    return createThemeDraftFromTheme(baseTheme);
  });
  const [envOverridesText, setEnvOverridesText] = useState("");
  const [defaultClaudeMode, setDefaultClaudeMode] = useState<ClaudeMode>("normal");
  const [claudeModeByWorkspace, setClaudeModeByWorkspace] = useState<Record<string, ClaudeMode>>({});
  const [defaultModel, setDefaultModel] = useState(DEFAULT_MODEL_ID);
  const [selectedModelByWorkspace, setSelectedModelByWorkspace] = useState<Record<string, string>>({});
  const [thinkingMode, setThinkingMode] = useState<"off" | "low" | "medium" | "high">("off");
  const [workspaceGroupConfig, setWorkspaceGroupConfig] = useState<WorkspaceGroup[]>(DEFAULT_WORKSPACE_GROUPS);
  const [workspaceGroupOverrides, setWorkspaceGroupOverrides] = useState<Record<string, string>>({});
  const [showGroupSettings, setShowGroupSettings] = useState(false);
  const [dragActiveId, setDragActiveId] = useState<string | null>(null);
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(() => {
    const stored = localStorage.getItem(LEFT_PANEL_OPEN_STORAGE_KEY);
    return stored !== null ? stored === "true" : true;
  });
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(() => {
    const stored = localStorage.getItem(RIGHT_PANEL_OPEN_STORAGE_KEY);
    return stored !== null ? stored === "true" : true;
  });
  const [autoStartingWorkspaceId, setAutoStartingWorkspaceId] = useState<string | null>(null);
  const [expandedActivityIdsByWorkspace, setExpandedActivityIdsByWorkspace] = useState<Record<string, string[]>>({});
  const [credentialErrorWorkspaces, setCredentialErrorWorkspaces] = useState<Set<string>>(new Set());
  const [answeredQuestionTimestamps, setAnsweredQuestionTimestamps] = useState<Set<string>>(new Set());
  const [thinkingSinceByWorkspace, setThinkingSinceByWorkspace] = useState<Record<string, number | null>>({});
  const [thinkingElapsedSec, setThinkingElapsedSec] = useState(0);
  const [showRenameForm, setShowRenameForm] = useState(false);
  const [renameWorkspaceId, setRenameWorkspaceId] = useState<string | null>(null);
  const [renameWorkspaceName, setRenameWorkspaceName] = useState("");
  const [showKeyboardShortcuts, setShowKeyboardShortcuts] = useState(false);
  const [workspaceOpenTarget, setWorkspaceOpenTarget] = useState<WorkspaceOpenTarget>("");
  const [leftPanelWidth, setLeftPanelWidth] = useState(280);
  const [rightPanelWidth, setRightPanelWidth] = useState(360);
  const [terminalHeight, setTerminalHeight] = useState(180);
  const [isResizingLeft, setIsResizingLeft] = useState(false);
  const [isResizingRight, setIsResizingRight] = useState(false);
  const [isResizingTerminal, setIsResizingTerminal] = useState(false);
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalHistoryByWorkspace, setTerminalHistoryByWorkspace] = useState<Record<string, string[]>>({});
  const [terminalHistoryIndex, setTerminalHistoryIndex] = useState<number | null>(null);
  const [terminalLinesByWorkspace, setTerminalLinesByWorkspace] = useState<Record<string, TerminalLine[]>>({});
  const [unreadByWorkspace, setUnreadByWorkspace] = useState<Record<string, number>>({});
  const [pendingUnreadByWorkspace, setPendingUnreadByWorkspace] = useState<Record<string, boolean>>({});
  const [isRunningTerminalCommand, setIsRunningTerminalCommand] = useState(false);
  const [isTogglingRemoteServer, setIsTogglingRemoteServer] = useState(false);
  const [terminalTab, setTerminalTab] = useState<"setup" | "remote" | "terminal">("terminal");
  const [pendingAutoPromptsByWorkspace, setPendingAutoPromptsByWorkspace] = useState<Record<string, PromptShortcut[]>>({});
  const [orchestratorConfig, setOrchestratorConfig] = useState<OrchestratorConfig | null>(null);
  const [isRunningScript, setIsRunningScript] = useState(false);
  const startingWorkspaceIdsRef = useRef<Set<string>>(new Set());
  const selectedWorkspaceRef = useRef<string | null>(null);
  const thinkingSinceByWorkspaceRef = useRef<Record<string, number | null>>({});
  const pendingUnreadByWorkspaceRef = useRef<Record<string, boolean>>({});
  const detectedPrUrlByWorkspaceRef = useRef<Record<string, string>>({});
  const sendMessageRef = useRef<(rawMessage?: string, visibleOverride?: string, targetWorkspaceId?: string) => Promise<boolean>>(async () => false);
  const [queuedMessagesByWorkspace, setQueuedMessagesByWorkspace] = useState<Record<string, QueuedMessage[]>>({});
  const queuedMessagesByWorkspaceRef = useRef<Record<string, QueuedMessage[]>>({});
  useEffect(() => { queuedMessagesByWorkspaceRef.current = queuedMessagesByWorkspace; }, [queuedMessagesByWorkspace]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const terminalEndRef = useRef<HTMLDivElement>(null);
  const terminalInputRef = useRef<HTMLInputElement>(null);
  const bedrockEnabled = useMemo(
    () => isTruthyEnvValue(parseEnvOverrides(envOverridesText)[BEDROCK_ENV_KEY]),
    [envOverridesText],
  );
  const allSkills = useMemo(() => [...projectSkills, ...userSkills], [projectSkills, userSkills]);
  const availableThemes = useMemo(() => getAllThemes(customThemes), [customThemes]);
  const themeOptions = useMemo(() => getThemeOptions(availableThemes), [availableThemes]);
  const inputMessage = selectedWorkspace ? (inputMessageByWorkspace[selectedWorkspace] ?? "") : "";
  const claudeMode = selectedWorkspace
    ? (claudeModeByWorkspace[selectedWorkspace] ?? defaultClaudeMode)
    : defaultClaudeMode;
  const selectedModel = selectedWorkspace
    ? (selectedModelByWorkspace[selectedWorkspace] ?? defaultModel)
    : defaultModel;

  useEffect(() => {
    selectedWorkspaceRef.current = selectedWorkspace;
  }, [selectedWorkspace]);

  useEffect(() => {
    thinkingSinceByWorkspaceRef.current = thinkingSinceByWorkspace;
  }, [thinkingSinceByWorkspace]);

  useEffect(() => {
    pendingUnreadByWorkspaceRef.current = pendingUnreadByWorkspace;
  }, [pendingUnreadByWorkspace]);

  // Global keyboard shortcuts (Conductor pattern)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger unmodified shortcuts when typing in inputs
      // Allow Cmd/Ctrl combos and Escape through regardless of focus
      if (
        !e.metaKey && !e.ctrlKey && e.key !== "Escape" &&
        (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
      ) {
        return;
      }

      // Cmd+[: Toggle left sidebar
      if (e.metaKey && e.code === "BracketLeft" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setIsLeftPanelOpen(prev => !prev);
      }

      // Cmd+]: Toggle right sidebar
      if (e.metaKey && e.code === "BracketRight" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setIsRightPanelOpen(prev => !prev);
      }

      // Cmd+/: Show keyboard shortcuts
      if (e.metaKey && e.key === "/" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setShowKeyboardShortcuts(true);
      }

      // Escape: Close any open dialog/form
      if (e.key === "Escape") {
        if (showGroupSettings) setShowGroupSettings(false);
        else if (showKeyboardShortcuts) setShowKeyboardShortcuts(false);
        else if (showCreateForm) setShowCreateForm(false);
        else if (showRenameForm) setShowRenameForm(false);
        else if (showThemeForm) setShowThemeForm(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showGroupSettings, showKeyboardShortcuts, showCreateForm, showRenameForm, showThemeForm]);

  function normalizeUpdateErrorMessage(rawError: string): string {
    const message = rawError.trim();
    const lowered = message.toLowerCase();
    if (
      lowered.includes("could not fetch a valid release json from the remote") ||
      lowered.includes("404")
    ) {
      return "Update feed is unavailable for this release.";
    }
    return message;
  }

  function isUnreadCandidateMessage(message: AgentMessage): boolean {
    const role = message.role ?? "";
    if (role === "user" || message.agentId === "user") return false;
    if (role === "assistant" || role === "question" || role === "error" || role === "credential_error") {
      return true;
    }
    return message.isError;
  }

  function extractPullRequestUrl(content: string): string | null {
    const match = content.match(/https?:\/\/[^\s)]+\/pull\/\d+/i);
    return match ? match[0] : null;
  }

  useEffect(() => {
    loadInitialState();
    // Silent background check on launch; surfaced only on explicit user action.
    void checkForAppUpdate(false, false);
    
    // Listen for agent messages from backend
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
          setWorkspaces((prev) =>
            prev.map((workspace) =>
              workspace.id === messageWorkspaceId
                ? { ...workspace, status: workspace.status === "merged" ? "merged" : "inReview", prUrl }
                : workspace,
            ),
          );
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

      // Drain the next queued message for this workspace
      const queue = queuedMessagesByWorkspaceRef.current[workspaceId];
      if (queue && queue.length > 0) {
        const [next, ...rest] = queue;
        setQueuedMessagesByWorkspace((prev) => ({
          ...prev,
          [workspaceId]: rest,
        }));
        // Small delay to let the agent settle before sending the next message
        setTimeout(() => {
          void sendMessageRef.current(next.text, next.visible, workspaceId);
        }, 300);
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
    const unlistenClients = listen<number>("remote-clients-updated", (event) => {
      setServerStatus((prev) => {
        if (!prev) return prev;
        return { ...prev, connectedClients: event.payload };
      });
    });
    
    return () => {
      unlisten.then(fn => fn());
      unlistenRunState.then(fn => fn());
      unlistenClients.then(fn => fn());
    };
  }, []);

  useEffect(() => {
    if (selectedRepo) {
      loadWorkspaces(selectedRepo);
    }
  }, [selectedRepo]);

  useEffect(() => {
    void loadSkills(selectedRepo);
  }, [selectedRepo]);

  useEffect(() => {
    if (!defaultRepoInitialized) return;
    try {
      if (defaultRepoId) {
        localStorage.setItem(DEFAULT_REPOSITORY_STORAGE_KEY, defaultRepoId);
      } else {
        localStorage.removeItem(DEFAULT_REPOSITORY_STORAGE_KEY);
      }
    } catch (err) {
      console.error("Failed to persist default repository:", err);
    }
  }, [defaultRepoId, defaultRepoInitialized]);

  useEffect(() => {
    const id = window.setInterval(async () => {
      try {
        const status = await invoke<AppStatus>("get_app_status");
        setServerStatus(status.serverStatus);
      } catch {
        // Keep last known server status if polling fails.
      }
    }, 3000);

    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (selectedWorkspace) {
      loadMessages(selectedWorkspace);
      setUnreadByWorkspace((prev) => {
        if (!prev[selectedWorkspace]) return prev;
        persistUnread(selectedWorkspace, 0);
        const next = { ...prev };
        delete next[selectedWorkspace];
        return next;
      });
      setPendingUnreadByWorkspace((prev) => {
        if (!prev[selectedWorkspace]) return prev;
        const next = { ...prev };
        delete next[selectedWorkspace];
        pendingUnreadByWorkspaceRef.current = next;
        return next;
      });
    } else {
      setMessages([]);
    }
  }, [selectedWorkspace]);

  useEffect(() => {
    const validWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    setUnreadByWorkspace((prev) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const [workspaceId, count] of Object.entries(prev)) {
        if (validWorkspaceIds.has(workspaceId) && count > 0) {
          next[workspaceId] = count;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setPendingUnreadByWorkspace((prev) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [workspaceId, pending] of Object.entries(prev)) {
        if (validWorkspaceIds.has(workspaceId) && pending) {
          next[workspaceId] = true;
        } else {
          changed = true;
        }
      }
      if (changed) {
        pendingUnreadByWorkspaceRef.current = next;
        return next;
      }
      return prev;
    });
    setInputMessageByWorkspace((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [workspaceId, draft] of Object.entries(prev)) {
        if (validWorkspaceIds.has(workspaceId)) {
          next[workspaceId] = draft;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // Note: selectedModelByWorkspace and claudeModeByWorkspace are intentionally
    // NOT cleaned up here. They are user preferences keyed by workspace UUID —
    // stale entries are harmless and cleaning them here causes selections to be
    // lost when switching repos (loadWorkspaces replaces the list with only the
    // current repo's workspaces, purging other repo entries).
  }, [workspaces]);

  useEffect(() => {
    const unreadTotal = Object.values(unreadByWorkspace).reduce((sum, count) => sum + count, 0);
    getCurrentWindow()
      .setBadgeCount(unreadTotal > 0 ? unreadTotal : undefined)
      .catch(() => {
        // Ignore unsupported platform badge operations.
      });
  }, [unreadByWorkspace]);

  useEffect(() => {
    if (!selectedWorkspace) {
      setThinkingElapsedSec(0);
      return;
    }
    const thinkingSince = thinkingSinceByWorkspace[selectedWorkspace] ?? null;
    if (thinkingSince === null) {
      setThinkingElapsedSec(0);
      return;
    }

    const tick = () => setThinkingElapsedSec(Math.max(0, Math.floor((Date.now() - thinkingSince) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [selectedWorkspace, thinkingSinceByWorkspace]);

  useEffect(() => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [terminalLinesByWorkspace, selectedWorkspace, isRunningTerminalCommand]);

  // Periodically sync workspace review states from GitHub PR state.
  useEffect(() => {
    const hasUnmerged = workspaces.some((ws) => ws.status !== "merged");
    if (!hasUnmerged || !selectedRepo) return;
    const sync = async () => {
      try {
        await invoke<string[]>("sync_pr_statuses");
        await loadWorkspaces(selectedRepo);
      } catch {
        // Silently ignore — gh CLI may not be available
      }
    };
    void sync();
    const interval = setInterval(() => void sync(), 60_000);
    return () => clearInterval(interval);
  }, [selectedRepo, workspaces.filter((ws) => ws.status !== "merged").length]);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      if (isResizingLeft) {
        setLeftPanelWidth(Math.min(460, Math.max(220, event.clientX)));
      }
      if (isResizingRight) {
        setRightPanelWidth(Math.min(560, Math.max(280, window.innerWidth - event.clientX)));
      }
      if (isResizingTerminal) {
        const next = window.innerHeight - event.clientY - 24;
        setTerminalHeight(Math.min(360, Math.max(120, next)));
      }
    };

    const onMouseUp = () => {
      setIsResizingLeft(false);
      setIsResizingRight(false);
      setIsResizingTerminal(false);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isResizingLeft, isResizingRight, isResizingTerminal]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PROMPT_SHORTCUTS_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const normalized: PromptShortcut[] = parsed
          .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
          .map((item, index) => {
            const name = typeof item.name === "string" ? item.name : "";
            const prompt = typeof item.prompt === "string" ? item.prompt : "";
            const id =
              typeof item.id === "string" && item.id.trim()
                ? item.id
                : `${Date.now()}-${index}-${Math.floor(Math.random() * 100000)}`;
            return {
              id,
              name,
              prompt,
              autoRunOnCreate: item.autoRunOnCreate === true,
            };
          })
          .filter((item) => item.name.trim() && item.prompt.trim());
        setPromptShortcuts(normalized);
      }
    } catch (err) {
      console.error("Failed to load prompt shortcuts:", err);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(PROMPT_SHORTCUTS_STORAGE_KEY, JSON.stringify(promptShortcuts));
    } catch (err) {
      console.error("Failed to persist prompt shortcuts:", err);
    }
  }, [promptShortcuts]);

  useEffect(() => {
    saveCustomThemes(customThemes);
  }, [customThemes]);

  useEffect(() => {
    const normalizedTheme = normalizeThemeId(selectedTheme, availableThemes);
    if (normalizedTheme !== selectedTheme) {
      setSelectedTheme(normalizedTheme);
      return;
    }
    applyTheme(normalizedTheme, availableThemes);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, normalizedTheme);
    } catch (err) {
      console.error("Failed to persist theme selection:", err);
    }
  }, [availableThemes, selectedTheme]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(ENV_OVERRIDES_STORAGE_KEY);
      if (raw) {
        setEnvOverridesText(raw);
      }
    } catch (err) {
      console.error("Failed to load env overrides:", err);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(ENV_OVERRIDES_STORAGE_KEY, envOverridesText);
    } catch (err) {
      console.error("Failed to persist env overrides:", err);
    }
  }, [envOverridesText]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CLAUDE_MODE_STORAGE_KEY);
      if (raw === "plan" || raw === "normal") {
        setDefaultClaudeMode(raw);
      }
    } catch (err) {
      console.error("Failed to load Claude mode:", err);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(CLAUDE_MODE_STORAGE_KEY, defaultClaudeMode);
    } catch (err) {
      console.error("Failed to persist Claude mode:", err);
    }
  }, [defaultClaudeMode]);

  useEffect(() => {
    localStorage.setItem(LEFT_PANEL_OPEN_STORAGE_KEY, String(isLeftPanelOpen));
  }, [isLeftPanelOpen]);

  useEffect(() => {
    localStorage.setItem(RIGHT_PANEL_OPEN_STORAGE_KEY, String(isRightPanelOpen));
  }, [isRightPanelOpen]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(MODEL_STORAGE_KEY);
      if (raw && raw.trim().length > 0) {
        const normalized = raw.trim();
        const isKnownOption = MODEL_OPTIONS.some((option) => option.value === normalized);
        if (isKnownOption) {
          setDefaultModel(normalized);
        } else {
          setDefaultModel(DEFAULT_MODEL_ID);
        }
      }
    } catch (err) {
      console.error("Failed to load model selection:", err);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, defaultModel);
    } catch (err) {
      console.error("Failed to persist model selection:", err);
    }
  }, [defaultModel]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(MODEL_BY_WORKSPACE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, string>;
        setSelectedModelByWorkspace(parsed);
      }
    } catch (err) {
      console.error("Failed to load per-workspace model selection:", err);
    }
  }, []);

  useEffect(() => {
    try {
      if (Object.keys(selectedModelByWorkspace).length > 0) {
        localStorage.setItem(MODEL_BY_WORKSPACE_STORAGE_KEY, JSON.stringify(selectedModelByWorkspace));
      } else {
        localStorage.removeItem(MODEL_BY_WORKSPACE_STORAGE_KEY);
      }
    } catch (err) {
      console.error("Failed to persist per-workspace model selection:", err);
    }
  }, [selectedModelByWorkspace]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(THINKING_MODE_STORAGE_KEY);
      if (raw === "off" || raw === "low" || raw === "medium" || raw === "high") {
        setThinkingMode(raw);
      }
    } catch (err) {
      console.error("Failed to load thinking mode:", err);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(THINKING_MODE_STORAGE_KEY, thinkingMode);
    } catch (err) {
      console.error("Failed to persist thinking mode:", err);
    }
  }, [thinkingMode]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(WORKSPACE_GROUPS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as WorkspaceGroup[];
        if (Array.isArray(parsed) && parsed.length > 0) setWorkspaceGroupConfig(parsed);
      }
    } catch (err) {
      console.error("Failed to load workspace groups:", err);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(WORKSPACE_GROUPS_STORAGE_KEY, JSON.stringify(workspaceGroupConfig));
    } catch (err) {
      console.error("Failed to persist workspace groups:", err);
    }
  }, [workspaceGroupConfig]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(WORKSPACE_GROUP_OVERRIDES_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, string>;
        if (parsed && typeof parsed === "object") setWorkspaceGroupOverrides(parsed);
      }
    } catch (err) {
      console.error("Failed to load workspace group overrides:", err);
    }
  }, []);

  useEffect(() => {
    try {
      if (Object.keys(workspaceGroupOverrides).length > 0) {
        localStorage.setItem(WORKSPACE_GROUP_OVERRIDES_STORAGE_KEY, JSON.stringify(workspaceGroupOverrides));
      } else {
        localStorage.removeItem(WORKSPACE_GROUP_OVERRIDES_STORAGE_KEY);
      }
    } catch (err) {
      console.error("Failed to persist workspace group overrides:", err);
    }
  }, [workspaceGroupOverrides]);

  // useLayoutEffect prevents a visual flash when switching workspaces:
  // it clears stale state synchronously before the browser paints,
  // so the user never sees the previous workspace's data under the new name.
  useLayoutEffect(() => {
    if (!selectedWorkspace) {
      setWorkspaceFilesByPath({});
      setExpandedPaths(new Set());
      setLoadingPaths(new Set());
      setSelectedFilePath(null);
      setFileContentsByPath({});
      setDiffContentsByTab({});
      setLoadingDiffTabId(null);
      setCenterTabs([{ id: "chat", type: "chat", title: "Chat" }]);
      setActiveCenterTabId("chat");
      setWorkspaceChanges([]);
      setCheckResults([]);
      setDetectedChecks([]);
      setTerminalInput("");
      setAttachedFiles([]);
      return;
    }

    setWorkspaceFilesByPath({});
    setExpandedPaths(new Set([""]));
    setLoadingPaths(new Set());
    setSelectedFilePath(null);
    setFileContentsByPath({});
    setDiffContentsByTab({});
    setLoadingDiffTabId(null);
    setCenterTabs([{ id: "chat", type: "chat", title: "Chat" }]);
    setActiveCenterTabId("chat");
    setWorkspaceChanges([]);
    setCheckResults([]);
    setDetectedChecks([]);
    setTerminalInput("");
    setAttachedFiles([]);
    // Skip backend calls for optimistic workspaces that don't exist in the backend yet.
    // The effect will re-fire when selectedWorkspace changes from tempId to the real ID.
    const ws = workspaces.find((w) => w.id === selectedWorkspace);
    if (!ws || ws.status === "initializing") return;
    loadWorkspaceFiles(selectedWorkspace, "");
  }, [selectedWorkspace]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    if (activeRightTab === "changes") {
      loadWorkspaceChanges(selectedWorkspace);
    }
  }, [activeRightTab, selectedWorkspace]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    if (activeRightTab === "checks") {
      loadWorkspaceCheckDefinitions(selectedWorkspace);
    }
  }, [activeRightTab, selectedWorkspace]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    void ensureAgentForWorkspace(selectedWorkspace);
  }, [selectedWorkspace, workspaces]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    const pending = pendingAutoPromptsByWorkspace[selectedWorkspace] || [];
    if (pending.length === 0) return;

    const thinkingSince = thinkingSinceByWorkspace[selectedWorkspace] ?? null;
    if (thinkingSince !== null) return;

    const hasRunningAgent = agents.some(
      (agent) => agent.workspaceId === selectedWorkspace && agent.status === "running",
    );
    if (!hasRunningAgent) return;

    let cancelled = false;
    const nextPrompt = pending[0];
    const visibleLabel = `/auto ${nextPrompt.name}`;

    const runAutoPrompt = async () => {
      const sent = await sendMessage(nextPrompt.prompt, visibleLabel);
      if (cancelled) return;
      setPendingAutoPromptsByWorkspace((prev) => {
        const current = prev[selectedWorkspace] || [];
        if (current.length === 0) return prev;
        const [, ...rest] = current;
        if (rest.length === 0) {
          const next = { ...prev };
          delete next[selectedWorkspace];
          return next;
        }
        return {
          ...prev,
          [selectedWorkspace]: rest,
        };
      });
      if (!sent) {
        setError(`Failed to auto-run prompt: ${nextPrompt.name}`);
      }
    };

    void runAutoPrompt();
    return () => {
      cancelled = true;
    };
  }, [selectedWorkspace, pendingAutoPromptsByWorkspace, thinkingSinceByWorkspace, agents]);

  async function loadInitialState() {
    try {
      const status = await invoke<AppStatus>("get_app_status");
      setRepositories(status.repositories);
      setServerStatus(status.serverStatus);
      
      if (status.repositories.length > 0) {
        let persistedDefaultRepo: string | null = null;
        try {
          persistedDefaultRepo = localStorage.getItem(DEFAULT_REPOSITORY_STORAGE_KEY);
        } catch (err) {
          console.error("Failed to read default repository:", err);
        }
        const hasPersistedDefault =
          !!persistedDefaultRepo &&
          status.repositories.some((repo) => repo.id === persistedDefaultRepo);

        if (hasPersistedDefault) {
          setDefaultRepoId(persistedDefaultRepo);
          setSelectedRepo(persistedDefaultRepo);
        } else {
          setSelectedRepo(status.repositories[0].id);
          if (persistedDefaultRepo) {
            setDefaultRepoId(null);
            try {
              localStorage.removeItem(DEFAULT_REPOSITORY_STORAGE_KEY);
            } catch (err) {
              console.error("Failed to clear invalid default repository:", err);
            }
          }
        }
      }

      setDefaultRepoInitialized(true);
      
      const ag = await invoke<Agent[]>("list_agents");
      setAgents(ag);
    } catch (err) {
      console.error("Failed to load initial state:", err);
      setError(String(err));
    } finally {
      setIsLoading(false);
    }
  }

  async function checkForAppUpdate(showNoUpdateStatus = false, surfaceErrors = true) {
    setIsCheckingUpdate(true);
    setUpdateError(null);

    try {
      const update = await invoke<UpdateInfo | null>("check_for_app_update");
      if (update) {
        setAvailableUpdate(update);
        setUpdateDismissed(false);
      } else {
        setAvailableUpdate(null);
        if (showNoUpdateStatus) {
          setUpdateError("You are already on the latest version.");
        }
      }
    } catch (err) {
      const normalizedError = normalizeUpdateErrorMessage(String(err));
      console.error("Failed to check for app updates:", err);
      if (surfaceErrors) {
        setUpdateError(normalizedError);
      }
    } finally {
      setIsCheckingUpdate(false);
    }
  }

  async function installAppUpdate() {
    if (isInstallingUpdate) return;

    setIsInstallingUpdate(true);
    setUpdateError(null);
    try {
      await invoke("install_app_update");
      setUpdateError("Installing update and restarting...");
    } catch (err) {
      console.error("Failed to install app update:", err);
      setUpdateError(String(err));
    } finally {
      setIsInstallingUpdate(false);
    }
  }

  function persistUnread(workspaceId: string, count: number) {
    invoke("update_workspace_unread", { workspaceId, unread: count }).catch(() => {});
  }

  async function togglePin(workspaceId: string) {
    try {
      const updated = await invoke<Workspace>("toggle_workspace_pinned", { workspaceId });
      setWorkspaces((prev) => prev.map((w) => (w.id === updated.id ? updated : w)));
    } catch (err) {
      console.error("Failed to toggle pin:", err);
    }
  }

  function handleDragStart(event: DragStartEvent) {
    setDragActiveId(event.active.id as string);
  }

  function handleDragOver(event: DragOverEvent) {
    const overId = event.over?.id as string | undefined;
    if (!overId) { setDragOverGroupId(null); return; }
    // overId could be a workspace id or a group droppable id (prefixed with "group:")
    if (overId.startsWith("group:")) {
      setDragOverGroupId(overId.replace("group:", ""));
    } else {
      // Find which group the over workspace belongs to
      const overGroup = workspaceGroups.find((g) => g.items.some((w) => w.id === overId));
      setDragOverGroupId(overGroup?.key ?? null);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setDragActiveId(null);
    setDragOverGroupId(null);
    if (!over || !active) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    // Determine target group
    let targetGroup: typeof workspaceGroups[0] | undefined;
    if (overId.startsWith("group:")) {
      targetGroup = workspaceGroups.find((g) => g.key === overId.replace("group:", ""));
    } else {
      targetGroup = workspaceGroups.find((g) => g.items.some((w) => w.id === overId));
    }

    // Determine source group
    const sourceGroup = workspaceGroups.find((g) => g.items.some((w) => w.id === activeId));

    if (!targetGroup || !sourceGroup) return;

    if (sourceGroup.key !== targetGroup.key) {
      // Cross-group move
      const groupDef = workspaceGroupConfig.find((g) => g.id === targetGroup!.key);
      if (!groupDef) return;
      const newStatus = statusForGroup(groupDef);
      try {
        if (newStatus) {
          // Target has a status: change workspace status and clear any override
          const updated = await invoke<Workspace>("set_workspace_status", {
            workspaceId: activeId,
            status: newStatus,
          });
          setWorkspaces((prev) => prev.map((w) => (w.id === updated.id ? updated : w)));
          setWorkspaceGroupOverrides((prev) => {
            if (!prev[activeId]) return prev;
            const next = { ...prev };
            delete next[activeId];
            return next;
          });
        } else {
          // Target is status-free: keep current status, set group override
          setWorkspaceGroupOverrides((prev) => ({ ...prev, [activeId]: groupDef.id }));
        }
      } catch (err) {
        console.error("Failed to move workspace:", err);
      }
    } else if (activeId !== overId && !overId.startsWith("group:")) {
      // Same-group reorder
      const oldIndex = sourceGroup.items.findIndex((w) => w.id === activeId);
      const newIndex = sourceGroup.items.findIndex((w) => w.id === overId);
      if (oldIndex !== -1 && newIndex !== -1) {
        const reordered = arrayMove(sourceGroup.items, oldIndex, newIndex);
        reordered.forEach((w, idx) => {
          invoke("update_workspace_display_order", { workspaceId: w.id, displayOrder: idx }).catch(() => {});
        });
        setWorkspaces((prev) => {
          const updated = new Map(reordered.map((w, idx) => [w.id, idx]));
          return prev.map((w) => (updated.has(w.id) ? { ...w, displayOrder: updated.get(w.id)! } : w));
        });
      }
    }
  }

  function removeQueuedMessage(workspaceId: string, messageId: string) {
    setQueuedMessagesByWorkspace((prev) => ({
      ...prev,
      [workspaceId]: (prev[workspaceId] || []).filter((m) => m.id !== messageId),
    }));
  }

  async function saveWorkspaceNotes(workspaceId: string, notes: string) {
    try {
      await invoke("update_workspace_notes", { workspaceId, notes });
      setWorkspaces((prev) =>
        prev.map((w) => (w.id === workspaceId ? { ...w, notes: notes || null } : w)),
      );
    } catch (err) {
      console.error("Failed to save notes:", err);
    }
  }

  async function loadWorkspaces(repoId: string) {
    try {
      const ws = await invoke<Workspace[]>("list_workspaces", { repoId });
      setWorkspaces((prev) => {
        // Preserve optimistic workspaces (status=initializing) that haven't been committed to DB yet.
        // Without this, background loadWorkspaces calls (e.g. PR sync) wipe the optimistic entry
        // before create_workspace returns, causing the workspace to disappear from the UI.
        const dbIds = new Set(ws.map((w) => w.id));
        const optimistic = prev.filter((w) => w.status === "initializing" && !dbIds.has(w.id));
        return optimistic.length > 0 ? [...ws, ...optimistic] : ws;
      });
      // Initialize unread counts from persisted data
      const unreadInit: Record<string, number> = {};
      for (const w of ws) {
        if (w.unread > 0) unreadInit[w.id] = w.unread;
      }
      setUnreadByWorkspace((prev) => ({ ...unreadInit, ...prev }));
    } catch (err) {
      console.error("Failed to load workspaces:", err);
    }
  }

  async function loadMessages(workspaceId: string) {
    try {
      const msgs = await invoke<AgentMessage[]>("get_agent_messages", { workspaceId });
      setMessages(msgs);
    } catch (err) {
      console.error("Failed to load messages:", err);
    }
  }

  async function addRepository() {
    setError(null);
    
    try {
      const selected = await invoke<string | null>("pick_folder");
      
      if (selected) {
        const repo = await invoke<Repository>("add_repository", { 
          path: selected 
        });
        setRepositories(prev => [...prev, repo]);
        setSelectedRepo(repo.id);
        if (repositories.length === 0) {
          setDefaultRepoId(repo.id);
        }
      }
    } catch (err) {
      console.error("Failed to add repository:", err);
      setError(String(err));
    }
  }

  function handleSelectRepository(repoId: string) {
    if (repoId === selectedRepo) return;
    setSelectedRepo(repoId);
    setSelectedWorkspace(null);
    setMessages([]);
  }

  function setDefaultRepository(repoId: string) {
    setDefaultRepoId(repoId);
    handleSelectRepository(repoId);
  }

  async function removeRepository(repoId: string) {
    try {
      const removedWorkspaceIds = new Set(
        workspaces.filter((workspace) => workspace.repoId === repoId).map((workspace) => workspace.id),
      );

      await invoke("remove_repository", { repoId });

      const remainingRepos = repositories.filter((repo) => repo.id !== repoId);
      setRepositories(remainingRepos);
      setWorkspaces((prev) => prev.filter((workspace) => workspace.repoId !== repoId));
      setAgents((prev) => prev.filter((agent) => !removedWorkspaceIds.has(agent.workspaceId)));
      setPendingAutoPromptsByWorkspace((prev) => {
        const next = { ...prev };
        for (const workspaceId of removedWorkspaceIds) {
          delete next[workspaceId];
        }
        return next;
      });
      setThinkingSinceByWorkspace((prev) => {
        const next = { ...prev };
        for (const workspaceId of removedWorkspaceIds) {
          delete next[workspaceId];
        }
        return next;
      });

      if (selectedRepo === repoId) {
        const nextRepoId = remainingRepos[0]?.id ?? null;
        setSelectedRepo(nextRepoId);
        setSelectedWorkspace(null);
        setMessages([]);
      }

      if (defaultRepoId === repoId) {
        setDefaultRepoId(remainingRepos[0]?.id ?? null);
      }
    } catch (err) {
      console.error("Failed to remove repository:", err);
      setError(String(err));
    }
  }

  async function createWorkspace() {
    if (!newWorkspaceName.trim() || !selectedRepo) return;

    // Check if git is busy (Conductor pattern: git-busy-check)
    try {
      const gitStatus = await invoke<string>("check_git_busy", { repoId: selectedRepo });
      if (gitStatus.startsWith("busy:")) {
        const reason = gitStatus.replace("busy:", "");
        setError(`Cannot create workspace: git ${reason} in progress. Complete or abort the ${reason} first.`);
        return;
      }
    } catch (err) {
      console.warn("Git busy check failed, proceeding anyway:", err);
    }

    // Generate optimistic workspace immediately for instant UI feedback
    const tempId = crypto.randomUUID();
    const workspaceName = newWorkspaceName.trim();
    const optimisticWorkspace: Workspace = {
      id: tempId,
      repoId: selectedRepo,
      name: workspaceName,
      branch: `workspace/${workspaceName}`,
      worktreePath: "", // placeholder until backend confirms
      status: "initializing",
      unread: 0,
      displayOrder: 0,
      pinnedAt: null,
      notes: null,
    };

    // Update UI immediately - user sees workspace appear instantly
    const autoRunPrompts = promptShortcuts.filter((shortcut) => shortcut.autoRunOnCreate);
    setWorkspaces(prev => [...prev, optimisticWorkspace]);
    setNewWorkspaceName("");
    setShowCreateForm(false);
    setSelectedWorkspace(tempId);
    setIsLeftPanelOpen(false);

    try {
      // Backend creates actual workspace (git worktree add, etc.)
      const workspace = await invoke<Workspace>("create_workspace", {
        repoId: selectedRepo,
        name: workspaceName
      });

      // Replace optimistic placeholder with real workspace data
      setWorkspaces(prev => prev.map(w => w.id === tempId ? workspace : w));
      setSelectedWorkspace(workspace.id);

      // Migrate per-workspace settings from temp ID to real ID
      setSelectedModelByWorkspace((prev) => {
        if (!(tempId in prev)) return prev;
        const next = { ...prev, [workspace.id]: prev[tempId] };
        delete next[tempId];
        return next;
      });
      setClaudeModeByWorkspace((prev) => {
        if (!(tempId in prev)) return prev;
        const next = { ...prev, [workspace.id]: prev[tempId] };
        delete next[tempId];
        return next;
      });

      // Handle auto-run prompts with real workspace ID
      if (autoRunPrompts.length > 0) {
        setPendingAutoPromptsByWorkspace((prev) => ({
          ...prev,
          [workspace.id]: autoRunPrompts,
        }));
      }
    } catch (err) {
      // Rollback: remove optimistic workspace on failure
      console.error("Failed to create workspace:", err);
      setWorkspaces(prev => prev.filter(w => w.id !== tempId));
      setSelectedWorkspace(null);
      setError(String(err));
    }
  }

  async function removeWorkspace(workspaceId: string) {
    try {
      const workspaceAgents = agents.filter(a => a.workspaceId === workspaceId);
      for (const agent of workspaceAgents) {
        await stopAgent(agent.id);
      }
      
      await invoke("remove_workspace", { workspaceId });
      setWorkspaces(prev => prev.filter(w => w.id !== workspaceId));
      setThinkingSinceByWorkspace((prev) => {
        const next = { ...prev };
        delete next[workspaceId];
        return next;
      });
      setPendingAutoPromptsByWorkspace((prev) => {
        const next = { ...prev };
        delete next[workspaceId];
        return next;
      });
      setSelectedModelByWorkspace((prev) => {
        if (!(workspaceId in prev)) return prev;
        const next = { ...prev };
        delete next[workspaceId];
        return next;
      });
      setClaudeModeByWorkspace((prev) => {
        if (!(workspaceId in prev)) return prev;
        const next = { ...prev };
        delete next[workspaceId];
        return next;
      });
      setWorkspaceGroupOverrides((prev) => {
        if (!(workspaceId in prev)) return prev;
        const next = { ...prev };
        delete next[workspaceId];
        return next;
      });
      if (selectedWorkspace === workspaceId) {
        const remaining = workspaces.filter(w => w.id !== workspaceId);
        const next = remaining.length > 0 ? remaining[0].id : null;
        setSelectedWorkspace(next);
        if (!next) setMessages([]);
      }
      if (renameWorkspaceId === workspaceId) {
        setShowRenameForm(false);
        setRenameWorkspaceId(null);
        setRenameWorkspaceName("");
      }
    } catch (err) {
      console.error("Failed to remove workspace:", err);
      setError(String(err));
    }
  }

  function openRenameWorkspaceForm(workspace: Workspace) {
    setRenameWorkspaceId(workspace.id);
    setRenameWorkspaceName(workspace.name);
    setShowRenameForm(true);
  }

  async function renameWorkspace() {
    if (!renameWorkspaceId || !renameWorkspaceName.trim()) return;
    try {
      const updated = await invoke<Workspace>("rename_workspace", {
        workspaceId: renameWorkspaceId,
        name: renameWorkspaceName.trim(),
      });
      setWorkspaces((prev) => prev.map((workspace) => (workspace.id === updated.id ? updated : workspace)));
      setShowRenameForm(false);
      setRenameWorkspaceId(null);
      setRenameWorkspaceName("");
    } catch (err) {
      console.error("Failed to rename workspace:", err);
      setError(String(err));
    }
  }

  async function startAgent(workspaceId: string) {
    try {
      const agent = await invoke<Agent>("start_agent", {
        workspaceId,
        envOverrides: parseEnvOverrides(envOverridesText),
      });
      setAgents(prev => [...prev, agent]);
      await loadWorkspaces(selectedRepo!);
    } catch (err) {
      console.error("Failed to start agent:", err);
      setError(String(err));
    }
  }

  async function ensureAgentForWorkspace(workspaceId: string) {
    const workspace = workspaces.find((w) => w.id === workspaceId);
    if (!workspace || workspace.status === "initializing") return;

    const hasRunningAgent = agents.some(
      (agent) => agent.workspaceId === workspaceId && (agent.status === "running" || agent.status === "starting"),
    );
    if (hasRunningAgent || startingWorkspaceIdsRef.current.has(workspaceId)) return;

    startingWorkspaceIdsRef.current.add(workspaceId);
    setAutoStartingWorkspaceId(workspaceId);
    try {
      await startAgent(workspaceId);
    } finally {
      startingWorkspaceIdsRef.current.delete(workspaceId);
      setAutoStartingWorkspaceId((prev) => (prev === workspaceId ? null : prev));
    }
  }

  async function stopAgent(agentId: string) {
    try {
      const stoppedWorkspaceId = agents.find((agent) => agent.id === agentId)?.workspaceId ?? null;
      await invoke("stop_agent", { agentId });
      setAgents(prev => prev.filter(a => a.id !== agentId));
      if (stoppedWorkspaceId) {
        setThinkingSinceByWorkspace((prev) => ({ ...prev, [stoppedWorkspaceId]: null }));
      }
      if (selectedRepo) await loadWorkspaces(selectedRepo);
    } catch (err) {
      console.error("Failed to stop agent:", err);
      setError(String(err));
    }
  }

  async function interruptAgent(agentId: string) {
    try {
      await invoke("interrupt_agent", { agentId });
      const ws = agents.find((a) => a.id === agentId)?.workspaceId ?? null;
      if (ws) {
        setThinkingSinceByWorkspace((prev) => ({ ...prev, [ws]: null }));
      }
    } catch (err) {
      console.error("Failed to interrupt agent:", err);
      setError(String(err));
    }
  }

  function normalizePromptName(value: string) {
    return value.trim().toLowerCase().replace(/\s+/g, " ");
  }

  function normalizeSkillCommand(value: string) {
    return value.trim().toLowerCase().replace(/\\/g, "/");
  }

  function sanitizeSkillDirName(value: string) {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, "")
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  }

  function formatSkillExecutionPrompt(skill: SkillShortcut, userInput?: string) {
    const trimmedInput = userInput?.trim();
    const blocks: string[] = [
      `Execute the following ${skill.scope} skill in this workspace.`,
      `<skill name="${skill.name}" scope="${skill.scope}" command="/${skill.commandName}" path="${skill.relativePath}">\n${skill.content}\n</skill>`,
    ];
    if (trimmedInput) {
      blocks.push(`User request:\n${trimmedInput}`);
    }
    return blocks.join("\n\n");
  }

  function resolveSkillSlashCommand(rawCommand: string): { skill: SkillShortcut; args: string } | null {
    const trimmed = rawCommand.trim();
    if (!trimmed) return null;

    const normalizedFull = normalizeSkillCommand(trimmed);
    const exactMatches = allSkills.filter((skill) => {
      const command = normalizeSkillCommand(skill.commandName);
      const name = normalizePromptName(skill.name);
      const relative = normalizeSkillCommand(skill.relativePath);
      return command === normalizedFull || name === normalizePromptName(trimmed) || relative === normalizedFull;
    });

    if (exactMatches.length === 1) {
      return { skill: exactMatches[0], args: "" };
    }
    if (exactMatches.length > 1) {
      setError(`Multiple skills match '${trimmed}'. Use /project:... or /user:...`);
      return null;
    }

    const firstSpace = trimmed.indexOf(" ");
    if (firstSpace <= 0) return null;

    const token = trimmed.slice(0, firstSpace).trim();
    const args = trimmed.slice(firstSpace + 1).trim();
    const normalizedToken = normalizeSkillCommand(token);
    const tokenMatches = allSkills.filter((skill) => {
      const command = normalizeSkillCommand(skill.commandName);
      const relative = normalizeSkillCommand(skill.relativePath);
      const scopedRelative = `${skill.scope}:${relative}`;
      return command === normalizedToken || relative === normalizedToken || scopedRelative === normalizedToken;
    });

    if (tokenMatches.length === 1) {
      return { skill: tokenMatches[0], args };
    }
    if (tokenMatches.length > 1) {
      setError(`Multiple skills match '${token}'. Use /project:... or /user:...`);
    }
    return null;
  }

  async function loadSkills(repoId: string | null) {
    setIsSkillsLoading(true);
    try {
      const data = await invoke<SkillCatalogResponse>("list_skills", {
        repoId: repoId ?? null,
      });
      setProjectSkills(data.projectSkills || []);
      setUserSkills(data.userSkills || []);
      setProjectSkillsRoot(data.projectRoot ?? null);
      setUserSkillsRoot(data.userRoot ?? null);
    } catch (err) {
      console.error("Failed to load skills:", err);
      setError(String(err));
    } finally {
      setIsSkillsLoading(false);
    }
  }

  function openAddSkillForm(scope: SkillScope) {
    setEditingSkillId(null);
    setSkillScopeDraft(scope);
    setSkillRelativePathDraft(null);
    setSkillNameDraft("");
    setSkillBodyDraft("");
    setShowSkillForm(true);
  }

  function openEditSkillForm(skill: SkillShortcut) {
    setEditingSkillId(skill.id);
    setSkillScopeDraft(skill.scope);
    setSkillRelativePathDraft(skill.relativePath);
    setSkillNameDraft(skill.name);
    setSkillBodyDraft(skill.content);
    setShowSkillForm(true);
  }

  async function saveSkillDraft() {
    const name = skillNameDraft.trim();
    const body = skillBodyDraft.trim();
    if (!name || !body) return;
    if (skillScopeDraft === "project" && !selectedRepo) {
      setError("Select a repository before saving a project skill.");
      return;
    }

    try {
      await invoke<SkillShortcut>("save_skill", {
        scope: skillScopeDraft,
        repoId: skillScopeDraft === "project" ? selectedRepo : null,
        relativePath: skillRelativePathDraft,
        name,
        content: body,
      });
      setShowSkillForm(false);
      setEditingSkillId(null);
      await loadSkills(selectedRepo);
    } catch (err) {
      console.error("Failed to save skill:", err);
      setError(String(err));
    }
  }

  async function runSkillShortcut(skill: SkillShortcut, args?: string) {
    const trimmedArgs = args?.trim();
    const command = trimmedArgs ? `/${skill.commandName} ${trimmedArgs}` : `/${skill.commandName}`;
    const payload = formatSkillExecutionPrompt(skill, trimmedArgs);
    await sendMessage(payload, command);
  }

  function openCreateThemeForm() {
    const baseTheme = availableThemes[selectedTheme] ?? availableThemes[DEFAULT_THEME_ID];
    if (!baseTheme) return;
    setEditingThemeId(null);
    setThemeDraft({
      ...createThemeDraftFromTheme(baseTheme),
      label: `${baseTheme.label} copy`,
      description: `Custom theme based on ${baseTheme.label}.`,
    });
    setShowThemeForm(true);
  }

  function openEditThemeForm() {
    const currentTheme = availableThemes[selectedTheme];
    if (!currentTheme || isBuiltInTheme(currentTheme.id)) {
      return;
    }
    setEditingThemeId(currentTheme.id);
    setThemeDraft(createThemeDraftFromTheme(currentTheme));
    setShowThemeForm(true);
  }

  function closeThemeForm() {
    setShowThemeForm(false);
    setEditingThemeId(null);
  }

  function updateThemeDraftColor(token: ThemeColorTokenKey, value: string) {
    setThemeDraft((prev) => ({
      ...prev,
      colors: {
        ...prev.colors,
        [token]: value,
      },
    }));
  }

  function saveThemeDraft() {
    const label = themeDraft.label.trim();
    if (!label) {
      setError("Theme name is required.");
      return;
    }
    if (!isHexColor(themeDraft.rootText) || !isHexColor(themeDraft.rootBackground)) {
      setError("Root colors must be valid hex values like #1a2b3c.");
      return;
    }
    for (const token of COLOR_TOKEN_KEYS) {
      if (!isHexColor(themeDraft.colors[token])) {
        setError(`Invalid color for ${token}. Use hex format like #1a2b3c.`);
        return;
      }
    }

    const id = editingThemeId ?? createThemeId(label, availableThemes);
    const nextTheme: ThemeDefinition = {
      id,
      label,
      description: themeDraft.description.trim() || `Custom theme: ${label}`,
      rootText: themeDraft.rootText,
      rootBackground: themeDraft.rootBackground,
      colors: cloneThemeColors(themeDraft.colors),
    };

    setCustomThemes((prev) => ({
      ...prev,
      [id]: nextTheme,
    }));
    setSelectedTheme(id);
    closeThemeForm();
  }

  function deleteSelectedCustomTheme() {
    if (isBuiltInTheme(selectedTheme)) return;
    setCustomThemes((prev) => {
      const next = { ...prev };
      delete next[selectedTheme];
      return next;
    });
    setSelectedTheme(DEFAULT_THEME_ID);
  }

  function parseEnvOverrides(raw: string): Record<string, string> {
    const map: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      let trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      if (trimmed.startsWith("export ")) {
        trimmed = trimmed.slice("export ".length).trim();
      }

      if (trimmed.startsWith("set ")) {
        trimmed = trimmed.slice("set ".length).trim();
      }

      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!key) continue;
      map[key] = value;
    }
    return map;
  }

  function setWorkspaceInputDraft(value: string) {
    if (!selectedWorkspace) return;
    setInputMessageByWorkspace((prev) => ({ ...prev, [selectedWorkspace]: value }));
  }

  function setWorkspaceModel(value: string) {
    const normalized = value.trim();
    const isKnownOption = MODEL_OPTIONS.some((option) => option.value === normalized);
    const nextValue = isKnownOption ? normalized : DEFAULT_MODEL_ID;
    if (!selectedWorkspace) {
      setDefaultModel(nextValue);
      return;
    }
    setSelectedModelByWorkspace((prev) => ({ ...prev, [selectedWorkspace]: nextValue }));
  }

  function toggleWorkspaceClaudeMode() {
    const nextMode: ClaudeMode = claudeMode === "plan" ? "normal" : "plan";
    if (!selectedWorkspace) {
      setDefaultClaudeMode(nextMode);
      return;
    }
    setClaudeModeByWorkspace((prev) => ({ ...prev, [selectedWorkspace]: nextMode }));
  }

  function setBedrockEnabled(enabled: boolean) {
    setEnvOverridesText((current) => upsertEnvOverrideLine(current, BEDROCK_ENV_KEY, enabled ? "1" : null));
  }

  function dismissCredentialError(workspaceId: string) {
    setCredentialErrorWorkspaces((prev) => {
      const next = new Set(prev);
      next.delete(workspaceId);
      return next;
    });
  }

  async function sendMessage(rawMessage?: string, visibleOverride?: string, targetWorkspaceId?: string): Promise<boolean> {
    const effectiveWorkspaceId = targetWorkspaceId ?? selectedWorkspace;
    const composedInput = (rawMessage ?? inputMessage).trim();
    if (!composedInput) return false;
    if (effectiveWorkspaceId) {
      dismissCredentialError(effectiveWorkspaceId);
    }
    const workspaceThinkingSince = effectiveWorkspaceId
      ? (thinkingSinceByWorkspace[effectiveWorkspaceId] ?? null)
      : null;
    if (workspaceThinkingSince !== null && effectiveWorkspaceId) {
      // Queue the message instead of dropping it
      const queued: QueuedMessage = {
        id: crypto.randomUUID(),
        text: composedInput,
        visible: visibleOverride ?? composedInput,
        queuedAt: Date.now(),
      };
      setQueuedMessagesByWorkspace((prev) => ({
        ...prev,
        [effectiveWorkspaceId]: [...(prev[effectiveWorkspaceId] || []), queued],
      }));
      if (!rawMessage) {
        setInputMessageByWorkspace((prev) => ({ ...prev, [effectiveWorkspaceId]: "" }));
      }
      return true;
    }

    const workspaceAgents = agents.filter(a => a.workspaceId === effectiveWorkspaceId);
    if (workspaceAgents.length === 0) {
      setError("No active agent in this workspace");
      if (effectiveWorkspaceId) {
        setThinkingSinceByWorkspace((prev) => ({ ...prev, [effectiveWorkspaceId]: null }));
      }
      return false;
    }

    const agent = workspaceAgents[0];
    let messageToSend = composedInput;
    let visibleMessage = visibleOverride ?? composedInput;

    if (!rawMessage && composedInput.startsWith("/")) {
      const commandBody = composedInput.slice(1).trim();
      const commandName = normalizePromptName(commandBody);
      const matchedPrompt = promptShortcuts.find((shortcut) => normalizePromptName(shortcut.name) === commandName);
      if (matchedPrompt) {
        messageToSend = matchedPrompt.prompt;
        visibleMessage = `/${matchedPrompt.name}`;
      } else {
        const matchedSkill = resolveSkillSlashCommand(commandBody);
        if (matchedSkill) {
          messageToSend = formatSkillExecutionPrompt(matchedSkill.skill, matchedSkill.args);
          visibleMessage = matchedSkill.args
            ? `/${matchedSkill.skill.commandName} ${matchedSkill.args}`
            : `/${matchedSkill.skill.commandName}`;
        }
      }
    }

    const workspace = workspaces.find((item) => item.id === effectiveWorkspaceId);
    if (!workspace) {
      setError("Workspace not found");
      return false;
    }

    const attachedRelativePaths: string[] = [];
    if (attachedFiles.length > 0) {
      try {
        const attachmentSections: string[] = [];
        for (const absolutePath of attachedFiles) {
          const relativePath = toWorkspaceRelativePath(absolutePath, workspace.worktreePath);
          if (relativePath === null || !relativePath.trim()) {
            continue;
          }

          const content = await invoke<string>("read_workspace_file", {
            workspaceId: workspace.id,
            relativePath,
            maxBytes: 200000,
          });

          attachedRelativePaths.push(relativePath);
          attachmentSections.push(
            `<attached_file path="${relativePath}">\n${content}\n</attached_file>`,
          );
        }

        if (attachmentSections.length > 0) {
          messageToSend = `${messageToSend}\n\nUse these attached files as context:\n\n${attachmentSections.join("\n\n")}`;
        }
      } catch (err) {
        console.error("Failed to prepare attached files:", err);
        setError(String(err));
        return false;
      }
    }

    if (attachedRelativePaths.length > 0) {
      const fileSummary = `[Files: ${attachedRelativePaths.join(", ")}]`;
      visibleMessage = visibleMessage ? `${visibleMessage}\n${fileSummary}` : fileSummary;
    }
    
    // Add user message to display
    setMessages(prev => [...prev, {
      agentId: "user",
      role: "user",
      content: visibleMessage,
      isError: false,
      timestamp: new Date().toISOString(),
    }]);
    
    try {
      if (effectiveWorkspaceId) {
        setThinkingSinceByWorkspace((prev) => ({ ...prev, [effectiveWorkspaceId]: Date.now() }));
      }
      await invoke("send_message_to_agent", {
        agentId: agent.id,
        message: messageToSend,
        envOverrides: parseEnvOverrides(envOverridesText),
        permissionMode: claudeMode === "plan" ? "plan" : "bypassPermissions",
        model: selectedModel,
        effort: thinkingMode === "off" ? null : thinkingMode,
      });
      if (!rawMessage && effectiveWorkspaceId) {
        setInputMessageByWorkspace((prev) => ({ ...prev, [effectiveWorkspaceId]: "" }));
      }
      if (!targetWorkspaceId) {
        setAttachedFiles([]);
      }
    } catch (err) {
      console.error("Failed to send message:", err);
      setError(String(err));
      if (effectiveWorkspaceId) {
        setThinkingSinceByWorkspace((prev) => ({ ...prev, [effectiveWorkspaceId]: null }));
      }
      return false;
    }
    return true;
  }
  sendMessageRef.current = sendMessage;

  const handleQuestionAnswer = useCallback((questionTimestamp: string, answer: string) => {
    setAnsweredQuestionTimestamps((prev) => {
      const next = new Set(prev);
      next.add(questionTimestamp);
      return next;
    });
    void sendMessageRef.current(answer);
  }, []);

  function generateWorkspaceName() {
    const adjective = NAME_ADJECTIVES[Math.floor(Math.random() * NAME_ADJECTIVES.length)];
    const noun = NAME_NOUNS[Math.floor(Math.random() * NAME_NOUNS.length)];
    const suffix = Math.floor(100 + Math.random() * 900);
    return `${adjective}-${noun}-${suffix}`;
  }

  function openCreateWorkspaceForm() {
    setNewWorkspaceName(generateWorkspaceName());
    setShowCreateForm(true);
  }

  function handleSelectWorkspace(workspaceId: string) {
    setSelectedWorkspace(workspaceId);
    setIsLeftPanelOpen(false);
    void ensureAgentForWorkspace(workspaceId);
    // Load orchestrator.json config for the workspace
    void loadOrchestratorConfig(workspaceId);
  }

  async function loadOrchestratorConfig(workspaceId: string) {
    try {
      const config = await invoke<OrchestratorConfig>("get_workspace_config", { workspaceId });
      setOrchestratorConfig(config);
    } catch (err) {
      console.warn("Failed to load orchestrator config:", err);
      setOrchestratorConfig(null);
    }
  }

  async function runOrchestratorScript(scriptType: "setup" | "run" | "archive") {
    if (!selectedWorkspace) return;
    setIsRunningScript(true);
    try {
      const [stdout, stderr, exitCode] = await invoke<[string, string, number]>("run_orchestrator_script", {
        workspaceId: selectedWorkspace,
        scriptType,
      });
      // Add output to terminal
      const newLines: TerminalLine[] = [
        { id: crypto.randomUUID(), kind: "command", text: `orchestrator ${scriptType}` },
      ];
      if (stdout) {
        newLines.push({ id: crypto.randomUUID(), kind: "stdout", text: stdout });
      }
      if (stderr) {
        newLines.push({ id: crypto.randomUUID(), kind: "stderr", text: stderr });
      }
      newLines.push({
        id: crypto.randomUUID(),
        kind: exitCode === 0 ? "meta" : "stderr",
        text: `Exit code: ${exitCode}`,
      });
      setTerminalLinesByWorkspace(prev => ({
        ...prev,
        [selectedWorkspace]: [...(prev[selectedWorkspace] || []), ...newLines],
      }));
    } catch (err) {
      setError(String(err));
    } finally {
      setIsRunningScript(false);
    }
  }

  async function addFilesToComposer() {
    const workspace = workspaces.find((item) => item.id === selectedWorkspace);
    if (!workspace) return;

    try {
      const picked = await open({
        multiple: true,
        directory: false,
        defaultPath: workspace.worktreePath,
      });

      if (!picked) return;

      const pickedFiles = Array.isArray(picked) ? picked : [picked];
      const accepted: string[] = [];
      let ignoredCount = 0;

      for (const item of pickedFiles) {
        if (typeof item !== "string") continue;
        const relativePath = toWorkspaceRelativePath(item, workspace.worktreePath);
        if (relativePath === null) {
          ignoredCount += 1;
          continue;
        }
        accepted.push(item);
      }

      if (accepted.length > 0) {
        setAttachedFiles((prev) => Array.from(new Set([...prev, ...accepted])));
      }
      if (ignoredCount > 0) {
        setError(`${ignoredCount} file(s) were ignored because they are outside the workspace.`);
      }
    } catch (err) {
      console.error("Failed to attach files:", err);
      setError(String(err));
    }
  }

  function removeAttachedFile(path: string) {
    setAttachedFiles((prev) => prev.filter((item) => item !== path));
  }

  function openAddPromptForm() {
    setEditingPromptId(null);
    setNewPromptName("");
    setNewPromptBody("");
    setNewPromptAutoRunOnCreate(false);
    setShowAddPromptForm(true);
  }

  function openEditPromptForm(shortcut: PromptShortcut) {
    setEditingPromptId(shortcut.id);
    setNewPromptName(shortcut.name);
    setNewPromptBody(shortcut.prompt);
    setNewPromptAutoRunOnCreate(shortcut.autoRunOnCreate === true);
    setShowAddPromptForm(true);
  }

  function deletePromptShortcut(promptId: string) {
    setPromptShortcuts((prev) => prev.filter((shortcut) => shortcut.id !== promptId));
  }

  function addPromptShortcut() {
    const name = newPromptName.trim();
    const prompt = newPromptBody.trim();
    if (!name || !prompt) return;

    const normalized = normalizePromptName(name);
    const hasDuplicate = promptShortcuts.some(
      (shortcut) =>
        shortcut.id !== editingPromptId && normalizePromptName(shortcut.name) === normalized,
    );
    if (hasDuplicate) {
      setError(`Prompt name already exists: ${name}`);
      return;
    }

    if (editingPromptId) {
      setPromptShortcuts((prev) =>
        prev.map((shortcut) =>
          shortcut.id === editingPromptId
            ? {
                ...shortcut,
                name,
                prompt,
                autoRunOnCreate: newPromptAutoRunOnCreate,
              }
            : shortcut,
        ),
      );
    } else {
      setPromptShortcuts((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.floor(Math.random() * 100000)}`,
          name,
          prompt,
          autoRunOnCreate: newPromptAutoRunOnCreate,
        },
      ]);
    }
    setEditingPromptId(null);
    setShowAddPromptForm(false);
  }

  async function runPromptShortcut(shortcut: PromptShortcut) {
    await sendMessage(shortcut.prompt, `/${shortcut.name}`);
  }

  async function loadWorkspaceFiles(workspaceId: string, relativePath: string) {
    setLoadingPaths((prev) => {
      const next = new Set(prev);
      next.add(relativePath);
      return next;
    });

    try {
      const entries = await invoke<WorkspaceFileEntry[]>("list_workspace_files", {
        workspaceId,
        relativePath: relativePath === "" ? null : relativePath,
      });

      setWorkspaceFilesByPath((prev) => ({
        ...prev,
        [relativePath]: entries,
      }));
    } catch (err) {
      console.error("Failed to load workspace files:", err);
      setError(String(err));
    } finally {
      setLoadingPaths((prev) => {
        const next = new Set(prev);
        next.delete(relativePath);
        return next;
      });
    }
  }

  function toggleDirectory(path: string) {
    const isExpanded = expandedPaths.has(path);
    if (isExpanded) {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      return;
    }

    setExpandedPaths((prev) => {
      const next = new Set(prev);
      next.add(path);
      return next;
    });

    if (selectedWorkspace && !workspaceFilesByPath[path]) {
      loadWorkspaceFiles(selectedWorkspace, path);
    }
  }

  async function openFile(path: string) {
    if (!selectedWorkspace) return;

    setSelectedFilePath(path);
    setCenterTabs((prev) => {
      if (prev.some((tab) => tab.id === `file:${path}`)) return prev;
      const title = path.split("/").pop() || path;
      return [...prev, { id: `file:${path}`, type: "file", title, path }];
    });
    setActiveCenterTabId(`file:${path}`);

    if (fileContentsByPath[path] === undefined) {
      setIsLoadingFileContent(true);
      try {
        const content = await invoke<string>("read_workspace_file", {
          workspaceId: selectedWorkspace,
          relativePath: path,
          maxBytes: 200000,
        });
        setFileContentsByPath((prev) => ({ ...prev, [path]: content }));
      } catch (err) {
        console.error("Failed to read workspace file:", err);
        setFileContentsByPath((prev) => ({ ...prev, [path]: "" }));
        setError(String(err));
      } finally {
        setIsLoadingFileContent(false);
      }
    }
  }

  function closeCenterTab(tabId: string) {
    if (tabId === "chat") return;
    setCenterTabs((prev) => prev.filter((tab) => tab.id !== tabId));
    if (activeCenterTabId === tabId) {
      setActiveCenterTabId("chat");
    }
  }

  async function loadWorkspaceChanges(workspaceId: string) {
    setIsLoadingChanges(true);
    try {
      const changes = await invoke<WorkspaceChangeEntry[]>("list_workspace_changes", { workspaceId });
      setWorkspaceChanges(changes);
    } catch (err) {
      console.error("Failed to load workspace changes:", err);
      setError(String(err));
    } finally {
      setIsLoadingChanges(false);
    }
  }

  async function loadWorkspaceCheckDefinitions(workspaceId: string) {
    setIsLoadingDetectedChecks(true);
    try {
      const checks = await invoke<WorkspaceCheckDefinition[]>("list_workspace_checks", { workspaceId });
      setDetectedChecks(checks);
    } catch (err) {
      console.error("Failed to detect workspace checks:", err);
      setDetectedChecks([]);
      setError(String(err));
    } finally {
      setIsLoadingDetectedChecks(false);
    }
  }

  async function runWorkspaceChecks() {
    if (!selectedWorkspace) return;
    const workspaceId = selectedWorkspace;
    setTerminalTab("terminal");
    appendTerminalLine(workspaceId, "meta", "Running workspace checks...");
    setIsRunningChecks(true);
    try {
      const results = await invoke<WorkspaceCheckResult[]>("run_workspace_checks", {
        workspaceId,
      });
      setCheckResults(results);
      let passCount = 0;
      for (const result of results) {
        appendTerminalLine(workspaceId, "command", `$ ${result.command}`);
        appendTerminalLine(
          workspaceId,
          "meta",
          `${result.success ? "PASS" : "FAIL"} ${result.name} · exit ${result.exitCode ?? "?"} · ${result.durationMs}ms`,
        );
        if (result.stdout.trim()) {
          appendTerminalLine(workspaceId, "stdout", result.stdout.trimEnd());
        }
        if (result.stderr.trim()) {
          appendTerminalLine(workspaceId, "stderr", result.stderr.trimEnd());
        }
        if (result.success) {
          passCount += 1;
        }
      }
      appendTerminalLine(
        workspaceId,
        "meta",
        `Checks complete: ${passCount}/${results.length} passed.`,
      );
    } catch (err) {
      console.error("Failed to run workspace checks:", err);
      appendTerminalLine(workspaceId, "stderr", String(err));
      setError(String(err));
    } finally {
      setIsRunningChecks(false);
    }
  }

  const currentTerminalLines = selectedWorkspace ? terminalLinesByWorkspace[selectedWorkspace] || [] : [];

  function appendTerminalLine(workspaceId: string, kind: TerminalLine["kind"], text: string) {
    setTerminalLinesByWorkspace((prev) => ({
      ...prev,
      [workspaceId]: [
        ...(prev[workspaceId] || []),
        {
          id: `${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
          kind,
          text,
        },
      ],
    }));
  }

  async function runTerminalCommand() {
    if (!selectedWorkspace || !terminalInput.trim() || isRunningTerminalCommand) return;
    const command = terminalInput.trim();
    if (selectedWorkspace) {
      setTerminalHistoryByWorkspace((prev) => ({
        ...prev,
        [selectedWorkspace]: [...(prev[selectedWorkspace] || []), command],
      }));
    }
    setTerminalHistoryIndex(null);
    setTerminalInput("");
    appendTerminalLine(selectedWorkspace, "command", `$ ${command}`);
    setIsRunningTerminalCommand(true);

    try {
      const result = await invoke<TerminalCommandResult>("run_workspace_terminal_command", {
        workspaceId: selectedWorkspace,
        command,
        envOverrides: parseEnvOverrides(envOverridesText),
      });

      appendTerminalLine(
        selectedWorkspace,
        "meta",
        `exit ${result.exitCode ?? "?"} in ${result.durationMs}ms · ${result.cwd}`,
      );
      if (result.stdout.trim()) {
        appendTerminalLine(selectedWorkspace, "stdout", result.stdout.trimEnd());
      }
      if (result.stderr.trim()) {
        appendTerminalLine(selectedWorkspace, "stderr", result.stderr.trimEnd());
      }
    } catch (err) {
      appendTerminalLine(selectedWorkspace, "stderr", String(err));
      setError(String(err));
    } finally {
      setIsRunningTerminalCommand(false);
    }
  }

  async function startRemoteServer() {
    if (isTogglingRemoteServer) return;
    setIsTogglingRemoteServer(true);
    try {
      const status = await invoke<ServerStatus>("start_remote_server");
      setServerStatus(status);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsTogglingRemoteServer(false);
    }
  }

  async function stopRemoteServer() {
    if (isTogglingRemoteServer) return;
    setIsTogglingRemoteServer(true);
    try {
      const status = await invoke<ServerStatus>("stop_remote_server");
      setServerStatus(status);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsTogglingRemoteServer(false);
    }
  }

  function normalizeChangeStatus(status: string): string {
    return status.trim() || status;
  }

  function getChangeStatusClass(status: string): string {
    const normalized = normalizeChangeStatus(status);
    if (normalized === "??" || normalized.includes("A")) return "text-emerald-300";
    if (normalized.includes("D")) return "text-rose-300";
    if (normalized.includes("R")) return "text-amber-300";
    if (normalized.includes("M")) return "text-sky-300";
    return "md-text-muted";
  }

  async function openChangedFile(change: WorkspaceChangeEntry) {
    if (!selectedWorkspace) return;

    const tabId = `diff:${change.status}:${change.oldPath ?? ""}:${change.path}`;
    setCenterTabs((prev) => {
      if (prev.some((tab) => tab.id === tabId)) return prev;
      const title = change.path.split("/").pop() || change.path;
      return [
        ...prev,
        {
          id: tabId,
          type: "diff",
          title,
          path: change.path,
          status: change.status,
          oldPath: change.oldPath,
        },
      ];
    });
    setActiveCenterTabId(tabId);

    if (diffContentsByTab[tabId] !== undefined) return;

    setLoadingDiffTabId(tabId);
    try {
      const diff = await invoke<string>("read_workspace_change_diff", {
        workspaceId: selectedWorkspace,
        path: change.path,
        oldPath: change.oldPath ?? null,
        status: change.status,
      });
      setDiffContentsByTab((prev) => ({ ...prev, [tabId]: diff }));
    } catch (err) {
      console.error("Failed to load workspace change diff:", err);
      setDiffContentsByTab((prev) => ({ ...prev, [tabId]: "" }));
      setError(String(err));
    } finally {
      setLoadingDiffTabId((prev) => (prev === tabId ? null : prev));
    }
  }

  async function openCurrentWorkspaceInEditor(editor: EditorKind) {
    if (!selectedWorkspace) return;
    try {
      await invoke("open_workspace_in_editor", { workspaceId: selectedWorkspace, editor });
    } catch (err) {
      const editorLabel = editor === "vscode" ? "VS Code" : "IntelliJ";
      setError(`Failed to open workspace in ${editorLabel}: ${String(err)}`);
    }
  }

  async function openCurrentWorkspaceTarget(target: WorkspaceOpenTarget) {
    if (!target) return;
    if (target === "terminal") {
      setTerminalTab("terminal");
      return;
    }
    await openCurrentWorkspaceInEditor(target);
  }

  function getDiffLineClass(line: string): string {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) return "text-indigo-300";
    if (line.startsWith("+")) return "text-emerald-300";
    if (line.startsWith("-")) return "text-rose-300";
    if (line.startsWith("@@")) return "text-amber-300";
    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("new file mode") || line.startsWith("deleted file mode")) {
      return "md-text-muted";
    }
    return "md-text-primary";
  }

  function renderFileTree(path: string, depth: number) {
    const entries = workspaceFilesByPath[path] || [];

    return entries.map((entry) => {
      const isExpanded = expandedPaths.has(entry.path);
      const isLoading = loadingPaths.has(entry.path);
      const childrenLoaded = workspaceFilesByPath[entry.path] !== undefined;

      return (
        <div key={entry.path}>
          <button
            onClick={() => {
              if (entry.isDir) {
                toggleDirectory(entry.path);
              } else {
                openFile(entry.path);
              }
            }}
            className={`flex w-full items-center gap-2 rounded-md md-px-2 md-py-1.5 text-left text-xs transition ${
              activeCenterTabId === `file:${entry.path}`
                ? "md-surface-strong md-text-strong"
                : entry.isDir
                  ? "hover:md-surface-subtle"
                  : "hover:md-surface-subtle md-text-secondary"
            }`}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
          >
            <span className="w-3 md-text-muted">{entry.isDir ? (isExpanded ? "▾" : "▸") : " "}</span>
            <span
              className={`material-symbols-rounded !text-base ${
                entry.isDir ? "md-text-primary" : "md-text-dim"
              }`}
            >
              {entry.isDir ? (isExpanded ? "folder_open" : "folder") : "description"}
            </span>
            <span className="truncate">{entry.name}</span>
          </button>

          {entry.isDir && isExpanded && (
            <>
              {isLoading && (
                <div
                  className="md-px-2 md-py-1 text-xs md-text-muted"
                  style={{ paddingLeft: `${(depth + 1) * 14 + 14}px` }}
                >
                  Loading...
                </div>
              )}
              {!isLoading && childrenLoaded && renderFileTree(entry.path, depth + 1)}
            </>
          )}
        </div>
      );
    });
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "initializing": return "bg-sky-400 animate-pulse";
      case "running": return "bg-emerald-400";
      case "inReview": return "bg-amber-400";
      case "merged": return "bg-violet-400";
      case "idle": return "bg-zinc-500";
      default: return "bg-zinc-500";
    }
  };

  const workspaceGroups = useMemo(
    () => {
      const claimed = new Set<string>();
      // Pass 1: assign workspaces with overrides or matching statuses
      const groups = workspaceGroupConfig.map((group) => {
        const items = workspaces.filter((ws) => {
          if (claimed.has(ws.id)) return false;
          // If workspace has an explicit group override, respect it
          const override = workspaceGroupOverrides[ws.id];
          if (override) {
            if (override !== group.id) return false;
            claimed.add(ws.id);
            return true;
          }
          // Status-free groups only contain overridden workspaces (filled in pass 1)
          if (group.statuses.length === 0) return false;
          if (!group.statuses.includes(ws.status)) return false;
          claimed.add(ws.id);
          return true;
        });
        return { key: group.id, label: group.label, statuses: group.statuses, items };
      });
      // Pass 2: put unclaimed workspaces into the first status-free group (catch-all)
      const unclaimed = workspaces.filter((ws) => !claimed.has(ws.id));
      if (unclaimed.length > 0) {
        const catchAll = groups.find((g) => g.statuses.length === 0);
        if (catchAll) {
          catchAll.items = [...catchAll.items, ...unclaimed];
        }
      }
      return groups;
    },
    [workspaces, workspaceGroupConfig, workspaceGroupOverrides],
  );

  const currentRepo = repositories.find(r => r.id === selectedRepo);
  const currentWorkspace = workspaces.find(w => w.id === selectedWorkspace);
  const workspaceAgents = agents.filter(a => a.workspaceId === selectedWorkspace);
  const isAutoStartingCurrentWorkspace = autoStartingWorkspaceId === selectedWorkspace;
  const currentThinkingSince = selectedWorkspace
    ? (thinkingSinceByWorkspace[selectedWorkspace] ?? null)
    : null;
  const isThinkingCurrentWorkspace = currentThinkingSince !== null;
  const currentQueuedMessages = selectedWorkspace ? (queuedMessagesByWorkspace[selectedWorkspace] || []) : [];
  const activeCenterTab = centerTabs.find((tab) => tab.id === activeCenterTabId) || centerTabs[0];
  const workspaceMessages = selectedWorkspace ? messages : [];
  const latestSystemMessage = useMemo(() => {
    for (let idx = workspaceMessages.length - 1; idx >= 0; idx -= 1) {
      const message = workspaceMessages[idx];
      if (message.role === "system" && !message.isError) {
        return message;
      }
    }
    return null;
  }, [workspaceMessages]);
  const derivedAnsweredQuestionTimestamps = useMemo(() => {
    const answered = new Set<string>();
    let pendingQuestionTimestamp: string | null = null;

    for (const message of workspaceMessages) {
      if (message.role === "question") {
        if (pendingQuestionTimestamp) {
          // A newer question supersedes an older pending one.
          answered.add(pendingQuestionTimestamp);
        }
        pendingQuestionTimestamp = message.timestamp;
        continue;
      }

      if (pendingQuestionTimestamp && (message.role === "user" || message.agentId === "user")) {
        answered.add(pendingQuestionTimestamp);
        pendingQuestionTimestamp = null;
      }
    }

    return answered;
  }, [workspaceMessages]);
  const chatRows = useMemo<ChatRow[]>(() => {
    const rows: ChatRow[] = [];
    let systemBuffer: AgentMessage[] = [];
    let sequence = 0;

    const flushSystemBuffer = () => {
      if (systemBuffer.length === 0) return;
      const first = systemBuffer[0];
      const rowId = `activity-${first.timestamp}-${sequence}`;
      rows.push({
        kind: "activity",
        id: rowId,
        group: {
          id: rowId,
          messages: systemBuffer,
          lines: compactActivityLines(systemBuffer),
        },
      });
      sequence += 1;
      systemBuffer = [];
    };

    for (const message of workspaceMessages) {
      const isSystemActivity = message.role === "system" && !message.isError;
      if (isSystemActivity) {
        systemBuffer.push(message);
        continue;
      }

      flushSystemBuffer();
      rows.push({
        kind: "message",
        id: `message-${message.timestamp}-${sequence}`,
        message,
      });
      sequence += 1;
    }

    flushSystemBuffer();
    return rows;
  }, [workspaceMessages]);
  const renderedChatRows = useMemo(() => {
    const expandedActivityIds = new Set(
      selectedWorkspace ? (expandedActivityIdsByWorkspace[selectedWorkspace] || []) : [],
    );

    return chatRows.map((row, rowIdx) => {
      if (row.kind === "activity") {
        const isLatestRunningActivity = isThinkingCurrentWorkspace && rowIdx === chatRows.length - 1;
        const expanded = expandedActivityIds.has(row.id);
        return (
          <div key={row.id}>
            <button
              onClick={() => {
                if (!selectedWorkspace) return;
                setExpandedActivityIdsByWorkspace((prev) => {
                  const existing = new Set(prev[selectedWorkspace] || []);
                  if (existing.has(row.id)) {
                    existing.delete(row.id);
                  } else {
                    existing.add(row.id);
                  }
                  return {
                    ...prev,
                    [selectedWorkspace]: Array.from(existing),
                  };
                });
              }}
              className="flex w-full items-center gap-2 py-1.5 text-left transition hover:bg-white/5"
            >
              <span className="text-xs md-text-faint">
                Agent activity ({row.group.messages.length} events)
              </span>
              {isLatestRunningActivity && (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-700/60 bg-amber-950/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
                  running
                </span>
              )}
              <span className="material-symbols-rounded ml-auto !text-sm md-text-faint">
                {expanded ? "expand_more" : "chevron_right"}
              </span>
            </button>

            {expanded && (
              <div className="space-y-1.5 pl-2 pt-1 pb-1">
                {row.group.lines.map((line, lineIdx) => (
                  <div key={`${row.id}-line-${lineIdx}`} className="flex items-start gap-2 text-xs md-text-faint">
                    <span className="mt-1 h-1 w-1 flex-none rounded-full bg-white/20" />
                    <span className="break-all font-mono">
                      <LinkifiedInlineText
                        text={line.text}
                        className="underline decoration-white/35 underline-offset-2 hover:decoration-white/70"
                      />
                    </span>
                    {line.count > 1 && (
                      <span className="text-[10px] md-text-faint">x{line.count}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      }

      const msg = row.message;
      const isUser =
        msg.role === "user" ||
        msg.agentId === "user" ||
        msg.content.trimStart().startsWith(">");

      if (msg.isError) {
        if (msg.role === "credential_error") {
          return (
            <div key={row.id} className="rounded-xl border border-amber-700/60 bg-amber-950/25 px-3 py-2">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-amber-300">Credential Error</div>
              <pre className="select-text overflow-x-auto whitespace-pre-wrap text-sm text-amber-200">{msg.content}</pre>
              <button
                type="button"
                className="mt-1.5 text-xs text-amber-400 underline underline-offset-2 hover:text-amber-300"
                onClick={() => setTerminalTab("setup")}
              >
                Open Setup tab
              </button>
            </div>
          );
        }
        return (
          <div key={row.id} className="rounded-xl border border-rose-700/60 bg-rose-950/20 px-3 py-2">
            <div className="mb-1 text-[11px] uppercase tracking-wide text-rose-300">Error</div>
            <pre className="select-text overflow-x-auto whitespace-pre-wrap text-sm text-rose-200">{msg.content}</pre>
          </div>
        );
      }

      if (msg.role === "question") {
        const isAnswered =
          answeredQuestionTimestamps.has(msg.timestamp) ||
          derivedAnsweredQuestionTimestamps.has(msg.timestamp);
        return (
          <QuestionCard
            key={row.id}
            message={msg}
            rowId={row.id}
            isAnswered={isAnswered}
            onAnswer={(answer) => handleQuestionAnswer(msg.timestamp, answer)}
          />
        );
      }

      if (isUser) {
        return (
          <div key={row.id} className="flex justify-end">
            <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-sky-900/40 px-4 py-3">
              <pre className="select-text overflow-x-auto whitespace-pre-wrap text-sm leading-relaxed md-text-strong">
                {msg.content.replace(/^>\s?/, "")}
              </pre>
            </div>
          </div>
        );
      }

      return (
        <div key={row.id}>
          <MarkdownMessage content={msg.content} />
        </div>
      );
    });
  }, [
    answeredQuestionTimestamps,
    chatRows,
    derivedAnsweredQuestionTimestamps,
    expandedActivityIdsByWorkspace,
    handleQuestionAnswer,
    isThinkingCurrentWorkspace,
    selectedWorkspace,
  ]);
  const sortedWorkspaceChanges = useMemo(
    () =>
      [...workspaceChanges].sort((a, b) => {
        const byPath = a.path.localeCompare(b.path);
        if (byPath !== 0) return byPath;
        return a.status.localeCompare(b.status);
      }),
    [workspaceChanges],
  );
  if (isLoading) {
    return (
      <div className="md-surface flex h-screen items-center justify-center md-text-primary">
        <div className="h-8 w-8 animate-spin rounded-full border-2 md-outline border-t-amber-300" />
      </div>
    );
  }

  if (repositories.length === 0) {
    return (
      <div className="md-surface flex h-screen items-center justify-center">
        <div className="md-dialog mx-4 max-w-md md-px-6 md-py-8 text-center">
          <div className="mb-6 md-text-muted">
            <svg className="w-20 h-20 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
          </div>
          <h1 className="mb-2 text-2xl font-semibold md-text-strong">
            Welcome to Claude Orchestrator
          </h1>
          <p className="mb-8 md-text-dim">
            Add a Git repository to get started. Each workspace will be an isolated 
            worktree where Claude can develop features independently.
          </p>
          
          {error && (
            <div className="mb-4 rounded-lg border border-rose-900/70 bg-rose-950/40 p-3 text-sm text-rose-300">
              {error}
            </div>
          )}
          
          <button
            onClick={addRepository}
            className="md-btn md-btn-tonal md-px-6 md-py-2 text-sm"
          >
            Add Git Repository
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`md-surface relative flex h-screen overflow-hidden md-text-strong ${isResizingLeft || isResizingRight || isResizingTerminal ? "select-none" : ""}`}>
      {(isLeftPanelOpen || isRightPanelOpen) && (
        <button
          className="fixed inset-0 z-30 bg-black/55 lg:hidden"
          onClick={() => {
            setIsLeftPanelOpen(false);
            setIsRightPanelOpen(false);
          }}
          aria-label="Close menus"
        />
      )}

      <aside
        className={`md-surface-container fixed inset-y-0 left-0 z-40 flex flex-col border-r md-outline backdrop-blur transition-all duration-200 lg:static lg:z-auto ${
          isLeftPanelOpen ? "w-[280px] translate-x-0" : "-translate-x-full lg:translate-x-0 lg:w-0 lg:min-w-0 lg:overflow-hidden lg:border-r-0"
        }`}
        style={isLeftPanelOpen ? { width: `${leftPanelWidth}px` } : undefined}
      >
        <div className="flex h-14 items-center border-b md-outline md-px-5">
          <div className="flex items-center justify-between">
            <p className="md-label-medium">History</p>
            <button
              onClick={() => setIsLeftPanelOpen(false)}
              className="md-btn lg:hidden"
            >
              Close
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto md-px-4 md-py-4">
          <div className="mb-4">
            <div className="mb-2 flex items-center justify-between md-px-1">
              <h2 className="md-title-small">Repositories</h2>
              <button
                type="button"
                onClick={addRepository}
                className="md-icon-plain rounded-full border md-outline"
                title="Add repository"
                aria-label="Add repository"
              >
                <span className="material-symbols-rounded !text-[18px]">add</span>
              </button>
            </div>
            {repositories.length === 0 ? (
              <p className="px-2 text-xs md-text-muted">No repositories added.</p>
            ) : (
              <div className="space-y-1">
                {repositories.map((repo) => (
                  <div
                    key={repo.id}
                    className={`md-list-item flex items-center gap-2 md-px-2 md-py-1.5 ${
                      selectedRepo === repo.id ? "md-list-item-active" : ""
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleSelectRepository(repo.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <p className="truncate text-xs md-text-primary">{repo.name}</p>
                    </button>
                    <button
                      type="button"
                      onClick={() => setDefaultRepository(repo.id)}
                      className={`md-icon-plain ${defaultRepoId === repo.id ? "md-text-primary !bg-white/10" : ""}`}
                      title={defaultRepoId === repo.id ? "Default repository" : "Set as default repository"}
                      aria-label={defaultRepoId === repo.id ? "Default repository" : `Set ${repo.name} as default`}
                    >
                      <span
                        className="material-symbols-rounded !text-[16px]"
                        style={{
                          fontVariationSettings:
                            defaultRepoId === repo.id
                              ? '"FILL" 1, "wght" 500, "GRAD" 0, "opsz" 24'
                              : '"FILL" 0, "wght" 400, "GRAD" 0, "opsz" 24',
                        }}
                      >
                        star
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void removeRepository(repo.id);
                      }}
                      className="md-icon-plain md-icon-plain-danger"
                      title="Remove repository"
                      aria-label={`Remove ${repo.name}`}
                    >
                      <span className="material-symbols-rounded !text-[16px]">delete</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mb-4 flex items-center justify-between md-px-1">
            <h2 className="md-title-small">Workspaces</h2>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setShowGroupSettings(true)}
                className="md-icon-plain"
                title="Configure workspace groups"
                aria-label="Configure workspace groups"
              >
                <span className="material-symbols-rounded !text-[16px]">settings</span>
              </button>
              <button
                type="button"
                onClick={openCreateWorkspaceForm}
                className="md-icon-plain rounded-full border md-outline disabled:cursor-not-allowed disabled:opacity-45"
                disabled={!selectedRepo}
                title={selectedRepo ? "Add workspace" : "Select a repository first"}
                aria-label={selectedRepo ? "Add workspace" : "Select a repository first"}
              >
                <span className="material-symbols-rounded !text-[18px]">add</span>
              </button>
            </div>
          </div>

          <DndContext
            sensors={dndSensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={(e) => void handleDragEnd(e)}
          >
            {workspaceGroups.map((group) => (
              <SortableContext
                key={group.key}
                items={[...group.items.map((w) => w.id), `group:${group.key}`]}
                strategy={verticalListSortingStrategy}
              >
                <div className="mb-3">
                  <div className="mb-1 flex items-center gap-2 md-px-2 md-label-large">
                    <span>{group.label}</span>
                    <span>{group.items.length}</span>
                  </div>
                  <div
                    className={`min-h-[4px] space-y-1 rounded transition-colors ${
                      dragActiveId && dragOverGroupId === group.key ? "bg-sky-500/10 ring-1 ring-sky-500/30" : ""
                    }`}
                    data-group-id={group.key}
                  >
                    {group.items.map((workspace) => (
                      <SortableWorkspaceItem
                        key={workspace.id}
                        workspace={workspace}
                        isSelected={selectedWorkspace === workspace.id}
                        unreadCount={unreadByWorkspace[workspace.id] || 0}
                        onSelect={handleSelectWorkspace}
                        onTogglePin={(id) => void togglePin(id)}
                        onRename={openRenameWorkspaceForm}
                        onRemove={(id) => void removeWorkspace(id)}
                        getStatusColor={getStatusColor}
                      />
                    ))}
                    {group.items.length === 0 && (
                      <GroupDropZone groupKey={group.key} />
                    )}
                  </div>
                </div>
              </SortableContext>
            ))}
            <DragOverlay>
              {dragActiveId ? (() => {
                const ws = workspaces.find((w) => w.id === dragActiveId);
                return ws ? (
                  <div className="rounded-lg border md-outline md-surface-container-high px-3 py-2 shadow-lg">
                    <span className="md-body-small md-text-primary">{ws.name}</span>
                  </div>
                ) : null;
              })() : null}
            </DragOverlay>
          </DndContext>
        </div>

      </aside>

      <div
        className="relative -ml-px z-10 hidden w-0.5 cursor-col-resize transition hover:w-1 hover:bg-violet-400/60 lg:block"
        onMouseDown={() => setIsResizingLeft(true)}
        title="Resize sidebar"
      />

      <main className="flex min-w-0 flex-1 flex-col md-outline lg:border-r">
        <header className="md-surface-container-high flex h-14 items-center justify-between border-b md-outline md-px-5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex items-center gap-2 lg:hidden">
              <button
                onClick={() => setIsLeftPanelOpen(true)}
                className="md-btn"
                aria-label="Open left menu"
              >
                <span className="material-symbols-rounded !text-base">menu</span>
                Menu
              </button>
              <button
                onClick={() => setIsRightPanelOpen(true)}
                className="md-btn"
                aria-label="Open right menu"
              >
                <span className="material-symbols-rounded !text-base">dock_to_right</span>
                Tools
              </button>
            </div>
            <span
              className="truncate md-title-small"
              onDoubleClick={() => currentWorkspace && openRenameWorkspaceForm(currentWorkspace)}
              title={currentWorkspace ? "Double-click to rename" : undefined}
              style={currentWorkspace ? { cursor: "text" } : undefined}
            >{currentWorkspace?.name || "Select workspace"}</span>
            {currentWorkspace && <span className="truncate md-label-large">{currentWorkspace.branch}</span>}
          </div>
          <div className="flex items-center gap-1">
            {currentWorkspace && (
              <select
                value={workspaceOpenTarget}
                onChange={(e) => {
                  const target = e.target.value as WorkspaceOpenTarget;
                  setWorkspaceOpenTarget("");
                  void openCurrentWorkspaceTarget(target);
                }}
                className="md-select !w-auto !min-h-0 h-7 py-0 pl-2 pr-7 text-[11px]"
                title="Open current workspace"
                aria-label="Open current workspace"
              >
                <option value="">Open</option>
                <option value="vscode">VS Code</option>
                <option value="intellij">IntelliJ</option>
                <option value="terminal">Terminal</option>
              </select>
            )}
            {currentWorkspace && workspaceAgents.length > 0 && (
              <button
                onClick={() => stopAgent(workspaceAgents[0].id)}
                className="md-icon-plain !h-7 !w-7 md-text-muted hover:text-rose-300"
                title="End agent session"
                aria-label="End agent session"
              >
                <span className="material-symbols-rounded !text-[18px]">archive</span>
              </button>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md-surface">
          {error && (
            <div className="mx-4 mt-4 rounded-md border border-rose-900/60 bg-rose-950/30 md-px-3 md-py-2 text-xs text-rose-300">
              {error}
              <button onClick={() => setError(null)} className="ml-2 text-rose-100 underline">
                dismiss
              </button>
            </div>
          )}

          {availableUpdate && !updateDismissed && (
            <div className="mx-4 mt-3 rounded-md border border-emerald-700/50 bg-emerald-950/25 md-px-3 md-py-2 text-xs text-emerald-200">
              <div className="flex flex-wrap items-center gap-2">
                <span>
                  Update available: {availableUpdate.currentVersion} → {availableUpdate.version}
                </span>
                <button
                  type="button"
                  className="md-btn md-btn-tonal !min-h-0 !px-2 !py-1 text-[11px]"
                  onClick={() => void installAppUpdate()}
                  disabled={isInstallingUpdate}
                >
                  {isInstallingUpdate ? "Installing..." : "Install now"}
                </button>
                <button
                  type="button"
                  className="md-btn !min-h-0 !px-2 !py-1 text-[11px]"
                  onClick={() => setUpdateDismissed(true)}
                >
                  Later
                </button>
              </div>
              {availableUpdate.body && (
                <p className="mt-1 truncate md-text-muted">{availableUpdate.body}</p>
              )}
            </div>
          )}

          {currentWorkspace ? (
            <>
              <div className="md-tab-strip md-px-4 pt-2">
                <div className="flex items-end gap-1 overflow-x-auto pb-0.5">
                  {centerTabs.map((tab) => (
                    <div
                      key={tab.id}
                      className={`md-tab -mb-px flex items-center gap-2 md-px-3 md-py-2 ${
                        activeCenterTabId === tab.id
                          ? "md-tab-active"
                          : "hover:md-text-primary"
                      }`}
                    >
                      <button onClick={() => setActiveCenterTabId(tab.id)} className="whitespace-nowrap">
                        {tab.title}
                      </button>
                      {(tab.type === "file" || tab.type === "diff") && (
                        <button
                          onClick={() => closeCenterTab(tab.id)}
                          className="md-text-muted transition hover:md-text-primary"
                          aria-label={`Close ${tab.title}`}
                        >
                          x
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto md-px-3 md-py-3">
                <div className="space-y-3">
                  {activeCenterTab.type === "chat" && workspaceMessages.length === 0 ? (
                    <div className="flex h-[55vh] items-center justify-center md-text-muted">
                      {workspaceAgents.length > 0 || isAutoStartingCurrentWorkspace ? (
                        <div className="text-center">
                          <div className="mb-2 animate-pulse text-emerald-300">●</div>
                          <p className="text-sm">{isAutoStartingCurrentWorkspace ? "Agent is starting..." : "Agent is running..."}</p>
                        </div>
                      ) : (
                        <p className="text-sm">Waiting for workspace agent...</p>
                      )}
                    </div>
                  ) : activeCenterTab.type === "chat" ? (
                    renderedChatRows
                  ) : activeCenterTab.type === "file" ? (
                    <div>
                      <p className="mb-2 truncate text-xs md-text-muted">{activeCenterTab.path}</p>
                      {isLoadingFileContent && selectedFilePath === activeCenterTab.path ? (
                        <p className="text-xs md-text-muted">Loading file...</p>
                      ) : (
                        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap font-mono text-sm md-text-primary">
                          {(activeCenterTab.path && fileContentsByPath[activeCenterTab.path]) || "(empty file)"}
                        </pre>
                      )}
                    </div>
                  ) : (
                    <div>
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <p className="truncate text-xs md-text-muted">{activeCenterTab.path}</p>
                        {activeCenterTab.status && (
                          <span className={`md-chip !px-2 !py-0 text-[10px] font-mono ${getChangeStatusClass(activeCenterTab.status)}`}>
                            {normalizeChangeStatus(activeCenterTab.status)}
                          </span>
                        )}
                      </div>
                      {activeCenterTab.oldPath && (
                        <p className="mb-2 truncate text-[11px] md-text-faint">from: {activeCenterTab.oldPath}</p>
                      )}
                      {loadingDiffTabId === activeCenterTab.id ? (
                        <p className="text-xs md-text-muted">Loading diff...</p>
                      ) : (
                        <pre className="max-h-[70vh] overflow-auto whitespace-pre font-mono text-sm">
                          {(diffContentsByTab[activeCenterTab.id] || "(no diff output)")
                            .split("\n")
                            .map((line, idx) => (
                              <div key={`${activeCenterTab.id}-${idx}`} className={getDiffLineClass(line)}>
                                {line || " "}
                              </div>
                            ))}
                        </pre>
                      )}
                    </div>
                  )}
                  {activeCenterTab.type === "chat" && <div ref={messagesEndRef} />}
                  {activeCenterTab.type === "chat" && isThinkingCurrentWorkspace && (
                    <div className="md-px-1 md-py-2 text-xs md-text-muted">
                      <span className="inline-flex items-center gap-2">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-amber-300" />
                        Agent running... {thinkingElapsedSec}s
                      </span>
                      {latestSystemMessage && (
                        <span className="ml-2 md-text-faint">Last step: {shortText(latestSystemMessage.content, 96)}</span>
                      )}
                    </div>
                    )}
                  {activeCenterTab.type === "chat" && currentQueuedMessages.length > 0 && (
                    <div className="mx-2 mb-2 space-y-1.5">
                      <div className="text-[10px] font-semibold uppercase tracking-wider md-text-dim">
                        Queued ({currentQueuedMessages.length})
                      </div>
                      {currentQueuedMessages.map((qm, idx) => (
                        <div
                          key={qm.id}
                          className="flex items-start gap-2 rounded-lg border border-dashed border-sky-500/30 bg-sky-950/20 px-3 py-2"
                        >
                          <span className="mt-0.5 shrink-0 text-[10px] font-mono text-sky-400/70">#{idx + 1}</span>
                          <p className="min-w-0 flex-1 text-xs md-text-secondary line-clamp-2">{qm.visible}</p>
                          <button
                            type="button"
                            onClick={() => selectedWorkspace && removeQueuedMessage(selectedWorkspace, qm.id)}
                            className="shrink-0 md-icon-plain !h-5 !w-5"
                            title="Remove from queue"
                            aria-label="Remove queued message"
                          >
                            <span className="material-symbols-rounded !text-[14px]">close</span>
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {workspaceAgents.length > 0 && activeCenterTab.type === "chat" && selectedWorkspace && credentialErrorWorkspaces.has(selectedWorkspace) && (
                <div className="border-t border-amber-700/50 bg-amber-950/40 px-4 py-3">
                  <div className="flex items-start gap-3">
                    <span className="material-symbols-rounded text-amber-400 !text-xl mt-0.5">key</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-amber-200">AWS credentials expired or invalid</div>
                      <div className="text-xs text-amber-300/70 mt-0.5">Run `aws sso login` (or update environment overrides), then retry your message.</div>
                    </div>
                    <button
                      type="button"
                      className="shrink-0 rounded-lg bg-amber-700/50 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-700/70 transition-colors"
                      onClick={() => { setTerminalTab("setup"); dismissCredentialError(selectedWorkspace); }}
                    >
                      Go to Setup
                    </button>
                    <button
                      type="button"
                      className="shrink-0 text-amber-400/60 hover:text-amber-300 transition-colors"
                      onClick={() => dismissCredentialError(selectedWorkspace)}
                      title="Dismiss"
                    >
                      <span className="material-symbols-rounded !text-lg">close</span>
                    </button>
                  </div>
                </div>
              )}

              {workspaceAgents.length > 0 && activeCenterTab.type === "chat" && (
                <div className="border-t md-outline md-surface-container-high md-px-3 md-py-2">
                  <div className="rounded-2xl border md-outline md-surface-container md-px-3 md-py-2">
                    <textarea
                      value={inputMessage}
                      onChange={(e) => setWorkspaceInputDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void sendMessage();
                        }
                      }}
                      rows={3}
                      placeholder="Ask to make changes... or /prompt name /project:skill-path"
                      aria-busy={isThinkingCurrentWorkspace}
                      style={{ resize: "vertical" }}
                      className="w-full overflow-y-auto rounded-lg border md-outline bg-black/10 px-2 py-1 text-sm leading-relaxed outline-none md-text-primary placeholder:md-text-muted min-h-[96px] max-h-[45vh]"
                    />

                    {attachedFiles.length > 0 && (
                      <div className="flex flex-wrap gap-2 border-t md-outline pt-2">
                        {attachedFiles.map((path) => {
                          const relativePath = currentWorkspace
                            ? toWorkspaceRelativePath(path, currentWorkspace.worktreePath) ?? path.split("/").pop() ?? path
                            : path.split("/").pop() ?? path;
                          return (
                            <span key={path} className="md-chip gap-1">
                              <span className="material-symbols-rounded !text-sm">description</span>
                              <span className="max-w-[240px] truncate">{relativePath}</span>
                              <button
                                type="button"
                                className="md-icon-plain !h-4 !w-4"
                                onClick={() => removeAttachedFile(path)}
                                title="Remove attached file"
                              >
                                <span className="material-symbols-rounded !text-sm">close</span>
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    )}

                    <div className="mt-1.5 flex items-center gap-1.5 border-t md-outline pt-1.5">
                        <button
                          type="button"
                          onClick={() => void addFilesToComposer()}
                          className="md-icon-plain !h-7 !w-7"
                          title="Attach files"
                          aria-label="Attach files"
                        >
                          <span className="material-symbols-rounded !text-[18px]">attach_file</span>
                        </button>
                        <select
                          value={selectedModel}
                          onChange={(e) => setWorkspaceModel(e.target.value)}
                          className="md-select !min-h-0 h-7 py-0 pl-2 pr-6 text-[11px]"
                          style={{ width: "auto" }}
                          aria-label="Model selection"
                        >
                          {MODEL_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <select
                          value={thinkingMode}
                          onChange={(e) => setThinkingMode(e.target.value as "off" | "low" | "medium" | "high")}
                          className="md-select !min-h-0 h-7 py-0 pl-2 pr-6 text-[11px]"
                          style={{ width: "auto" }}
                          aria-label="Thinking mode"
                        >
                          <option value="off">Think off</option>
                          <option value="low">Think low</option>
                          <option value="medium">Think med</option>
                          <option value="high">Think high</option>
                        </select>

                        <div className="ml-auto flex items-center gap-1">
                          <button
                            onClick={toggleWorkspaceClaudeMode}
                            className={`md-icon-plain !h-7 !w-7 ${claudeMode === "plan" ? "text-violet-300" : ""}`}
                            title={claudeMode === "plan" ? "Planning mode (click for normal)" : "Normal mode (click for plan)"}
                            aria-label={claudeMode === "plan" ? "Switch to normal mode" : "Switch to planning mode"}
                          >
                            <span className="material-symbols-rounded !text-[18px]">
                              {claudeMode === "plan" ? "schema" : "bolt"}
                            </span>
                          </button>

                          {isThinkingCurrentWorkspace && workspaceAgents.length > 0 && (
                            <button
                              onClick={() => interruptAgent(workspaceAgents[0].id)}
                              className="md-icon-plain !h-7 !w-7 text-amber-400 hover:text-amber-300"
                              title="Interrupt current prompt"
                              aria-label="Interrupt agent"
                            >
                              <span className="material-symbols-rounded !text-[18px]">pause_circle</span>
                            </button>
                          )}
                          <button
                            onClick={() => {
                              void sendMessage();
                            }}
                            disabled={!inputMessage.trim()}
                            className={`md-icon-plain !h-7 !w-7 disabled:cursor-not-allowed disabled:opacity-30 ${
                              isThinkingCurrentWorkspace
                                ? "text-sky-400/70 hover:text-sky-300"
                                : "text-sky-300"
                            }`}
                            title={isThinkingCurrentWorkspace ? "Queue message (sent after current run)" : "Send message"}
                            aria-label={isThinkingCurrentWorkspace ? "Queue message" : "Send message"}
                          >
                            <span className="material-symbols-rounded !text-[18px]">
                              {isThinkingCurrentWorkspace ? "queue" : "send"}
                            </span>
                          </button>
                        </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center md-px-5">
              <div className="max-w-md text-center md-text-muted">
                <h3 className="text-lg font-medium md-text-primary">Select or Create a Workspace</h3>
                <p className="mt-2 text-sm">
                  Each workspace is an isolated git worktree where Claude can develop features.
                </p>
                <button
                  onClick={openCreateWorkspaceForm}
                  className="md-btn md-btn-tonal mt-4"
                >
                  Create workspace
                </button>
              </div>
            </div>
          )}
        </div>
      </main>

      <div
        className="hidden w-1 cursor-col-resize md-resizer transition hover:bg-violet-400/60 lg:block"
        onMouseDown={() => setIsResizingRight(true)}
        title="Resize tools panel"
      />

      <aside
        className={`md-surface-container fixed inset-y-0 right-0 z-40 flex w-[360px] max-w-[92vw] flex-col transition-all duration-200 lg:static lg:z-auto lg:max-w-none ${
          isRightPanelOpen ? "translate-x-0" : "translate-x-full lg:translate-x-0 lg:w-0 lg:min-w-0 lg:overflow-hidden lg:border-l-0"
        }`}
        style={isRightPanelOpen ? { width: `${rightPanelWidth}px` } : undefined}
      >
        <div className="flex h-14 items-center border-b md-outline md-px-4">
          <div className="md-segmented text-xs">
            <button
              onClick={() => setActiveRightTab("prompts")}
              className={`md-segmented-btn ${
                activeRightTab === "prompts" ? "md-segmented-btn-active" : ""
              }`}
            >
              Prompts
            </button>
            <button
              onClick={() => setActiveRightTab("files")}
              className={`md-segmented-btn ${
                activeRightTab === "files" ? "md-segmented-btn-active" : ""
              }`}
            >
              All files
            </button>
            <button
              onClick={() => setActiveRightTab("changes")}
              className={`md-segmented-btn ${
                activeRightTab === "changes" ? "md-segmented-btn-active" : ""
              }`}
            >
              Changes
            </button>
            <button
              onClick={() => setActiveRightTab("checks")}
              className={`md-segmented-btn ${
                activeRightTab === "checks" ? "md-segmented-btn-active" : ""
              }`}
            >
              Checks
            </button>
          </div>
            <button
              onClick={() => setIsRightPanelOpen(false)}
              className="md-btn ml-auto lg:hidden"
            >
              Close
            </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto md-px-4 md-py-4">
          {activeRightTab === "prompts" && (
            <div className="space-y-3 text-sm">
              <p className="md-label-medium">Prompt Library</p>
              <div className="md-card p-3 md-text-secondary">
                {promptShortcuts.length === 0 ? (
                  <p className="text-xs md-text-muted">No prompt shortcuts yet.</p>
                ) : (
                  <div className="space-y-2">
                    {promptShortcuts.map((shortcut) => (
                      <div
                        key={shortcut.id}
                        className="md-card cursor-pointer md-px-2 md-py-2 transition hover:md-surface-subtle"
                        onClick={() => {
                          void runPromptShortcut(shortcut);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            void runPromptShortcut(shortcut);
                          }
                        }}
                        role="button"
                        tabIndex={0}
                        aria-label={`Run prompt ${shortcut.name}`}
                        title={shortcut.prompt}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm md-text-strong">{shortcut.name}</span>
                            {shortcut.autoRunOnCreate && (
                              <span className="md-chip !px-2 !py-0 text-[10px]">Auto-run on create</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openEditPromptForm(shortcut);
                              }}
                              className="md-icon-plain"
                              title="Edit prompt"
                              aria-label={`Edit ${shortcut.name}`}
                            >
                              <span className="material-symbols-rounded !text-[16px]">edit</span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                deletePromptShortcut(shortcut.id);
                              }}
                              className="md-icon-plain md-icon-plain-danger"
                              title="Delete prompt"
                              aria-label={`Delete ${shortcut.name}`}
                            >
                              <span className="material-symbols-rounded !text-[16px]">delete</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex justify-center">
                  <button
                    type="button"
                    onClick={openAddPromptForm}
                    className="md-icon-plain !h-8 !w-8 rounded-full border md-outline hover:md-surface-subtle"
                    title="Add prompt shortcut"
                    aria-label="Add prompt shortcut"
                  >
                    <span className="material-symbols-rounded !text-[18px]">add</span>
                  </button>
                </div>
              </div>
              <div className="md-card p-3 md-text-secondary">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-1 text-left"
                    onClick={() => setProjectSkillsExpanded((prev) => !prev)}
                    aria-expanded={projectSkillsExpanded}
                  >
                    <span className="material-symbols-rounded !text-[16px] md-text-muted">
                      {projectSkillsExpanded ? "expand_more" : "chevron_right"}
                    </span>
                    <span className="truncate text-sm md-text-strong">Project Skills ({projectSkills.length})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openAddSkillForm("project")}
                    disabled={!selectedRepo}
                    className="md-icon-plain !h-8 !w-8 rounded-full border md-outline hover:md-surface-subtle disabled:cursor-not-allowed disabled:opacity-40"
                    title={selectedRepo ? "Add project skill" : "Select a repository to add project skills"}
                    aria-label="Add project skill"
                  >
                    <span className="material-symbols-rounded !text-[18px]">add</span>
                  </button>
                </div>
                {projectSkillsExpanded && (
                  <div className="mt-2 space-y-2">
                    {isSkillsLoading && <p className="text-xs md-text-muted">Loading project skills...</p>}
                    {!isSkillsLoading && projectSkills.length === 0 && (
                      <p className="text-xs md-text-muted">No project skills found.</p>
                    )}
                    {!isSkillsLoading &&
                      projectSkills.map((skill) => (
                        <div
                          key={skill.id}
                          className="md-card cursor-pointer md-px-2 md-py-2 transition hover:md-surface-subtle"
                          onClick={() => {
                            void runSkillShortcut(skill);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              void runSkillShortcut(skill);
                            }
                          }}
                          role="button"
                          tabIndex={0}
                          aria-label={`Run skill ${skill.name}`}
                          title={skill.filePath}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm md-text-strong">{skill.name}</p>
                              <p className="truncate text-[11px] md-text-muted">/{skill.commandName}</p>
                            </div>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openEditSkillForm(skill);
                              }}
                              className="md-icon-plain"
                              title="Edit skill"
                              aria-label={`Edit ${skill.name}`}
                            >
                              <span className="material-symbols-rounded !text-[16px]">edit</span>
                            </button>
                          </div>
                        </div>
                      ))}
                  </div>
                )}
                {projectSkillsRoot && (
                  <p className="mt-2 truncate text-[11px] md-text-muted" title={projectSkillsRoot}>
                    {projectSkillsRoot}
                  </p>
                )}
              </div>
              <div className="md-card p-3 md-text-secondary">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-1 text-left"
                    onClick={() => setUserSkillsExpanded((prev) => !prev)}
                    aria-expanded={userSkillsExpanded}
                  >
                    <span className="material-symbols-rounded !text-[16px] md-text-muted">
                      {userSkillsExpanded ? "expand_more" : "chevron_right"}
                    </span>
                    <span className="truncate text-sm md-text-strong">User Skills ({userSkills.length})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openAddSkillForm("user")}
                    className="md-icon-plain !h-8 !w-8 rounded-full border md-outline hover:md-surface-subtle"
                    title="Add user skill"
                    aria-label="Add user skill"
                  >
                    <span className="material-symbols-rounded !text-[18px]">add</span>
                  </button>
                </div>
                {userSkillsExpanded && (
                  <div className="mt-2 space-y-2">
                    {isSkillsLoading && <p className="text-xs md-text-muted">Loading user skills...</p>}
                    {!isSkillsLoading && userSkills.length === 0 && (
                      <p className="text-xs md-text-muted">No user skills found.</p>
                    )}
                    {!isSkillsLoading &&
                      userSkills.map((skill) => (
                        <div
                          key={skill.id}
                          className="md-card cursor-pointer md-px-2 md-py-2 transition hover:md-surface-subtle"
                          onClick={() => {
                            void runSkillShortcut(skill);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              void runSkillShortcut(skill);
                            }
                          }}
                          role="button"
                          tabIndex={0}
                          aria-label={`Run skill ${skill.name}`}
                          title={skill.filePath}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-sm md-text-strong">{skill.name}</p>
                              <p className="truncate text-[11px] md-text-muted">/{skill.commandName}</p>
                            </div>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openEditSkillForm(skill);
                              }}
                              className="md-icon-plain"
                              title="Edit skill"
                              aria-label={`Edit ${skill.name}`}
                            >
                              <span className="material-symbols-rounded !text-[16px]">edit</span>
                            </button>
                          </div>
                        </div>
                      ))}
                  </div>
                )}
                {userSkillsRoot && (
                  <p className="mt-2 truncate text-[11px] md-text-muted" title={userSkillsRoot}>
                    {userSkillsRoot}
                  </p>
                )}
              </div>
              <p className="text-xs md-text-muted">
                Click to run. Use `/prompt name`, `/project:skill-path`, `/user:skill-path`, or `/skill-path` when unique.
              </p>

              {currentWorkspace && (
                <div className="mt-4 border-t md-outline pt-3">
                  <p className="mb-2 md-label-medium">Actions</p>
                  <button
                    onClick={() => {
                      sendMessage(
                        `Push this branch to origin and create a pull request using \`gh pr create\`. Write a clear, descriptive PR title and body based on the changes on this branch. Use \`git log main..HEAD\` and \`git diff main\` to understand what changed.`,
                        "Open Pull Request"
                      );
                    }}
                    className="md-list-item flex w-full items-center gap-2 rounded-md md-px-2 md-py-1.5 text-left text-xs transition hover:md-surface-subtle"
                  >
                    <span className="material-symbols-rounded !text-base md-text-muted">merge</span>
                    <span className="md-text-primary">Open Pull Request</span>
                  </button>
                  <button
                    onClick={() => {
                      sendMessage(
                        `Review the code changes on this branch. Use \`git diff main\` to see what changed. For each file, analyze the changes and provide feedback on:\n- Correctness and potential bugs\n- Code quality and readability\n- Performance concerns\n- Security issues\n- Suggestions for improvement\n\nBe specific with line references and provide actionable feedback. Summarize with an overall assessment.`,
                        "Code Review"
                      );
                    }}
                    className="md-list-item flex w-full items-center gap-2 rounded-md md-px-2 md-py-1.5 text-left text-xs transition hover:md-surface-subtle"
                  >
                    <span className="material-symbols-rounded !text-base md-text-muted">rate_review</span>
                    <span className="md-text-primary">Code Review</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {activeRightTab === "files" && (
            <div className="space-y-2 text-sm">
              <p className="md-label-medium">Workspace Files</p>
              <div className="md-card p-3 md-text-secondary">
                <p className="truncate text-xs md-text-muted">
                  {currentWorkspace?.worktreePath || currentRepo?.path || "No active workspace"}
                </p>

                {!selectedWorkspace && (
                  <p className="mt-3 text-xs md-text-muted">Select a workspace to browse files.</p>
                )}

                {selectedWorkspace && loadingPaths.has("") && !workspaceFilesByPath[""] && (
                  <p className="mt-3 text-xs md-text-muted">Loading files...</p>
                )}

                {selectedWorkspace &&
                  workspaceFilesByPath[""] &&
                  workspaceFilesByPath[""].length === 0 && (
                    <p className="mt-3 text-xs md-text-muted">This workspace is empty.</p>
                  )}

                {selectedWorkspace && workspaceFilesByPath[""] && (
                  <div className="mt-3">{renderFileTree("", 0)}</div>
                )}
              </div>

              <p className="text-xs md-text-muted">Click a file to open it as a center tab.</p>
            </div>
          )}

          {activeRightTab === "changes" && (
            <div className="space-y-2 text-sm">
              <p className="md-label-medium">Workspace Changes</p>
              <div className="md-card p-3 md-text-secondary">
                <div className="mb-2 flex items-center justify-between">
                  <span className="md-text-secondary">Changed files ({workspaceChanges.length})</span>
                  <button
                    onClick={() => selectedWorkspace && loadWorkspaceChanges(selectedWorkspace)}
                    className="md-btn"
                  >
                    Refresh
                  </button>
                </div>
                <p className="truncate text-xs md-text-muted">
                  {currentWorkspace?.worktreePath || currentRepo?.path || "No active workspace"}
                </p>

                {isLoadingChanges && <p className="md-text-muted">Loading changes...</p>}
                {!isLoadingChanges && workspaceChanges.length === 0 && (
                  <p className="md-text-muted">Working tree is clean.</p>
                )}
                {!isLoadingChanges && workspaceChanges.length > 0 && (
                  <div className="mt-3 max-h-[52vh] space-y-1 overflow-auto pr-1">
                    {sortedWorkspaceChanges.map((change) => {
                      const tabId = `diff:${change.status}:${change.oldPath ?? ""}:${change.path}`;
                      const isActive = activeCenterTabId === tabId;
                      return (
                        <div key={`${change.status}:${change.oldPath ?? ""}:${change.path}`}>
                          <button
                            onClick={() => {
                              void openChangedFile(change);
                            }}
                            className={`flex w-full items-center gap-2 rounded-md md-px-2 md-py-1.5 text-left text-xs transition hover:md-surface-subtle ${
                              isActive ? "md-surface-strong md-text-strong" : "md-text-secondary"
                            }`}
                          >
                            <span className="material-symbols-rounded !text-base md-text-dim">description</span>
                            <span className="truncate">{change.path}</span>
                            <span className={`ml-auto w-8 flex-none text-right font-mono text-[11px] ${getChangeStatusClass(change.status)}`}>
                              {normalizeChangeStatus(change.status)}
                            </span>
                          </button>
                          {change.oldPath && (
                            <p className="truncate pl-7 text-[11px] md-text-muted">from: {change.oldPath}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <p className="text-xs md-text-muted">Click any file here to open its diff in the center pane.</p>
            </div>
          )}

          {activeRightTab === "checks" && (
            <div className="md-card p-3 text-xs">
              <div className="mb-2 flex items-center justify-between">
                <span className="md-text-secondary">Workspace checks</span>
                <button
                  onClick={runWorkspaceChecks}
                  disabled={!selectedWorkspace || isRunningChecks}
                  className="md-btn md-btn-tonal disabled:opacity-50"
                >
                  {isRunningChecks ? "Running..." : "Run checks"}
                </button>
              </div>

              <div className="mb-3 border-b pb-3 md-outline">
                <p className="mb-2 md-text-dim">Detected checks</p>
                {isLoadingDetectedChecks && <p className="md-text-muted">Detecting checks...</p>}
                {!isLoadingDetectedChecks && detectedChecks.length === 0 && (
                  <p className="md-text-muted">No checks detected for this workspace.</p>
                )}
                {!isLoadingDetectedChecks && detectedChecks.length > 0 && (
                  <div className="space-y-2">
                    {detectedChecks.map((check) => (
                      <div key={`${check.name}-${check.command}`} className="md-card p-2">
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="md-text-secondary">{check.name}</span>
                        </div>
                        <p className="truncate font-mono text-[11px] md-text-muted">{check.command}</p>
                        <p className="mt-1 text-[11px] md-text-muted">{check.description}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {!isRunningChecks && checkResults.length === 0 && (
                <p className="md-text-muted">Run checks to see summary results.</p>
              )}

              {checkResults.length > 0 && (
                <div className="space-y-2">
                  {checkResults.map((check, index) => (
                    <div key={`${check.name}-${index}`} className="md-card p-2">
                      <div className="mb-1 flex items-center justify-between">
                        <span className={check.success ? "text-emerald-300" : "text-rose-300"}>
                          {check.success ? "PASS" : "FAIL"} {check.name}
                        </span>
                        <span className="text-[11px] md-text-muted">{check.durationMs}ms</span>
                      </div>
                      <p className="truncate font-mono text-[11px] md-text-muted">{check.command}</p>
                      {!!check.stdout && (
                        <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-[11px] text-emerald-200">
                          {check.stdout}
                        </pre>
                      )}
                      {!!check.stderr && (
                        <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-[11px] text-rose-300">
                          {check.stderr}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div
          className="h-1 cursor-row-resize border-t md-outline-strong md-surface-subtle transition hover:bg-amber-400/60"
          onMouseDown={() => setIsResizingTerminal(true)}
          title="Resize terminal"
        />
        <div className="flex flex-col overflow-hidden border-t md-outline md-px-4 md-py-2" style={{ height: `${terminalHeight}px` }}>
          <div className="mb-1 flex shrink-0 items-center justify-between text-xs md-text-muted">
            <div className="md-segmented">
              <button
                onClick={() => setTerminalTab("setup")}
                className={`md-segmented-btn ${terminalTab === "setup" ? "md-segmented-btn-active" : ""}`}
              >
                Setup
              </button>
              <button
                onClick={() => setTerminalTab("remote")}
                className={`md-segmented-btn ${terminalTab === "remote" ? "md-segmented-btn-active" : ""}`}
              >
                Remote
              </button>
              <button
                onClick={() => setTerminalTab("terminal")}
                className={`md-segmented-btn ${terminalTab === "terminal" ? "md-segmented-btn-active" : ""}`}
              >
                Terminal
              </button>
            </div>
          </div>
          {terminalTab === "setup" && (
            <div className="md-card min-h-0 flex-1 space-y-3 overflow-auto p-3 text-xs md-text-secondary">
              <div>
                <p className="md-text-dim">Workspace</p>
                <p className="mb-3 md-text-strong">{currentWorkspace?.name || "-"}</p>
                <p className="md-text-dim">Path</p>
                <p className="break-all md-text-strong">{currentWorkspace?.worktreePath || "-"}</p>
              </div>

              <div className="border-t md-outline pt-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="md-text-dim">App updates</p>
                  <button
                    type="button"
                    className="md-btn md-btn-tonal !min-h-0 !px-2 !py-1 text-[11px] disabled:opacity-50"
                    onClick={() => void checkForAppUpdate(true)}
                    disabled={isCheckingUpdate}
                  >
                    {isCheckingUpdate ? "Checking..." : "Check now"}
                  </button>
                </div>
                {availableUpdate ? (
                  <div className="rounded-md border border-emerald-700/50 bg-emerald-950/25 p-2 text-[11px] text-emerald-200">
                    <p>New version available: {availableUpdate.currentVersion} → {availableUpdate.version}</p>
                    <button
                      type="button"
                      className="md-btn mt-2 !min-h-0 !px-2 !py-1 text-[11px]"
                      onClick={() => void installAppUpdate()}
                      disabled={isInstallingUpdate}
                    >
                      {isInstallingUpdate ? "Installing..." : "Install update"}
                    </button>
                  </div>
                ) : !updateError ? (
                  <p className="text-[11px] md-text-muted">No pending update detected.</p>
                ) : null}
                {updateError && <p className="mt-1 text-[11px] text-amber-300">{updateError}</p>}
              </div>

              <div className="border-t md-outline pt-3">
                <p className="md-text-dim">Theme</p>
                <div className="mt-2 space-y-2">
                  <div className="flex items-center gap-2">
                    <select
                      value={selectedTheme}
                      onChange={(event) => setSelectedTheme(normalizeThemeId(event.target.value, availableThemes))}
                      className="md-select !min-h-0"
                      aria-label="Theme selection"
                    >
                      {themeOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={openCreateThemeForm}
                      className="md-icon-plain !h-8 !w-8 rounded-full border md-outline hover:md-surface-subtle"
                      title="Create theme"
                      aria-label="Create theme"
                    >
                      <span className="material-symbols-rounded !text-[18px]">add</span>
                    </button>
                    <button
                      type="button"
                      onClick={openEditThemeForm}
                      disabled={isBuiltInTheme(selectedTheme)}
                      className="md-icon-plain !h-8 !w-8 rounded-full border md-outline hover:md-surface-subtle disabled:cursor-not-allowed disabled:opacity-40"
                      title={isBuiltInTheme(selectedTheme) ? "Only custom themes are editable" : "Edit theme"}
                      aria-label="Edit theme"
                    >
                      <span className="material-symbols-rounded !text-[16px]">edit</span>
                    </button>
                    <button
                      type="button"
                      onClick={deleteSelectedCustomTheme}
                      disabled={isBuiltInTheme(selectedTheme)}
                      className="md-icon-plain md-icon-plain-danger !h-8 !w-8 rounded-full border md-outline hover:md-surface-subtle disabled:cursor-not-allowed disabled:opacity-40"
                      title={isBuiltInTheme(selectedTheme) ? "Built-in themes cannot be deleted" : "Delete custom theme"}
                      aria-label="Delete custom theme"
                    >
                      <span className="material-symbols-rounded !text-[16px]">delete</span>
                    </button>
                  </div>
                  <p className="text-[11px] md-text-muted">
                    {themeOptions.find((option) => option.value === selectedTheme)?.description}
                  </p>
                  <p className="text-[11px] md-text-muted">
                    Use + to create themes from the app. Built-ins stay unchanged.
                  </p>
                </div>
              </div>

              {currentWorkspace && (
                <div className="border-t md-outline pt-3">
                  <p className="md-text-dim">Notes</p>
                  <p className="mb-2 text-[11px] md-text-muted">
                    Workspace-specific notes. Saved on blur.
                  </p>
                  <textarea
                    defaultValue={currentWorkspace.notes || ""}
                    key={currentWorkspace.id}
                    onBlur={(e) => void saveWorkspaceNotes(currentWorkspace.id, e.target.value)}
                    rows={3}
                    className="md-field"
                    placeholder="Add notes about this workspace..."
                  />
                </div>
              )}

              <div className="border-t md-outline pt-3">
                <p className="md-text-dim">Environment overrides (app-wide)</p>
                <p className="mb-2 text-[11px] md-text-muted">
                  Supports lines like `export KEY=VALUE` or `KEY=VALUE`. Applied to agents, chat and terminal commands.
                </p>
                <label className="mb-2 flex items-center gap-2 rounded-md border px-2 py-1.5 md-outline">
                  <input
                    type="checkbox"
                    checked={bedrockEnabled}
                    onChange={(e) => setBedrockEnabled(e.target.checked)}
                    className="h-4 w-4 accent-sky-500"
                  />
                  <span className="text-[11px] md-text-strong">Use AWS Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`)</span>
                </label>
                <textarea
                  value={envOverridesText}
                  onChange={(e) => setEnvOverridesText(e.target.value)}
                  rows={6}
                  className="md-field font-mono"
                  placeholder={"export CLAUDE_CODE_USE_BEDROCK=1\n# optional if not using default profile\nexport AWS_PROFILE=your-profile"}
                />
              </div>

              {/* Scripts (conductor.json / orchestrator.json) */}
              <div className="border-t md-outline pt-3">
                <p className="md-text-dim">Scripts</p>
                <p className="mb-2 text-[11px] md-text-muted">
                  Configure via conductor.json or orchestrator.json at repo/workspace root.
                </p>
                {orchestratorConfig && (orchestratorConfig.setupScript || orchestratorConfig.runScript) ? (
                  <div className="space-y-2">
                    {orchestratorConfig.setupScript && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void runOrchestratorScript("setup")}
                          disabled={isRunningScript}
                          className="md-btn md-btn-tonal !min-h-0 flex-1 !px-2 !py-1 text-[11px] disabled:opacity-50"
                        >
                          {isRunningScript ? "Running..." : "Run Setup"}
                        </button>
                        <code className="flex-1 truncate rounded bg-black/20 px-1 py-0.5 text-[10px] md-text-muted">
                          {orchestratorConfig.setupScript}
                        </code>
                      </div>
                    )}
                    {orchestratorConfig.runScript && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void runOrchestratorScript("run")}
                          disabled={isRunningScript}
                          className="md-btn md-btn-tonal !min-h-0 flex-1 !px-2 !py-1 text-[11px] disabled:opacity-50"
                        >
                          {isRunningScript ? "Running..." : "Run Script"}
                        </button>
                        <code className="flex-1 truncate rounded bg-black/20 px-1 py-0.5 text-[10px] md-text-muted">
                          {orchestratorConfig.runScript}
                        </code>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-[11px] md-text-muted">
                    No scripts configured. Create conductor.json:
                  </p>
                )}
                <pre className="mt-2 rounded bg-black/20 p-2 text-[10px] md-text-muted">
{`{
  "setupScript": "npm install",
  "runScript": "npm run dev",
  "runMode": "concurrent"
}`}
                </pre>
              </div>
            </div>
          )}
          {terminalTab === "terminal" && (
            <div className="min-h-0 flex-1">
              <div
                className="md-card flex h-full flex-col overflow-auto bg-black/55 p-2 font-mono text-xs"
                onClick={() => terminalInputRef.current?.focus()}
              >
                {currentTerminalLines.length === 0 && (
                  <p className="md-text-muted">{currentWorkspace?.name || "workspace"} terminal is ready.</p>
                )}
                {currentTerminalLines.map((line) => (
                  <pre
                    key={line.id}
                    className={`whitespace-pre-wrap ${
                      line.kind === "command"
                        ? "text-sky-300"
                        : line.kind === "stderr"
                          ? "text-rose-300"
                          : line.kind === "meta"
                            ? "md-text-muted"
                            : "text-emerald-300"
                    }`}
                  >
                    {line.text}
                  </pre>
                ))}
                {isRunningTerminalCommand && <p className="text-amber-300">Running...</p>}
                <div className="mt-1 flex items-center gap-2 text-emerald-300">
                  <span className="shrink-0">$</span>
                  <input
                    ref={terminalInputRef}
                    value={terminalInput}
                    onChange={(e) => setTerminalInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void runTerminalCommand();
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        const history = selectedWorkspace ? (terminalHistoryByWorkspace[selectedWorkspace] || []) : [];
                        if (history.length === 0) return;
                        const newIndex = terminalHistoryIndex === null
                          ? history.length - 1
                          : Math.max(0, terminalHistoryIndex - 1);
                        setTerminalHistoryIndex(newIndex);
                        setTerminalInput(history[newIndex]);
                      } else if (e.key === "ArrowDown") {
                        e.preventDefault();
                        const history = selectedWorkspace ? (terminalHistoryByWorkspace[selectedWorkspace] || []) : [];
                        if (terminalHistoryIndex === null) return;
                        const newIndex = terminalHistoryIndex + 1;
                        if (newIndex >= history.length) {
                          setTerminalHistoryIndex(null);
                          setTerminalInput("");
                        } else {
                          setTerminalHistoryIndex(newIndex);
                          setTerminalInput(history[newIndex]);
                        }
                      } else {
                        if (terminalHistoryIndex !== null) {
                          setTerminalHistoryIndex(null);
                        }
                      }
                    }}
                    placeholder={currentWorkspace ? "type command and press Enter" : "select workspace"}
                    className="w-full border-none bg-transparent p-0 text-xs text-emerald-300 outline-none placeholder:md-text-soft"
                    disabled={!currentWorkspace || isRunningTerminalCommand}
                  />
                </div>
                <div ref={terminalEndRef} />
              </div>
            </div>
          )}
          {terminalTab === "remote" && (
            <div className="md-card min-h-0 flex-1 space-y-4 overflow-auto p-3 text-xs md-text-secondary">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <p className="md-text-dim">Server status</p>
                  <p className={`text-sm ${serverStatus?.running ? "text-emerald-300" : "text-rose-300"}`}>
                    {serverStatus?.running ? "Running" : "Stopped"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="md-text-dim">Connected clients</p>
                  <p className="text-sm md-text-strong">{serverStatus?.connectedClients ?? 0}</p>
                </div>
              </div>

              <div className="border-t md-outline pt-3">
                <p className="md-text-dim">Connection URL</p>
                <p className="mt-1 break-all font-mono text-[11px] md-text-strong">
                  {serverStatus?.connectUrl || "ws://localhost:3001"}
                </p>
              </div>

              <div className="border-t md-outline pt-3">
                <p className="mb-2 md-text-dim">Server controls</p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={startRemoteServer}
                    disabled={isTogglingRemoteServer || !!serverStatus?.running}
                    className="md-icon-plain !h-8 !w-8 rounded-full border md-outline disabled:cursor-not-allowed disabled:opacity-40"
                    title="Start remote server"
                  >
                    <span className="material-symbols-rounded !text-[16px]">play_arrow</span>
                  </button>
                  <button
                    onClick={stopRemoteServer}
                    disabled={isTogglingRemoteServer || !serverStatus?.running}
                    className="md-icon-plain !h-8 !w-8 rounded-full border md-outline disabled:cursor-not-allowed disabled:opacity-40"
                    title="Stop remote server"
                  >
                    <span className="material-symbols-rounded !text-[16px]">stop</span>
                  </button>
                  {isTogglingRemoteServer && <span className="text-[11px] md-text-muted">Updating...</span>}
                </div>
              </div>
            </div>
          )}
        </div>
      </aside>

      {showCreateForm && (
        <div className="md-dialog-scrim fixed inset-0 z-40 flex items-center justify-center">
          <div className="md-dialog w-full max-w-md p-4">
            <p className="mb-2 text-sm font-medium md-text-primary">Create New Workspace</p>
            <input
              type="text"
              value={newWorkspaceName}
              onChange={(e) => setNewWorkspaceName(e.target.value)}
              placeholder="Feature name"
              className="md-field"
              onKeyDown={(e) => e.key === "Enter" && createWorkspace()}
              autoFocus
            />
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => {
                  setShowCreateForm(false);
                  setNewWorkspaceName("");
                }}
                className="md-btn flex-1"
              >
                Cancel
              </button>
              <button
                onClick={createWorkspace}
                className="md-btn md-btn-tonal flex-1"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {showRenameForm && (
        <div className="md-dialog-scrim fixed inset-0 z-40 flex items-center justify-center">
          <div className="md-dialog w-full max-w-md p-4">
            <p className="mb-2 text-sm font-medium md-text-primary">Rename Workspace</p>
            <input
              type="text"
              value={renameWorkspaceName}
              onChange={(e) => setRenameWorkspaceName(e.target.value)}
              placeholder="Workspace name"
              className="md-field"
              onKeyDown={(e) => e.key === "Enter" && renameWorkspace()}
              autoFocus
            />
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => {
                  setShowRenameForm(false);
                  setRenameWorkspaceId(null);
                  setRenameWorkspaceName("");
                }}
                className="md-btn flex-1"
              >
                Cancel
              </button>
              <button
                onClick={renameWorkspace}
                disabled={!renameWorkspaceName.trim()}
                className="md-btn md-btn-tonal flex-1 disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddPromptForm && (
        <div className="md-dialog-scrim fixed inset-0 z-50 flex items-center justify-center">
          <div className="md-dialog mx-4 w-full max-w-lg">
            <div className="border-b md-outline p-4">
              <h3 className="text-lg font-semibold md-text-strong">
                {editingPromptId ? "Edit Prompt Shortcut" : "Add Prompt Shortcut"}
              </h3>
              <p className="mt-1 text-sm md-text-muted">
                {editingPromptId
                  ? "Update a reusable prompt button and slash command."
                  : "Create a reusable prompt button and slash command."}
              </p>
            </div>

            <div className="space-y-4 p-4">
              <div>
                <label className="mb-1 block text-sm font-medium md-text-secondary">Name</label>
                <input
                  type="text"
                  value={newPromptName}
                  onChange={(e) => setNewPromptName(e.target.value)}
                  className="md-field"
                  placeholder="e.g. Code review"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium md-text-secondary">Prompt</label>
                <textarea
                  value={newPromptBody}
                  onChange={(e) => setNewPromptBody(e.target.value)}
                  rows={6}
                  className="md-field font-mono"
                  placeholder="Write the full prompt to execute"
                />
              </div>
              <label className="flex items-start gap-2 rounded-lg border md-outline p-3 text-sm">
                <input
                  type="checkbox"
                  checked={newPromptAutoRunOnCreate}
                  onChange={(e) => setNewPromptAutoRunOnCreate(e.target.checked)}
                  className="mt-0.5 h-4 w-4"
                />
                <span>
                  <span className="block md-text-secondary">Auto-run on workspace creation</span>
                  <span className="block text-xs md-text-muted">
                    Execute this prompt automatically after a new workspace is created and its agent is ready.
                  </span>
                </span>
              </label>
            </div>

            <div className="flex justify-end gap-2 border-t md-outline p-4">
              <button
                onClick={() => {
                  setShowAddPromptForm(false);
                  setEditingPromptId(null);
                }}
                className="md-btn"
              >
                Cancel
              </button>
              <button
                onClick={addPromptShortcut}
                disabled={!newPromptName.trim() || !newPromptBody.trim()}
                className="md-btn md-btn-tonal disabled:opacity-50"
              >
                {editingPromptId ? "Save Prompt" : "Add Prompt"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showSkillForm && (
        <div className="md-dialog-scrim fixed inset-0 z-50 flex items-center justify-center">
          <div className="md-dialog mx-4 w-full max-w-2xl">
            <div className="border-b md-outline p-4">
              <h3 className="text-lg font-semibold md-text-strong">
                {editingSkillId ? "Edit Skill" : "Add Skill"}
              </h3>
              <p className="mt-1 text-sm md-text-muted">
                {editingSkillId
                  ? "Update this skill's instructions."
                  : "Create a reusable project or user skill."}
              </p>
            </div>
            <div className="space-y-4 p-4">
              <div>
                <label className="mb-1 block text-sm font-medium md-text-secondary">Scope</label>
                <select
                  value={skillScopeDraft}
                  onChange={(e) => setSkillScopeDraft(e.target.value as SkillScope)}
                  className="md-select"
                  disabled={editingSkillId !== null}
                >
                  <option value="project">Project</option>
                  <option value="user">User</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium md-text-secondary">Name</label>
                <input
                  type="text"
                  value={skillNameDraft}
                  onChange={(e) => setSkillNameDraft(e.target.value)}
                  className="md-field"
                  placeholder="e.g. release-engineer"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium md-text-secondary">Skill Content (SKILL.md)</label>
                <textarea
                  value={skillBodyDraft}
                  onChange={(e) => setSkillBodyDraft(e.target.value)}
                  rows={14}
                  className="md-field font-mono"
                  placeholder="# Skill name&#10;&#10;Write the skill instructions here."
                />
              </div>
              <div className="space-y-1 rounded-lg border md-outline p-3 text-xs md-text-muted">
                {skillRelativePathDraft && (
                  <p>
                    Path: <span className="font-mono md-text-secondary">{skillRelativePathDraft}/SKILL.md</span>
                  </p>
                )}
                <p>
                  Command preview:{" "}
                  <span className="font-mono md-text-secondary">
                    /
                    {skillScopeDraft}
                    :
                    {skillRelativePathDraft || sanitizeSkillDirName(skillNameDraft.trim() || "skill")}
                  </span>
                </p>
                {skillScopeDraft === "project" && projectSkillsRoot && (
                  <p>
                    Project root: <span className="font-mono md-text-secondary">{projectSkillsRoot}</span>
                  </p>
                )}
                {skillScopeDraft === "user" && userSkillsRoot && (
                  <p>
                    User root: <span className="font-mono md-text-secondary">{userSkillsRoot}</span>
                  </p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t md-outline p-4">
              <button
                onClick={() => {
                  setShowSkillForm(false);
                  setEditingSkillId(null);
                }}
                className="md-btn"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  void saveSkillDraft();
                }}
                disabled={!skillNameDraft.trim() || !skillBodyDraft.trim()}
                className="md-btn md-btn-tonal disabled:opacity-50"
              >
                {editingSkillId ? "Save Skill" : "Add Skill"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showThemeForm && (
        <div className="md-dialog-scrim fixed inset-0 z-50 flex items-center justify-center">
          <div className="md-dialog mx-4 w-full max-w-2xl">
            <div className="border-b md-outline p-4">
              <h3 className="text-lg font-semibold md-text-strong">
                {editingThemeId ? "Edit Theme" : "Create Theme"}
              </h3>
              <p className="mt-1 text-sm md-text-muted">
                Configure palette colors and save as a reusable custom theme.
              </p>
            </div>

            <div className="space-y-4 p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium md-text-secondary">Theme name</label>
                  <input
                    type="text"
                    value={themeDraft.label}
                    onChange={(event) => setThemeDraft((prev) => ({ ...prev, label: event.target.value }))}
                    className="md-field"
                    placeholder="e.g. Solarized Dark"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium md-text-secondary">Description</label>
                  <input
                    type="text"
                    value={themeDraft.description}
                    onChange={(event) => setThemeDraft((prev) => ({ ...prev, description: event.target.value }))}
                    className="md-field"
                    placeholder="Short note shown in theme picker"
                  />
                </div>
              </div>

              <div className="rounded-lg border md-outline p-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide md-text-muted">Root Colors</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="flex items-center gap-2 text-xs md-text-muted">
                    <span className="w-28">Root text</span>
                    <input
                      type="color"
                      value={themeDraft.rootText}
                      onChange={(event) => setThemeDraft((prev) => ({ ...prev, rootText: event.target.value }))}
                      className="h-8 w-10 rounded border md-outline bg-transparent p-0"
                    />
                    <input
                      type="text"
                      value={themeDraft.rootText}
                      onChange={(event) => setThemeDraft((prev) => ({ ...prev, rootText: event.target.value }))}
                      className="md-field !min-h-0 h-8 font-mono text-xs"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-xs md-text-muted">
                    <span className="w-28">Root background</span>
                    <input
                      type="color"
                      value={themeDraft.rootBackground}
                      onChange={(event) =>
                        setThemeDraft((prev) => ({ ...prev, rootBackground: event.target.value }))
                      }
                      className="h-8 w-10 rounded border md-outline bg-transparent p-0"
                    />
                    <input
                      type="text"
                      value={themeDraft.rootBackground}
                      onChange={(event) =>
                        setThemeDraft((prev) => ({ ...prev, rootBackground: event.target.value }))
                      }
                      className="md-field !min-h-0 h-8 font-mono text-xs"
                    />
                  </label>
                </div>
              </div>

              <div className="rounded-lg border md-outline p-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide md-text-muted">Material Tokens</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {THEME_COLOR_FIELDS.map((field) => (
                    <label key={field.key} className="flex items-center gap-2 text-xs md-text-muted">
                      <span className="w-36 truncate">{field.label}</span>
                      <input
                        type="color"
                        value={themeDraft.colors[field.key]}
                        onChange={(event) => updateThemeDraftColor(field.key, event.target.value)}
                        className="h-8 w-10 rounded border md-outline bg-transparent p-0"
                      />
                      <input
                        type="text"
                        value={themeDraft.colors[field.key]}
                        onChange={(event) => updateThemeDraftColor(field.key, event.target.value)}
                        className="md-field !min-h-0 h-8 font-mono text-xs"
                      />
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t md-outline p-4">
              <button onClick={closeThemeForm} className="md-btn">
                Cancel
              </button>
              <button onClick={saveThemeDraft} className="md-btn md-btn-tonal">
                {editingThemeId ? "Save Theme" : "Create Theme"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Keyboard Shortcuts Dialog (Conductor pattern: Cmd+/) */}
      {showGroupSettings && (
        <div className="md-dialog-scrim fixed inset-0 z-50 flex items-center justify-center">
          <div className="md-dialog mx-4 w-full max-w-md">
            <div className="border-b md-outline p-4">
              <h3 className="text-lg font-semibold md-text-strong">Workspace Groups</h3>
              <p className="mt-1 text-sm md-text-muted">
                Customize sidebar columns. Drag workspaces between groups to change their status.
              </p>
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-4 space-y-3">
              {workspaceGroupConfig.map((group, idx) => (
                <div key={group.id} className="rounded border md-outline p-3 space-y-2">
                  <input
                    type="text"
                    className="md-field w-full text-sm"
                    value={group.label}
                    placeholder="Group name"
                    onChange={(e) => {
                      const updated = [...workspaceGroupConfig];
                      updated[idx] = { ...group, label: e.target.value };
                      setWorkspaceGroupConfig(updated);
                    }}
                  />
                  <div className="flex items-center gap-2">
                    <label className="text-[11px] md-text-muted">Status</label>
                    <select
                      className="md-select !min-h-0 h-7 flex-1 py-0 pl-2 pr-6 text-[11px]"
                      value={group.statuses[0] || ""}
                      onChange={(e) => {
                        const updated = [...workspaceGroupConfig];
                        updated[idx] = {
                          ...group,
                          statuses: e.target.value ? [e.target.value as Workspace["status"]] : [],
                        };
                        setWorkspaceGroupConfig(updated);
                      }}
                    >
                      {(() => {
                        const usedStatuses = new Set(
                          workspaceGroupConfig
                            .filter((_, i) => i !== idx)
                            .flatMap((g) => g.statuses),
                        );
                        return (
                          <>
                            <option value="">None</option>
                            <option value="idle" disabled={usedStatuses.has("idle")}>
                              Idle{usedStatuses.has("idle") ? " (used)" : ""}
                            </option>
                            <option value="running" disabled={usedStatuses.has("running")}>
                              Running{usedStatuses.has("running") ? " (used)" : ""}
                            </option>
                            <option value="inReview" disabled={usedStatuses.has("inReview")}>
                              In Review{usedStatuses.has("inReview") ? " (used)" : ""}
                            </option>
                            <option value="merged" disabled={usedStatuses.has("merged")}>
                              Merged{usedStatuses.has("merged") ? " (used)" : ""}
                            </option>
                          </>
                        );
                      })()}
                    </select>
                    <button
                      type="button"
                      onClick={() => {
                        if (workspaceGroupConfig.length <= 1) return;
                        setWorkspaceGroupConfig((prev) => prev.filter((_, i) => i !== idx));
                      }}
                      className="md-icon-plain md-icon-plain-danger !h-7 !w-7"
                      title="Remove group"
                      disabled={workspaceGroupConfig.length <= 1}
                    >
                      <span className="material-symbols-rounded !text-[16px]">close</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between border-t md-outline p-4">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const id = `custom-${Date.now()}`;
                    setWorkspaceGroupConfig((prev) => [...prev, { id, label: "New group", statuses: [] }]);
                  }}
                  className="md-btn md-btn-tonal text-sm"
                >
                  Add group
                </button>
                <button
                  type="button"
                  onClick={() => setWorkspaceGroupConfig(DEFAULT_WORKSPACE_GROUPS)}
                  className="md-btn text-sm"
                >
                  Reset defaults
                </button>
              </div>
              <button onClick={() => setShowGroupSettings(false)} className="md-btn md-btn-tonal">
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {showKeyboardShortcuts && (
        <div className="md-dialog-scrim fixed inset-0 z-50 flex items-center justify-center">
          <div className="md-dialog mx-4 w-full max-w-md">
            <div className="border-b md-outline p-4">
              <h3 className="text-lg font-semibold md-text-strong">Keyboard Shortcuts</h3>
              <p className="mt-1 text-sm md-text-muted">
                Quick actions to boost your productivity
              </p>
            </div>

            <div className="p-4 space-y-3">
              <div className="flex items-center justify-between py-2 border-b md-outline">
                <span className="md-text-secondary">Toggle left sidebar</span>
                <kbd className="px-2 py-1 rounded md-surface text-xs font-mono">⌘[</kbd>
              </div>
              <div className="flex items-center justify-between py-2 border-b md-outline">
                <span className="md-text-secondary">Toggle right sidebar</span>
                <kbd className="px-2 py-1 rounded md-surface text-xs font-mono">⌘]</kbd>
              </div>
              <div className="flex items-center justify-between py-2 border-b md-outline">
                <span className="md-text-secondary">Show shortcuts</span>
                <kbd className="px-2 py-1 rounded md-surface text-xs font-mono">⌘/</kbd>
              </div>
              <div className="flex items-center justify-between py-2 border-b md-outline">
                <span className="md-text-secondary">Close dialog</span>
                <kbd className="px-2 py-1 rounded md-surface text-xs font-mono">Esc</kbd>
              </div>
            </div>

            <div className="flex justify-end border-t md-outline p-4">
              <button onClick={() => setShowKeyboardShortcuts(false)} className="md-btn md-btn-tonal">
                Done
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
