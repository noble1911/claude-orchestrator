import { type ThemeColorTokenKey } from "./themes";

export interface Repository {
  id: string;
  path: string;
  name: string;
  defaultBranch: string;
  addedAt: string;
}

export interface Workspace {
  id: string;
  repoId: string;
  name: string;
  branch: string;
  worktreePath: string;
  status: "idle" | "running" | "inReview" | "merged" | "initializing";
  lastActivity?: string;
  prUrl?: string;
  unread: number;
  displayOrder: number;
  pinnedAt?: string | null;
  notes?: string | null;
  parentGodWorkspaceId?: string | null;
  isGod?: boolean;
  sourceClaudeSessionId?: string | null;
}

export interface Agent {
  id: string;
  workspaceId: string;
  status: "starting" | "running" | "stopped" | "error";
  sessionId?: string;
  claudeSessionId?: string;
}

export interface AgentMessage {
  agentId: string;
  workspaceId?: string;
  role?: "user" | "assistant" | "system" | "error" | string;
  content: string;
  isError: boolean;
  timestamp: string;
}

export interface AgentRunStateEvent {
  workspaceId: string;
  agentId: string;
  running: boolean;
  timestamp: string;
}

export interface PermissionRequestEvent {
  workspaceId: string;
  agentId: string;
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
}

export interface ServerStatus {
  running: boolean;
  port: number;
  connectedClients: number;
  connectUrl: string;
  webUrl: string;
  pairingCode?: string | null;
}

export interface AppStatus {
  repositories: Repository[];
  serverStatus: ServerStatus;
}

export interface UpdateInfo {
  currentVersion: string;
  version: string;
  body?: string | null;
  date?: string | null;
}

// orchestrator.json configuration (Conductor pattern)
export interface OrchestratorConfig {
  setupScript?: string;
  runScript?: string;
  runMode: string;
  archiveScript?: string;
  checks: OrchestratorCheck[];
}

export interface OrchestratorCheck {
  name: string;
  command: string;
  description?: string;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface WorkspaceChangeEntry {
  status: string;
  path: string;
  oldPath?: string;
}

export interface WorkspaceCheckResult {
  name: string;
  command: string;
  success: boolean;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  skipped: boolean;
}

export interface WorkspaceCheckDefinition {
  name: string;
  command: string;
  description: string;
}

export interface CustomCheck {
  id: string;
  name: string;
  command: string;
}

export interface TerminalCommandResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  durationMs: number;
}

export interface TerminalLine {
  id: string;
  kind: "command" | "stdout" | "stderr" | "meta";
  text: string;
}

export interface PromptShortcut {
  id: string;
  name: string;
  prompt: string;
  autoRunOnCreate?: boolean;
}

export interface GodWorkspaceTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
}

export interface SkillShortcut {
  id: string;
  scope: "project" | "user";
  name: string;
  commandName: string;
  relativePath: string;
  filePath: string;
  content: string;
}

export interface SkillCatalogResponse {
  projectRoot?: string | null;
  userRoot?: string | null;
  projectSkills: SkillShortcut[];
  userSkills: SkillShortcut[];
}

export interface MarketplaceSkill {
  /** Directory name in the GitHub repo (e.g., "frontend-design") */
  dirName: string;
  /** Display name from SKILL.md frontmatter */
  name: string;
  /** Description from SKILL.md frontmatter */
  description: string;
  /** Full SKILL.md content (body without frontmatter) */
  content: string;
  /** Which repo this skill came from (undefined = official) */
  repoSource?: string;
}

export interface CustomSkillRepo {
  /** Unique ID */
  id: string;
  /** GitHub owner/repo (e.g., "myuser/my-skills") */
  repo: string;
  /** Optional subdirectory within the repo (default: "skills") */
  path: string;
  /** Optional display label */
  label: string;
}

export interface CenterTab {
  id: string;
  type: "chat" | "file" | "diff" | "graph" | "canvas";
  title: string;
  path?: string;
  status?: string;
  oldPath?: string;
  /** For type === "canvas": the HTML artifact id being displayed */
  artifactId?: string;
}

/** HTML artifact emitted by an agent via the `render_html` MCP tool. */
export interface HtmlArtifact {
  id: string;
  workspaceId: string;
  /** Stable key — when the agent reuses it, we replace in place. */
  identifier?: string | null;
  title: string;
  html: string;
  createdAt: string;
}

// ─── Orchestration Graph ───────────────────────────────────────────

export type OrchestrationEventKind =
  | "workspaceCreated"
  | "agentStarted"
  | "messageSent"
  | "agentStopped"
  | "statusPolled"
  | "waitStarted"
  | "waitCompleted"
  | "artifactWritten"
  | "artifactRead"
  | "artifactDeleted";

export interface OrchestrationEvent {
  id: string;
  godWorkspaceId: string;
  childWorkspaceId?: string | null;
  childWorkspaceName?: string | null;
  kind: OrchestrationEventKind;
  timestamp: string;
  summary: string;
  artifactKey?: string | null;
}

export interface OrchestrationChildStatus {
  workspaceId: string;
  name: string;
  workspaceStatus: string;
  agentStatus?: string | null;
  processing: boolean;
  completionReason?: string | null;
  messageCount: number;
  lastActivity?: string | null;
}

export interface OrchestrationArtifact {
  key: string;
  value: string;
  updatedAt: string;
}

export interface OrchestrationSnapshot {
  godWorkspaceId: string;
  children: OrchestrationChildStatus[];
  artifacts: OrchestrationArtifact[];
}

export type ClaudeMode = "normal" | "plan";
export type EditorKind = "vscode" | "intellij";
export type WorkspaceOpenTarget = "" | EditorKind | "terminal";
export type SkillScope = "project" | "user";

export interface ActivityLine {
  text: string;
  count: number;
}

export interface ActivityGroup {
  id: string;
  messages: AgentMessage[];
  lines: ActivityLine[];
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: QuestionOption[];
}

export interface AskUserQuestionPayload {
  questions: QuestionItem[];
}

export interface QueuedMessage {
  id: string;
  text: string;
  visible: string;
  queuedAt: number;
}

export interface ThemeDraft {
  label: string;
  description: string;
  rootText: string;
  rootBackground: string;
  colors: Record<ThemeColorTokenKey, string>;
}

export type ChatRow =
  | { kind: "message"; id: string; message: AgentMessage }
  | { kind: "activity"; id: string; group: ActivityGroup };

export interface WorkspaceGroup {
  id: string;
  label: string;
  /** Which workspace statuses belong in this group */
  statuses: Workspace["status"][];
}

export interface ShortcutKeys {
  /** KeyboardEvent.key value (e.g. "/", "ArrowUp", "Escape") */
  key: string;
  /** KeyboardEvent.code value when needed (e.g. "BracketLeft") — if set, code is matched instead of key */
  code?: string;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Human-readable label for display (e.g. "⌘[", "Esc") */
  displayLabel: string;
}

export interface ShortcutBinding {
  id: string;
  label: string;
  defaultKeys: ShortcutKeys;
  /** User override — undefined means use defaultKeys */
  customKeys?: ShortcutKeys;
  /** If true, shortcut is displayed but not rebindable (native Tauri or range-based) */
  readonly?: boolean;
}

export interface QuestionCardProps {
  message: AgentMessage;
  rowId: string;
  isAnswered: boolean;
  onAnswer: (answer: string) => void;
}

export interface SortableWorkspaceItemProps {
  workspace: Workspace;
  isSelected: boolean;
  unreadCount: number;
  repoName?: string;
  onSelect: (id: string) => void;
  onTogglePin: (id: string) => void;
  onRename: (ws: Workspace) => void;
  onRemove: (id: string) => void;
  onContinueFrom: (id: string) => void;
  getStatusColor: (status: string) => string;
}
