import { isValidElement, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  AgentMessage,
  ActivityLine,
  AskUserQuestionPayload,
  QuestionItem,
  QuestionOption,
  ShortcutBinding,
  ShortcutKeys,
  ThemeDraft,
  Workspace,
  WorkspaceGroup,
} from "./types";
import { SHORTCUTS_STORAGE_KEY } from "./constants";
import {
  COLOR_TOKEN_KEYS,
  type ThemeColorTokenKey,
  type ThemeDefinition,
} from "./themes";

export const MAX_ASSISTANT_STREAM_CHECKPOINTS = 12;

export const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

export function compactActivityLines(messages: AgentMessage[]): ActivityLine[] {
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

export function messageIdentity(message: AgentMessage): string {
  return `${message.timestamp}::${message.agentId}::${message.role ?? ""}`;
}

export function isAssistantStreamingMessage(message: AgentMessage): boolean {
  return (message.role ?? "") === "assistant" && !message.isError;
}

export function shouldAppendAssistantCheckpoint(previousContent: string, nextContent: string): boolean {
  const previous = previousContent.replace(/\r\n/g, "\n");
  const next = nextContent.replace(/\r\n/g, "\n");
  if (!next.trim() || next === previous) {
    return false;
  }

  // If Claude rewrites/shortens the draft, keep both versions visible.
  if (next.length <= previous.length) {
    return true;
  }

  const addedLength = next.length - previous.length;
  const previousNewlines = (previous.match(/\n/g) || []).length;
  const nextNewlines = (next.match(/\n/g) || []).length;
  const previousFenceCount = (previous.match(/```/g) || []).length;
  const nextFenceCount = (next.match(/```/g) || []).length;

  if (nextNewlines > previousNewlines && addedLength >= 12) {
    return true;
  }
  if (/[.!?]\s*$/.test(next) && addedLength >= 24) {
    return true;
  }
  if (nextFenceCount > previousFenceCount) {
    return true;
  }
  return addedLength >= 160;
}

export function upsertMessageByIdentity(messages: AgentMessage[], incoming: AgentMessage): AgentMessage[] {
  const key = messageIdentity(incoming);
  let existingIndex = -1;
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    if (messageIdentity(messages[idx]) === key) {
      existingIndex = idx;
      break;
    }
  }
  if (existingIndex < 0) {
    return [...messages, incoming];
  }
  const existing = messages[existingIndex];
  if (
    existing.content === incoming.content &&
    existing.isError === incoming.isError &&
    (existing.role ?? "") === (incoming.role ?? "")
  ) {
    return messages;
  }

  if (isAssistantStreamingMessage(existing) && isAssistantStreamingMessage(incoming)) {
    if (shouldAppendAssistantCheckpoint(existing.content, incoming.content)) {
      let checkpointCount = 0;
      for (const message of messages) {
        if (messageIdentity(message) !== key) continue;
        checkpointCount += 1;
        if (checkpointCount >= MAX_ASSISTANT_STREAM_CHECKPOINTS) {
          const next = [...messages];
          next[existingIndex] = incoming;
          return next;
        }
      }
      return [...messages, incoming];
    }
    const next = [...messages];
    next[existingIndex] = incoming;
    return next;
  }

  return [...messages, incoming];
}

export function shortText(value: string, maxLength = 120): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

export function extractTextFromNode(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((item) => extractTextFromNode(item)).join("");
  }
  if (isValidElement(node)) {
    return extractTextFromNode((node.props as { children?: ReactNode }).children);
  }
  return "";
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const success = document.execCommand("copy");
      document.body.removeChild(textArea);
      return success;
    } catch {
      return false;
    }
  }
}

export function normalizeExternalHref(rawHref?: string | null): string | null {
  if (!rawHref) return null;
  const trimmed = rawHref.trim();
  if (!trimmed) return null;
  const candidate = /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function splitTextWithUrls(text: string): Array<{ text: string; href?: string }> {
  const output: Array<{ text: string; href?: string }> = [];
  let lastIndex = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const raw = match[0];
    if (index > lastIndex) {
      output.push({ text: text.slice(lastIndex, index) });
    }

    let candidate = raw;
    let trailing = "";
    while (candidate.length > 0 && /[),.;!?]$/.test(candidate)) {
      trailing = candidate.slice(-1) + trailing;
      candidate = candidate.slice(0, -1);
    }

    const href = normalizeExternalHref(candidate);
    if (href) {
      output.push({ text: candidate, href });
    } else {
      output.push({ text: raw });
      trailing = "";
    }

    if (trailing) {
      output.push({ text: trailing });
    }
    lastIndex = index + raw.length;
  }

  if (lastIndex < text.length) {
    output.push({ text: text.slice(lastIndex) });
  }

  return output.length > 0 ? output : [{ text }];
}

export async function openExternalHref(rawHref?: string | null): Promise<void> {
  const href = normalizeExternalHref(rawHref);
  if (!href) return;
  try {
    await openUrl(href);
  } catch {
    window.open(href, "_blank", "noopener,noreferrer");
  }
}

export function toWorkspaceRelativePath(absolutePath: string, workspaceRoot: string): string | null {
  const normalizedAbsolute = absolutePath.replace(/\\/g, "/");
  const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "");

  if (normalizedAbsolute === normalizedRoot) {
    return "";
  }
  if (!normalizedAbsolute.startsWith(`${normalizedRoot}/`)) {
    return null;
  }
  return normalizedAbsolute.slice(normalizedRoot.length + 1);
}

/** When a workspace is dragged into a group, which status should it get? Uses the first non-system status. */
export function statusForGroup(group: WorkspaceGroup): Workspace["status"] | null {
  const settable = group.statuses.filter((s) => s !== "initializing");
  return settable[0] ?? null;
}

export function cloneThemeColors(source: Record<ThemeColorTokenKey, string>): Record<ThemeColorTokenKey, string> {
  const colors = {} as Record<ThemeColorTokenKey, string>;
  for (const key of COLOR_TOKEN_KEYS) {
    colors[key] = source[key];
  }
  return colors;
}

export function createThemeDraftFromTheme(theme: ThemeDefinition): ThemeDraft {
  return {
    label: theme.label,
    description: theme.description,
    rootText: theme.rootText,
    rootBackground: theme.rootBackground,
    colors: cloneThemeColors(theme.colors),
  };
}

export function isTruthyEnvValue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function upsertEnvOverrideLine(raw: string, targetKey: string, nextValue: string | null): string {
  const lines = raw.split("\n");
  const result: string[] = [];
  let didWriteTarget = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      result.push(line);
      continue;
    }

    let candidate = trimmed;
    if (candidate.startsWith("export ")) {
      candidate = candidate.slice("export ".length).trim();
    } else if (candidate.startsWith("set ")) {
      candidate = candidate.slice("set ".length).trim();
    }

    const eqIndex = candidate.indexOf("=");
    if (eqIndex <= 0) {
      result.push(line);
      continue;
    }

    const key = candidate.slice(0, eqIndex).trim();
    if (key !== targetKey) {
      result.push(line);
      continue;
    }

    if (!didWriteTarget && nextValue !== null) {
      result.push(`export ${targetKey}=${nextValue}`);
      didWriteTarget = true;
    }
  }

  if (!didWriteTarget && nextValue !== null) {
    if (result.length > 0 && result[result.length - 1].trim().length > 0) {
      result.push("");
    }
    result.push(`export ${targetKey}=${nextValue}`);
  }

  while (result.length > 0 && result[result.length - 1].trim().length === 0) {
    result.pop();
  }

  return result.join("\n");
}

export function parseAskUserQuestionPayload(raw: string): AskUserQuestionPayload | null {
  try {
    const parsed = JSON.parse(raw) as { questions?: unknown };
    if (!parsed || !Array.isArray(parsed.questions)) {
      return null;
    }

    const questions: QuestionItem[] = parsed.questions
      .map((item: unknown) => {
        const source = item as {
          question?: unknown;
          header?: unknown;
          multiSelect?: unknown;
          options?: unknown;
        };
        const question = typeof source.question === "string" ? source.question.trim() : "";
        const header = typeof source.header === "string" ? source.header.trim() : undefined;
        const multiSelect = typeof source.multiSelect === "boolean" ? source.multiSelect : undefined;
        const options: QuestionOption[] = [];
        if (Array.isArray(source.options)) {
          for (const opt of source.options) {
            const optSource = opt as { label?: unknown; description?: unknown };
            const label = typeof optSource.label === "string" ? optSource.label.trim() : "";
            if (!label) continue;
            const description =
              typeof optSource.description === "string" ? optSource.description.trim() : undefined;
            const normalized: QuestionOption = { label };
            if (description) {
              normalized.description = description;
            }
            options.push(normalized);
          }
        }

        return {
          question,
          header,
          multiSelect,
          options,
        };
      })
      .filter((item: QuestionItem) => item.question.length > 0 || (item.options?.length ?? 0) > 0);

    if (questions.length === 0) {
      return null;
    }

    return { questions };
  } catch {
    return null;
  }
}

export function buildBundledQuestionAnswerText(
  payload: AskUserQuestionPayload,
  selectedAnswersByQuestion: Record<number, string[]>,
): string {
  return payload.questions
    .map((question, questionIdx) => {
      const promptText = question.question || question.header || `Question ${questionIdx + 1}`;
      const selectedValues = selectedAnswersByQuestion[questionIdx] || [];
      return `${questionIdx + 1}. ${promptText}: ${selectedValues.join(", ")}`;
    })
    .join("\n");
}

// ─── Shortcut utilities ─────────────────────────────────────────────

/** Load user's custom shortcut overrides from localStorage. */
export function loadCustomShortcuts(): Record<string, ShortcutKeys> {
  try {
    const raw = localStorage.getItem(SHORTCUTS_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Record<string, ShortcutKeys>;
  } catch {
    // ignore corrupt data
  }
  return {};
}

/** Persist custom shortcut overrides to localStorage. */
export function saveCustomShortcuts(overrides: Record<string, ShortcutKeys>): void {
  try {
    if (Object.keys(overrides).length > 0) {
      localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(overrides));
    } else {
      localStorage.removeItem(SHORTCUTS_STORAGE_KEY);
    }
  } catch {
    // localStorage may be full or unavailable
  }
}

/** Merge default shortcuts with user overrides, returning the resolved list. */
export function resolveShortcuts(
  defaults: ShortcutBinding[],
  overrides: Record<string, ShortcutKeys>,
): ShortcutBinding[] {
  return defaults.map((binding) => {
    const custom = overrides[binding.id];
    if (custom && !binding.readonly) {
      return { ...binding, customKeys: custom };
    }
    return binding;
  });
}

/** Get the active keys (custom or default) for a shortcut binding. */
export function activeKeys(binding: ShortcutBinding): ShortcutKeys {
  return binding.customKeys ?? binding.defaultKeys;
}

/** Check whether a KeyboardEvent matches a ShortcutKeys definition. */
export function shortcutMatchesEvent(keys: ShortcutKeys, e: KeyboardEvent): boolean {
  if (keys.meta && !e.metaKey) return false;
  if (!keys.meta && e.metaKey) return false;
  if (keys.shift && !e.shiftKey) return false;
  if (!keys.shift && e.shiftKey) return false;
  if (keys.alt && !e.altKey) return false;
  if (!keys.alt && e.altKey) return false;
  if (keys.code) return e.code === keys.code;
  return e.key === keys.key;
}

const KEY_DISPLAY_MAP: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Backspace: "⌫",
  Delete: "⌦",
  Enter: "↵",
  Tab: "⇥",
  " ": "Space",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Minus: "-",
  Equal: "+",
};

/** Build a human-readable display label from a ShortcutKeys (e.g. "⌘⇧["). */
export function formatKeyCombination(keys: ShortcutKeys): string {
  let label = "";
  if (keys.meta) label += "⌘";
  if (keys.alt) label += "⌥";
  if (keys.shift) label += "⇧";
  const mainKey = keys.code
    ? (KEY_DISPLAY_MAP[keys.code] ?? keys.code)
    : (KEY_DISPLAY_MAP[keys.key] ?? keys.key.toUpperCase());
  return label + mainKey;
}

/** Extract a ShortcutKeys from a live KeyboardEvent (for recording new bindings). Returns null if only modifiers are pressed. */
export function recordKeysFromEvent(e: KeyboardEvent): ShortcutKeys | null {
  // Ignore bare modifier presses
  if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return null;
  const keys: ShortcutKeys = {
    key: e.key,
    meta: e.metaKey || undefined,
    shift: e.shiftKey || undefined,
    alt: e.altKey || undefined,
    displayLabel: "", // will be computed
  };
  // For bracket-style keys, prefer code for accurate matching
  if (e.code && /^(Bracket|Backslash|Slash|Semicolon|Quote|Comma|Period|Minus|Equal)/.test(e.code)) {
    keys.code = e.code;
  }
  keys.displayLabel = formatKeyCombination(keys);
  return keys;
}

/** Check if a new binding conflicts with existing shortcuts. Returns the conflicting shortcut label or null. */
export function detectShortcutConflict(
  shortcuts: ShortcutBinding[],
  changedId: string,
  newKeys: ShortcutKeys,
): string | null {
  for (const binding of shortcuts) {
    if (binding.id === changedId) continue;
    const existing = activeKeys(binding);
    if (
      existing.key === newKeys.key &&
      (existing.code ?? null) === (newKeys.code ?? null) &&
      !!existing.meta === !!newKeys.meta &&
      !!existing.shift === !!newKeys.shift &&
      !!existing.alt === !!newKeys.alt
    ) {
      return binding.label;
    }
  }
  return null;
}
