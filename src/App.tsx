import { useState, useEffect, useRef } from "react";
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
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(false);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(false);
  const [autoStartingWorkspaceId, setAutoStartingWorkspaceId] = useState<string | null>(null);
  const [isAgentThinking, setIsAgentThinking] = useState(false);
  const [thinkingSince, setThinkingSince] = useState<number | null>(null);
  const [thinkingElapsedSec, setThinkingElapsedSec] = useState(0);
  const [isActivityExpanded, setIsActivityExpanded] = useState(false);
  const startingWorkspaceIdsRef = useRef<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadInitialState();
    
    // Listen for agent messages from backend
    const unlisten = listen<AgentMessage>("agent-message", (event) => {
      setMessages(prev => [...prev, event.payload]);
      const isUserLike = event.payload.agentId === "user" || event.payload.content.trimStart().startsWith(">");
      const isResponseLike = !isUserLike && (event.payload.agentId !== "system" || event.payload.isError);
      if (isResponseLike) {
        setIsAgentThinking(false);
        setThinkingSince(null);
      }
    });
    
    return () => {
      unlisten.then(fn => fn());
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
      setIsAgentThinking(false);
      setThinkingSince(null);
    }
  }, [selectedWorkspace]);

  useEffect(() => {
    if (!isAgentThinking || thinkingSince === null) {
      setThinkingElapsedSec(0);
      return;
    }

    const tick = () => setThinkingElapsedSec(Math.max(0, Math.floor((Date.now() - thinkingSince) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [isAgentThinking, thinkingSince]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
      // Auto-start agent
      await startAgent(workspace.id);
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
      if (selectedWorkspace === workspaceId) {
        setSelectedWorkspace(null);
        setMessages([]);
      }
    } catch (err) {
      console.error("Failed to remove workspace:", err);
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
      await invoke("stop_agent", { agentId });
      setAgents(prev => prev.filter(a => a.id !== agentId));
      setIsAgentThinking(false);
      setThinkingSince(null);
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
    
    const workspaceAgents = agents.filter(a => a.workspaceId === selectedWorkspace);
    if (workspaceAgents.length === 0) {
      setError("No active agent in this workspace");
      setIsAgentThinking(false);
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
      content: visibleMessage,
      isError: false,
      timestamp: new Date().toISOString(),
    }]);
    
    try {
      setIsAgentThinking(true);
      setThinkingSince(Date.now());
      await invoke("send_message_to_agent", { 
        agentId: agent.id, 
        message: messageToSend,
        envOverrides: parseEnvOverrides(envOverridesText),
      });
      if (!rawMessage) {
        setInputMessage("");
      }
    } catch (err) {
      console.error("Failed to send message:", err);
      setError(String(err));
      setIsAgentThinking(false);
      setThinkingSince(null);
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
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition ${
              activeCenterTabId === `file:${entry.path}`
                ? "bg-zinc-800 text-zinc-100"
                : entry.isDir
                  ? "hover:bg-zinc-900/80"
                  : "hover:bg-zinc-900/60 text-zinc-300"
            }`}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
          >
            <span className="w-3 text-zinc-500">{entry.isDir ? (isExpanded ? "▾" : "▸") : " "}</span>
            <span className={entry.isDir ? "text-zinc-200" : "text-zinc-400"}>{entry.isDir ? "[D]" : "[F]"}</span>
            <span className="truncate">{entry.name}</span>
          </button>

          {entry.isDir && isExpanded && (
            <>
              {isLoading && (
                <div
                  className="px-2 py-1 text-xs text-zinc-500"
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
      case "running": return "bg-emerald-400";
      case "starting": return "bg-amber-400";
      case "idle": return "bg-zinc-500";
      case "stopped": return "bg-zinc-500";
      case "error": return "bg-rose-500";
      default: return "bg-zinc-500";
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
  const activeCenterTab = centerTabs.find((tab) => tab.id === activeCenterTabId) || centerTabs[0];
  const workspaceMessages = selectedWorkspace 
    ? messages.filter(
        (m) =>
          workspaceAgents.some((a) => a.id === m.agentId) ||
          m.agentId === "system" ||
          m.agentId === "user",
      )
    : [];
  const activityMessages = workspaceMessages
    .filter((m) => m.agentId === "system" || m.isError)
    .slice(-30);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[radial-gradient(circle_at_top,_#25211b_0%,_#141210_46%,_#0d0b09_100%)] text-zinc-200">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-amber-300" />
      </div>
    );
  }

  if (repositories.length === 0) {
    return (
      <div className="flex h-screen items-center justify-center bg-[radial-gradient(circle_at_top,_#25211b_0%,_#141210_46%,_#0d0b09_100%)]">
        <div className="mx-4 max-w-md rounded-2xl border border-zinc-800 bg-zinc-950/80 px-6 py-8 text-center shadow-[0_24px_60px_rgba(0,0,0,0.45)]">
          <div className="mb-6 text-zinc-500">
            <svg className="w-20 h-20 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
          </div>
          <h1 className="mb-2 text-2xl font-semibold text-zinc-100">
            Welcome to Claude Orchestrator
          </h1>
          <p className="mb-8 text-zinc-400">
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
            className="rounded-lg border border-amber-700/50 bg-amber-900/40 px-6 py-3 text-base font-medium text-amber-100 transition hover:bg-amber-800/50"
          >
            Add Git Repository
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-screen overflow-hidden bg-[radial-gradient(circle_at_top,_#25211b_0%,_#141210_46%,_#0d0b09_100%)] text-zinc-100">
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
        className={`fixed inset-y-0 left-0 z-40 flex w-[280px] flex-col border-r border-zinc-800/80 bg-zinc-950/95 backdrop-blur transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 lg:bg-zinc-950/70 ${
          isLeftPanelOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="border-b border-zinc-800 px-5 py-4">
          <div className="flex items-center justify-between">
            <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">History</p>
            <button
              onClick={() => setIsLeftPanelOpen(false)}
              className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 lg:hidden"
            >
              Close
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-4">
          <div className="mb-4 flex items-center justify-between px-2">
            <h2 className="text-sm font-medium text-zinc-300">Workspaces</h2>
            <button
              onClick={openCreateWorkspaceForm}
              className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200"
            >
              + New
            </button>
          </div>

          {workspaceGroups.map((group) => (
            <div key={group.key} className="mb-3">
              <div className="mb-1 flex items-center gap-2 px-2 text-xs text-zinc-500">
                <span>{group.label}</span>
                <span>{group.items.length}</span>
              </div>
              <div className="space-y-1">
                {group.items.map((workspace) => (
                  <button
                    key={workspace.id}
                    onClick={() => handleSelectWorkspace(workspace.id)}
                    className={`w-full rounded-lg border px-3 py-2 text-left transition ${
                      selectedWorkspace === workspace.id
                        ? "border-zinc-600 bg-zinc-800/70"
                        : "border-transparent bg-transparent hover:border-zinc-800 hover:bg-zinc-900/80"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${getStatusColor(workspace.status)}`} />
                      <span className="truncate text-sm text-zinc-200">{workspace.name}</span>
                    </div>
                    <p className="mt-1 truncate text-xs text-zinc-500">{workspace.branch}</p>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="border-t border-zinc-800 px-4 py-3">
          <button
            onClick={addRepository}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 transition hover:border-zinc-500"
          >
            + Add repository
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col lg:border-r lg:border-zinc-800/80">
        <header className="flex h-14 items-center justify-between border-b border-zinc-800/80 bg-zinc-950/45 px-5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex items-center gap-2 lg:hidden">
              <button
                onClick={() => setIsLeftPanelOpen(true)}
                className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                aria-label="Open left menu"
              >
                Menu
              </button>
              <button
                onClick={() => setIsRightPanelOpen(true)}
                className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
                aria-label="Open right menu"
              >
                Tools
              </button>
            </div>
            <span className="text-xs text-zinc-500">{currentRepo?.name || "No repo"}</span>
            <span className="text-zinc-700">/</span>
            <span className="truncate text-sm text-zinc-200">{currentWorkspace?.name || "Select workspace"}</span>
            {currentWorkspace && <span className="truncate text-xs text-zinc-500">{currentWorkspace.branch}</span>}
            {currentWorkspace && (
              <button
                onClick={() => removeWorkspace(selectedWorkspace!)}
                title="Delete workspace"
                className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-zinc-400 transition hover:border-rose-700 hover:text-rose-300"
                aria-label="Delete workspace"
              >
                🗑
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`rounded border px-2 py-1 text-[11px] ${
                (serverStatus?.connectedClients || 0) > 0
                  ? "border-emerald-700/60 bg-emerald-950/30 text-emerald-300"
                  : "border-zinc-700 bg-zinc-900 text-zinc-400"
              }`}
              title="Connected remote clients"
            >
              Mobile {(serverStatus?.connectedClients || 0) > 0 ? "Connected" : "Offline"} ({serverStatus?.connectedClients || 0})
            </span>
            <select
              value={selectedRepo || ""}
              onChange={(e) => {
                setSelectedRepo(e.target.value);
                setSelectedWorkspace(null);
                setMessages([]);
              }}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300 outline-none"
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
                className="whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 transition hover:border-zinc-500"
              >
                Open PR
              </button>
            )}
            {currentWorkspace && workspaceAgents.length > 0 && (
              <button
                onClick={() => stopAgent(workspaceAgents[0].id)}
                className="rounded-md border border-rose-700/60 bg-rose-950/40 px-3 py-1.5 text-xs text-rose-200"
              >
                Stop
              </button>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col bg-[#120f0d]/70">
          {error && (
            <div className="mx-4 mt-4 rounded-md border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
              {error}
              <button onClick={() => setError(null)} className="ml-2 underline">
                dismiss
              </button>
            </div>
          )}

          {currentWorkspace ? (
            <>
              <div className="border-b border-zinc-800 px-5 pt-3">
                <div className="mx-auto flex max-w-4xl items-center gap-2 overflow-x-auto pb-3">
                  {centerTabs.map((tab) => (
                    <div
                      key={tab.id}
                      className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs ${
                        activeCenterTabId === tab.id
                          ? "border-zinc-600 bg-zinc-800 text-zinc-100"
                          : "border-zinc-800 bg-zinc-900 text-zinc-400"
                      }`}
                    >
                      <button onClick={() => setActiveCenterTabId(tab.id)} className="whitespace-nowrap">
                        {tab.title}
                      </button>
                      {tab.type === "file" && (
                        <button
                          onClick={() => closeCenterTab(tab.id)}
                          className="text-zinc-500 transition hover:text-zinc-200"
                          aria-label={`Close ${tab.title}`}
                        >
                          x
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-6 py-5">
                <div className="mx-auto max-w-4xl space-y-3">
                  {activeCenterTab.type === "chat" && (
                    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40">
                      <button
                        onClick={() => setIsActivityExpanded((prev) => !prev)}
                        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-zinc-400"
                      >
                        <span className="inline-flex items-center gap-2">
                          <span className={`h-2 w-2 rounded-full ${isAgentThinking ? "animate-pulse bg-amber-300" : "bg-zinc-600"}`} />
                          Activity {isAgentThinking ? `(thinking ${thinkingElapsedSec}s)` : ""}
                        </span>
                        <span>{isActivityExpanded ? "Hide" : `Show ${activityMessages.length}`}</span>
                      </button>
                      {isActivityExpanded && (
                        <div className="max-h-44 space-y-1 overflow-auto border-t border-zinc-800 px-3 py-2">
                          {activityMessages.length === 0 ? (
                            <p className="text-xs text-zinc-500">No activity yet.</p>
                          ) : (
                            [...activityMessages].reverse().map((msg, idx) => (
                              <div
                                key={`${msg.timestamp}-${idx}`}
                                className={`rounded px-2 py-1 text-xs ${
                                  msg.isError ? "bg-rose-950/30 text-rose-300" : "text-zinc-400"
                                }`}
                              >
                                {msg.content}
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {activeCenterTab.type === "chat" && workspaceMessages.length === 0 ? (
                    <div className="flex h-[55vh] items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950/45 text-zinc-500">
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
                    workspaceMessages.map((msg, idx) => {
                      const isUser = msg.agentId === "user" || msg.content.trimStart().startsWith(">");
                      const isSystem = msg.agentId === "system";

                      if (msg.isError) {
                        return (
                          <div key={idx} className="rounded-xl border border-rose-900/60 bg-rose-950/20 p-4">
                            <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-sm text-rose-200">{msg.content}</pre>
                          </div>
                        );
                      }

                      if (isUser) {
                        return (
                          <div key={idx} className="flex justify-end">
                            <div className="max-w-[80%] rounded-2xl border border-sky-900/70 bg-sky-950/25 px-4 py-3">
                              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-sm text-sky-100">
                                {msg.content.replace(/^>\s?/, "")}
                              </pre>
                            </div>
                          </div>
                        );
                      }

                      if (isSystem) {
                        return (
                          <div key={idx} className="rounded-md border border-zinc-800 bg-zinc-950/50 px-3 py-2 text-xs text-zinc-400">
                            {msg.content}
                          </div>
                        );
                      }

                      return (
                        <div key={idx} className="px-1 py-1">
                          <pre className="overflow-x-auto whitespace-pre-wrap text-sm text-zinc-200">{msg.content}</pre>
                        </div>
                      );
                    })
                  ) : (
                    <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
                      <p className="mb-2 truncate text-xs text-zinc-500">{activeCenterTab.path}</p>
                      {isLoadingFileContent && selectedFilePath === activeCenterTab.path ? (
                        <p className="text-xs text-zinc-500">Loading file...</p>
                      ) : (
                        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap font-mono text-sm text-zinc-200">
                          {(activeCenterTab.path && fileContentsByPath[activeCenterTab.path]) || "(empty file)"}
                        </pre>
                      )}
                    </div>
                  )}
                  {activeCenterTab.type === "chat" && <div ref={messagesEndRef} />}
                  {activeCenterTab.type === "chat" && isAgentThinking && (
                    <div className="px-1 py-2 text-sm text-zinc-400">
                      <span className="inline-flex items-center gap-2">
                        <span className="h-2 w-2 animate-pulse rounded-full bg-amber-300" />
                        AI is thinking... {thinkingElapsedSec}s
                      </span>
                      <p className="mt-1 text-xs text-zinc-500">
                        Claude is running in {currentWorkspace?.name || "current workspace"} and may take a while.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {workspaceAgents.length > 0 && activeCenterTab.type === "chat" && (
                <div className="border-t border-zinc-800 bg-zinc-950/70 px-5 py-4">
                  <div className="mx-auto flex max-w-4xl gap-2">
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
                      className="flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-900/90 px-4 py-2 text-sm text-zinc-200 outline-none placeholder:text-zinc-500 focus:border-zinc-500"
                    />
                    <button
                      onClick={() => {
                        void sendMessage();
                      }}
                      disabled={!inputMessage.trim()}
                      className="self-end rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-200 transition hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Send
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center px-5">
              <div className="max-w-md text-center text-zinc-500">
                <h3 className="text-lg font-medium text-zinc-200">Select or Create a Workspace</h3>
                <p className="mt-2 text-sm">
                  Each workspace is an isolated git worktree where Claude can develop features.
                </p>
                <button
                  onClick={openCreateWorkspaceForm}
                  className="mt-4 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-200 transition hover:border-zinc-500"
                >
                  Create workspace
                </button>
              </div>
            </div>
          )}
        </div>
      </main>

      <aside
        className={`fixed inset-y-0 right-0 z-40 flex w-[360px] max-w-[92vw] flex-col bg-[#0f0d0b]/95 transition-transform duration-200 lg:static lg:z-auto lg:max-w-none lg:translate-x-0 lg:bg-[#0f0d0b]/90 ${
          isRightPanelOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex h-14 items-center border-b border-zinc-800 px-4">
          <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-900 p-1 text-xs">
            <button
              onClick={() => setActiveRightTab("files")}
              className={`rounded-md px-3 py-1 ${
                activeRightTab === "files" ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              All files
            </button>
            <button
              onClick={() => setActiveRightTab("changes")}
              className={`rounded-md px-3 py-1 ${
                activeRightTab === "changes" ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Changes
            </button>
            <button
              onClick={() => setActiveRightTab("checks")}
              className={`rounded-md px-3 py-1 ${
                activeRightTab === "checks" ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Checks
            </button>
          </div>
          <button
            onClick={() => setIsRightPanelOpen(false)}
            className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 lg:hidden"
          >
            Close
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="mb-4 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs uppercase tracking-wide text-zinc-500">Prompt Buttons</p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setShowEnvForm(true)}
                  className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs text-zinc-300"
                  title="Edit environment overrides"
                >
                  Env
                </button>
                <button
                  onClick={openAddPromptForm}
                  className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs text-zinc-300"
                  title="Add prompt shortcut"
                >
                  +
                </button>
              </div>
            </div>
            {promptShortcuts.length === 0 ? (
              <p className="text-xs text-zinc-500">No prompt shortcuts yet.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {promptShortcuts.map((shortcut) => (
                  <button
                    key={shortcut.id}
                    onClick={() => runPromptShortcut(shortcut)}
                    className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 transition hover:border-zinc-500"
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
              <p className="text-xs uppercase tracking-wide text-zinc-500">Workspace Files</p>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-zinc-300">
                <p className="truncate text-xs text-zinc-500">
                  {currentWorkspace?.worktreePath || currentRepo?.path || "No active workspace"}
                </p>

                {!selectedWorkspace && (
                  <p className="mt-3 text-xs text-zinc-500">Select a workspace to browse files.</p>
                )}

                {selectedWorkspace && loadingPaths.has("") && !workspaceFilesByPath[""] && (
                  <p className="mt-3 text-xs text-zinc-500">Loading files...</p>
                )}

                {selectedWorkspace &&
                  workspaceFilesByPath[""] &&
                  workspaceFilesByPath[""].length === 0 && (
                    <p className="mt-3 text-xs text-zinc-500">This workspace is empty.</p>
                  )}

                {selectedWorkspace && workspaceFilesByPath[""] && (
                  <div className="mt-3">{renderFileTree("", 0)}</div>
                )}
              </div>

              <p className="text-xs text-zinc-500">Click a file to open it as a center tab.</p>
            </div>
          )}

          {activeRightTab === "changes" && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-xs">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-zinc-300">Git status</span>
                <button
                  onClick={() => selectedWorkspace && loadWorkspaceChanges(selectedWorkspace)}
                  className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300"
                >
                  Refresh
                </button>
              </div>

              {isLoadingChanges && <p className="text-zinc-500">Loading changes...</p>}
              {!isLoadingChanges && workspaceChanges.length === 0 && (
                <p className="text-zinc-500">Working tree is clean.</p>
              )}
              {!isLoadingChanges && workspaceChanges.length > 0 && (
                <div className="space-y-1">
                  {workspaceChanges.map((change) => (
                    <div key={`${change.status}-${change.path}`} className="rounded border border-zinc-800 bg-zinc-900/60 px-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="w-10 font-mono text-[11px] text-amber-300">{change.status}</span>
                        <span className="truncate text-zinc-200">{change.path}</span>
                      </div>
                      {change.oldPath && (
                        <p className="mt-0.5 truncate pl-12 text-[11px] text-zinc-500">from: {change.oldPath}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeRightTab === "checks" && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 text-xs">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-zinc-300">Workspace checks</span>
                <button
                  onClick={runWorkspaceChecks}
                  disabled={!selectedWorkspace || isRunningChecks}
                  className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 disabled:opacity-50"
                >
                  {isRunningChecks ? "Running..." : "Run checks"}
                </button>
              </div>

              {!isRunningChecks && checkResults.length === 0 && (
                <p className="text-zinc-500">Run checks to see summary results.</p>
              )}

              {checkResults.length > 0 && (
                <div className="space-y-2">
                  {checkResults.map((check, index) => (
                    <div key={`${check.name}-${index}`} className="rounded border border-zinc-800 bg-zinc-900/60 p-2">
                      <div className="mb-1 flex items-center justify-between">
                        <span className={check.success ? "text-emerald-300" : "text-rose-300"}>
                          {check.success ? "PASS" : "FAIL"} {check.name}
                        </span>
                        <span className="text-[11px] text-zinc-500">{check.durationMs}ms</span>
                      </div>
                      <p className="truncate font-mono text-[11px] text-zinc-500">{check.command}</p>
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

        <div className="border-t border-zinc-800 px-4 py-3">
          <div className="mb-2 flex items-center justify-between text-xs text-zinc-500">
            <span>Terminal</span>
            <span>{serverStatus?.running ? `Port ${serverStatus.port}` : "Offline"}</span>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-black/50 p-3 font-mono text-xs text-emerald-300">
            <p>{currentWorkspace?.name || "workspace"} git:{currentWorkspace ? `(${currentWorkspace.branch})` : ""} $</p>
          </div>
        </div>
      </aside>

      {showCreateForm && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/55">
          <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-4 shadow-2xl">
            <p className="mb-2 text-sm font-medium text-zinc-200">Create New Workspace</p>
            <input
              type="text"
              value={newWorkspaceName}
              onChange={(e) => setNewWorkspaceName(e.target.value)}
              placeholder="Feature name"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 outline-none placeholder:text-zinc-500"
              onKeyDown={(e) => e.key === "Enter" && createWorkspace()}
              autoFocus
            />
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => {
                  setShowCreateForm(false);
                  setNewWorkspaceName("");
                }}
                className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-300"
              >
                Cancel
              </button>
              <button
                onClick={createWorkspace}
                className="flex-1 rounded-lg border border-amber-700/60 bg-amber-900/40 px-3 py-2 text-sm font-medium text-amber-100"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PR Creation Modal */}
      {showPRForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="mx-4 w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl">
            <div className="border-b border-zinc-800 p-4">
              <h3 className="text-lg font-semibold text-zinc-100">Create Pull Request</h3>
              <p className="mt-1 text-sm text-zinc-500">
                This will push the branch and create a PR on GitHub
              </p>
            </div>
            
            <div className="space-y-4 p-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-zinc-300">Title</label>
                <input
                  type="text"
                  value={prTitle}
                  onChange={(e) => setPrTitle(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
                  placeholder="PR title"
                />
              </div>
              
              <div>
                <label className="mb-1 block text-sm font-medium text-zinc-300">Description</label>
                <textarea
                  value={prBody}
                  onChange={(e) => setPrBody(e.target.value)}
                  rows={6}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-200"
                  placeholder="PR description (markdown supported)"
                />
              </div>
            </div>
            
            <div className="flex justify-end gap-2 border-t border-zinc-800 p-4">
              <button
                onClick={() => { setShowPRForm(false); setPrTitle(""); setPrBody(""); }}
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-300"
                disabled={isCreatingPR}
              >
                Cancel
              </button>
              <button
                onClick={createPullRequest}
                disabled={isCreatingPR || !prTitle.trim()}
                className="rounded-lg border border-amber-700/60 bg-amber-900/40 px-4 py-2 text-sm font-medium text-amber-100 disabled:opacity-50"
              >
                {isCreatingPR ? "Creating..." : "Create PR"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddPromptForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="mx-4 w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl">
            <div className="border-b border-zinc-800 p-4">
              <h3 className="text-lg font-semibold text-zinc-100">Add Prompt Shortcut</h3>
              <p className="mt-1 text-sm text-zinc-500">
                Create a reusable prompt button and slash command.
              </p>
            </div>

            <div className="space-y-4 p-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-zinc-300">Name</label>
                <input
                  type="text"
                  value={newPromptName}
                  onChange={(e) => setNewPromptName(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200"
                  placeholder="e.g. Code review"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-zinc-300">Prompt</label>
                <textarea
                  value={newPromptBody}
                  onChange={(e) => setNewPromptBody(e.target.value)}
                  rows={6}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-200"
                  placeholder="Write the full prompt to execute"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-zinc-800 p-4">
              <button
                onClick={() => setShowAddPromptForm(false)}
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-300"
              >
                Cancel
              </button>
              <button
                onClick={addPromptShortcut}
                disabled={!newPromptName.trim() || !newPromptBody.trim()}
                className="rounded-lg border border-amber-700/60 bg-amber-900/40 px-4 py-2 text-sm font-medium text-amber-100 disabled:opacity-50"
              >
                Add Prompt
              </button>
            </div>
          </div>
        </div>
      )}

      {showEnvForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="mx-4 w-full max-w-xl rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl">
            <div className="border-b border-zinc-800 p-4">
              <h3 className="text-lg font-semibold text-zinc-100">Environment Overrides</h3>
              <p className="mt-1 text-sm text-zinc-500">
                Paste freeform env lines. Supports `export KEY=VALUE` and `KEY=VALUE`.
              </p>
            </div>
            <div className="p-4">
              <textarea
                value={envOverridesText}
                onChange={(e) => setEnvOverridesText(e.target.value)}
                rows={12}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-200"
                placeholder={"export CLAUDE_CODE_USE_BEDROCK=1\nexport AWS_PROFILE=your-profile"}
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-zinc-800 p-4">
              <button
                onClick={() => setShowEnvForm(false)}
                className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-300"
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
