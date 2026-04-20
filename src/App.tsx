import {
  useCallback,
  useState,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
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
  DEFAULT_THEME_ID,
  THEME_STORAGE_KEY,
  type ThemeDefinition,
  type ThemeMap,
  applyTheme,
  getAllThemes,
  getStoredThemeId,
  getThemeOptions,
  isBuiltInTheme,
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
  MODEL_STORAGE_KEY,
  MODEL_BY_WORKSPACE_STORAGE_KEY,
  THINKING_MODE_STORAGE_KEY,
  DEFAULT_REPOSITORY_STORAGE_KEY,
  BEDROCK_ENV_KEY,
  WORKSPACE_GROUPS_STORAGE_KEY,
  WORKSPACE_GROUP_OVERRIDES_STORAGE_KEY,
  DEFAULT_WORKSPACE_GROUPS,
  DEFAULT_SHORTCUTS,
  LEFT_PANEL_OPEN_STORAGE_KEY,
  RIGHT_PANEL_OPEN_STORAGE_KEY,
  SIDEBAR_FONT_SIZE_STORAGE_KEY,
  CHAT_FONT_SIZE_STORAGE_KEY,
  SIDEBAR_FONT_SIZE_DEFAULT,
  CHAT_FONT_SIZE_DEFAULT,
  V2_CHAT_STORAGE_KEY,
  THINKING_MODE_OPTIONS,
  PERMISSION_MODE_OPTIONS,
  PERMISSION_MODE_STORAGE_KEY,
  PERMISSION_MODE_BY_WORKSPACE_STORAGE_KEY,
  CUSTOM_CHECKS_STORAGE_KEY,
  GOD_WORKSPACE_TEMPLATES,
} from "./constants";
import {
  compactActivityLines,
  shortText,
  toWorkspaceRelativePath,
  statusForGroup,
  createThemeDraftFromTheme,
  isTruthyEnvValue,
  upsertEnvOverrideLine,
  loadCustomShortcuts,
  saveCustomShortcuts,
  resolveShortcuts,
  activeKeys,
  shortcutMatchesEvent,
  getStatusColor,
  normalizeUpdateErrorMessage,
  normalizePromptName,
  normalizeSkillCommand,
  formatSkillExecutionPrompt,
  parseEnvOverrides,
  normalizeChangeStatus,
  getChangeStatusClass,
  getDiffLineClass,
} from "./utils";
import type {
  Repository,
  Workspace,
  Agent,
  AgentMessage,
  ServerStatus,
  AppStatus,
  UpdateInfo,
  OrchestratorConfig,
  WorkspaceFileEntry,
  WorkspaceChangeEntry,
  WorkspaceCheckResult,
  WorkspaceCheckDefinition,
  CustomCheck,
  TerminalCommandResult,
  TerminalLine,
  PromptShortcut,
  SkillShortcut,
  SkillCatalogResponse,
  CenterTab,
  EditorKind,
  WorkspaceOpenTarget,
  SkillScope,
  QueuedMessage,
  ThemeDraft,
  ChatRow,
  WorkspaceGroup,
  ShortcutKeys,
  PermissionRequestEvent,
  HtmlArtifact,
} from "./types";
import LinkifiedInlineText from "./components/LinkifiedInlineText";
import MarkdownMessage from "./components/MarkdownMessage";
import QuestionCard from "./components/QuestionCard";
import PermissionCard from "./components/PermissionCard";
import SortableWorkspaceItem from "./components/SortableWorkspaceItem";
import GroupDropZone from "./components/GroupDropZone";
import OrchestrationGraph from "./components/OrchestrationGraph";
import CanvasPanel from "./components/CanvasPanel";
import ThinkingTimer from "./components/ThinkingTimer";
import SettingsModal, { type SettingsTab } from "./components/SettingsModal";
import ToolbarDropdown from "./components/ToolbarDropdown";
import SkillSidebarCard from "./components/SkillSidebarCard";
import FileTree from "./components/FileTree";
import CreateWorkspaceDialog from "./components/dialogs/CreateWorkspaceDialog";
import RenameWorkspaceDialog from "./components/dialogs/RenameWorkspaceDialog";
import PromptShortcutDialog from "./components/dialogs/PromptShortcutDialog";
import SkillDialog from "./components/dialogs/SkillDialog";
import ThemeDialog from "./components/dialogs/ThemeDialog";
import GroupSettingsDialog from "./components/dialogs/GroupSettingsDialog";
import { usePersistedState } from "./hooks/usePersistedState";
import { usePanelResize } from "./hooks/usePanelResize";
import { useTauriListener } from "./hooks/useTauriListener";
import { useAgentEvents } from "./hooks/useAgentEvents";

function App() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [defaultRepoId, setDefaultRepoId] = useState<string | null>(null);
  const [defaultRepoInitialized, setDefaultRepoInitialized] = useState(false);
  const [godWorkspaces, setGodWorkspaces] = useState<Workspace[]>([]);
  const [godChildWorkspaces, setGodChildWorkspaces] = useState<Workspace[]>([]);
  const [selectedGodWorkspace, setSelectedGodWorkspace] = useState<string | null>(null);
  const [showCreateGodWorkspace, setShowCreateGodWorkspace] = useState(false);
  const [createGodFormInitialName, setCreateGodFormInitialName] = useState("");
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createFormInitialName, setCreateFormInitialName] = useState("");
  const [createFormSourceWorkspaceId, setCreateFormSourceWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [availableUpdate, setAvailableUpdate] = useState<UpdateInfo | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [pendingPermissions, setPendingPermissions] = useState<Record<string, PermissionRequestEvent[]>>({});
  const [inputMessageByWorkspace, setInputMessageByWorkspace] = useState<Record<string, string>>({});
  const [activeRightTab, setActiveRightTab] = useState<"prompts" | "files" | "changes" | "checks">("prompts");
  const [workspaceFilesByPath, setWorkspaceFilesByPath] = useState<Record<string, WorkspaceFileEntry[]>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileContentsByPath, setFileContentsByPath] = useState<Record<string, string>>({});
  const [isLoadingFileContent, setIsLoadingFileContent] = useState(false);
  const [editedContentsByPath, setEditedContentsByPath] = useState<Record<string, string>>({});
  const [savingFilePath, setSavingFilePath] = useState<string | null>(null);
  const [diffContentsByTab, setDiffContentsByTab] = useState<Record<string, string>>({});
  const [loadingDiffTabId, setLoadingDiffTabId] = useState<string | null>(null);
  const [centerTabs, setCenterTabs] = useState<CenterTab[]>([{ id: "chat", type: "chat", title: "Chat" }]);
  const [activeCenterTabId, setActiveCenterTabId] = useState("chat");
  const [htmlArtifactsByWorkspace, setHtmlArtifactsByWorkspace] = useState<Record<string, HtmlArtifact[]>>({});
  const [activeArtifactByWorkspace, setActiveArtifactByWorkspace] = useState<Record<string, string>>({});
  const [workspaceChanges, setWorkspaceChanges] = useState<WorkspaceChangeEntry[]>([]);
  const [isLoadingChanges, setIsLoadingChanges] = useState(false);
  const [detectedChecks, setDetectedChecks] = useState<WorkspaceCheckDefinition[]>([]);
  const [isLoadingDetectedChecks, setIsLoadingDetectedChecks] = useState(false);
  const [isRunningChecks, setIsRunningChecks] = useState(false);
  const [customChecks, setCustomChecks] = usePersistedState<CustomCheck[]>(
    CUSTOM_CHECKS_STORAGE_KEY, [], JSON.stringify,
    (raw) => {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item): item is CustomCheck =>
          !!item && typeof item === "object" && typeof item.id === "string" && typeof item.name === "string" && typeof item.command === "string",
      );
    },
  );
  const [detectedChecksExpanded, setDetectedChecksExpanded] = useState(true);
  const [customChecksExpanded, setCustomChecksExpanded] = useState(true);
  const [showAddCheckForm, setShowAddCheckForm] = useState(false);
  const [editingCheckId, setEditingCheckId] = useState<string | null>(null);
  const [newCheckName, setNewCheckName] = useState("");
  const [newCheckCommand, setNewCheckCommand] = useState("");
  const [runningCheckKey, setRunningCheckKey] = useState<string | null>(null);
  const [checkResultByKey, setCheckResultByKey] = useState<Record<string, WorkspaceCheckResult>>({});
  const [promptShortcuts, setPromptShortcuts] = usePersistedState<PromptShortcut[]>(
    PROMPT_SHORTCUTS_STORAGE_KEY, [], JSON.stringify,
    (raw) => {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
        .map((item, index) => ({
          id: typeof item.id === "string" && item.id.trim()
            ? item.id
            : `${Date.now()}-${index}-${Math.floor(Math.random() * 100000)}`,
          name: typeof item.name === "string" ? item.name : "",
          prompt: typeof item.prompt === "string" ? item.prompt : "",
          autoRunOnCreate: item.autoRunOnCreate === true,
        }))
        .filter((item) => item.name.trim() && item.prompt.trim());
    },
  );
  const [editingPromptForDialog, setEditingPromptForDialog] = useState<PromptShortcut | null | undefined>(undefined);
  const [projectSkills, setProjectSkills] = useState<SkillShortcut[]>([]);
  const [userSkills, setUserSkills] = useState<SkillShortcut[]>([]);
  const [projectSkillsRoot, setProjectSkillsRoot] = useState<string | null>(null);
  const [userSkillsRoot, setUserSkillsRoot] = useState<string | null>(null);
  const [isSkillsLoading, setIsSkillsLoading] = useState(false);
  const [promptsExpanded, setPromptsExpanded] = useState(true);
  const [projectSkillsExpanded, setProjectSkillsExpanded] = useState(false);
  const [userSkillsExpanded, setUserSkillsExpanded] = useState(false);
  const [skillDialogState, setSkillDialogState] = useState<{ skill: SkillShortcut | null; scope: SkillScope } | null>(null);
  const [customThemes, setCustomThemes] = useState<ThemeMap>(() => loadCustomThemes());
  const [selectedTheme, setSelectedTheme] = useState<string>(() => {
    const themes = getAllThemes(loadCustomThemes());
    return getStoredThemeId(themes);
  });
  const [themeDialogState, setThemeDialogState] = useState<{ editingId: string | null; draft: ThemeDraft } | null>(null);
  const [envOverridesText, setEnvOverridesText] = usePersistedState(
    ENV_OVERRIDES_STORAGE_KEY, "", (v) => v, (v) => v,
  );
  const [defaultModel, setDefaultModel] = usePersistedState(
    MODEL_STORAGE_KEY, DEFAULT_MODEL_ID, (v) => v,
    (raw) => {
      const normalized = raw.trim();
      return MODEL_OPTIONS.some((o) => o.value === normalized) ? normalized : DEFAULT_MODEL_ID;
    },
  );
  const [selectedModelByWorkspace, setSelectedModelByWorkspace] = usePersistedState<Record<string, string>>(
    MODEL_BY_WORKSPACE_STORAGE_KEY, {},
    (v) => Object.keys(v).length > 0 ? JSON.stringify(v) : null,
  );
  const [thinkingMode, setThinkingMode] = usePersistedState<"off" | "low" | "medium" | "high">(
    THINKING_MODE_STORAGE_KEY, "off", (v) => v,
    (raw) => (raw === "off" || raw === "low" || raw === "medium" || raw === "high") ? raw : "off",
  );
  const [defaultPermissionMode, setDefaultPermissionMode] = usePersistedState<string>(
    PERMISSION_MODE_STORAGE_KEY, "dangerouslySkipPermissions", (v) => v,
    (raw) => {
      const validModes = ["dangerouslySkipPermissions", "bypassPermissions", "auto", "acceptEdits", "default", "dontAsk", "plan"];
      return validModes.includes(raw) ? raw : "dangerouslySkipPermissions";
    },
  );
  const [permissionModeByWorkspace, setPermissionModeByWorkspace] = usePersistedState<Record<string, string>>(
    PERMISSION_MODE_BY_WORKSPACE_STORAGE_KEY, {},
    (v) => Object.keys(v).length > 0 ? JSON.stringify(v) : null,
  );
  const [workspaceGroupConfig, setWorkspaceGroupConfig] = usePersistedState<WorkspaceGroup[]>(
    WORKSPACE_GROUPS_STORAGE_KEY, DEFAULT_WORKSPACE_GROUPS, JSON.stringify,
    (raw) => { const parsed = JSON.parse(raw); return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_WORKSPACE_GROUPS; },
  );
  const [workspaceGroupOverrides, setWorkspaceGroupOverrides] = usePersistedState<Record<string, string>>(
    WORKSPACE_GROUP_OVERRIDES_STORAGE_KEY, {},
    (v) => Object.keys(v).length > 0 ? JSON.stringify(v) : null,
  );
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
  const [renameDialogWorkspace, setRenameDialogWorkspace] = useState<{ id: string; name: string } | null>(null);
  const [shortcutOverrides, setShortcutOverrides] = useState<Record<string, ShortcutKeys>>(() => loadCustomShortcuts());
  const [initialSettingsTab, setInitialSettingsTab] = useState<SettingsTab | undefined>(undefined);
  const [workspaceOpenTarget, setWorkspaceOpenTarget] = useState<WorkspaceOpenTarget>("");
  const {
    leftPanelWidth, rightPanelWidth, terminalHeight, isResizing,
    startResizingLeft, startResizingRight, startResizingTerminal,
  } = usePanelResize();
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
  const autoPromptInFlightRef = useRef<Set<string>>(new Set());
  const queueDrainInFlightRef = useRef<Set<string>>(new Set());
  const [orchestratorConfig, setOrchestratorConfig] = useState<OrchestratorConfig | null>(null);
  const [isRunningScript, setIsRunningScript] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [sidebarFontSize, setSidebarFontSize] = usePersistedState<number>(
    SIDEBAR_FONT_SIZE_STORAGE_KEY, SIDEBAR_FONT_SIZE_DEFAULT, String,
    (raw) => { const n = Number(raw); return Number.isNaN(n) ? SIDEBAR_FONT_SIZE_DEFAULT : n; },
  );
  const [chatFontSize, setChatFontSize] = usePersistedState<number>(
    CHAT_FONT_SIZE_STORAGE_KEY, CHAT_FONT_SIZE_DEFAULT, String,
    (raw) => { const n = Number(raw); return Number.isNaN(n) ? CHAT_FONT_SIZE_DEFAULT : n; },
  );
  const [v2Chat, setV2Chat] = usePersistedState<boolean>(
    V2_CHAT_STORAGE_KEY, true, String, (raw) => raw === "true",
  );
  const startingWorkspaceIdsRef = useRef<Set<string>>(new Set());
  const selectedWorkspaceRef = useRef<string | null>(null);
  const thinkingSinceByWorkspaceRef = useRef<Record<string, number | null>>({});
  const pendingUnreadByWorkspaceRef = useRef<Record<string, boolean>>({});
  const detectedPrUrlByWorkspaceRef = useRef<Record<string, string>>({});
  const sendMessageRef = useRef<(rawMessage?: string, visibleOverride?: string, targetWorkspaceId?: string) => Promise<boolean>>(async () => false);
  const onHtmlArtifactRef = useRef<(artifact: HtmlArtifact) => void>(() => {});
  const [queuedMessagesByWorkspace, setQueuedMessagesByWorkspace] = useState<Record<string, QueuedMessage[]>>({});
  const queuedMessagesByWorkspaceRef = useRef<Record<string, QueuedMessage[]>>({});
  useEffect(() => { queuedMessagesByWorkspaceRef.current = queuedMessagesByWorkspace; }, [queuedMessagesByWorkspace]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const terminalEndRef = useRef<HTMLDivElement>(null);
  const chatTextareaRef = useRef<HTMLTextAreaElement>(null);
  const lastWorkspaceByRepoRef = useRef<Record<string, string>>({});
  const lastChildByGodWorkspaceRef = useRef<Record<string, string>>({});
  const pendingWorkspaceRestoreRef = useRef<string | null>(null);
  const repoSwitchGenRef = useRef(0);
  const godSwitchGenRef = useRef(0);
  const selectedRepoRef = useRef(selectedRepo);
  selectedRepoRef.current = selectedRepo;
  const selectedGodWorkspaceRef = useRef(selectedGodWorkspace);
  selectedGodWorkspaceRef.current = selectedGodWorkspace;
  const terminalInputRef = useRef<HTMLInputElement>(null);
  const bedrockEnabled = useMemo(
    () => isTruthyEnvValue(parseEnvOverrides(envOverridesText)[BEDROCK_ENV_KEY]),
    [envOverridesText],
  );
  const availableThemes = useMemo(() => getAllThemes(customThemes), [customThemes]);
  const themeOptions = useMemo(() => getThemeOptions(availableThemes), [availableThemes]);
  const inputMessage = selectedWorkspace ? (inputMessageByWorkspace[selectedWorkspace] ?? "") : "";
  const selectedModel = selectedWorkspace
    ? (selectedModelByWorkspace[selectedWorkspace] ?? defaultModel)
    : defaultModel;
  const permissionMode = selectedWorkspace
    ? (permissionModeByWorkspace[selectedWorkspace] ?? defaultPermissionMode)
    : defaultPermissionMode;

  const resolvedShortcuts = useMemo(
    () => resolveShortcuts(DEFAULT_SHORTCUTS, shortcutOverrides),
    [shortcutOverrides],
  );

  useEffect(() => {
    selectedWorkspaceRef.current = selectedWorkspace;
  }, [selectedWorkspace]);

  useEffect(() => {
    thinkingSinceByWorkspaceRef.current = thinkingSinceByWorkspace;
  }, [thinkingSinceByWorkspace]);

  useEffect(() => {
    pendingUnreadByWorkspaceRef.current = pendingUnreadByWorkspace;
  }, [pendingUnreadByWorkspace]);

  // Global keyboard shortcuts (Conductor pattern) — uses resolved shortcut config
  useEffect(() => {
    const getKeys = (id: string) => {
      const binding = resolvedShortcuts.find((s) => s.id === id);
      return binding ? activeKeys(binding) : null;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger unmodified shortcuts when typing in inputs
      // Allow Cmd/Ctrl combos and Escape through regardless of focus
      if (
        !e.metaKey && !e.ctrlKey && e.key !== "Escape" &&
        (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
      ) {
        return;
      }

      const toggleLeftKeys = getKeys("toggleLeftSidebar");
      if (toggleLeftKeys && shortcutMatchesEvent(toggleLeftKeys, e)) {
        e.preventDefault();
        setIsLeftPanelOpen(prev => !prev);
        return;
      }

      const toggleRightKeys = getKeys("toggleRightSidebar");
      if (toggleRightKeys && shortcutMatchesEvent(toggleRightKeys, e)) {
        e.preventDefault();
        setIsRightPanelOpen(prev => !prev);
        return;
      }

      const showShortcutsKeys = getKeys("showShortcuts");
      if (showShortcutsKeys && shortcutMatchesEvent(showShortcutsKeys, e)) {
        e.preventDefault();
        setInitialSettingsTab("shortcuts");
        setShowSettingsModal(true);
        return;
      }

      const newWorkspaceKeys = getKeys("newWorkspace");
      if (newWorkspaceKeys && shortcutMatchesEvent(newWorkspaceKeys, e)) {
        e.preventDefault();
        openCreateWorkspaceForm();
        return;
      }

      const closeKeys = getKeys("closeDialog");
      if (closeKeys && shortcutMatchesEvent(closeKeys, e)) {
        if (showSettingsModal) { setShowSettingsModal(false); setInitialSettingsTab(undefined); }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showSettingsModal, resolvedShortcuts]);

  useAgentEvents({
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
    onHtmlArtifactRef,
    persistUnread,
  });

  useEffect(() => {
    onHtmlArtifactRef.current = (artifact: HtmlArtifact) => {
      setHtmlArtifactsByWorkspace((prev) => {
        const existing = prev[artifact.workspaceId] ?? [];
        const deduped = existing.filter((a) => a.id !== artifact.id);
        return {
          ...prev,
          [artifact.workspaceId]: [artifact, ...deduped],
        };
      });
      setActiveArtifactByWorkspace((prev) => ({
        ...prev,
        [artifact.workspaceId]: artifact.id,
      }));
      // Only auto-open the Canvas tab when the artifact's workspace is
      // currently focused. Artifacts in background workspaces queue up
      // silently and surface when the user switches to that workspace.
      if (selectedWorkspaceRef.current === artifact.workspaceId) {
        setCenterTabs((prev) => {
          if (prev.some((tab) => tab.id === "canvas")) return prev;
          return [...prev, { id: "canvas", type: "canvas", title: "Canvas" }];
        });
        setActiveCenterTabId((prev) => (prev === "chat" ? "canvas" : prev));
      }
    };
  }, []);

  // Load persisted HTML artifacts when a workspace is selected, and sync
  // the Canvas tab's existence to whether this workspace has any artifacts.
  // Depending on the raw `htmlArtifactsByWorkspace` map would re-run the
  // effect on every artifact change; a boolean "already loaded" flag limits
  // re-runs to workspace switches.
  const artifactsLoadedForSelected =
    selectedWorkspace !== null && htmlArtifactsByWorkspace[selectedWorkspace] !== undefined;
  const selectedHasArtifacts =
    selectedWorkspace !== null && (htmlArtifactsByWorkspace[selectedWorkspace]?.length ?? 0) > 0;
  useEffect(() => {
    if (!selectedWorkspace) return;
    if (artifactsLoadedForSelected) {
      // Already loaded — just sync the Canvas tab's presence to the current count.
      setCenterTabs((prev) => {
        const hasTab = prev.some((tab) => tab.id === "canvas");
        if (selectedHasArtifacts && !hasTab) {
          return [...prev, { id: "canvas", type: "canvas", title: "Canvas" }];
        }
        if (!selectedHasArtifacts && hasTab) {
          return prev.filter((tab) => tab.id !== "canvas");
        }
        return prev;
      });
      if (!selectedHasArtifacts) {
        setActiveCenterTabId((prev) => (prev === "canvas" ? "chat" : prev));
      }
      return;
    }
    invoke<HtmlArtifact[]>("list_html_artifacts", { workspaceId: selectedWorkspace })
      .then((artifacts) => {
        setHtmlArtifactsByWorkspace((prev) => ({
          ...prev,
          [selectedWorkspace]: artifacts,
        }));
        if (artifacts.length > 0) {
          setActiveArtifactByWorkspace((prev) =>
            prev[selectedWorkspace] ? prev : { ...prev, [selectedWorkspace]: artifacts[0].id }
          );
          setCenterTabs((prev) => {
            if (prev.some((tab) => tab.id === "canvas")) return prev;
            return [...prev, { id: "canvas", type: "canvas", title: "Canvas" }];
          });
        } else {
          // Drop a stale Canvas tab inherited from a previous workspace.
          setCenterTabs((prev) => prev.filter((tab) => tab.id !== "canvas"));
          setActiveCenterTabId((prev) => (prev === "canvas" ? "chat" : prev));
        }
      })
      .catch((err) => {
        console.error("Failed to load HTML artifacts:", err);
      });
  }, [selectedWorkspace, artifactsLoadedForSelected, selectedHasArtifacts]);

  useTauriListener<number>("remote-clients-updated", (count) => {
    setServerStatus((prev) => prev ? { ...prev, connectedClients: count } : prev);
  });

  useTauriListener("open-settings", () => {
    setShowSettingsModal(true);
  });

  useEffect(() => {
    loadInitialState();
    // Silent background check on launch and every hour thereafter.
    void checkForAppUpdate(false, false);
    const updateInterval = setInterval(() => void checkForAppUpdate(false, false), 60 * 60 * 1000);
    void getVersion().then(setAppVersion);
    return () => { clearInterval(updateInterval); };
  }, []);

  useEffect(() => {
    if (selectedRepo) {
      loadWorkspaces(selectedRepo);
    }
  }, [selectedRepo]);

  useEffect(() => {
    void loadSkills(selectedRepo);
  }, [selectedRepo]);

  useTauriListener("skills-changed", () => {
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
    const validWorkspaceIds = new Set([
      ...workspaces.map((workspace) => workspace.id),
      ...godChildWorkspaces.map((workspace) => workspace.id),
      ...godWorkspaces.map((workspace) => workspace.id),
    ]);
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
    // Note: selectedModelByWorkspace is intentionally
    // NOT cleaned up here. These are user preferences keyed by workspace UUID —
    // stale entries are harmless and cleaning them here causes selections to be
    // lost when switching repos (loadWorkspaces replaces the list with only the
    // current repo's workspaces, purging other repo entries).
  }, [workspaces, godChildWorkspaces, godWorkspaces]);

  useEffect(() => {
    const unreadTotal = Object.values(unreadByWorkspace).reduce((sum, count) => sum + count, 0);
    getCurrentWindow()
      .setBadgeCount(unreadTotal > 0 ? unreadTotal : undefined)
      .catch(() => {
        // Ignore unsupported platform badge operations.
      });
  }, [unreadByWorkspace]);

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
        // Use ref to avoid stale closure — if user switched repos during
        // the await above, selectedRepo here would be the old value.
        const currentRepo = selectedRepoRef.current;
        if (currentRepo) await loadWorkspaces(currentRepo);
      } catch {
        // Silently ignore — gh CLI may not be available
      }
    };
    void sync();
    const interval = setInterval(() => void sync(), 60_000);
    return () => clearInterval(interval);
  }, [selectedRepo, workspaces.filter((ws) => ws.status !== "merged").length]);


  // Track whether we're below the lg breakpoint so persistence effects
  // can skip saving responsive closes to localStorage.
  const isBelowLg = useRef(!window.matchMedia("(min-width: 1024px)").matches);

  // Auto-close sidebars when the window shrinks below lg, and restore the
  // user's persisted preference when it grows back above lg.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const handler = (e: MediaQueryListEvent) => {
      if (!e.matches) {
        isBelowLg.current = true;
        setIsLeftPanelOpen(false);
        setIsRightPanelOpen(false);
      } else {
        isBelowLg.current = false;
        // Restore persisted preference
        const left = localStorage.getItem(LEFT_PANEL_OPEN_STORAGE_KEY);
        const right = localStorage.getItem(RIGHT_PANEL_OPEN_STORAGE_KEY);
        setIsLeftPanelOpen(left !== "false");
        setIsRightPanelOpen(right !== "false");
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Panel open state uses a conditional persist guard (isBelowLg) so it
  // cannot use usePersistedState — keep as raw effects.
  useEffect(() => {
    if (!isBelowLg.current) localStorage.setItem(LEFT_PANEL_OPEN_STORAGE_KEY, String(isLeftPanelOpen));
  }, [isLeftPanelOpen]);

  useEffect(() => {
    if (!isBelowLg.current) localStorage.setItem(RIGHT_PANEL_OPEN_STORAGE_KEY, String(isRightPanelOpen));
  }, [isRightPanelOpen]);

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
    saveCustomShortcuts(shortcutOverrides);
  }, [shortcutOverrides]);



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
      setEditedContentsByPath({});
      setDiffContentsByTab({});
      setLoadingDiffTabId(null);
      setCenterTabs([{ id: "chat", type: "chat", title: "Chat" }]);
      setActiveCenterTabId("chat");
      setWorkspaceChanges([]);
      setCheckResultByKey({});
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
    setEditedContentsByPath({});
    setDiffContentsByTab({});
    setLoadingDiffTabId(null);
    const isGodWs = godWorkspaces.some((g) => g.id === selectedWorkspace);
    setCenterTabs(
      isGodWs
        ? [
            { id: "chat", type: "chat" as const, title: "Chat" },
            { id: "graph", type: "graph" as const, title: "Graph" },
          ]
        : [{ id: "chat", type: "chat" as const, title: "Chat" }],
    );
    setActiveCenterTabId("chat");
    setWorkspaceChanges([]);
    setCheckResultByKey({});
    setDetectedChecks([]);
    setTerminalInput("");
    setAttachedFiles([]);
    // Skip backend calls for optimistic workspaces that don't exist in the backend yet.
    // The effect will re-fire when selectedWorkspace changes from tempId to the real ID.
    const ws = workspaces.find((w) => w.id === selectedWorkspace) ?? godChildWorkspaces.find((w) => w.id === selectedWorkspace) ?? godWorkspaces.find((w) => w.id === selectedWorkspace);
    if (!ws || ws.status === "initializing") return;
    loadWorkspaceFiles(selectedWorkspace, "");
  }, [selectedWorkspace]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    const ws = workspaces.find((w) => w.id === selectedWorkspace) ?? godChildWorkspaces.find((w) => w.id === selectedWorkspace) ?? godWorkspaces.find((w) => w.id === selectedWorkspace);
    if (!ws || ws.status === "initializing") return;
    if (activeRightTab === "changes") {
      loadWorkspaceChanges(selectedWorkspace);
    }
  }, [activeRightTab, selectedWorkspace, workspaces, godChildWorkspaces, godWorkspaces]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    const ws = workspaces.find((w) => w.id === selectedWorkspace) ?? godChildWorkspaces.find((w) => w.id === selectedWorkspace) ?? godWorkspaces.find((w) => w.id === selectedWorkspace);
    if (!ws || ws.status === "initializing") return;
    if (activeRightTab === "checks") {
      loadWorkspaceCheckDefinitions(selectedWorkspace);
    }
  }, [activeRightTab, selectedWorkspace, workspaces, godChildWorkspaces, godWorkspaces]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    void ensureAgentForWorkspace(selectedWorkspace);
  }, [selectedWorkspace, workspaces, godChildWorkspaces, godWorkspaces]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    const pending = pendingAutoPromptsByWorkspace[selectedWorkspace] || [];
    if (pending.length === 0) return;

    // Prevent duplicate sends — skip if we're already sending for this workspace
    if (autoPromptInFlightRef.current.has(selectedWorkspace)) return;

    const thinkingSince = thinkingSinceByWorkspace[selectedWorkspace] ?? null;
    if (thinkingSince !== null) return;

    const hasRunningAgent = agents.some(
      (agent) => agent.workspaceId === selectedWorkspace && agent.status === "running",
    );
    if (!hasRunningAgent) return;

    const nextPrompt = pending[0];
    const visibleLabel = `/auto ${nextPrompt.name}`;
    autoPromptInFlightRef.current.add(selectedWorkspace);

    const runAutoPrompt = async () => {
      try {
        const sent = await sendMessage(nextPrompt.prompt, visibleLabel);
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
      } finally {
        autoPromptInFlightRef.current.delete(selectedWorkspace);
      }
    };

    void runAutoPrompt();
  }, [selectedWorkspace, pendingAutoPromptsByWorkspace, thinkingSinceByWorkspace, agents]);

  // Drain the first queued message for any workspace that now has a running agent.
  // This is the reactive counterpart to the event-driven drain in useAgentEvents —
  // it handles the case where an agent was just started and hasn't processed a message
  // yet (so agent-run-state(false) hasn't fired).
  useEffect(() => {
    for (const [wsId, queue] of Object.entries(queuedMessagesByWorkspace)) {
      if (!queue.length) continue;
      if (queueDrainInFlightRef.current.has(wsId)) continue;
      const thinkingSince = thinkingSinceByWorkspace[wsId] ?? null;
      if (thinkingSince !== null) continue;
      const hasRunningAgent = agents.some(
        (agent) => agent.workspaceId === wsId && agent.status === "running",
      );
      if (!hasRunningAgent) continue;

      const [next, ...rest] = queue;
      queueDrainInFlightRef.current.add(wsId);
      setQueuedMessagesByWorkspace((prev) => ({ ...prev, [wsId]: rest }));
      sendMessageRef.current(next.text, next.visible, wsId).finally(() => {
        queueDrainInFlightRef.current.delete(wsId);
      });
    }
  }, [queuedMessagesByWorkspace, thinkingSinceByWorkspace, agents]);

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

      const gws = await invoke<Workspace[]>("list_god_workspaces");
      setGodWorkspaces(gws);
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

  const handleTogglePin = useCallback(async (workspaceId: string) => {
    try {
      const updated = await invoke<Workspace>("toggle_workspace_pinned", { workspaceId });
      const updater = (prev: Workspace[]) => prev.map((w) => (w.id === updated.id ? updated : w));
      setWorkspaces(updater);
      setGodChildWorkspaces(updater);
      setGodWorkspaces(updater);
    } catch (err) {
      console.error("Failed to toggle pin:", err);
    }
  }, []);

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
          const updater = (prev: Workspace[]) => prev.map((w) => (w.id === updated.id ? updated : w));
          setWorkspaces(updater);
          setGodChildWorkspaces(updater);
          setGodWorkspaces(updater);
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
        const reorderUpdater = (prev: Workspace[]) => {
          const updated = new Map(reordered.map((w, idx) => [w.id, idx]));
          return prev.map((w) => (updated.has(w.id) ? { ...w, displayOrder: updated.get(w.id)! } : w));
        };
        setWorkspaces(reorderUpdater);
        setGodChildWorkspaces(reorderUpdater);
        setGodWorkspaces(reorderUpdater);
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
      const updater = (prev: Workspace[]) =>
        prev.map((w) => (w.id === workspaceId ? { ...w, notes: notes || null } : w));
      setWorkspaces(updater);
      setGodChildWorkspaces(updater);
      setGodWorkspaces(updater);
    } catch (err) {
      console.error("Failed to save notes:", err);
    }
  }

  async function loadWorkspaces(repoId: string) {
    const gen = repoSwitchGenRef.current;
    try {
      const ws = await invoke<Workspace[]>("list_workspaces", { repoId });
      // Discard results if user switched repos while we were loading
      if (repoSwitchGenRef.current !== gen) return;
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
      // Restore the remembered workspace after switching repos — set selection
      // atomically (same React batch as setWorkspaces above) so there's no
      // render frame where workspaces are visible but nothing is highlighted.
      if (pendingWorkspaceRestoreRef.current === repoId) {
        pendingWorkspaceRestoreRef.current = null;
        const remembered = lastWorkspaceByRepoRef.current[repoId];
        const target = ws.find((w) => w.id === remembered) || ws[0];
        if (target) {
          setSelectedWorkspace(target.id);
          selectedWorkspaceRef.current = target.id;
          if (selectedRepoRef.current) {
            lastWorkspaceByRepoRef.current[selectedRepoRef.current] = target.id;
          }
          if (window.innerWidth < 1024) setIsLeftPanelOpen(false);
          void ensureAgentRef.current(target.id);
          void loadConfigRef.current(target.id);
        }
      }
    } catch (err) {
      // Discard errors from stale loads too
      if (repoSwitchGenRef.current !== gen) return;
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

  const isGodMode = selectedGodWorkspace !== null;

  // Filter the god-workspace skill out of user skills when not in god mode.
  // The skill contains HTTP API docs and bearer token patterns that are
  // irrelevant (and potentially dangerous) in regular workspace contexts.
  const filteredUserSkills = useMemo(
    () => isGodMode ? userSkills : userSkills.filter((s) => s.relativePath !== "god-workspace"),
    [userSkills, isGodMode],
  );
  const allSkills = useMemo(() => [...projectSkills, ...filteredUserSkills], [projectSkills, filteredUserSkills]);

  function handleSelectRepository(repoId: string) {
    if (repoId === selectedRepo && !isGodMode) return;
    // Exit god mode when selecting a repo
    setSelectedGodWorkspace(null);
    // Save current workspace for the repo we're leaving
    if (selectedRepo && selectedWorkspace) {
      lastWorkspaceByRepoRef.current[selectedRepo] = selectedWorkspace;
    }
    // Invalidate any in-flight loadWorkspaces calls (e.g. PR sync polling)
    repoSwitchGenRef.current += 1;
    setSelectedRepo(repoId);
    setMessages([]);
    // Clear workspaces immediately so the sidebar doesn't flash the old repo's items
    setWorkspaces([]);
    setSelectedWorkspace(null);
    // The useEffect on selectedRepo will call loadWorkspaces, and then
    // pendingWorkspaceRestoreRef will restore the remembered workspace
    pendingWorkspaceRestoreRef.current = repoId;
  }

  function handleSelectGodWorkspace(godWsId: string) {
    if (godWsId === selectedGodWorkspace) return;
    // Save current selection for the god workspace we're leaving — including
    // the god workspace's own ID, which is a valid selection (its chat panel).
    if (selectedGodWorkspace && selectedWorkspace) {
      lastChildByGodWorkspaceRef.current[selectedGodWorkspace] = selectedWorkspace;
    }
    // Save state for normal mode restoration
    if (selectedRepo && selectedWorkspace) {
      lastWorkspaceByRepoRef.current[selectedRepo] = selectedWorkspace;
    }
    setSelectedGodWorkspace(godWsId);
    setSelectedRepo(null);
    // Restore last-selected child, or default to the god workspace itself
    const remembered = lastChildByGodWorkspaceRef.current[godWsId];
    setSelectedWorkspace(remembered || godWsId);
    setMessages([]);
    // Invalidate any in-flight loadGodChildWorkspaces calls from a prior god workspace
    godSwitchGenRef.current += 1;
    setGodChildWorkspaces([]);
    void loadGodChildWorkspaces(godWsId);
  }

  function handleSelectMyWorkspaces() {
    if (!isGodMode) return;
    setSelectedGodWorkspace(null);
    setGodChildWorkspaces([]);
    setMessages([]);
    setSelectedWorkspace(null);
    // Prefer the user's default repo; fall back to the last-selected repo,
    // then to the first available repository.
    const restoreRepo = defaultRepoId || selectedRepoRef.current || (repositories.length > 0 ? repositories[0].id : null);
    if (restoreRepo) {
      handleSelectRepository(restoreRepo);
    }
  }

  async function loadGodChildWorkspaces(godWsId: string) {
    const gen = godSwitchGenRef.current;
    try {
      const children = await invoke<Workspace[]>("list_god_child_workspaces", { godWorkspaceId: godWsId });
      // Discard results if user switched god workspaces while we were loading
      if (godSwitchGenRef.current !== gen) return;
      setGodChildWorkspaces((prev) => {
        // Preserve optimistic entries (status=initializing) not yet in the DB,
        // matching the same pattern used in loadWorkspaces.
        const dbIds = new Set(children.map((w) => w.id));
        const optimistic = prev.filter((w) => w.status === "initializing" && !dbIds.has(w.id));
        return optimistic.length > 0 ? [...children, ...optimistic] : children;
      });
      // Three-Array Rule: also patch child entries that live in workspaces
      const updatedMap = new Map(children.map((w) => [w.id, w]));
      setWorkspaces((prev) => prev.map((w) => updatedMap.get(w.id) ?? w));
    } catch (err) {
      if (godSwitchGenRef.current !== gen) return;
      setError(String(err));
    }
  }

  function openCreateGodWorkspaceForm() {
    setCreateGodFormInitialName(generateWorkspaceName());
    setShowCreateGodWorkspace(true);
  }

  async function handleCreateGodWorkspace(name: string, templateId?: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (!defaultRepoId) {
      setError("Please star a default repository first");
      return;
    }
    try {
      setShowCreateGodWorkspace(false);
      const gw = await invoke<Workspace>("create_god_workspace", { repoId: defaultRepoId, name: trimmed });
      setGodWorkspaces((prev) => [gw, ...prev]);
      // Auto-select and start the agent so the god workspace is immediately usable
      handleSelectGodWorkspace(gw.id);
      const agent = await invoke<Agent>("start_agent", {
        workspaceId: gw.id,
        envOverrides: parseEnvOverrides(envOverridesText),
      });
      setAgents(prev => [...prev, agent]);

      // Queue the selected template as an auto-prompt only after successful agent start
      if (templateId) {
        const template = GOD_WORKSPACE_TEMPLATES.find((t) => t.id === templateId);
        if (template) {
          setPendingAutoPromptsByWorkspace((prev) => ({
            ...prev,
            [gw.id]: [{ id: template.id, name: template.name, prompt: template.prompt }],
          }));
        }
      }
    } catch (err) {
      setError(`God workspace created but agent failed to start: ${String(err)}`);
    }
  }

  async function handleRemoveGodWorkspace(id: string) {
    const gw = godWorkspaces.find((g) => g.id === id);
    if (!window.confirm(`Delete god workspace "${gw?.name ?? id}" and all its child workspaces?`)) return;
    try {
      // Collect child IDs from both arrays (godChildWorkspaces only holds the
      // currently-selected god workspace's children, so also check workspaces
      // which contains children added during this session).
      const childIds = new Set([
        ...godChildWorkspaces.filter((w) => w.parentGodWorkspaceId === id).map((w) => w.id),
        ...workspaces.filter((w) => w.parentGodWorkspaceId === id).map((w) => w.id),
      ]);
      // Include the god workspace itself for agent/timer cleanup
      const allRemovedIds = new Set([...childIds, id]);

      await invoke("remove_god_workspace", { id });

      setGodWorkspaces((prev) => prev.filter((gw) => gw.id !== id));
      setGodChildWorkspaces((prev) => prev.filter((w) => w.parentGodWorkspaceId !== id));
      setWorkspaces((prev) => prev.filter((w) => !allRemovedIds.has(w.id)));
      setAgents((prev) => prev.filter((a) => !allRemovedIds.has(a.workspaceId)));
      setThinkingSinceByWorkspace((prev) => {
        const next = { ...prev };
        for (const wid of allRemovedIds) delete next[wid];
        return next;
      });
      setPendingAutoPromptsByWorkspace((prev) => {
        const next = { ...prev };
        for (const wid of allRemovedIds) delete next[wid];
        return next;
      });
      setSelectedModelByWorkspace((prev) => {
        let changed = false;
        for (const wid of allRemovedIds) { if (wid in prev) { changed = true; break; } }
        if (!changed) return prev;
        const next = { ...prev };
        for (const wid of allRemovedIds) delete next[wid];
        return next;
      });
      setPermissionModeByWorkspace((prev) => {
        let changed = false;
        for (const wid of allRemovedIds) { if (wid in prev) { changed = true; break; } }
        if (!changed) return prev;
        const next = { ...prev };
        for (const wid of allRemovedIds) delete next[wid];
        return next;
      });
      setWorkspaceGroupOverrides((prev) => {
        let changed = false;
        for (const wid of allRemovedIds) { if (wid in prev) { changed = true; break; } }
        if (!changed) return prev;
        const next = { ...prev };
        for (const wid of allRemovedIds) delete next[wid];
        return next;
      });

      if (selectedGodWorkspace === id) {
        handleSelectMyWorkspaces();
      }
    } catch (err) {
      setError(String(err));
    }
  }

  function setDefaultRepository(repoId: string) {
    setDefaultRepoId(repoId);
    handleSelectRepository(repoId);
  }

  async function removeRepository(repoId: string) {
    try {
      // Collect IDs from all three workspace arrays for downstream cleanup
      const removedWorkspaceIds = new Set([
        ...workspaces.filter((w) => w.repoId === repoId).map((w) => w.id),
        ...godChildWorkspaces.filter((w) => w.repoId === repoId).map((w) => w.id),
        ...godWorkspaces.filter((w) => w.repoId === repoId).map((w) => w.id),
      ]);

      await invoke("remove_repository", { repoId });

      const remainingRepos = repositories.filter((repo) => repo.id !== repoId);
      setRepositories(remainingRepos);
      setWorkspaces((prev) => prev.filter((workspace) => workspace.repoId !== repoId));
      setGodChildWorkspaces((prev) => prev.filter((workspace) => workspace.repoId !== repoId));
      setGodWorkspaces((prev) => prev.filter((workspace) => workspace.repoId !== repoId));
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

  async function createWorkspace(inputName: string, sourceWorkspaceId?: string) {
    // In God mode, create a child workspace
    if (isGodMode && selectedGodWorkspace) {
      if (!inputName.trim() || !defaultRepoId) {
        setError("Please star a default repository first");
        return;
      }
      try {
        const workspace = await invoke<Workspace>("create_god_child_workspace", {
          godWorkspaceId: selectedGodWorkspace,
          repoId: defaultRepoId,
          name: inputName.trim(),
        });
        setGodChildWorkspaces((prev) => [...prev, workspace]);
        // Also add to workspaces so event handlers and lookups that only scan
        // workspaces (e.g. agent-run-state, removeWorkspaceImplRef) can find it.
        setWorkspaces((prev) => [...prev, workspace]);
        setSelectedWorkspace(workspace.id);
        if (selectedGodWorkspace) {
          lastChildByGodWorkspaceRef.current[selectedGodWorkspace] = workspace.id;
        }
        void loadConfigRef.current(workspace.id);
        setShowCreateForm(false);
      } catch (err) {
        setError(String(err));
      }
      return;
    }

    if (!inputName.trim() || !selectedRepo) return;

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
    const workspaceName = inputName.trim();
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
    setShowCreateForm(false);
    setSelectedWorkspace(tempId);
    if (window.innerWidth < 1024) setIsLeftPanelOpen(false);

    try {
      // Backend creates actual workspace (git worktree add, etc.)
      const workspace = await invoke<Workspace>("create_workspace", {
        repoId: selectedRepo,
        name: workspaceName,
        sourceWorkspaceId: sourceWorkspaceId ?? null,
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
      setPermissionModeByWorkspace((prev) => {
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

  const removeWorkspaceImplRef = useRef<(workspaceId: string) => Promise<void>>(null!);
  removeWorkspaceImplRef.current = async (workspaceId: string) => {
    try {
      const workspaceAgents = agents.filter(a => a.workspaceId === workspaceId);
      for (const agent of workspaceAgents) {
        await stopAgent(agent.id);
      }

      await invoke("remove_workspace", { workspaceId });
      // Remove from all three workspace arrays (harmless no-op on the "wrong" arrays)
      setWorkspaces(prev => prev.filter(w => w.id !== workspaceId));
      setGodChildWorkspaces(prev => prev.filter(w => w.id !== workspaceId));
      setGodWorkspaces(prev => prev.filter(w => w.id !== workspaceId));
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
      setPermissionModeByWorkspace((prev) => {
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
        const sourceList = isGodMode ? godChildWorkspaces : workspaces;
        const remaining = sourceList.filter(w => w.id !== workspaceId);
        const next = remaining.length > 0 ? remaining[0].id : null;
        setSelectedWorkspace(next);
        if (!next) setMessages([]);
      }
      if (renameDialogWorkspace?.id === workspaceId) {
        setRenameDialogWorkspace(null);
      }
    } catch (err) {
      console.error("Failed to remove workspace:", err);
      setError(String(err));
    }
  };
  const handleRemoveWorkspace = useCallback((workspaceId: string) => {
    void removeWorkspaceImplRef.current(workspaceId);
  }, []);

  const openRenameWorkspaceForm = useCallback((workspace: Workspace) => {
    setRenameDialogWorkspace({ id: workspace.id, name: workspace.name });
  }, []);

  async function handleRenameWorkspace(newName: string) {
    if (!renameDialogWorkspace || !newName.trim()) return;
    try {
      const updated = await invoke<Workspace>("rename_workspace", {
        workspaceId: renameDialogWorkspace.id,
        name: newName.trim(),
      });
      const updater = (prev: Workspace[]) => prev.map((workspace) => (workspace.id === updated.id ? updated : workspace));
      setWorkspaces(updater);
      setGodChildWorkspaces(updater);
      setGodWorkspaces(updater);
      setRenameDialogWorkspace(null);
    } catch (err) {
      console.error("Failed to rename workspace:", err);
      setError(String(err));
    }
  }

  async function startAgent(workspaceId: string) {
    const agent = await invoke<Agent>("start_agent", {
      workspaceId,
      envOverrides: parseEnvOverrides(envOverridesText),
    });
    setAgents(prev => [...prev, agent]);
    const currentRepo = selectedRepoRef.current;
    const currentGodWs = selectedGodWorkspaceRef.current;
    if (currentRepo) {
      await loadWorkspaces(currentRepo);
    } else if (currentGodWs) {
      await loadGodChildWorkspaces(currentGodWs);
    }
  }

  async function ensureAgentForWorkspace(workspaceId: string) {
    const workspace = workspaces.find((w) => w.id === workspaceId) ?? godChildWorkspaces.find((w) => w.id === workspaceId) ?? godWorkspaces.find((w) => w.id === workspaceId);
    if (!workspace || workspace.status === "initializing") return;

    const hasRunningAgent = agents.some(
      (agent) => agent.workspaceId === workspaceId && (agent.status === "running" || agent.status === "starting"),
    );
    if (hasRunningAgent || startingWorkspaceIdsRef.current.has(workspaceId)) return;

    startingWorkspaceIdsRef.current.add(workspaceId);
    setAutoStartingWorkspaceId(workspaceId);
    try {
      await startAgent(workspaceId);
      const queue = queuedMessagesByWorkspaceRef.current[workspaceId];
      if (queue && queue.length > 0) {
        const [next, ...rest] = queue;
        setQueuedMessagesByWorkspace((prev) => {
          const updated = { ...prev, [workspaceId]: rest };
          queuedMessagesByWorkspaceRef.current = updated;
          return updated;
        });
        void sendMessageRef.current(next.text, next.visible, workspaceId);
      }
    } catch (err) {
      setError(String(err));
      setQueuedMessagesByWorkspace((prev) => {
        if (!prev[workspaceId]?.length) return prev;
        const next = { ...prev };
        delete next[workspaceId];
        return next;
      });
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
      const currentRepo = selectedRepoRef.current;
      const currentGodWs = selectedGodWorkspaceRef.current;
      if (currentRepo) {
        await loadWorkspaces(currentRepo);
      } else if (currentGodWs) {
        await loadGodChildWorkspaces(currentGodWs);
      }
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

  async function openSkillsMarketplace(scope: SkillScope) {
    const repoParam =
      scope === "project" && selectedRepo ? `&repoId=${selectedRepo}` : "";
    const url = `index.html?view=marketplace&scope=${scope}${repoParam}`;
    const existing = await WebviewWindow.getByLabel("skills-marketplace");
    if (existing) {
      await existing.setFocus();
      return;
    }
    new WebviewWindow("skills-marketplace", {
      url,
      title: "Skills Marketplace",
      width: 720,
      height: 600,
      resizable: true,
      center: true,
    });
  }

  function openAddSkillForm(scope: SkillScope) {
    setSkillDialogState({ skill: null, scope });
  }

  function openEditSkillForm(skill: SkillShortcut) {
    setSkillDialogState({ skill, scope: skill.scope });
  }

  async function handleSaveSkill(draft: { scope: SkillScope; relativePath: string | null; name: string; content: string }) {
    if (draft.scope === "project" && !selectedRepo) {
      setError("Select a repository before saving a project skill.");
      return;
    }

    try {
      await invoke<SkillShortcut>("save_skill", {
        scope: draft.scope,
        repoId: draft.scope === "project" ? selectedRepo : null,
        relativePath: draft.relativePath,
        name: draft.name,
        content: draft.content,
      });
      setSkillDialogState(null);
      await loadSkills(selectedRepo);
    } catch (err) {
      console.error("Failed to save skill:", err);
      setError(String(err));
    }
  }

  async function deleteSkill(skill: SkillShortcut) {
    if (!window.confirm(`Delete skill "${skill.name}"?`)) return;
    try {
      await invoke("delete_skill", {
        scope: skill.scope,
        repoId: skill.scope === "project" ? selectedRepo : null,
        relativePath: skill.relativePath,
      });
      await loadSkills(selectedRepo);
    } catch (err) {
      console.error("Failed to delete skill:", err);
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
    setThemeDialogState({
      editingId: null,
      draft: {
        ...createThemeDraftFromTheme(baseTheme),
        label: `${baseTheme.label} copy`,
        description: `Custom theme based on ${baseTheme.label}.`,
      },
    });
  }

  function openEditThemeForm() {
    const currentTheme = availableThemes[selectedTheme];
    if (!currentTheme || isBuiltInTheme(currentTheme.id)) {
      return;
    }
    setThemeDialogState({
      editingId: currentTheme.id,
      draft: createThemeDraftFromTheme(currentTheme),
    });
  }

  function handleSaveTheme(theme: ThemeDefinition) {
    setCustomThemes((prev) => ({
      ...prev,
      [theme.id]: theme,
    }));
    setSelectedTheme(theme.id);
    setThemeDialogState(null);
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

  async function handlePermissionResponse(
    wsId: string,
    requestId: string,
    agentId: string,
    allow: boolean,
    denyMessage?: string,
  ) {
    try {
      await invoke("respond_to_permission", { agentId, requestId, allow, denyMessage });
      // Only clear the card on success — if invoke fails the user can retry.
      setPendingPermissions((prev) => {
        const list = prev[wsId];
        if (!list) return prev;
        const next = list.filter((p) => p.requestId !== requestId);
        if (next.length === 0) {
          const result = { ...prev };
          delete result[wsId];
          return result;
        }
        return { ...prev, [wsId]: next };
      });
    } catch (err) {
      console.error("Failed to respond to permission:", err);
      setError(String(err));
    }
  }

  function enqueueMessage(workspaceId: string, text: string, visible: string, clearInput: boolean) {
    const queued: QueuedMessage = {
      id: crypto.randomUUID(),
      text,
      visible,
      queuedAt: Date.now(),
    };
    setQueuedMessagesByWorkspace((prev) => ({
      ...prev,
      [workspaceId]: [...(prev[workspaceId] || []), queued],
    }));
    if (clearInput) {
      setInputMessageByWorkspace((prev) => ({ ...prev, [workspaceId]: "" }));
    }
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
      enqueueMessage(effectiveWorkspaceId, composedInput, visibleOverride ?? composedInput, !rawMessage);
      return true;
    }

    const workspaceAgents = agents.filter(a => a.workspaceId === effectiveWorkspaceId);
    if (workspaceAgents.length === 0) {
      if (!effectiveWorkspaceId) return false;
      enqueueMessage(effectiveWorkspaceId, composedInput, visibleOverride ?? composedInput, !rawMessage);
      void ensureAgentForWorkspace(effectiveWorkspaceId);
      return true;
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

    const workspace = workspaces.find((item) => item.id === effectiveWorkspaceId) ?? godChildWorkspaces.find((item) => item.id === effectiveWorkspaceId) ?? godWorkspaces.find((item) => item.id === effectiveWorkspaceId);
    if (!workspace) {
      setError("Workspace not found");
      return false;
    }

    if (attachedFiles.length > 0) {
      try {
        const results = await Promise.all(
          attachedFiles.map(async (absolutePath) => {
            const content = await invoke<string>("read_file_by_path", {
              filePath: absolutePath,
              maxBytes: 200000,
            });
            const relativePath = toWorkspaceRelativePath(absolutePath, workspace.worktreePath);
            const displayPath = relativePath ?? absolutePath;
            return { displayPath, content };
          })
        );

        const attachmentSections = results.map(
          ({ displayPath, content }) =>
            `<attached_file path="${displayPath}">\n${content}\n</attached_file>`,
        );

        if (attachmentSections.length > 0) {
          messageToSend = `${messageToSend}\n\nUse these attached files as context:\n\n${attachmentSections.join("\n\n")}`;
        }

        const fileSummary = `[Files: ${results.map((r) => r.displayPath).join(", ")}]`;
        visibleMessage = visibleMessage ? `${visibleMessage}\n${fileSummary}` : fileSummary;
      } catch (err) {
        console.error("Failed to prepare attached files:", err);
        setError(String(err));
        return false;
      }
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
        permissionMode,
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

  const handleQuestionAnswer = useCallback((agentId: string, questionTimestamp: string, answer: string) => {
    // Write the answer directly to the running CLI process's stdin instead of
    // going through sendMessage (which would queue it behind the "running" state).
    invoke("answer_agent_question", {
      agentId,
      message: answer,
    }).then(() => {
      // Only mark answered after the invoke succeeds, so the user can retry on failure.
      setAnsweredQuestionTimestamps((prev) => {
        const next = new Set(prev);
        next.add(questionTimestamp);
        return next;
      });
    }).catch((err) => setError(String(err)));
  }, []);

  function generateWorkspaceName() {
    const adjective = NAME_ADJECTIVES[Math.floor(Math.random() * NAME_ADJECTIVES.length)];
    const noun = NAME_NOUNS[Math.floor(Math.random() * NAME_NOUNS.length)];
    const suffix = Math.floor(100 + Math.random() * 900);
    return `${adjective}-${noun}-${suffix}`;
  }

  function openCreateWorkspaceForm(sourceWorkspaceId?: string) {
    setCreateFormInitialName(generateWorkspaceName());
    setCreateFormSourceWorkspaceId(sourceWorkspaceId ?? null);
    setShowCreateForm(true);
  }

  const ensureAgentRef = useRef(ensureAgentForWorkspace);
  ensureAgentRef.current = ensureAgentForWorkspace;

  const loadConfigRef = useRef(loadOrchestratorConfig);
  loadConfigRef.current = loadOrchestratorConfig;

  const handleSelectWorkspace = useCallback((workspaceId: string) => {
    setSelectedWorkspace(workspaceId);
    // Remember this workspace for the current repo/god-workspace so we can restore it later
    if (selectedRepoRef.current) lastWorkspaceByRepoRef.current[selectedRepoRef.current] = workspaceId;
    if (selectedGodWorkspaceRef.current) lastChildByGodWorkspaceRef.current[selectedGodWorkspaceRef.current] = workspaceId;
    // Close the sidebar overlay on mobile; leave it open on desktop
    if (window.innerWidth < 1024) setIsLeftPanelOpen(false);
    void ensureAgentRef.current(workspaceId);
    // Load orchestrator.json config for the workspace
    void loadConfigRef.current(workspaceId);
  }, []);

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
    const workspace = workspaces.find((item) => item.id === selectedWorkspace) ?? godChildWorkspaces.find((item) => item.id === selectedWorkspace) ?? godWorkspaces.find((item) => item.id === selectedWorkspace);
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

      for (const item of pickedFiles) {
        if (typeof item !== "string") continue;
        accepted.push(item);
      }

      if (accepted.length > 0) {
        setAttachedFiles((prev) => Array.from(new Set([...prev, ...accepted])));
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
    setEditingPromptForDialog(null);
  }

  function openEditPromptForm(shortcut: PromptShortcut) {
    setEditingPromptForDialog(shortcut);
  }

  function deletePromptShortcut(promptId: string) {
    setPromptShortcuts((prev) => prev.filter((shortcut) => shortcut.id !== promptId));
  }

  function handleSavePrompt(saved: { id: string; name: string; prompt: string; autoRunOnCreate: boolean }) {
    const isEditing = editingPromptForDialog && editingPromptForDialog.id === saved.id;
    if (isEditing) {
      setPromptShortcuts((prev) =>
        prev.map((shortcut) =>
          shortcut.id === saved.id ? { ...shortcut, ...saved } : shortcut,
        ),
      );
    } else {
      setPromptShortcuts((prev) => [...prev, saved]);
    }
    setEditingPromptForDialog(undefined);
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

  async function saveFile(path: string) {
    if (!selectedWorkspace) return;
    const content = editedContentsByPath[path];
    if (content === undefined) return;
    setSavingFilePath(path);
    try {
      await invoke("write_workspace_file", {
        workspaceId: selectedWorkspace,
        relativePath: path,
        content,
      });
      // Update the cached content to match saved content and clear dirty state
      setFileContentsByPath((prev) => ({ ...prev, [path]: content }));
      setEditedContentsByPath((prev) => {
        const next = { ...prev };
        delete next[path];
        return next;
      });
    } catch (err) {
      console.error("Failed to save file:", err);
      setError(String(err));
    } finally {
      setSavingFilePath(null);
    }
  }

  function closeCenterTab(tabId: string) {
    if (tabId === "chat") return;
    // Warn if there are unsaved edits for a file tab
    if (tabId.startsWith("file:")) {
      const path = tabId.slice(5);
      if (editedContentsByPath[path] !== undefined) {
        if (!window.confirm("You have unsaved changes. Close anyway?")) return;
        setEditedContentsByPath((prev) => {
          const next = { ...prev };
          delete next[path];
          return next;
        });
      }
    }
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
      const newResults: Record<string, WorkspaceCheckResult> = {};
      for (const r of results) {
        newResults[`${r.name}::${r.command}`] = r;
      }
      setCheckResultByKey((prev) => ({ ...prev, ...newResults }));
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

  async function runSingleCheck(checkName: string, checkCommand: string) {
    if (!selectedWorkspace) return;
    const key = `${checkName}::${checkCommand}`;
    setRunningCheckKey(key);
    try {
      const result = await invoke<WorkspaceCheckResult>("run_single_workspace_check", {
        workspaceId: selectedWorkspace,
        checkName,
        checkCommand,
      });
      setCheckResultByKey((prev) => ({ ...prev, [key]: result }));
      appendTerminalLine(selectedWorkspace, "command", `$ ${result.command}`);
      appendTerminalLine(
        selectedWorkspace,
        "meta",
        `${result.success ? "PASS" : "FAIL"} ${result.name} · exit ${result.exitCode ?? "?"} · ${result.durationMs}ms`,
      );
      if (result.stdout.trim()) {
        appendTerminalLine(selectedWorkspace, "stdout", result.stdout.trimEnd());
      }
      if (result.stderr.trim()) {
        appendTerminalLine(selectedWorkspace, "stderr", result.stderr.trimEnd());
      }
    } catch (err) {
      console.error("Failed to run check:", err);
      setError(String(err));
    } finally {
      setRunningCheckKey(null);
    }
  }

  function saveCustomCheck() {
    const name = newCheckName.trim();
    const command = newCheckCommand.trim();
    if (!name || !command) return;
    if (editingCheckId) {
      setCustomChecks((prev) => prev.map((c) => (c.id === editingCheckId ? { ...c, name, command } : c)));
    } else {
      setCustomChecks((prev) => [...prev, { id: `${Date.now()}-${Math.floor(Math.random() * 100000)}`, name, command }]);
    }
    setNewCheckName("");
    setNewCheckCommand("");
    setShowAddCheckForm(false);
    setEditingCheckId(null);
  }

  function deleteCustomCheck(id: string) {
    setCustomChecks((prev) => prev.filter((c) => c.id !== id));
  }

  function openEditCheckForm(check: CustomCheck) {
    setEditingCheckId(check.id);
    setNewCheckName(check.name);
    setNewCheckCommand(check.command);
    setShowAddCheckForm(true);
  }

  function openAddCheckForm() {
    setEditingCheckId(null);
    setNewCheckName("");
    setNewCheckCommand("");
    setShowAddCheckForm(true);
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

  const workspaceGroups = useMemo(
    () => {
      const displayedWorkspaces = isGodMode ? godChildWorkspaces : workspaces;
      const claimed = new Set<string>();
      // Pass 1: assign workspaces with overrides or matching statuses
      const groups = workspaceGroupConfig.map((group) => {
        const items = displayedWorkspaces.filter((ws) => {
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
        return { key: group.id, label: group.label, statuses: group.statuses, items, itemIds: [...items.map((w) => w.id), `group:${group.id}`] };
      });
      // Pass 2: put unclaimed workspaces into the first status-free group (catch-all)
      const unclaimed = displayedWorkspaces.filter((ws) => !claimed.has(ws.id));
      if (unclaimed.length > 0) {
        const catchAll = groups.find((g) => g.statuses.length === 0);
        if (catchAll) {
          catchAll.items = [...catchAll.items, ...unclaimed];
          catchAll.itemIds = [...catchAll.items.map((w) => w.id), `group:${catchAll.key}`];
        }
      }
      return groups;
    },
    [workspaces, godChildWorkspaces, isGodMode, workspaceGroupConfig, workspaceGroupOverrides],
  );

  // Keyboard shortcuts that depend on workspaceGroups (visual order) and repositories
  useEffect(() => {
    const prevBinding = resolvedShortcuts.find((s) => s.id === "prevWorkspace");
    const nextBinding = resolvedShortcuts.find((s) => s.id === "nextWorkspace");
    const prevKeys = prevBinding ? activeKeys(prevBinding) : null;
    const nextKeys = nextBinding ? activeKeys(nextBinding) : null;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Navigate workspaces in sidebar order
      const goingUp = prevKeys && shortcutMatchesEvent(prevKeys, e);
      const goingDown = nextKeys && shortcutMatchesEvent(nextKeys, e);
      if (goingUp || goingDown) {
        e.preventDefault();
        const flat = workspaceGroups.flatMap((g) => g.items);
        if (flat.length === 0) return;
        const idx = flat.findIndex((w) => w.id === selectedWorkspace);
        if (idx === -1) {
          handleSelectWorkspace(flat[0].id);
        } else if (goingUp && idx > 0) {
          handleSelectWorkspace(flat[idx - 1].id);
        } else if (!goingUp && idx < flat.length - 1) {
          handleSelectWorkspace(flat[idx + 1].id);
        }
        setTimeout(() => chatTextareaRef.current?.focus(), 0);
        return;
      }

      // Cmd+1-9: Switch repository by position (readonly, always hardcoded)
      if (e.metaKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const repo = repositories[parseInt(e.key, 10) - 1];
        if (repo) handleSelectRepository(repo.id);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [workspaceGroups, selectedWorkspace, repositories, resolvedShortcuts]);

  const currentRepo = useMemo(() => repositories.find(r => r.id === selectedRepo), [repositories, selectedRepo]);
  // Unified lookup across all workspace arrays — used by effects and handlers
  // that need to find a workspace by ID regardless of whether it's regular, god, or god-child.
  const allWorkspaces = useMemo(() => [...workspaces, ...godChildWorkspaces, ...godWorkspaces], [workspaces, godChildWorkspaces, godWorkspaces]);
  const currentWorkspace = useMemo(() => allWorkspaces.find(w => w.id === selectedWorkspace), [allWorkspaces, selectedWorkspace]);
  const workspaceAgents = useMemo(() => agents.filter(a => a.workspaceId === selectedWorkspace), [agents, selectedWorkspace]);
  const isAutoStartingCurrentWorkspace = autoStartingWorkspaceId === selectedWorkspace;
  const currentThinkingSince = selectedWorkspace
    ? (thinkingSinceByWorkspace[selectedWorkspace] ?? null)
    : null;
  const isThinkingCurrentWorkspace = currentThinkingSince !== null;
  const currentQueuedMessages = useMemo(() => selectedWorkspace ? (queuedMessagesByWorkspace[selectedWorkspace] || []) : [], [selectedWorkspace, queuedMessagesByWorkspace]);
  const activeCenterTab = useMemo(() => centerTabs.find((tab) => tab.id === activeCenterTabId) || centerTabs[0], [centerTabs, activeCenterTabId]);
  const workspaceMessages = useMemo(() => selectedWorkspace ? messages : [], [selectedWorkspace, messages]);
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
              className={v2Chat
                ? "flex w-full items-center gap-2 py-0.5 text-left cursor-pointer group/activity"
                : "flex w-full items-center gap-2 py-1.5 text-left transition hover:bg-white/5"
              }
            >
              {v2Chat && (
                <span className={`h-[5px] w-[5px] flex-none rounded-full ${isLatestRunningActivity ? "animate-pulse bg-amber-300" : "bg-white/20"}`} />
              )}
              <span className={v2Chat
                ? "text-[11.5px] text-white/30 group-hover/activity:text-white/50"
                : "text-xs md-text-faint"
              }>
                Agent activity ({row.group.messages.length} events)
              </span>
              {!v2Chat && isLatestRunningActivity && (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-700/60 bg-amber-950/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
                  running
                </span>
              )}
              {v2Chat ? (
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="ml-auto text-white/20">
                  <path d={expanded ? "M3 6L5 4L7 6" : "M3 4L5 6L7 4"} stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              ) : (
                <span className="material-symbols-rounded ml-auto !text-sm md-text-faint">
                  {expanded ? "expand_more" : "chevron_right"}
                </span>
              )}
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
            onAnswer={(answer) => handleQuestionAnswer(msg.agentId, msg.timestamp, answer)}
          />
        );
      }

      if (isUser) {
        return (
          <div key={row.id} className="flex justify-end">
            <div className={v2Chat
              ? "max-w-[72%] rounded-[18px] rounded-br-[4px] border-[0.5px] md-chat-bubble-user px-3.5 py-2"
              : "max-w-[80%] rounded-2xl rounded-tr-sm bg-sky-900/40 px-4 py-3"
            }>
              <pre className={v2Chat
                ? "select-text overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed md-text-primary"
                : "select-text overflow-x-auto whitespace-pre-wrap text-sm leading-relaxed md-text-strong"
              }>
                {msg.content.replace(/^>\s?/, "")}
              </pre>
            </div>
          </div>
        );
      }

      return (
        <div key={row.id} className={v2Chat ? "rounded-lg border-[0.5px] md-chat-bubble-assistant px-4 py-3.5" : ""}>
          <MarkdownMessage content={msg.content} v2={v2Chat} />
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
    v2Chat,
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
    <div className={`md-surface relative flex h-screen overflow-hidden md-text-strong ${isResizing ? "select-none" : ""}`}>
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

        <div className="flex-1 overflow-y-auto md-px-4 md-py-4" style={{ zoom: sidebarFontSize / 12 }}>
          {/* Mode Switcher: My Workspaces + God Workspaces */}
          <div className="mb-4">
            <div className="space-y-1">
              <div
                className={`md-list-item flex cursor-pointer items-center gap-2 md-px-2 md-py-1.5 ${
                  !isGodMode ? "md-list-item-active" : ""
                }`}
                onClick={handleSelectMyWorkspaces}
                onKeyDown={(e) => e.key === "Enter" && handleSelectMyWorkspaces()}
                role="button"
                tabIndex={0}
              >
                <span className="material-symbols-rounded !text-[16px]">home</span>
                <p className="truncate text-xs md-text-primary">My Workspaces</p>
              </div>
              {godWorkspaces.map((gw) => (
                <div
                  key={gw.id}
                  className={`md-list-item flex cursor-pointer items-center gap-2 md-px-2 md-py-1.5 ${
                    selectedGodWorkspace === gw.id ? "md-list-item-active" : ""
                  }`}
                  onClick={() => handleSelectGodWorkspace(gw.id)}
                  onKeyDown={(e) => e.key === "Enter" && handleSelectGodWorkspace(gw.id)}
                  role="button"
                  tabIndex={0}
                >
                  <span className="material-symbols-rounded !text-[16px]">hub</span>
                  <p className="min-w-0 flex-1 truncate text-xs md-text-primary">{gw.name}</p>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleRemoveGodWorkspace(gw.id);
                    }}
                    className="md-icon-plain md-icon-plain-danger"
                    title="Remove god workspace"
                    aria-label={`Remove ${gw.name}`}
                  >
                    <span className="material-symbols-rounded !text-[16px]">delete</span>
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={openCreateGodWorkspaceForm}
                className="flex w-full items-center gap-2 md-px-2 md-py-1.5 text-xs md-text-muted hover:md-text-primary"
              >
                <span className="material-symbols-rounded !text-[16px]">add</span>
                God Workspace
              </button>
            </div>
          </div>

          {/* Repositories — hidden in God mode */}
          {!isGodMode && (
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
          )}

          {isGodMode && selectedGodWorkspace && (
            <div
              className={`mb-3 flex cursor-pointer items-center gap-2 rounded-lg md-px-2 md-py-1.5 ${
                selectedWorkspace === selectedGodWorkspace ? "md-surface-container-highest" : "hover:md-surface-container-high"
              }`}
              onClick={() => handleSelectWorkspace(selectedGodWorkspace)}
              onKeyDown={(e) => e.key === "Enter" && handleSelectWorkspace(selectedGodWorkspace)}
              role="button"
              tabIndex={0}
            >
              <span className="material-symbols-rounded !text-[16px]">hub</span>
              <span className="min-w-0 flex-1 truncate text-xs font-medium md-text-primary">
                {godWorkspaces.find((gw) => gw.id === selectedGodWorkspace)?.name ?? "Orchestrator"} Chat
              </span>
              {(unreadByWorkspace[selectedGodWorkspace] || 0) > 0 && selectedWorkspace !== selectedGodWorkspace && (
                <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-sky-500 px-1 text-[10px] font-bold text-white">
                  {unreadByWorkspace[selectedGodWorkspace]}
                </span>
              )}
            </div>
          )}

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
                onClick={() => openCreateWorkspaceForm()}
                className="md-icon-plain rounded-full border md-outline disabled:cursor-not-allowed disabled:opacity-45"
                disabled={!selectedRepo && !isGodMode}
                title={selectedRepo || isGodMode ? "Add workspace" : "Select a repository first"}
                aria-label={selectedRepo || isGodMode ? "Add workspace" : "Select a repository first"}
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
                items={group.itemIds}
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
                        repoName={isGodMode ? repositories.find((r) => r.id === workspace.repoId)?.name : undefined}
                        onSelect={handleSelectWorkspace}
                        onTogglePin={handleTogglePin}
                        onRename={openRenameWorkspaceForm}
                        onRemove={handleRemoveWorkspace}
                        onContinueFrom={(id) => openCreateWorkspaceForm(id)}
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
                const displayedWs = isGodMode ? godChildWorkspaces : workspaces;
                const ws = displayedWs.find((w) => w.id === dragActiveId);
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
        onMouseDown={startResizingLeft}
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
              <ToolbarDropdown
                value={workspaceOpenTarget}
                options={[
                  { value: "vscode", label: "VS Code" },
                  { value: "intellij", label: "IntelliJ" },
                  { value: "terminal", label: "Terminal" },
                ]}
                onChange={(v) => {
                  setWorkspaceOpenTarget("");
                  void openCurrentWorkspaceTarget(v as WorkspaceOpenTarget);
                }}
                icon="open_in_new"
                placeholder="Open"
                direction="down"
                ariaLabel="Open current workspace"
              />
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
                        {tab.type === "file" && tab.path && editedContentsByPath[tab.path] !== undefined && (
                          <span className="ml-1 text-amber-400" title="Unsaved changes">*</span>
                        )}
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

              {activeCenterTab.type === "canvas" && selectedWorkspace ? (
                <div className="flex-1 min-h-0 overflow-hidden">
                  <CanvasPanel
                    artifacts={htmlArtifactsByWorkspace[selectedWorkspace] ?? []}
                    artifact={(htmlArtifactsByWorkspace[selectedWorkspace] ?? []).find(
                      (a) => a.id === activeArtifactByWorkspace[selectedWorkspace],
                    )}
                    onSelectArtifact={(artifactId) =>
                      setActiveArtifactByWorkspace((prev) => ({
                        ...prev,
                        [selectedWorkspace]: artifactId,
                      }))
                    }
                    onDeleteArtifact={async (artifactId) => {
                      try {
                        await invoke("delete_html_artifact", { artifactId });
                      } catch (err) {
                        console.error("Failed to delete HTML artifact:", err);
                        return;
                      }
                      let becameEmpty = false;
                      setHtmlArtifactsByWorkspace((prev) => {
                        const current = prev[selectedWorkspace] ?? [];
                        const remaining = current.filter((a) => a.id !== artifactId);
                        becameEmpty = remaining.length === 0;
                        setActiveArtifactByWorkspace((prevActive) => {
                          if (prevActive[selectedWorkspace] !== artifactId) return prevActive;
                          const next = { ...prevActive };
                          if (remaining.length > 0) {
                            next[selectedWorkspace] = remaining[0].id;
                          } else {
                            delete next[selectedWorkspace];
                          }
                          return next;
                        });
                        return { ...prev, [selectedWorkspace]: remaining };
                      });
                      if (becameEmpty) {
                        setCenterTabs((prev) => prev.filter((tab) => tab.id !== "canvas"));
                        setActiveCenterTabId((prev) => (prev === "canvas" ? "chat" : prev));
                      }
                    }}
                  />
                </div>
              ) : (
              <div className={`flex-1 overflow-y-auto ${v2Chat ? "px-5 py-5" : "md-px-3 md-py-3"}`} style={{ zoom: chatFontSize / 14 }}>
                <div className={v2Chat ? "flex flex-col gap-[18px]" : "space-y-3"}>
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
                    <>
                      {selectedWorkspace && (pendingPermissions[selectedWorkspace] || []).map((req) => (
                        <PermissionCard
                          key={req.requestId}
                          request={req}
                          onAllow={() => void handlePermissionResponse(req.workspaceId, req.requestId, req.agentId, true)}
                          onDeny={() => void handlePermissionResponse(req.workspaceId, req.requestId, req.agentId, false)}
                        />
                      ))}
                      {renderedChatRows}
                    </>
                  ) : activeCenterTab.type === "file" ? (
                    <div className="flex h-full flex-col">
                      <div className="mb-2 flex items-center gap-2">
                        <p className="flex-1 truncate text-xs md-text-muted">{activeCenterTab.path}</p>
                        {activeCenterTab.path && editedContentsByPath[activeCenterTab.path] !== undefined && (
                          <>
                            <span className="text-[10px] font-medium text-amber-400">UNSAVED</span>
                            <button
                              onClick={() => {
                                const p = activeCenterTab.path;
                                if (p) {
                                  setEditedContentsByPath((prev) => {
                                    const next = { ...prev };
                                    delete next[p];
                                    return next;
                                  });
                                }
                              }}
                              className="rounded px-2 py-0.5 text-[10px] md-text-muted transition hover:md-text-primary"
                            >
                              Revert
                            </button>
                            <button
                              onClick={() => activeCenterTab.path && saveFile(activeCenterTab.path)}
                              disabled={savingFilePath === activeCenterTab.path}
                              className="rounded bg-emerald-600 px-2 py-0.5 text-[10px] text-white transition hover:bg-emerald-500 disabled:opacity-50"
                            >
                              {savingFilePath === activeCenterTab.path ? "Saving..." : "Save"}
                            </button>
                          </>
                        )}
                      </div>
                      {isLoadingFileContent && selectedFilePath === activeCenterTab.path ? (
                        <p className="text-xs md-text-muted">Loading file...</p>
                      ) : (
                        <textarea
                          className="flex-1 resize-none overflow-auto whitespace-pre rounded border border-transparent bg-transparent p-2 font-mono text-sm leading-relaxed md-text-primary outline-none focus:md-border"
                          style={{ minHeight: "70vh", tabSize: 2 }}
                          spellCheck={false}
                          value={
                            activeCenterTab.path && editedContentsByPath[activeCenterTab.path] !== undefined
                              ? editedContentsByPath[activeCenterTab.path]
                              : (activeCenterTab.path && fileContentsByPath[activeCenterTab.path]) || ""
                          }
                          onChange={(e) => {
                            const p = activeCenterTab.path;
                            if (!p) return;
                            const original = fileContentsByPath[p] ?? "";
                            // Only mark dirty if content actually differs from the original
                            if (e.target.value === original) {
                              setEditedContentsByPath((prev) => {
                                const next = { ...prev };
                                delete next[p];
                                return next;
                              });
                            } else {
                              setEditedContentsByPath((prev) => ({ ...prev, [p]: e.target.value }));
                            }
                          }}
                          onKeyDown={(e) => {
                            const p = activeCenterTab.path;
                            // Cmd+S / Ctrl+S to save
                            if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                              e.preventDefault();
                              if (p && editedContentsByPath[p] !== undefined) {
                                saveFile(p);
                              }
                            }
                            // Tab key inserts spaces instead of changing focus
                            if (e.key === "Tab") {
                              e.preventDefault();
                              if (!p) return;
                              const target = e.currentTarget;
                              const start = target.selectionStart;
                              const end = target.selectionEnd;
                              const newValue = target.value.substring(0, start) + "  " + target.value.substring(end);
                              setEditedContentsByPath((prev) => ({ ...prev, [p]: newValue }));
                              // Restore cursor position after React re-render
                              requestAnimationFrame(() => {
                                target.selectionStart = target.selectionEnd = start + 2;
                              });
                            }
                          }}
                        />
                      )}
                    </div>
                  ) : activeCenterTab.type === "graph" && selectedGodWorkspace ? (
                    <OrchestrationGraph
                      godWorkspaceId={selectedGodWorkspace}
                      godWorkspaceName={godWorkspaces.find((g) => g.id === selectedGodWorkspace)?.name ?? "Orchestrator"}
                      onSelectWorkspace={handleSelectWorkspace}
                    />
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
                  {activeCenterTab.type === "chat" && isThinkingCurrentWorkspace && currentThinkingSince !== null && (
                    <ThinkingTimer
                      thinkingSince={currentThinkingSince}
                      latestSystemMessage={latestSystemMessage ? shortText(latestSystemMessage.content, 96) : null}
                    />
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
              )}

              {activeCenterTab.type === "chat" && selectedWorkspace && credentialErrorWorkspaces.has(selectedWorkspace) && (
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

              {selectedWorkspace && activeCenterTab.type === "chat" && (
                <div className="border-t md-outline md-surface-container md-px-3 md-py-2">
                    {attachedFiles.length > 0 && (
                      <div className="mb-2 rounded-lg border md-outline bg-black/5 p-2">
                        <div className="mb-1.5 flex items-center justify-between">
                          <span className="flex items-center gap-1 text-[11px] font-medium md-text-secondary">
                            <span className="material-symbols-rounded !text-sm">attach_file</span>
                            {attachedFiles.length} file{attachedFiles.length !== 1 ? "s" : ""} attached
                          </span>
                          <button
                            type="button"
                            className="text-[10px] md-text-muted hover:md-text-secondary transition-colors"
                            onClick={() => setAttachedFiles([])}
                          >
                            Clear all
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {attachedFiles.map((path) => {
                            const fileName = path.split("/").pop() ?? path;
                            const relativePath = currentWorkspace
                              ? toWorkspaceRelativePath(path, currentWorkspace.worktreePath)
                              : null;
                            const isExternal = relativePath === null;
                            const displayPath = relativePath ?? path;
                            return (
                              <span
                                key={path}
                                className="md-chip gap-1.5 pr-1"
                                title={path}
                              >
                                <span className="material-symbols-rounded !text-sm">
                                  {isExternal ? "folder_open" : "description"}
                                </span>
                                <span className="flex flex-col leading-tight">
                                  <span className="text-xs font-medium max-w-[200px] truncate">{fileName}</span>
                                  {displayPath !== fileName && (
                                    <span className="text-[10px] md-text-muted max-w-[200px] truncate">{displayPath}</span>
                                  )}
                                </span>
                                <button
                                  type="button"
                                  className="md-icon-plain !h-4 !w-4 ml-0.5"
                                  onClick={() => removeAttachedFile(path)}
                                  title="Remove attached file"
                                >
                                  <span className="material-symbols-rounded !text-sm">close</span>
                                </button>
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <textarea
                      ref={chatTextareaRef}
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
                    <div className="flex items-center justify-end px-1">
                      <button
                        onClick={() => { setInitialSettingsTab("shortcuts"); setShowSettingsModal(true); }}
                        className="text-[10px] md-text-muted hover:md-text-secondary transition-colors"
                      >
                        ⌘/ for shortcuts
                      </button>
                    </div>

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
                        <ToolbarDropdown
                          value={selectedModel}
                          options={MODEL_OPTIONS}
                          onChange={setWorkspaceModel}
                          icon="auto_awesome"
                          ariaLabel="Model selection"
                        />
                        <ToolbarDropdown
                          value={thinkingMode}
                          options={THINKING_MODE_OPTIONS}
                          onChange={(v) => setThinkingMode(v as "off" | "low" | "medium" | "high")}
                          icon="psychology"
                          ariaLabel="Thinking mode"
                        />
                        <ToolbarDropdown
                          value={permissionMode}
                          options={PERMISSION_MODE_OPTIONS}
                          onChange={(v) => {
                            if (selectedWorkspace) {
                              setPermissionModeByWorkspace((prev) => ({ ...prev, [selectedWorkspace]: v }));
                            } else {
                              setDefaultPermissionMode(v);
                            }
                          }}
                          icon="shield"
                          ariaLabel="Permission mode"
                        />

                        <div className="ml-auto flex items-center gap-1">
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
                  onClick={() => openCreateWorkspaceForm()}
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
        onMouseDown={startResizingRight}
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

        <div className="min-h-0 flex-1 overflow-y-auto md-px-4 md-py-4" style={{ zoom: sidebarFontSize / 12 }}>
          {activeRightTab === "prompts" && (
            <div className="text-sm">
              {/* Prompts section */}
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-1 text-left"
                    onClick={() => setPromptsExpanded((prev) => !prev)}
                    aria-expanded={promptsExpanded}
                  >
                    <span className="material-symbols-rounded !text-[16px] md-text-muted">
                      {promptsExpanded ? "expand_more" : "chevron_right"}
                    </span>
                    <span className="md-label-medium">Prompts ({promptShortcuts.length})</span>
                  </button>
                  <button
                    type="button"
                    onClick={openAddPromptForm}
                    className="md-icon-plain !h-6 !w-6"
                    title="Add prompt shortcut"
                    aria-label="Add prompt shortcut"
                  >
                    <span className="material-symbols-rounded !text-[16px]">add</span>
                  </button>
                </div>
                {promptsExpanded && (
                  <div>
                    {promptShortcuts.length === 0 ? (
                      <p className="py-1 text-xs md-text-muted">No prompt shortcuts yet.</p>
                    ) : (
                      promptShortcuts.map((shortcut) => (
                        <div
                          key={shortcut.id}
                          className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md md-px-2 md-py-1.5 text-left text-xs transition hover:md-surface-subtle"
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
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="material-symbols-rounded !text-base md-text-muted">terminal</span>
                            <span className="truncate md-text-primary">{shortcut.name}</span>
                            {shortcut.autoRunOnCreate && (
                              <span className="md-chip !px-2 !py-0 text-[10px]">Auto</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openEditPromptForm(shortcut);
                              }}
                              className="md-icon-plain !h-6 !w-6"
                              title="Edit prompt"
                              aria-label={`Edit ${shortcut.name}`}
                            >
                              <span className="material-symbols-rounded !text-[14px]">edit</span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                deletePromptShortcut(shortcut.id);
                              }}
                              className="md-icon-plain md-icon-plain-danger !h-6 !w-6"
                              title="Delete prompt"
                              aria-label={`Delete ${shortcut.name}`}
                            >
                              <span className="material-symbols-rounded !text-[14px]">delete</span>
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>

              {/* Project Skills section */}
              <div className="mt-3 border-t md-outline pt-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-1 text-left"
                    onClick={() => setProjectSkillsExpanded((prev) => !prev)}
                    aria-expanded={projectSkillsExpanded}
                  >
                    <span className="material-symbols-rounded !text-[16px] md-text-muted">
                      {projectSkillsExpanded ? "expand_more" : "chevron_right"}
                    </span>
                    <span className="md-label-medium">Project Skills ({projectSkills.length})</span>
                  </button>
                  <div className="flex items-center">
                    <button
                      type="button"
                      onClick={() => openSkillsMarketplace("project")}
                      disabled={!selectedRepo}
                      className="md-icon-plain !h-6 !w-6 disabled:cursor-not-allowed disabled:opacity-40"
                      title="Browse skills marketplace"
                      aria-label="Browse skills marketplace"
                    >
                      <span className="material-symbols-rounded !text-[16px]">storefront</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => openAddSkillForm("project")}
                      disabled={!selectedRepo}
                      className="md-icon-plain !h-6 !w-6 disabled:cursor-not-allowed disabled:opacity-40"
                      title={selectedRepo ? "Add project skill" : "Select a repository to add project skills"}
                      aria-label="Add project skill"
                    >
                      <span className="material-symbols-rounded !text-[16px]">add</span>
                    </button>
                  </div>
                </div>
                {projectSkillsExpanded && (
                  <div>
                    {isSkillsLoading && <p className="py-1 text-xs md-text-muted">Loading project skills...</p>}
                    {!isSkillsLoading && projectSkills.length === 0 && (
                      <p className="py-1 text-xs md-text-muted">No project skills found.</p>
                    )}
                    {!isSkillsLoading &&
                      projectSkills.map((skill) => (
                        <SkillSidebarCard
                          key={skill.id}
                          skill={skill}
                          icon="code_blocks"
                          onRun={(s) => { void runSkillShortcut(s); }}
                          onEdit={openEditSkillForm}
                          onDelete={(s) => { void deleteSkill(s); }}
                        />
                      ))}
                    {projectSkillsRoot && (
                      <p className="mt-1 truncate text-[11px] md-text-muted" title={projectSkillsRoot}>
                        {projectSkillsRoot}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* User Skills section */}
              <div className="mt-3 border-t md-outline pt-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-1 text-left"
                    onClick={() => setUserSkillsExpanded((prev) => !prev)}
                    aria-expanded={userSkillsExpanded}
                  >
                    <span className="material-symbols-rounded !text-[16px] md-text-muted">
                      {userSkillsExpanded ? "expand_more" : "chevron_right"}
                    </span>
                    <span className="md-label-medium">User Skills ({filteredUserSkills.length})</span>
                  </button>
                  <div className="flex items-center">
                    <button
                      type="button"
                      onClick={() => openSkillsMarketplace("user")}
                      className="md-icon-plain !h-6 !w-6"
                      title="Browse skills marketplace"
                      aria-label="Browse skills marketplace"
                    >
                      <span className="material-symbols-rounded !text-[16px]">storefront</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => openAddSkillForm("user")}
                      className="md-icon-plain !h-6 !w-6"
                      title="Add user skill"
                      aria-label="Add user skill"
                    >
                      <span className="material-symbols-rounded !text-[16px]">add</span>
                    </button>
                  </div>
                </div>
                {userSkillsExpanded && (
                  <div>
                    {isSkillsLoading && <p className="py-1 text-xs md-text-muted">Loading user skills...</p>}
                    {!isSkillsLoading && filteredUserSkills.length === 0 && (
                      <p className="py-1 text-xs md-text-muted">No user skills found.</p>
                    )}
                    {!isSkillsLoading &&
                      filteredUserSkills.map((skill) => (
                        <SkillSidebarCard
                          key={skill.id}
                          skill={skill}
                          icon="person"
                          onRun={(s) => { void runSkillShortcut(s); }}
                          onEdit={openEditSkillForm}
                          onDelete={(s) => { void deleteSkill(s); }}
                        />
                      ))}
                    {userSkillsRoot && (
                      <p className="mt-1 truncate text-[11px] md-text-muted" title={userSkillsRoot}>
                        {userSkillsRoot}
                      </p>
                    )}
                  </div>
                )}
              </div>

              <p className="mt-3 text-xs md-text-muted">
                Click to run. Type <code className="text-[11px]">/name</code> in chat.
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
            <div className="text-sm md-text-secondary">
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
                <div className="mt-3">
                  <FileTree
                    filesByPath={workspaceFilesByPath}
                    expandedPaths={expandedPaths}
                    loadingPaths={loadingPaths}
                    activeCenterTabId={activeCenterTabId}
                    onToggleDirectory={toggleDirectory}
                    onOpenFile={openFile}
                  />
                </div>
              )}
            </div>
          )}

          {activeRightTab === "changes" && (
            <div className="text-sm md-text-secondary">
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
                <div className="mt-3 space-y-1 pr-1">
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
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1">
                              <span className="truncate font-medium md-text-strong">{change.path.split("/").pop()}</span>
                              <span className={`w-8 flex-none text-right font-mono text-[11px] ${getChangeStatusClass(change.status)}`}>
                                {normalizeChangeStatus(change.status)}
                              </span>
                            </span>
                            {change.path.includes("/") && (
                              <span className="block truncate text-[11px] md-text-muted">{change.path.substring(0, change.path.lastIndexOf("/"))}</span>
                            )}
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
          )}

          {activeRightTab === "checks" && (
            <div className="text-sm">
              {/* Run All button */}
              <div className="mb-3 flex items-center justify-end">
                <button
                  onClick={runWorkspaceChecks}
                  disabled={!selectedWorkspace || isRunningChecks}
                  className="md-btn md-btn-tonal disabled:opacity-50"
                >
                  {isRunningChecks ? "Running all..." : "Run all"}
                </button>
              </div>

              {/* Detected Checks section */}
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-1 text-left"
                    onClick={() => setDetectedChecksExpanded((prev) => !prev)}
                    aria-expanded={detectedChecksExpanded}
                  >
                    <span className="material-symbols-rounded !text-[16px] md-text-muted">
                      {detectedChecksExpanded ? "expand_more" : "chevron_right"}
                    </span>
                    <span className="md-label-medium">Detected Checks ({detectedChecks.length})</span>
                  </button>
                </div>
                {detectedChecksExpanded && (
                  <div>
                    {isLoadingDetectedChecks && <p className="py-1 text-xs md-text-muted">Detecting checks...</p>}
                    {!isLoadingDetectedChecks && detectedChecks.length === 0 && (
                      <p className="py-1 text-xs md-text-muted">No checks detected for this workspace.</p>
                    )}
                    {!isLoadingDetectedChecks &&
                      detectedChecks.map((check) => {
                        const key = `${check.name}::${check.command}`;
                        const result = checkResultByKey[key];
                        const isRunning = runningCheckKey === key;
                        return (
                          <div key={key}>
                            <div
                              className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md md-px-2 md-py-1.5 text-left text-xs transition hover:md-surface-subtle"
                              onClick={() => {
                                if (!isRunning) void runSingleCheck(check.name, check.command);
                              }}
                              onKeyDown={(e) => {
                                if ((e.key === "Enter" || e.key === " ") && !isRunning) {
                                  e.preventDefault();
                                  void runSingleCheck(check.name, check.command);
                                }
                              }}
                              role="button"
                              tabIndex={0}
                              aria-label={`Run check ${check.name}`}
                              title={check.command}
                            >
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="material-symbols-rounded !text-base md-text-muted">
                                  {isRunning ? "progress_activity" : result ? (result.success ? "check_circle" : "cancel") : "play_circle"}
                                </span>
                                <span className="min-w-0">
                                  <span className={`block truncate ${result ? (result.success ? "text-emerald-300" : "text-rose-300") : "md-text-primary"}`}>
                                    {check.name}
                                  </span>
                                  <span className="block truncate font-mono text-[11px] md-text-muted">{check.command}</span>
                                </span>
                              </div>
                              {result && (
                                <span className="flex-none text-[11px] md-text-muted">{result.durationMs}ms</span>
                              )}
                            </div>
                            {result && (result.stdout || result.stderr) && (
                              <div className="mb-1 ml-7 mr-2">
                                {!!result.stdout && (
                                  <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded px-2 py-1 text-[11px] text-emerald-200 md-surface-subtle">
                                    {result.stdout}
                                  </pre>
                                )}
                                {!!result.stderr && (
                                  <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded px-2 py-1 text-[11px] text-rose-300 md-surface-subtle">
                                    {result.stderr}
                                  </pre>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>

              {/* Custom Checks section */}
              <div className="mt-3 border-t md-outline pt-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-1 text-left"
                    onClick={() => setCustomChecksExpanded((prev) => !prev)}
                    aria-expanded={customChecksExpanded}
                  >
                    <span className="material-symbols-rounded !text-[16px] md-text-muted">
                      {customChecksExpanded ? "expand_more" : "chevron_right"}
                    </span>
                    <span className="md-label-medium">Custom Checks ({customChecks.length})</span>
                  </button>
                  <button
                    type="button"
                    onClick={openAddCheckForm}
                    className="md-icon-plain !h-6 !w-6"
                    title="Add custom check"
                    aria-label="Add custom check"
                  >
                    <span className="material-symbols-rounded !text-[16px]">add</span>
                  </button>
                </div>
                {customChecksExpanded && (
                  <div>
                    {showAddCheckForm && (
                      <div className="mb-2 space-y-2 rounded-md p-2 md-surface-subtle">
                        <input
                          type="text"
                          value={newCheckName}
                          onChange={(e) => setNewCheckName(e.target.value)}
                          placeholder="Check name"
                          className="md-input w-full"
                          autoFocus
                        />
                        <input
                          type="text"
                          value={newCheckCommand}
                          onChange={(e) => setNewCheckCommand(e.target.value)}
                          placeholder="Command (e.g. npm run lint)"
                          className="md-input w-full font-mono"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              saveCustomCheck();
                            }
                          }}
                        />
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            className="md-btn md-btn-text"
                            onClick={() => {
                              setShowAddCheckForm(false);
                              setEditingCheckId(null);
                              setNewCheckName("");
                              setNewCheckCommand("");
                            }}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="md-btn md-btn-tonal"
                            onClick={saveCustomCheck}
                            disabled={!newCheckName.trim() || !newCheckCommand.trim()}
                          >
                            {editingCheckId ? "Save" : "Add"}
                          </button>
                        </div>
                      </div>
                    )}
                    {customChecks.length === 0 && !showAddCheckForm && (
                      <p className="py-1 text-xs md-text-muted">No custom checks yet.</p>
                    )}
                    {customChecks.map((check) => {
                      const key = `${check.name}::${check.command}`;
                      const result = checkResultByKey[key];
                      const isRunning = runningCheckKey === key;
                      return (
                        <div key={check.id}>
                          <div
                            className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md md-px-2 md-py-1.5 text-left text-xs transition hover:md-surface-subtle"
                            onClick={() => {
                              if (!isRunning) void runSingleCheck(check.name, check.command);
                            }}
                            onKeyDown={(e) => {
                              if ((e.key === "Enter" || e.key === " ") && !isRunning) {
                                e.preventDefault();
                                void runSingleCheck(check.name, check.command);
                              }
                            }}
                            role="button"
                            tabIndex={0}
                            aria-label={`Run check ${check.name}`}
                            title={check.command}
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="material-symbols-rounded !text-base md-text-muted">
                                {isRunning ? "progress_activity" : result ? (result.success ? "check_circle" : "cancel") : "play_circle"}
                              </span>
                              <span className="min-w-0">
                                <span className={`block truncate ${result ? (result.success ? "text-emerald-300" : "text-rose-300") : "md-text-primary"}`}>
                                  {check.name}
                                </span>
                                <span className="block truncate font-mono text-[11px] md-text-muted">{check.command}</span>
                              </span>
                            </div>
                            <div className="flex items-center gap-1">
                              {result && (
                                <span className="flex-none text-[11px] md-text-muted">{result.durationMs}ms</span>
                              )}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openEditCheckForm(check);
                                }}
                                className="md-icon-plain !h-6 !w-6"
                                title="Edit check"
                                aria-label={`Edit ${check.name}`}
                              >
                                <span className="material-symbols-rounded !text-[14px]">edit</span>
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteCustomCheck(check.id);
                                }}
                                className="md-icon-plain md-icon-plain-danger !h-6 !w-6"
                                title="Delete check"
                                aria-label={`Delete ${check.name}`}
                              >
                                <span className="material-symbols-rounded !text-[14px]">delete</span>
                              </button>
                            </div>
                          </div>
                          {result && (result.stdout || result.stderr) && (
                            <div className="mb-1 ml-7 mr-2">
                              {!!result.stdout && (
                                <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded px-2 py-1 text-[11px] text-emerald-200 md-surface-subtle">
                                  {result.stdout}
                                </pre>
                              )}
                              {!!result.stderr && (
                                <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded px-2 py-1 text-[11px] text-rose-300 md-surface-subtle">
                                  {result.stderr}
                                </pre>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div
          className="h-1 cursor-row-resize border-t md-outline-strong md-surface-subtle transition hover:bg-amber-400/60"
          onMouseDown={startResizingTerminal}
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
                  <p className="md-text-dim">App updates{appVersion && <span className="ml-1 md-text-muted">v{appVersion}</span>}</p>
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

              {serverStatus?.running && serverStatus.pairingCode && (
                <div className="border-t md-outline pt-3">
                  <p className="md-text-dim">Pairing code</p>
                  <div className="mt-1 flex items-center gap-2">
                    <p className="font-mono text-2xl tracking-[0.3em] text-emerald-300">
                      {serverStatus.pairingCode}
                    </p>
                    <button
                      onClick={async () => {
                        try {
                          const status = await invoke<ServerStatus>("regenerate_pairing_code");
                          setServerStatus(status);
                        } catch { /* ignore */ }
                      }}
                      className="md-icon-plain !h-6 !w-6 rounded-full border md-outline"
                      title="Regenerate code"
                    >
                      <span className="material-symbols-rounded !text-[14px]">refresh</span>
                    </button>
                  </div>
                </div>
              )}

              {serverStatus?.running && (
                <div className="border-t md-outline pt-3">
                  <p className="md-text-dim">Web client URL</p>
                  <p className="mt-1 break-all font-mono text-[11px] text-emerald-300">
                    {serverStatus.webUrl}
                  </p>
                </div>
              )}

              <div className="border-t md-outline pt-3">
                <p className="md-text-dim">WebSocket URL</p>
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
        <CreateWorkspaceDialog
          initialName={createFormInitialName}
          continueFromWorkspaces={workspaces.filter((w) => w.repoId === selectedRepo && !w.isGod && w.status !== "initializing" && w.lastActivity)}
          initialSourceWorkspaceId={createFormSourceWorkspaceId}
          onClose={() => { setShowCreateForm(false); setCreateFormSourceWorkspaceId(null); }}
          onSubmit={(name, sourceWorkspaceId) => { void createWorkspace(name, sourceWorkspaceId); }}
        />
      )}

      {showCreateGodWorkspace && (
        <CreateWorkspaceDialog
          initialName={createGodFormInitialName}
          title="Create God Workspace"
          placeholder="God workspace name"
          templates={GOD_WORKSPACE_TEMPLATES}
          onClose={() => setShowCreateGodWorkspace(false)}
          onSubmit={(name, templateId) => { void handleCreateGodWorkspace(name, templateId); }}
        />
      )}

      {renameDialogWorkspace && (
        <RenameWorkspaceDialog
          initialName={renameDialogWorkspace.name}
          onClose={() => setRenameDialogWorkspace(null)}
          onSubmit={(newName) => { void handleRenameWorkspace(newName); }}
        />
      )}

      {editingPromptForDialog !== undefined && (
        <PromptShortcutDialog
          editingPrompt={editingPromptForDialog}
          existingPrompts={promptShortcuts}
          onClose={() => setEditingPromptForDialog(undefined)}
          onSave={handleSavePrompt}
          onError={setError}
        />
      )}

      {skillDialogState && (
        <SkillDialog
          editingSkill={skillDialogState.skill}
          initialScope={skillDialogState.scope}
          projectSkillsRoot={projectSkillsRoot}
          userSkillsRoot={userSkillsRoot}
          onClose={() => setSkillDialogState(null)}
          onSave={(draft) => { void handleSaveSkill(draft); }}
        />
      )}

      {showSettingsModal && (
        <SettingsModal
          onClose={() => { setShowSettingsModal(false); setInitialSettingsTab(undefined); }}
          selectedTheme={selectedTheme}
          onThemeChange={setSelectedTheme}
          themeOptions={themeOptions}
          availableThemes={availableThemes}
          onCreateTheme={() => { setShowSettingsModal(false); openCreateThemeForm(); }}
          onEditTheme={() => { setShowSettingsModal(false); openEditThemeForm(); }}
          onDeleteTheme={deleteSelectedCustomTheme}
          sidebarFontSize={sidebarFontSize}
          onSidebarFontSizeChange={setSidebarFontSize}
          chatFontSize={chatFontSize}
          onChatFontSizeChange={setChatFontSize}
          defaultModel={defaultModel}
          onDefaultModelChange={setDefaultModel}
          envOverridesText={envOverridesText}
          onEnvOverridesChange={setEnvOverridesText}
          bedrockEnabled={bedrockEnabled}
          onBedrockToggle={setBedrockEnabled}
          v2Chat={v2Chat}
          onV2ChatToggle={setV2Chat}
          shortcuts={resolvedShortcuts}
          onShortcutChange={(id, newKeys) => setShortcutOverrides((prev) => ({ ...prev, [id]: newKeys }))}
          onShortcutReset={(id) => setShortcutOverrides((prev) => { const next = { ...prev }; delete next[id]; return next; })}
          onShortcutResetAll={() => setShortcutOverrides({})}
          initialTab={initialSettingsTab}
        />
      )}

      {themeDialogState && (
        <ThemeDialog
          editingThemeId={themeDialogState.editingId}
          initialDraft={themeDialogState.draft}
          availableThemes={availableThemes}
          onClose={() => setThemeDialogState(null)}
          onSave={handleSaveTheme}
          onError={setError}
        />
      )}

      {showGroupSettings && (
        <GroupSettingsDialog
          groupConfig={workspaceGroupConfig}
          onConfigChange={setWorkspaceGroupConfig}
          onClose={() => setShowGroupSettings(false)}
        />
      )}

    </div>
  );
}

export default App;
