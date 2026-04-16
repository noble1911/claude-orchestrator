import type { WorkspaceGroup, ShortcutBinding, GodWorkspaceTemplate } from "./types";

export const NAME_ADJECTIVES = [
  "swift",
  "brisk",
  "neat",
  "solid",
  "lively",
  "calm",
  "bold",
  "quiet",
];

export const NAME_NOUNS = [
  "otter",
  "falcon",
  "maple",
  "harbor",
  "comet",
  "forest",
  "breeze",
  "ember",
];

export const MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "opus", label: "Opus 4.7" },
  { value: "sonnet", label: "Sonnet 4.6" },
  { value: "haiku", label: "Haiku 4.5" },
];
export const DEFAULT_MODEL_ID = "opus";

export const THINKING_MODE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export const PERMISSION_MODE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "dangerouslySkipPermissions", label: "Skip All" },
  { value: "bypassPermissions", label: "Bypass" },
  { value: "auto", label: "Auto" },
  { value: "acceptEdits", label: "Accept Edits" },
  { value: "default", label: "Default" },
  { value: "dontAsk", label: "Don't Ask" },
  { value: "plan", label: "Plan" },
];

export const GOD_WORKSPACE_TEMPLATES: GodWorkspaceTemplate[] = [
  {
    id: "parallel",
    name: "Parallel",
    description: "Split into independent subtasks, run in parallel, synthesize",
    prompt: `You are orchestrating parallel task decomposition. Follow this strategy:

1. Analyze the user's request and decompose it into independent subtasks that can run concurrently
2. Create a child workspace for each subtask (use descriptive names like "api-endpoints", "frontend-ui", "test-suite")
3. Start agents in ALL child workspaces
4. Send task instructions to each agent simultaneously
5. Use /api/workspace/wait to block until each agent completes — do NOT poll
6. Once all agents finish, read their lastAgentMessage from the wait responses
7. Synthesize the results and report back to the user

Wait for the user's task before creating any workspaces.`,
  },
  {
    id: "sequential",
    name: "Sequential Pipeline",
    description: "Chain stages where each builds on the previous output",
    prompt: `You are orchestrating a sequential pipeline. Follow this strategy:

1. Analyze the user's request and break it into ordered stages where each depends on the previous
2. Create workspace for stage 1, start its agent, send the task
3. Use /api/workspace/wait to block until the agent finishes
4. Read the output from lastAgentMessage or the messages endpoint
5. Create workspace for stage 2, include stage 1's output in the task description
6. Repeat until all stages are complete
7. Synthesize the final result and report back

Wait for the user's task before creating any workspaces.`,
  },
  {
    id: "review-loop",
    name: "Implement + Review",
    description: "One agent implements, another reviews, iterate until approved",
    prompt: `You are orchestrating an implement-review loop. Follow this strategy:

1. Analyze the user's request
2. Create two workspaces: one for implementation (e.g., "implement-feature"), one for review (e.g., "review-feature")
3. Start the implementation agent, send it the task, wait for completion
4. Read the implementation output, then send it to the review agent for code review
5. If the reviewer identifies issues, send the feedback back to the implementer to fix
6. Repeat the implement-review cycle (max 3 iterations) until the reviewer approves
7. Report the final result to the user

Wait for the user's task before creating any workspaces.`,
  },
];

export const PROMPT_SHORTCUTS_STORAGE_KEY = "claude_orchestrator_prompt_shortcuts";
export const ENV_OVERRIDES_STORAGE_KEY = "claude_orchestrator_env_overrides";
export const CLAUDE_MODE_STORAGE_KEY = "claude_orchestrator_mode";
export const MODEL_STORAGE_KEY = "claude_orchestrator_model";
export const MODEL_BY_WORKSPACE_STORAGE_KEY = "claude_orchestrator_model_by_workspace";
export const THINKING_MODE_STORAGE_KEY = "claude_orchestrator_thinking_mode";
export const PERMISSION_MODE_STORAGE_KEY = "claude_orchestrator_permission_mode";
export const PERMISSION_MODE_BY_WORKSPACE_STORAGE_KEY = "claude_orchestrator_permission_mode_by_workspace";
export const DEFAULT_REPOSITORY_STORAGE_KEY = "claude_orchestrator_default_repository";
export const BEDROCK_ENV_KEY = "CLAUDE_CODE_USE_BEDROCK";
export const WORKSPACE_GROUPS_STORAGE_KEY = "claude_orchestrator_workspace_groups";
export const WORKSPACE_GROUP_OVERRIDES_STORAGE_KEY = "claude_orchestrator_workspace_group_overrides";
export const LEFT_PANEL_OPEN_STORAGE_KEY = "claude_orchestrator_left_panel_open";
export const RIGHT_PANEL_OPEN_STORAGE_KEY = "claude_orchestrator_right_panel_open";
export const SIDEBAR_FONT_SIZE_STORAGE_KEY = "claude_orchestrator_sidebar_font_size";
export const CHAT_FONT_SIZE_STORAGE_KEY = "claude_orchestrator_chat_font_size";
export const SIDEBAR_FONT_SIZE_DEFAULT = 12;
export const CHAT_FONT_SIZE_DEFAULT = 14;
export const SIDEBAR_FONT_SIZE_OPTIONS = [10, 11, 12, 13, 14] as const;
export const CHAT_FONT_SIZE_OPTIONS = [12, 13, 14, 15, 16] as const;
export const V2_CHAT_STORAGE_KEY = "claude_orchestrator_v2_chat";

export const CUSTOM_CHECKS_STORAGE_KEY = "claude_orchestrator_custom_checks";
export const CUSTOM_SKILL_REPOS_STORAGE_KEY = "claude_orchestrator_custom_skill_repos";
export const SHORTCUTS_STORAGE_KEY = "claude_orchestrator_shortcuts";

export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  {
    id: "toggleLeftSidebar",
    label: "Toggle left sidebar",
    defaultKeys: { code: "BracketLeft", key: "[", meta: true, displayLabel: "⌘[" },
  },
  {
    id: "toggleRightSidebar",
    label: "Toggle right sidebar",
    defaultKeys: { code: "BracketRight", key: "]", meta: true, displayLabel: "⌘]" },
  },
  {
    id: "showShortcuts",
    label: "Show shortcuts",
    defaultKeys: { key: "/", meta: true, displayLabel: "⌘/" },
  },
  {
    id: "newWorkspace",
    label: "New workspace",
    defaultKeys: { key: "=", meta: true, displayLabel: "⌘+" },
  },
  {
    id: "closeDialog",
    label: "Close dialog",
    defaultKeys: { key: "Escape", displayLabel: "Esc" },
    readonly: true,
  },
  {
    id: "prevWorkspace",
    label: "Previous workspace",
    defaultKeys: { key: "ArrowUp", meta: true, displayLabel: "⌘↑" },
  },
  {
    id: "nextWorkspace",
    label: "Next workspace",
    defaultKeys: { key: "ArrowDown", meta: true, displayLabel: "⌘↓" },
  },
  {
    id: "switchRepo",
    label: "Switch to repository 1–9",
    defaultKeys: { key: "1", meta: true, displayLabel: "⌘1–9" },
    readonly: true,
  },
  {
    id: "openSettings",
    label: "Open Settings",
    defaultKeys: { key: ";", meta: true, displayLabel: "⌘;" },
    readonly: true,
  },
];

export const DEFAULT_WORKSPACE_GROUPS: WorkspaceGroup[] = [
  { id: "in-progress", label: "In progress", statuses: ["running"] },
  { id: "in-review", label: "In review", statuses: ["inReview"] },
  { id: "ready", label: "Ready", statuses: ["idle", "initializing"] },
  { id: "done", label: "Done", statuses: ["merged"] },
];
