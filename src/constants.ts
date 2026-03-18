import type { WorkspaceGroup } from "./types";

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
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];
export const DEFAULT_MODEL_ID = "opus";

export const PROMPT_SHORTCUTS_STORAGE_KEY = "claude_orchestrator_prompt_shortcuts";
export const ENV_OVERRIDES_STORAGE_KEY = "claude_orchestrator_env_overrides";
export const CLAUDE_MODE_STORAGE_KEY = "claude_orchestrator_mode";
export const MODEL_STORAGE_KEY = "claude_orchestrator_model";
export const MODEL_BY_WORKSPACE_STORAGE_KEY = "claude_orchestrator_model_by_workspace";
export const THINKING_MODE_STORAGE_KEY = "claude_orchestrator_thinking_mode";
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

export const DEFAULT_WORKSPACE_GROUPS: WorkspaceGroup[] = [
  { id: "in-progress", label: "In progress", statuses: ["running"] },
  { id: "in-review", label: "In review", statuses: ["inReview"] },
  { id: "ready", label: "Ready", statuses: ["idle", "initializing"] },
  { id: "done", label: "Done", statuses: ["merged"] },
];
