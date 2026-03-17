// Types mirroring the WebSocket server protocol

export interface Repository {
  id: string;
  path: string;
  name: string;
  default_branch: string;
  added_at: string;
}

export interface WorkspaceInfo {
  id: string;
  repo_id: string;
  name: string;
  branch: string;
  status: string;
  has_agent: boolean;
  pinned_at?: string | null;
  notes?: string | null;
  pr_url?: string | null;
}

export interface MessageInfo {
  agent_id: string;
  role: string;
  content: string;
  is_error: boolean;
  timestamp: string;
}

export interface FileEntryInfo {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface ChangeInfo {
  status: string;
  path: string;
  old_path?: string;
}

export interface CheckInfo {
  name: string;
  command: string;
  success: boolean;
  exit_code?: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  skipped: boolean;
}

export interface TerminalEntry {
  id: string;
  command: string;
  stdout: string;
  stderr: string;
  exit_code?: number | null;
  running: boolean;
}

// WebSocket response types
export type WsResponse =
  | { type: "connected"; server_name: string; features: string[] }
  | { type: "authenticated"; client_id: string }
  | { type: "authentication_failed"; reason: string }
  | { type: "repository_list"; repositories: Repository[] }
  | { type: "workspace_list"; workspaces: WorkspaceInfo[] }
  | { type: "workspace_created"; workspace: WorkspaceInfo }
  | { type: "workspace_renamed"; workspace: WorkspaceInfo }
  | { type: "workspace_removed"; workspace_id: string }
  | { type: "workspace_updated"; workspace: WorkspaceInfo }
  | { type: "message_history"; workspace_id: string; messages: MessageInfo[] }
  | { type: "files_list"; workspace_id: string; relative_path: string; entries: FileEntryInfo[] }
  | { type: "file_content"; workspace_id: string; path: string; content: string }
  | { type: "changes_list"; workspace_id: string; changes: ChangeInfo[] }
  | { type: "checks_result"; workspace_id: string; checks: CheckInfo[] }
  | { type: "change_diff"; workspace_id: string; file_path: string; diff: string }
  | { type: "terminal_output"; workspace_id: string; stdout: string; stderr: string; exit_code?: number | null }
  | { type: "subscribed"; workspace_id: string }
  | { type: "unsubscribed"; workspace_id: string }
  | { type: "agent_message"; workspace_id: string; role: string; content: string; is_error: boolean; timestamp: string }
  | { type: "agent_started"; workspace_id: string; agent_id: string }
  | { type: "agent_run_state"; workspace_id: string; agent_id: string; running: boolean; timestamp: string }
  | { type: "agent_stopped"; workspace_id: string }
  | { type: "agent_interrupted"; workspace_id: string }
  | { type: "error"; message: string };

export type ConnectionState = "disconnected" | "connecting" | "authenticating" | "connected";

export interface WorkspaceGroup {
  id: string;
  label: string;
  statuses: string[];
}
