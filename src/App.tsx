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
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadInitialState();
    
    // Listen for agent messages from backend
    const unlisten = listen<AgentMessage>("agent-message", (event) => {
      setMessages(prev => [...prev, event.payload]);
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
    if (selectedWorkspace) {
      loadMessages(selectedWorkspace);
    } else {
      setMessages([]);
    }
  }, [selectedWorkspace]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
      const agent = await invoke<Agent>("start_agent", { workspaceId });
      setAgents(prev => [...prev, agent]);
      await loadWorkspaces(selectedRepo!);
    } catch (err) {
      console.error("Failed to start agent:", err);
      setError(String(err));
    }
  }

  async function stopAgent(agentId: string) {
    try {
      await invoke("stop_agent", { agentId });
      setAgents(prev => prev.filter(a => a.id !== agentId));
      if (selectedRepo) await loadWorkspaces(selectedRepo);
    } catch (err) {
      console.error("Failed to stop agent:", err);
      setError(String(err));
    }
  }

  async function sendMessage() {
    if (!inputMessage.trim()) return;
    
    const workspaceAgents = agents.filter(a => a.workspaceId === selectedWorkspace);
    if (workspaceAgents.length === 0) {
      setError("No active agent in this workspace");
      return;
    }
    
    const agent = workspaceAgents[0];
    
    // Add user message to display
    setMessages(prev => [...prev, {
      agentId: agent.id,
      content: `> ${inputMessage}`,
      isError: false,
      timestamp: new Date().toISOString(),
    }]);
    
    try {
      await invoke("send_message_to_agent", { 
        agentId: agent.id, 
        message: inputMessage 
      });
      setInputMessage("");
    } catch (err) {
      console.error("Failed to send message:", err);
      setError(String(err));
    }
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

  const getStatusColor = (status: string) => {
    switch (status) {
      case "running": return "bg-green-500";
      case "starting": return "bg-yellow-500";
      case "idle": return "bg-gray-400";
      case "stopped": return "bg-gray-400";
      case "error": return "bg-red-500";
      default: return "bg-gray-400";
    }
  };

  const currentRepo = repositories.find(r => r.id === selectedRepo);
  const currentWorkspace = workspaces.find(w => w.id === selectedWorkspace);
  const workspaceAgents = agents.filter(a => a.workspaceId === selectedWorkspace);
  const workspaceMessages = selectedWorkspace 
    ? messages.filter(m => workspaceAgents.some(a => a.id === m.agentId) || m.agentId === "system")
    : [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50 dark:bg-gray-900">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (repositories.length === 0) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50 dark:bg-gray-900">
        <div className="text-center max-w-md px-4">
          <div className="text-gray-400 dark:text-gray-500 mb-6">
            <svg className="w-20 h-20 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
            Welcome to Claude Orchestrator
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mb-8">
            Add a Git repository to get started. Each workspace will be an isolated 
            worktree where Claude can develop features independently.
          </p>
          
          {error && (
            <div className="mb-4 p-3 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded-lg text-red-700 dark:text-red-300 text-sm">
              {error}
            </div>
          )}
          
          <button
            onClick={addRepository}
            className="px-6 py-3 text-base font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors shadow-lg hover:shadow-xl"
          >
            Add Git Repository
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100">
      {/* Sidebar */}
      <aside className="w-72 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col">
        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <h1 className="text-lg font-semibold">Claude Orchestrator</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Multi-agent feature development
          </p>
        </div>

        {error && (
          <div className="mx-4 mt-4 p-2 bg-red-100 dark:bg-red-900/30 border border-red-300 dark:border-red-700 rounded text-red-700 dark:text-red-300 text-xs">
            {error}
            <button onClick={() => setError(null)} className="ml-2 underline">dismiss</button>
          </div>
        )}

        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Repository
            </span>
            <button onClick={addRepository} className="text-xs text-primary-600 hover:text-primary-700">
              + Add
            </button>
          </div>
          <select
            value={selectedRepo || ""}
            onChange={(e) => {
              setSelectedRepo(e.target.value);
              setSelectedWorkspace(null);
              setMessages([]);
            }}
            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700"
          >
            {repositories.map((repo) => (
              <option key={repo.id} value={repo.id}>{repo.name}</option>
            ))}
          </select>
          {currentRepo && (
            <div className="mt-2 text-xs text-gray-500 dark:text-gray-400 truncate">
              {currentRepo.path}
            </div>
          )}
        </div>

        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600 dark:text-gray-300">WebSocket Server</span>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${serverStatus?.running ? 'bg-green-500' : 'bg-red-500'}`}></span>
              <span className="text-xs text-gray-500">
                {serverStatus?.running ? `Port ${serverStatus.port}` : 'Offline'}
              </span>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Workspaces
            </span>
            <button onClick={() => setShowCreateForm(true)} className="text-xs text-primary-600 hover:text-primary-700">
              + New
            </button>
          </div>
          
          {workspaces.length === 0 ? (
            <div className="px-2 py-4 text-sm text-gray-500 dark:text-gray-400 text-center">
              <p>No workspaces yet</p>
              <p className="text-xs mt-1">Create one to start</p>
            </div>
          ) : (
            <div className="space-y-1 mt-2">
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  onClick={() => setSelectedWorkspace(workspace.id)}
                  className={`w-full px-3 py-2 rounded-lg text-left transition-colors ${
                    selectedWorkspace === workspace.id
                      ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
                      : 'hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${getStatusColor(workspace.status)}`}></span>
                    <span className="font-medium text-sm truncate">{workspace.name}</span>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">
                    {workspace.branch}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {showCreateForm && (
          <div className="p-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50">
            <div className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-2">
              Create New Workspace
            </div>
            <input
              type="text"
              value={newWorkspaceName}
              onChange={(e) => setNewWorkspaceName(e.target.value)}
              placeholder="Feature name"
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700"
              onKeyDown={(e) => e.key === 'Enter' && createWorkspace()}
              autoFocus
            />
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => { setShowCreateForm(false); setNewWorkspaceName(""); }}
                className="flex-1 px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={createWorkspace}
                className="flex-1 px-3 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg"
              >
                Create
              </button>
            </div>
          </div>
        )}
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col">
        <header className="h-14 px-6 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 flex items-center justify-between">
          <div>
            <h2 className="font-medium">{currentWorkspace?.name || 'Select a workspace'}</h2>
            {currentWorkspace && (
              <div className="text-xs text-gray-500">Branch: {currentWorkspace.branch}</div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {currentWorkspace && (
              <button
                onClick={() => {
                  setPrTitle(`${currentWorkspace.name}`);
                  setPrBody(`## Summary\n\nChanges from workspace: ${currentWorkspace.name}\n\n## Test Plan\n\n- [ ] Manual testing`);
                  setShowPRForm(true);
                }}
                className="px-4 py-2 text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 rounded-lg"
              >
                Create PR
              </button>
            )}
            {currentWorkspace && workspaceAgents.length === 0 && (
              <button
                onClick={() => startAgent(selectedWorkspace!)}
                className="px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg"
              >
                Start Agent
              </button>
            )}
            {currentWorkspace && workspaceAgents.length > 0 && (
              <button
                onClick={() => stopAgent(workspaceAgents[0].id)}
                className="px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg"
              >
                Stop Agent
              </button>
            )}
            {currentWorkspace && (
              <button
                onClick={() => removeWorkspace(selectedWorkspace!)}
                className="px-3 py-2 text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
                title="Delete workspace"
              >
                🗑️
              </button>
            )}
          </div>
        </header>

        <div className="flex-1 flex flex-col overflow-hidden">
          {currentWorkspace ? (
            <>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {workspaceMessages.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-gray-500">
                    {workspaceAgents.length > 0 ? (
                      <div className="text-center">
                        <div className="animate-pulse mb-2">●</div>
                        <p>Agent is running...</p>
                      </div>
                    ) : (
                      <p>Start an agent to begin</p>
                    )}
                  </div>
                ) : (
                  workspaceMessages.map((msg, idx) => (
                    <div
                      key={idx}
                      className={`p-3 rounded-lg ${
                        msg.isError
                          ? 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'
                          : msg.content.startsWith('>')
                            ? 'bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800'
                            : msg.content.startsWith('✅')
                              ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
                              : 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700'
                      }`}
                    >
                      <pre className="whitespace-pre-wrap text-sm font-mono overflow-x-auto">
                        {msg.content}
                      </pre>
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              {workspaceAgents.length > 0 && (
                <div className="p-4 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={inputMessage}
                      onChange={(e) => setInputMessage(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                      placeholder="Send a message to Claude..."
                      className="flex-1 px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700"
                    />
                    <button
                      onClick={sendMessage}
                      disabled={!inputMessage.trim()}
                      className="px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 disabled:bg-gray-400 rounded-lg"
                    >
                      Send
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center text-gray-500">
                <svg className="w-16 h-16 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                <h3 className="text-lg font-medium">Select or Create a Workspace</h3>
                <p className="text-sm mt-2 max-w-md">
                  Each workspace is an isolated git worktree where Claude can develop features.
                </p>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* PR Creation Modal */}
      {showPRForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-lg mx-4">
            <div className="p-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-semibold">Create Pull Request</h3>
              <p className="text-sm text-gray-500 mt-1">
                This will push the branch and create a PR on GitHub
              </p>
            </div>
            
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Title</label>
                <input
                  type="text"
                  value={prTitle}
                  onChange={(e) => setPrTitle(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700"
                  placeholder="PR title"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium mb-1">Description</label>
                <textarea
                  value={prBody}
                  onChange={(e) => setPrBody(e.target.value)}
                  rows={6}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 font-mono"
                  placeholder="PR description (markdown supported)"
                />
              </div>
            </div>
            
            <div className="p-4 border-t border-gray-200 dark:border-gray-700 flex gap-2 justify-end">
              <button
                onClick={() => { setShowPRForm(false); setPrTitle(""); setPrBody(""); }}
                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
                disabled={isCreatingPR}
              >
                Cancel
              </button>
              <button
                onClick={createPullRequest}
                disabled={isCreatingPR || !prTitle.trim()}
                className="px-4 py-2 text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 rounded-lg"
              >
                {isCreatingPR ? "Creating..." : "Create PR"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
