import type { WorkspaceGroup, ShortcutBinding } from "./types";

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
  { value: "opus", label: "Opus 4.6" },
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

export const PROMPT_SHORTCUTS_STORAGE_KEY = "claude_orchestrator_prompt_shortcuts";
export const ENV_OVERRIDES_STORAGE_KEY = "claude_orchestrator_env_overrides";
export const CLAUDE_MODE_STORAGE_KEY = "claude_orchestrator_mode";
export const MODEL_STORAGE_KEY = "claude_orchestrator_model";
export const MODEL_BY_WORKSPACE_STORAGE_KEY = "claude_orchestrator_model_by_workspace";
export const THINKING_MODE_STORAGE_KEY = "claude_orchestrator_thinking_mode";
export const PERMISSION_MODE_STORAGE_KEY = "claude_orchestrator_permission_mode";
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
