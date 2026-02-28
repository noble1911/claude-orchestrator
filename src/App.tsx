import { useState, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface Repository {
  id: string;
  path: string;
  name: string;
  defaultBranch: string;
  addedAt: string;
}

interface Workspace {
  id: string;
  repoId: string;
  name: string;
  branch: string;
  worktreePath: string;
  status: "idle" | "running" | "error";
  lastActivity?: string;
}

interface Agent {
  id: string;
  workspaceId: string;
  status: "starting" | "running" | "stopped" | "error";
  sessionId?: string;
  claudeSessionId?: string;
}

interface AgentMessage {
  agentId: string;
  workspaceId?: string;
  role?: "user" | "assistant" | "system" | "error" | string;
  content: string;
  isError: boolean;
  timestamp: string;
}

interface ServerStatus {
  running: boolean;
  port: number;
  connectedClients: number;
}

interface AppStatus {
  repositories: Repository[];
  serverStatus: ServerStatus;
}

interface WorkspaceFileEntry {
  name: string;
  path: string;
  isDir: boolean;
}

interface WorkspaceChangeEntry {
  status: string;
  path: string;
  oldPath?: string;
}

interface WorkspaceCheckResult {
  name: string;
  command: string;
  success: boolean;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  skipped: boolean;
}

interface TerminalCommandResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  durationMs: number;
}

interface TerminalLine {
  id: string;
  kind: "command" | "stdout" | "stderr" | "meta";
  text: string;
}

interface PromptShortcut {
  id: string;
  name: string;
  prompt: string;
}

interface CenterTab {
  id: string;
  type: "chat" | "file";
  title: string;
  path?: string;
}

type ClaudeMode = "normal" | "plan";

interface ActivityLine {
  text: string;
  count: number;
}

interface ActivityGroup {
  id: string;
  messages: AgentMessage[];
  lines: ActivityLine[];
}

type ChatRow =
  | { kind: "message"; id: string; message: AgentMessage }
  | { kind: "activity"; id: string; group: ActivityGroup };

function compactActivityLines(messages: AgentMessage[]): ActivityLine[] {
  const lines: ActivityLine[] = [];

  for (const message of messages) {
    const text = message.content.trim();
    if (!text) continue;

    const last = lines[lines.length - 1];
    if (last && last.text === text) {
      last.count += 1;
      continue;
    }

    lines.push({ text, count: 1 });
  }

  return lines;
}

function shortText(value: string, maxLength = 120): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

const NAME_ADJECTIVES = [
  "swift",
  "brisk",
  "neat",
  "solid",
  "lively",
  "calm",
  "bold",
  "quiet",
];

const NAME_NOUNS = [
  "otter",
  "falcon",
  "maple",
  "harbor",
  "comet",
  "forest",
  "breeze",
  "ember",
];

const PROMPT_SHORTCUTS_STORAGE_KEY = "claude_orchestrator_prompt_shortcuts";
const ENV_OVERRIDES_STORAGE_KEY = "claude_orchestrator_env_overrides";
const CLAUDE_MODE_STORAGE_KEY = "claude_orchestrator_mode";

function App() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showPRForm, setShowPRForm] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [inputMessage, setInputMessage] = useState("");
  const [isCreatingPR, setIsCreatingPR] = useState(false);
  const [activeRightTab, setActiveRightTab] = useState<"files" | "changes" | "checks">("files");
  const [workspaceFilesByPath, setWorkspaceFilesByPath] = useState<Record<string, WorkspaceFileEntry[]>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileContentsByPath, setFileContentsByPath] = useState<Record<string, string>>({});
  const [isLoadingFileContent, setIsLoadingFileContent] = useState(false);
  const [centerTabs, setCenterTabs] = useState<CenterTab[]>([{ id: "chat", type: "chat", title: "Chat" }]);
  const [activeCenterTabId, setActiveCenterTabId] = useState("chat");
  const [workspaceChanges, setWorkspaceChanges] = useState<WorkspaceChangeEntry[]>([]);
  const [isLoadingChanges, setIsLoadingChanges] = useState(false);
  const [checkResults, setCheckResults] = useState<WorkspaceCheckResult[]>([]);
  const [isRunningChecks, setIsRunningChecks] = useState(false);
  const [promptShortcuts, setPromptShortcuts] = useState<PromptShortcut[]>([]);
  const [showAddPromptForm, setShowAddPromptForm] = useState(false);
  const [newPromptName, setNewPromptName] = useState("");
  const [newPromptBody, setNewPromptBody] = useState("");
  const [showEnvForm, setShowEnvForm] = useState(false);
  const [envOverridesText, setEnvOverridesText] = useState("");
  const [claudeMode, setClaudeMode] = useState<ClaudeMode>("normal");
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(false);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(false);
  const [autoStartingWorkspaceId, setAutoStartingWorkspaceId] = useState<string | null>(null);
  const [expandedActivityIdsByWorkspace, setExpandedActivityIdsByWorkspace] = useState<Record<string, string[]>>({});
  const [thinkingSinceByWorkspace, setThinkingSinceByWorkspace] = useState<Record<string, number | null>>({});
  const [thinkingElapsedSec, setThinkingElapsedSec] = useState(0);
  const [showRenameForm, setShowRenameForm] = useState(false);
  const [renameWorkspaceName, setRenameWorkspaceName] = useState("");
  const [leftPanelWidth, setLeftPanelWidth] = useState(280);
  const [rightPanelWidth, setRightPanelWidth] = useState(360);
  const [terminalHeight, setTerminalHeight] = useState(180);
  const [isResizingLeft, setIsResizingLeft] = useState(false);
  const [isResizingRight, setIsResizingRight] = useState(false);
  const [isResizingTerminal, setIsResizingTerminal] = useState(false);
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalLinesByWorkspace, setTerminalLinesByWorkspace] = useState<Record<string, TerminalLine[]>>({});
  const [isRunningTerminalCommand, setIsRunningTerminalCommand] = useState(false);
  const [terminalTab, setTerminalTab] = useState<"setup" | "run" | "terminal">("terminal");
  const startingWorkspaceIdsRef = useRef<Set<string>>(new Set());
  const selectedWorkspaceRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const terminalEndRef = useRef<HTMLDivElement>(null);
  const terminalInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    selectedWorkspaceRef.current = selectedWorkspace;
  }, [selectedWorkspace]);

  useEffect(() => {
    loadInitialState();
    
    // Listen for agent messages from backend
    const unlisten = listen<AgentMessage>("agent-message", (event) => {
      const messageWorkspaceId = event.payload.workspaceId ?? selectedWorkspaceRef.current;
      if (messageWorkspaceId && selectedWorkspaceRef.current === messageWorkspaceId) {
        setMessages(prev => [...prev, event.payload]);
      }
      const inferredRole =
        event.payload.role ??
        (event.payload.agentId === "user" || event.payload.content.trimStart().startsWith(">")
          ? "user"
          : "assistant");
      const isTerminalResponse = event.payload.isError || inferredRole === "assistant";
      if (isTerminalResponse) {
        if (messageWorkspaceId) {
          setThinkingSinceByWorkspace((prev) => ({ ...prev, [messageWorkspaceId]: null }));
        }
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
      unlistenClients.then(fn => fn());
    };
  }, []);

  useEffect(() => {
    if (selectedRepo) {
      loadWorkspaces(selectedRepo);
    }
  }, [selectedRepo]);

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
    } else {
      setMessages([]);
    }
  }, [selectedWorkspace]);

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
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [terminalLinesByWorkspace, selectedWorkspace, isRunningTerminalCommand]);

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
      const parsed = JSON.parse(raw) as PromptShortcut[];
      if (Array.isArray(parsed)) {
        setPromptShortcuts(parsed);
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
        setClaudeMode(raw);
      }
    } catch (err) {
      console.error("Failed to load Claude mode:", err);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(CLAUDE_MODE_STORAGE_KEY, claudeMode);
    } catch (err) {
      console.error("Failed to persist Claude mode:", err);
    }
  }, [claudeMode]);

  useEffect(() => {
    if (!selectedWorkspace) {
      setWorkspaceFilesByPath({});
      setExpandedPaths(new Set());
      setLoadingPaths(new Set());
      setSelectedFilePath(null);
      setFileContentsByPath({});
      setCenterTabs([{ id: "chat", type: "chat", title: "Chat" }]);
      setActiveCenterTabId("chat");
      setWorkspaceChanges([]);
      setCheckResults([]);
      setTerminalInput("");
      return;
    }

    setWorkspaceFilesByPath({});
    setExpandedPaths(new Set([""]));
    setLoadingPaths(new Set());
    setSelectedFilePath(null);
    setFileContentsByPath({});
    setCenterTabs([{ id: "chat", type: "chat", title: "Chat" }]);
    setActiveCenterTabId("chat");
    setWorkspaceChanges([]);
    setCheckResults([]);
    setTerminalInput("");
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
    void ensureAgentForWorkspace(selectedWorkspace);
  }, [selectedWorkspace]);

  async function loadInitialState() {
    try {
      const status = await invoke<AppStatus>("get_app_status");
      setRepositories(status.repositories);
      setServerStatus(status.serverStatus);
      
      if (status.repositories.length > 0) {
        setSelectedRepo(status.repositories[0].id);
      }
      
      const ag = await invoke<Agent[]>("list_agents");
      setAgents(ag);
    } catch (err) {
      console.error("Failed to load initial state:", err);
      setError(String(err));
    } finally {
      setIsLoading(false);
    }
  }

  async function loadWorkspaces(repoId: string) {
    try {
      const ws = await invoke<Workspace[]>("list_workspaces", { repoId });
      setWorkspaces(ws);
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
      }
    } catch (err) {
      console.error("Failed to add repository:", err);
      setError(String(err));
    }
  }

  async function createWorkspace() {
    if (!newWorkspaceName.trim() || !selectedRepo) return;
    
    try {
      const workspace = await invoke<Workspace>("create_workspace", { 
        repoId: selectedRepo,
        name: newWorkspaceName.trim() 
      });
      setWorkspaces(prev => [...prev, workspace]);
      setNewWorkspaceName("");
      setShowCreateForm(false);
      setSelectedWorkspace(workspace.id);
    } catch (err) {
      console.error("Failed to create workspace:", err);
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
      if (selectedWorkspace === workspaceId) {
        setSelectedWorkspace(null);
        setMessages([]);
      }
    } catch (err) {
      console.error("Failed to remove workspace:", err);
      setError(String(err));
    }
  }

  function openRenameWorkspaceForm() {
    if (!currentWorkspace) return;
    setRenameWorkspaceName(currentWorkspace.name);
    setShowRenameForm(true);
  }

  async function renameWorkspace() {
    if (!selectedWorkspace || !renameWorkspaceName.trim()) return;
    try {
      const updated = await invoke<Workspace>("rename_workspace", {
        workspaceId: selectedWorkspace,
        name: renameWorkspaceName.trim(),
      });
      setWorkspaces((prev) => prev.map((workspace) => (workspace.id === updated.id ? updated : workspace)));
      setShowRenameForm(false);
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

  function normalizePromptName(value: string) {
    return value.trim().toLowerCase().replace(/\s+/g, " ");
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

  async function sendMessage(rawMessage?: string, visibleOverride?: string): Promise<boolean> {
    const composedInput = (rawMessage ?? inputMessage).trim();
    if (!composedInput) return false;
    const workspaceThinkingSince = selectedWorkspace
      ? (thinkingSinceByWorkspace[selectedWorkspace] ?? null)
      : null;
    if (workspaceThinkingSince !== null) {
      return false;
    }
    
    const workspaceAgents = agents.filter(a => a.workspaceId === selectedWorkspace);
    if (workspaceAgents.length === 0) {
      setError("No active agent in this workspace");
      if (selectedWorkspace) {
        setThinkingSinceByWorkspace((prev) => ({ ...prev, [selectedWorkspace]: null }));
      }
      return false;
    }
    
    const agent = workspaceAgents[0];
    let messageToSend = composedInput;
    let visibleMessage = visibleOverride ?? composedInput;

    if (!rawMessage && composedInput.startsWith("/")) {
      const commandName = normalizePromptName(composedInput.slice(1));
      const matched = promptShortcuts.find((shortcut) => normalizePromptName(shortcut.name) === commandName);
      if (!matched) {
        setError(`Prompt not found: ${commandName}`);
        return false;
      }
      messageToSend = matched.prompt;
      visibleMessage = `/${matched.name}`;
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
      if (selectedWorkspace) {
        setThinkingSinceByWorkspace((prev) => ({ ...prev, [selectedWorkspace]: Date.now() }));
      }
      await invoke("send_message_to_agent", { 
        agentId: agent.id, 
        message: messageToSend,
        envOverrides: parseEnvOverrides(envOverridesText),
        permissionMode: claudeMode === "plan" ? "plan" : "bypassPermissions",
      });
      if (!rawMessage) {
        setInputMessage("");
      }
    } catch (err) {
      console.error("Failed to send message:", err);
      setError(String(err));
      if (selectedWorkspace) {
        setThinkingSinceByWorkspace((prev) => ({ ...prev, [selectedWorkspace]: null }));
      }
      return false;
    }
    return true;
  }

  async function createPullRequest() {
    if (!selectedWorkspace || !prTitle.trim()) return;
    
    setIsCreatingPR(true);
    setError(null);
    
    try {
      const prUrl = await invoke<string>("create_pull_request", {
        workspaceId: selectedWorkspace,
        title: prTitle.trim(),
        body: prBody.trim(),
      });
      
      setShowPRForm(false);
      setPrTitle("");
      setPrBody("");
      
      // Show success message
      setMessages(prev => [...prev, {
        agentId: "system",
        role: "system",
        content: `✅ Pull request created: ${prUrl}`,
        isError: false,
        timestamp: new Date().toISOString(),
      }]);
    } catch (err) {
      console.error("Failed to create PR:", err);
      setError(String(err));
    } finally {
      setIsCreatingPR(false);
    }
  }

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
  }

  function isActivityExpanded(activityId: string): boolean {
    if (!selectedWorkspace) return false;
    return (expandedActivityIdsByWorkspace[selectedWorkspace] || []).includes(activityId);
  }

  function toggleActivityGroup(activityId: string) {
    if (!selectedWorkspace) return;
    setExpandedActivityIdsByWorkspace((prev) => {
      const existing = new Set(prev[selectedWorkspace] || []);
      if (existing.has(activityId)) {
        existing.delete(activityId);
      } else {
        existing.add(activityId);
      }
      return {
        ...prev,
        [selectedWorkspace]: Array.from(existing),
      };
    });
  }

  function openAddPromptForm() {
    setNewPromptName("");
    setNewPromptBody("");
    setShowAddPromptForm(true);
  }

  function addPromptShortcut() {
    const name = newPromptName.trim();
    const prompt = newPromptBody.trim();
    if (!name || !prompt) return;

    const normalized = normalizePromptName(name);
    const hasDuplicate = promptShortcuts.some((shortcut) => normalizePromptName(shortcut.name) === normalized);
    if (hasDuplicate) {
      setError(`Prompt name already exists: ${name}`);
      return;
    }

    setPromptShortcuts((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.floor(Math.random() * 100000)}`,
        name,
        prompt,
      },
    ]);
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

  async function runWorkspaceChecks() {
    if (!selectedWorkspace) return;
    setIsRunningChecks(true);
    try {
      const results = await invoke<WorkspaceCheckResult[]>("run_workspace_checks", {
        workspaceId: selectedWorkspace,
      });
      setCheckResults(results);
    } catch (err) {
      console.error("Failed to run workspace checks:", err);
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
      case "running": return "md-status-running";
      case "starting": return "md-status-starting";
      case "idle": return "md-status-idle";
      case "stopped": return "md-status-stopped";
      case "error": return "md-status-error";
      default: return "md-status-idle";
    }
  };

  const workspaceGroups = [
    {
      key: "done",
      label: "Done",
      items: workspaces.filter((workspace) => workspace.status === "idle"),
    },
    {
      key: "in-review",
      label: "In review",
      items: [] as Workspace[],
    },
    {
      key: "in-progress",
      label: "In progress",
      items: workspaces.filter((workspace) => workspace.status === "running"),
    },
    {
      key: "backlog",
      label: "Backlog",
      items: [] as Workspace[],
    },
    {
      key: "canceled",
      label: "Canceled",
      items: workspaces.filter((workspace) => workspace.status === "error"),
    },
  ];

  const currentRepo = repositories.find(r => r.id === selectedRepo);
  const currentWorkspace = workspaces.find(w => w.id === selectedWorkspace);
  const workspaceAgents = agents.filter(a => a.workspaceId === selectedWorkspace);
  const isAutoStartingCurrentWorkspace = autoStartingWorkspaceId === selectedWorkspace;
  const currentThinkingSince = selectedWorkspace
    ? (thinkingSinceByWorkspace[selectedWorkspace] ?? null)
    : null;
  const isThinkingCurrentWorkspace = currentThinkingSince !== null;
  const activeCenterTab = centerTabs.find((tab) => tab.id === activeCenterTabId) || centerTabs[0];
  const workspaceMessages = selectedWorkspace ? messages : [];
  const latestSystemMessage = [...workspaceMessages]
    .reverse()
    .find((message) => message.role === "system" && !message.isError);
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
        className={`md-surface-container fixed inset-y-0 left-0 z-40 flex w-[280px] flex-col border-r md-outline backdrop-blur transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 ${
          isLeftPanelOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ width: `${leftPanelWidth}px` }}
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
          <div className="mb-4 flex items-center justify-between md-px-1">
            <h2 className="md-title-small">Workspaces</h2>
            <button
              onClick={openCreateWorkspaceForm}
              className="md-btn"
            >
              + New
            </button>
          </div>

          {workspaceGroups.map((group) => (
            <div key={group.key} className="mb-3">
              <div className="mb-1 flex items-center gap-2 md-px-2 md-label-large">
                <span>{group.label}</span>
                <span>{group.items.length}</span>
              </div>
              <div className="space-y-1">
                {group.items.map((workspace) => (
                  <button
                    key={workspace.id}
                    onClick={() => handleSelectWorkspace(workspace.id)}
                    className={`md-list-item w-full md-px-3 md-py-2 text-left ${
                      selectedWorkspace === workspace.id
                        ? "md-list-item-active"
                        : ""
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${getStatusColor(workspace.status)}`} />
                      <span className="truncate md-body-small md-text-primary">{workspace.name}</span>
                    </div>
                    <p className="mt-1 truncate md-body-small md-text-muted">{workspace.branch}</p>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="border-t md-outline md-px-4 md-py-3">
          <button
            onClick={addRepository}
            className="md-btn w-full"
          >
            + Add repository
          </button>
        </div>
      </aside>

      <div
        className="hidden w-1 cursor-col-resize md-resizer transition hover:bg-violet-400/60 lg:block"
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
            <span className="md-label-large">{currentRepo?.name || "No repo"}</span>
            <span className="md-text-faint">/</span>
            <span className="truncate md-title-small">{currentWorkspace?.name || "Select workspace"}</span>
            {currentWorkspace && <span className="truncate md-label-large">{currentWorkspace.branch}</span>}
            {currentWorkspace && (
              <button
                onClick={openRenameWorkspaceForm}
                title="Rename workspace"
                className="md-icon-plain"
                aria-label="Rename workspace"
              >
                <span className="material-symbols-rounded !text-[18px]">edit</span>
              </button>
            )}
            {currentWorkspace && (
              <button
                onClick={() => removeWorkspace(selectedWorkspace!)}
                title="Delete workspace"
                className="md-icon-plain md-icon-plain-danger"
                aria-label="Delete workspace"
              >
                <span className="material-symbols-rounded !text-[18px]">delete</span>
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`md-chip ${
                (serverStatus?.connectedClients || 0) > 0
                  ? "border-emerald-700/60 bg-emerald-950/30 text-emerald-300"
                  : "md-text-dim"
              }`}
              title="Connected remote clients"
            >
              Remote clients: {serverStatus?.connectedClients || 0}
            </span>
            <select
              value={selectedRepo || ""}
              onChange={(e) => {
                setSelectedRepo(e.target.value);
                setSelectedWorkspace(null);
                setMessages([]);
              }}
              className="md-select max-w-[220px]"
            >
              {repositories.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </select>
            {currentWorkspace && (
              <button
                onClick={() => {
                  setPrTitle(`${currentWorkspace.name}`);
                  setPrBody(`## Summary\n\nChanges from workspace: ${currentWorkspace.name}\n\n## Test Plan\n\n- [ ] Manual testing`);
                  setShowPRForm(true);
                }}
                className="md-btn md-btn-tonal whitespace-nowrap"
              >
                <span className="material-symbols-rounded !text-base">merge</span>
                Open PR
              </button>
            )}
            {currentWorkspace && workspaceAgents.length > 0 && (
              <button
                onClick={() => stopAgent(workspaceAgents[0].id)}
                className="md-btn md-btn-danger"
              >
                <span className="material-symbols-rounded !text-base">stop_circle</span>
                Stop
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
                      {tab.type === "file" && (
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

              <div className="flex-1 overflow-y-auto md-px-5 md-py-4">
                <div className="space-y-2">
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
                    chatRows.map((row, rowIdx) => {
                      if (row.kind === "activity") {
                        const isLatestRunningActivity = isThinkingCurrentWorkspace && rowIdx === chatRows.length - 1;
                        const expanded = isActivityExpanded(row.id) || isLatestRunningActivity;
                        return (
                          <div key={row.id} className="overflow-hidden rounded-md border md-outline md-surface-subtle">
                            <button
                              onClick={() => toggleActivityGroup(row.id)}
                              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition hover:bg-white/5"
                            >
                              <span className="inline-flex items-center gap-2">
                                <span className="material-symbols-rounded !text-base md-text-muted">
                                  {expanded ? "expand_more" : "chevron_right"}
                                </span>
                                <span className="text-xs md-text-muted">
                                  Agent activity ({row.group.messages.length} events)
                                </span>
                                {isLatestRunningActivity && (
                                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-700/60 bg-amber-950/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
                                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
                                    running
                                  </span>
                                )}
                              </span>
                            </button>

                            {expanded && (
                              <div className="space-y-1 border-t md-outline px-3 py-2">
                                {row.group.lines.map((line, lineIdx) => (
                                  <div key={`${row.id}-line-${lineIdx}`} className="flex items-start gap-2 text-xs md-text-muted">
                                    <span className="mt-1 h-1.5 w-1.5 flex-none rounded-full bg-white/25" />
                                    <span className="break-all font-mono">{line.text}</span>
                                    {line.count > 1 && (
                                      <span className="md-chip border-white/20 bg-white/5 !px-1.5 !py-0 text-[10px]">
                                        x{line.count}
                                      </span>
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
                        return (
                          <div key={row.id} className="border-l-2 border-rose-700 pl-3">
                            <div className="mb-1 text-[11px] uppercase tracking-wide text-rose-300">Error</div>
                            <pre className="overflow-x-auto whitespace-pre-wrap text-sm text-rose-200">{msg.content}</pre>
                          </div>
                        );
                      }

                      if (isUser) {
                        return (
                          <div key={row.id} className="border-l-2 border-sky-700 pl-3">
                            <div className="mb-1 text-[11px] uppercase tracking-wide text-sky-300">You</div>
                            <pre className="overflow-x-auto whitespace-pre-wrap text-sm md-text-strong">
                              {msg.content.replace(/^>\s?/, "")}
                            </pre>
                          </div>
                        );
                      }

                      return (
                        <div key={row.id} className="border-l-2 md-outline pl-3">
                          <pre className="overflow-x-auto whitespace-pre-wrap text-sm md-text-primary">{msg.content}</pre>
                        </div>
                      );
                    })
                  ) : (
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
                </div>
              </div>

              {workspaceAgents.length > 0 && activeCenterTab.type === "chat" && (
                <div className="border-t md-outline md-surface-container-high md-px-5 md-py-3">
                  <div className="flex gap-2">
                    <textarea
                      value={inputMessage}
                      onChange={(e) => setInputMessage(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void sendMessage();
                        }
                      }}
                      rows={3}
                      placeholder="Ask to make changes... or run shortcut with /prompt name"
                      className="md-field flex-1 resize-none"
                    />
                    <div className="flex flex-col items-end justify-end gap-2">
                      <button
                        onClick={() => setClaudeMode((prev) => (prev === "plan" ? "normal" : "plan"))}
                        className={`md-btn md-icon-btn ${claudeMode === "plan" ? "md-btn-tonal" : ""}`}
                        title={claudeMode === "plan" ? "Plan mode enabled (click for normal mode)" : "Normal mode enabled (click for plan mode)"}
                        aria-label={claudeMode === "plan" ? "Switch to normal mode" : "Switch to plan mode"}
                      >
                        <span className="material-symbols-rounded !text-base">
                          {claudeMode === "plan" ? "schema" : "bolt"}
                        </span>
                      </button>
                      <button
                        onClick={() => {
                          void sendMessage();
                        }}
                        disabled={!inputMessage.trim() || isThinkingCurrentWorkspace}
                        className="md-btn md-btn-tonal disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <span className="material-symbols-rounded !text-base">send</span>
                        Send
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
        className={`md-surface-container fixed inset-y-0 right-0 z-40 flex w-[360px] max-w-[92vw] flex-col transition-transform duration-200 lg:static lg:z-auto lg:max-w-none lg:translate-x-0 ${
          isRightPanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
        style={{ width: `${rightPanelWidth}px` }}
      >
        <div className="flex h-14 items-center border-b md-outline md-px-4">
          <div className="md-segmented text-xs">
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
          <div className="md-card mb-4 p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="md-label-medium">Prompts</p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setShowEnvForm(true)}
                  className="md-btn"
                  title="Edit environment overrides"
                >
                  Env
                </button>
                <button
                  onClick={openAddPromptForm}
                  className="md-btn md-btn-tonal"
                  title="Add prompt shortcut"
                >
                  <span className="material-symbols-rounded !text-base">add</span>
                  Add
                </button>
              </div>
            </div>
            {promptShortcuts.length === 0 ? (
              <p className="text-xs md-text-muted">No prompt shortcuts yet.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {promptShortcuts.map((shortcut) => (
                  <button
                    key={shortcut.id}
                    onClick={() => runPromptShortcut(shortcut)}
                    className="md-btn"
                    title={shortcut.prompt}
                  >
                    {shortcut.name}
                  </button>
                ))}
              </div>
            )}
          </div>

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
            <div className="md-card p-3 text-xs">
              <div className="mb-2 flex items-center justify-between">
                <span className="md-text-secondary">Git status</span>
                <button
                  onClick={() => selectedWorkspace && loadWorkspaceChanges(selectedWorkspace)}
                  className="md-btn"
                >
                  Refresh
                </button>
              </div>

              {isLoadingChanges && <p className="md-text-muted">Loading changes...</p>}
              {!isLoadingChanges && workspaceChanges.length === 0 && (
                <p className="md-text-muted">Working tree is clean.</p>
              )}
              {!isLoadingChanges && workspaceChanges.length > 0 && (
                <div className="space-y-1">
                  {workspaceChanges.map((change) => (
                    <div key={`${change.status}-${change.path}`} className="md-card md-px-2 md-py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="w-10 font-mono text-[11px] text-amber-300">{change.status}</span>
                        <span className="truncate md-text-primary">{change.path}</span>
                      </div>
                      {change.oldPath && (
                        <p className="mt-0.5 truncate pl-12 text-[11px] md-text-muted">from: {change.oldPath}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
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
        <div className="border-t md-outline md-px-4 md-py-3" style={{ height: `${terminalHeight}px` }}>
          <div className="mb-2 flex items-center justify-between text-xs md-text-muted">
            <div className="md-segmented">
              <button
                onClick={() => setTerminalTab("setup")}
                className={`md-segmented-btn ${terminalTab === "setup" ? "md-segmented-btn-active" : ""}`}
              >
                Setup
              </button>
              <button
                onClick={() => setTerminalTab("run")}
                className={`md-segmented-btn ${terminalTab === "run" ? "md-segmented-btn-active" : ""}`}
              >
                Run
              </button>
              <button
                onClick={() => setTerminalTab("terminal")}
                className={`md-segmented-btn ${terminalTab === "terminal" ? "md-segmented-btn-active" : ""}`}
              >
                Terminal
              </button>
            </div>
            <span>{serverStatus?.running ? "Server online" : "Server offline"}</span>
          </div>
          {terminalTab === "setup" && (
            <div className="md-card h-[calc(100%-24px)] overflow-auto p-3 text-xs md-text-secondary">
              <p className="md-text-dim">Workspace</p>
              <p className="mb-3 md-text-strong">{currentWorkspace?.name || "-"}</p>
              <p className="md-text-dim">Path</p>
              <p className="break-all md-text-strong">{currentWorkspace?.worktreePath || "-"}</p>
            </div>
          )}
          {terminalTab === "run" && (
            <div className="md-card h-[calc(100%-24px)] overflow-auto p-3 text-xs">
              <p className="mb-2 md-text-secondary">Quick actions</p>
              <button
                onClick={runWorkspaceChecks}
                disabled={!selectedWorkspace || isRunningChecks}
                className="md-btn md-btn-tonal disabled:opacity-40"
              >
                {isRunningChecks ? "Running checks..." : "Run workspace checks"}
              </button>
            </div>
          )}
          {terminalTab === "terminal" && (
            <div className="h-[calc(100%-24px)]">
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

      {/* PR Creation Modal */}
      {showPRForm && (
        <div className="md-dialog-scrim fixed inset-0 z-50 flex items-center justify-center">
          <div className="md-dialog mx-4 w-full max-w-lg">
            <div className="border-b md-outline p-4">
              <h3 className="text-lg font-semibold md-text-strong">Create Pull Request</h3>
              <p className="mt-1 text-sm md-text-muted">
                This will push the branch and create a PR on GitHub
              </p>
            </div>
            
            <div className="space-y-4 p-4">
              <div>
                <label className="mb-1 block text-sm font-medium md-text-secondary">Title</label>
                <input
                  type="text"
                  value={prTitle}
                  onChange={(e) => setPrTitle(e.target.value)}
                  className="md-field"
                  placeholder="PR title"
                />
              </div>
              
              <div>
                <label className="mb-1 block text-sm font-medium md-text-secondary">Description</label>
                <textarea
                  value={prBody}
                  onChange={(e) => setPrBody(e.target.value)}
                  rows={6}
                  className="md-field font-mono"
                  placeholder="PR description (markdown supported)"
                />
              </div>
            </div>
            
            <div className="flex justify-end gap-2 border-t md-outline p-4">
              <button
                onClick={() => { setShowPRForm(false); setPrTitle(""); setPrBody(""); }}
                className="md-btn"
                disabled={isCreatingPR}
              >
                Cancel
              </button>
              <button
                onClick={createPullRequest}
                disabled={isCreatingPR || !prTitle.trim()}
                className="md-btn md-btn-tonal disabled:opacity-50"
              >
                {isCreatingPR ? "Creating..." : "Create PR"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddPromptForm && (
        <div className="md-dialog-scrim fixed inset-0 z-50 flex items-center justify-center">
          <div className="md-dialog mx-4 w-full max-w-lg">
            <div className="border-b md-outline p-4">
              <h3 className="text-lg font-semibold md-text-strong">Add Prompt Shortcut</h3>
              <p className="mt-1 text-sm md-text-muted">
                Create a reusable prompt button and slash command.
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
            </div>

            <div className="flex justify-end gap-2 border-t md-outline p-4">
              <button
                onClick={() => setShowAddPromptForm(false)}
                className="md-btn"
              >
                Cancel
              </button>
              <button
                onClick={addPromptShortcut}
                disabled={!newPromptName.trim() || !newPromptBody.trim()}
                className="md-btn md-btn-tonal disabled:opacity-50"
              >
                Add Prompt
              </button>
            </div>
          </div>
        </div>
      )}

      {showEnvForm && (
        <div className="md-dialog-scrim fixed inset-0 z-50 flex items-center justify-center">
          <div className="md-dialog mx-4 w-full max-w-xl">
            <div className="border-b md-outline p-4">
              <h3 className="text-lg font-semibold md-text-strong">Environment Overrides</h3>
              <p className="mt-1 text-sm md-text-muted">
                Paste freeform env lines. Supports `export KEY=VALUE` and `KEY=VALUE`.
              </p>
            </div>
            <div className="p-4">
              <textarea
                value={envOverridesText}
                onChange={(e) => setEnvOverridesText(e.target.value)}
                rows={12}
                className="md-field font-mono"
                placeholder={"export CLAUDE_CODE_USE_BEDROCK=1\nexport AWS_PROFILE=your-profile"}
              />
            </div>
            <div className="flex justify-end gap-2 border-t md-outline p-4">
              <button
                onClick={() => setShowEnvForm(false)}
                className="md-btn"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
