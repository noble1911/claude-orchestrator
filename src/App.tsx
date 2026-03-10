import { useState, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

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
  status: "idle" | "running" | "inReview" | "merged";
  lastActivity?: string;
  prUrl?: string;
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
  connectUrl: string;
}

interface AppStatus {
  repositories: Repository[];
  serverStatus: ServerStatus;
}

interface UpdateInfo {
  currentVersion: string;
  version: string;
  body?: string | null;
  date?: string | null;
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

interface WorkspaceCheckDefinition {
  name: string;
  command: string;
  description: string;
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
  autoRunOnCreate?: boolean;
}

interface CenterTab {
  id: string;
  type: "chat" | "file" | "diff";
  title: string;
  path?: string;
  status?: string;
  oldPath?: string;
}

type ClaudeMode = "normal" | "plan";
type EditorKind = "vscode" | "intellij";
type WorkspaceOpenTarget = "" | EditorKind | "terminal";

interface ActivityLine {
  text: string;
  count: number;
}

interface ActivityGroup {
  id: string;
  messages: AgentMessage[];
  lines: ActivityLine[];
}

interface QuestionOption {
  label: string;
  description?: string;
}

interface QuestionItem {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: QuestionOption[];
}

interface AskUserQuestionPayload {
  questions: QuestionItem[];
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

function messageIdentity(message: AgentMessage): string {
  return `${message.timestamp}::${message.agentId}::${message.role ?? ""}`;
}

function isAssistantStreamingMessage(message: AgentMessage): boolean {
  return (message.role ?? "") === "assistant" && !message.isError;
}

function upsertMessageByIdentity(messages: AgentMessage[], incoming: AgentMessage): AgentMessage[] {
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
    const next = [...messages];
    next[existingIndex] = incoming;
    return next;
  }

  return [...messages, incoming];
}

function shortText(value: string, maxLength = 120): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function MarkdownMessage({ content }: { content: string }) {
  const normalizedContent = content.replace(/\r\n/g, "\n");
  if (!normalizedContent.trim()) {
    return <p className="whitespace-pre-wrap text-sm md-text-primary">{normalizedContent}</p>;
  }

  return (
    <div className="space-y-3">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          p: ({ children }) => (
            <p className="m-0 whitespace-pre-wrap text-sm leading-relaxed md-text-primary">{children}</p>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-white/35 underline-offset-2 hover:decoration-white/70"
            >
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="font-semibold md-text-strong">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ className, children }) => {
            const text = String(children ?? "");
            const isBlock = Boolean(className?.includes("language-")) || text.includes("\n");
            if (isBlock) {
              return <code className={className}>{children}</code>;
            }
            return <code className="rounded-md bg-white/10 px-1.5 py-0.5 font-mono text-[12px]">{children}</code>;
          },
          pre: ({ children }) => (
            <pre className="m-0 max-h-[50vh] overflow-auto rounded-xl border md-outline bg-black/45 px-3 py-2 whitespace-pre font-mono text-[12px] md-text-primary">
              {children}
            </pre>
          ),
          h1: ({ children }) => <h1 className="m-0 text-xl font-semibold leading-snug md-text-strong">{children}</h1>,
          h2: ({ children }) => <h2 className="m-0 text-lg font-semibold leading-snug md-text-strong">{children}</h2>,
          h3: ({ children }) => <h3 className="m-0 text-base font-semibold leading-snug md-text-strong">{children}</h3>,
          h4: ({ children }) => <h4 className="m-0 text-sm font-semibold leading-snug md-text-strong">{children}</h4>,
          h5: ({ children }) => <h5 className="m-0 text-sm font-medium leading-snug md-text-strong">{children}</h5>,
          h6: ({ children }) => <h6 className="m-0 text-sm font-medium leading-snug md-text-dim">{children}</h6>,
          ul: ({ children }) => <ul className="m-0 ml-5 list-disc space-y-1.5 text-sm md-text-primary">{children}</ul>,
          ol: ({ children }) => (
            <ol className="m-0 ml-5 list-decimal space-y-1.5 text-sm md-text-primary">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          hr: () => <hr className="border-0 border-t md-outline" />,
          blockquote: ({ children }) => (
            <blockquote className="m-0 border-l-2 border-white/20 pl-3 text-sm leading-relaxed italic md-text-dim">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto rounded-lg border md-outline">
              <table className="w-full border-collapse text-xs md-text-primary">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-white/5">{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => <tr className="border-t md-outline">{children}</tr>,
          th: ({ children }) => (
            <th className="border-r md-outline px-2 py-1 text-left font-semibold md-text-strong last:border-r-0">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-r md-outline px-2 py-1 align-top last:border-r-0">{children}</td>
          ),
        }}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
}

function toWorkspaceRelativePath(absolutePath: string, workspaceRoot: string): string | null {
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

const MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];
const DEFAULT_MODEL_ID = "opus";

const PROMPT_SHORTCUTS_STORAGE_KEY = "claude_orchestrator_prompt_shortcuts";
const ENV_OVERRIDES_STORAGE_KEY = "claude_orchestrator_env_overrides";
const CLAUDE_MODE_STORAGE_KEY = "claude_orchestrator_mode";
const MODEL_STORAGE_KEY = "claude_orchestrator_model";
const THINKING_MODE_STORAGE_KEY = "claude_orchestrator_thinking_mode";
const DEFAULT_REPOSITORY_STORAGE_KEY = "claude_orchestrator_default_repository";
const BEDROCK_ENV_KEY = "CLAUDE_CODE_USE_BEDROCK";

function isTruthyEnvValue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function upsertEnvOverrideLine(raw: string, targetKey: string, nextValue: string | null): string {
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

function parseAskUserQuestionPayload(raw: string): AskUserQuestionPayload | null {
  try {
    const parsed = JSON.parse(raw) as { questions?: unknown };
    if (!parsed || !Array.isArray(parsed.questions)) {
      return null;
    }

    const questions: QuestionItem[] = parsed.questions
      .map((item) => {
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
      .filter((item) => item.question.length > 0 || (item.options?.length ?? 0) > 0);

    if (questions.length === 0) {
      return null;
    }

    return { questions };
  } catch {
    return null;
  }
}

interface QuestionCardProps {
  message: AgentMessage;
  rowId: string;
  isAnswered: boolean;
  onAnswer: (answer: string) => void;
}

function buildBundledQuestionAnswerText(
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

function QuestionCard({ message, rowId, isAnswered, onAnswer }: QuestionCardProps) {
  const payload = useMemo(() => parseAskUserQuestionPayload(message.content), [message.content]);
  const [selectedAnswersByQuestion, setSelectedAnswersByQuestion] = useState<Record<number, string[]>>({});

  useEffect(() => {
    setSelectedAnswersByQuestion({});
  }, [message.timestamp, message.content]);

  if (!payload) {
    return (
      <div className="mt-3">
        <MarkdownMessage content={message.content} />
      </div>
    );
  }

  const canBundleAnswers =
    payload.questions.length > 1 &&
    payload.questions.every((question) => (question.options?.length ?? 0) > 0);

  const canSubmitBundledAnswers =
    canBundleAnswers &&
    payload.questions.every((_, questionIdx) => (selectedAnswersByQuestion[questionIdx]?.length ?? 0) > 0);

  const selectOption = (questionIdx: number, question: QuestionItem, optionLabel: string) => {
    if (isAnswered) return;
    if (!canBundleAnswers) {
      onAnswer(optionLabel);
      return;
    }

    setSelectedAnswersByQuestion((prev) => {
      const existing = prev[questionIdx] || [];
      if (question.multiSelect) {
        const hasValue = existing.includes(optionLabel);
        const nextValues = hasValue
          ? existing.filter((value) => value !== optionLabel)
          : [...existing, optionLabel];
        return { ...prev, [questionIdx]: nextValues };
      }
      return { ...prev, [questionIdx]: [optionLabel] };
    });
  };

  const submitBundledAnswers = () => {
    if (isAnswered || !canSubmitBundledAnswers) return;
    onAnswer(buildBundledQuestionAnswerText(payload, selectedAnswersByQuestion));
  };

  return (
    <div className="rounded-xl border md-outline bg-white/[0.03] p-3">
      <div className="mb-2 text-[11px] uppercase tracking-wide md-text-faint">Question</div>
      <div className="space-y-3">
        {payload.questions.map((question, questionIdx) => (
          <div key={`${rowId}-question-${questionIdx}`} className="space-y-2">
            {question.header && <div className="text-xs md-text-muted">{question.header}</div>}
            {question.question && <div className="text-sm md-text-primary">{question.question}</div>}
            {question.options && question.options.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {question.options.map((option, optionIdx) => (
                  <button
                    key={`${rowId}-option-${questionIdx}-${optionIdx}`}
                    type="button"
                    className={`md-chip transition hover:border-white/35 disabled:cursor-not-allowed disabled:opacity-55 ${
                      canBundleAnswers && (selectedAnswersByQuestion[questionIdx] || []).includes(option.label)
                        ? "border-white/45 bg-white/12"
                        : ""
                    }`}
                    disabled={isAnswered}
                    onClick={() => selectOption(questionIdx, question, option.label)}
                    title={option.description || option.label}
                  >
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {!isAnswered && canBundleAnswers && (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            className="rounded-md border md-outline px-3 py-1.5 text-xs font-medium md-text-primary transition hover:border-white/35 disabled:cursor-not-allowed disabled:opacity-55"
            disabled={!canSubmitBundledAnswers}
            onClick={submitBundledAnswers}
          >
            Submit answers
          </button>
          <span className="text-xs md-text-muted">
            {canSubmitBundledAnswers
              ? "Ready to send all answers."
              : "Select one option for each question before submitting."}
          </span>
        </div>
      )}
      {!isAnswered && (
        <div className={`text-xs md-text-muted ${canBundleAnswers ? "mt-2" : "mt-3"}`}>
          Or type a custom answer in the main chat box below.
        </div>
      )}
    </div>
  );
}

function App() {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [defaultRepoId, setDefaultRepoId] = useState<string | null>(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availableUpdate, setAvailableUpdate] = useState<UpdateInfo | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [inputMessage, setInputMessage] = useState("");
  const [activeRightTab, setActiveRightTab] = useState<"prompts" | "files" | "changes" | "checks">("prompts");
  const [workspaceFilesByPath, setWorkspaceFilesByPath] = useState<Record<string, WorkspaceFileEntry[]>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileContentsByPath, setFileContentsByPath] = useState<Record<string, string>>({});
  const [isLoadingFileContent, setIsLoadingFileContent] = useState(false);
  const [diffContentsByTab, setDiffContentsByTab] = useState<Record<string, string>>({});
  const [loadingDiffTabId, setLoadingDiffTabId] = useState<string | null>(null);
  const [centerTabs, setCenterTabs] = useState<CenterTab[]>([{ id: "chat", type: "chat", title: "Chat" }]);
  const [activeCenterTabId, setActiveCenterTabId] = useState("chat");
  const [workspaceChanges, setWorkspaceChanges] = useState<WorkspaceChangeEntry[]>([]);
  const [isLoadingChanges, setIsLoadingChanges] = useState(false);
  const [checkResults, setCheckResults] = useState<WorkspaceCheckResult[]>([]);
  const [detectedChecks, setDetectedChecks] = useState<WorkspaceCheckDefinition[]>([]);
  const [isLoadingDetectedChecks, setIsLoadingDetectedChecks] = useState(false);
  const [isRunningChecks, setIsRunningChecks] = useState(false);
  const [promptShortcuts, setPromptShortcuts] = useState<PromptShortcut[]>([]);
  const [showAddPromptForm, setShowAddPromptForm] = useState(false);
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const [newPromptName, setNewPromptName] = useState("");
  const [newPromptBody, setNewPromptBody] = useState("");
  const [newPromptAutoRunOnCreate, setNewPromptAutoRunOnCreate] = useState(false);
  const [envOverridesText, setEnvOverridesText] = useState("");
  const [claudeMode, setClaudeMode] = useState<ClaudeMode>("normal");
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL_ID);
  const [thinkingMode, setThinkingMode] = useState<"off" | "low" | "medium" | "high">("off");
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(false);
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(false);
  const [autoStartingWorkspaceId, setAutoStartingWorkspaceId] = useState<string | null>(null);
  const [expandedActivityIdsByWorkspace, setExpandedActivityIdsByWorkspace] = useState<Record<string, string[]>>({});
  const [credentialErrorWorkspaces, setCredentialErrorWorkspaces] = useState<Set<string>>(new Set());
  const [answeredQuestionTimestamps, setAnsweredQuestionTimestamps] = useState<Set<string>>(new Set());
  const [thinkingSinceByWorkspace, setThinkingSinceByWorkspace] = useState<Record<string, number | null>>({});
  const [thinkingElapsedSec, setThinkingElapsedSec] = useState(0);
  const [showRenameForm, setShowRenameForm] = useState(false);
  const [renameWorkspaceId, setRenameWorkspaceId] = useState<string | null>(null);
  const [renameWorkspaceName, setRenameWorkspaceName] = useState("");
  const [workspaceOpenTarget, setWorkspaceOpenTarget] = useState<WorkspaceOpenTarget>("");
  const [leftPanelWidth, setLeftPanelWidth] = useState(280);
  const [rightPanelWidth, setRightPanelWidth] = useState(360);
  const [terminalHeight, setTerminalHeight] = useState(180);
  const [isResizingLeft, setIsResizingLeft] = useState(false);
  const [isResizingRight, setIsResizingRight] = useState(false);
  const [isResizingTerminal, setIsResizingTerminal] = useState(false);
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalHistoryByWorkspace, setTerminalHistoryByWorkspace] = useState<Record<string, string[]>>({});
  const [terminalHistoryIndex, setTerminalHistoryIndex] = useState<number | null>(null);
  const [terminalLinesByWorkspace, setTerminalLinesByWorkspace] = useState<Record<string, TerminalLine[]>>({});
  const [unreadByWorkspace, setUnreadByWorkspace] = useState<Record<string, number>>({});
  const [isRunningTerminalCommand, setIsRunningTerminalCommand] = useState(false);
  const [isTogglingRemoteServer, setIsTogglingRemoteServer] = useState(false);
  const [terminalTab, setTerminalTab] = useState<"setup" | "remote" | "terminal">("terminal");
  const [pendingAutoPromptsByWorkspace, setPendingAutoPromptsByWorkspace] = useState<Record<string, PromptShortcut[]>>({});
  const startingWorkspaceIdsRef = useRef<Set<string>>(new Set());
  const selectedWorkspaceRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const terminalEndRef = useRef<HTMLDivElement>(null);
  const terminalInputRef = useRef<HTMLInputElement>(null);
  const bedrockEnabled = useMemo(
    () => isTruthyEnvValue(parseEnvOverrides(envOverridesText)[BEDROCK_ENV_KEY]),
    [envOverridesText],
  );

  useEffect(() => {
    selectedWorkspaceRef.current = selectedWorkspace;
  }, [selectedWorkspace]);

  function normalizeUpdateErrorMessage(rawError: string): string {
    const message = rawError.trim();
    const lowered = message.toLowerCase();
    if (
      lowered.includes("could not fetch a valid release json from the remote") ||
      lowered.includes("404")
    ) {
      return "Update feed is unavailable for this release.";
    }
    return message;
  }

  function isUnreadCandidateMessage(message: AgentMessage): boolean {
    const role = message.role ?? "";
    if (role === "user" || message.agentId === "user") return false;
    if (role === "assistant" || role === "question" || role === "error" || role === "credential_error") {
      return true;
    }
    return message.isError;
  }

  useEffect(() => {
    loadInitialState();
    // Silent background check on launch; surfaced only on explicit user action.
    void checkForAppUpdate(false, false);
    
    // Listen for agent messages from backend
    const unlisten = listen<AgentMessage>("agent-message", (event) => {
      const messageWorkspaceId = event.payload.workspaceId ?? selectedWorkspaceRef.current;
      if (messageWorkspaceId && selectedWorkspaceRef.current === messageWorkspaceId) {
        setMessages((prev) => upsertMessageByIdentity(prev, event.payload));
      }
      if (
        messageWorkspaceId &&
        selectedWorkspaceRef.current !== messageWorkspaceId &&
        isUnreadCandidateMessage(event.payload)
      ) {
        setUnreadByWorkspace((prev) => ({
          ...prev,
          [messageWorkspaceId]: (prev[messageWorkspaceId] || 0) + 1,
        }));
      }
      if (event.payload.role === "credential_error" && messageWorkspaceId) {
        setCredentialErrorWorkspaces((prev) => new Set(prev).add(messageWorkspaceId));
      }
      const inferredRole =
        event.payload.role ??
        (event.payload.agentId === "user" || event.payload.content.trimStart().startsWith(">")
          ? "user"
          : "assistant");
      const isTerminalResponse =
        event.payload.isError || inferredRole === "assistant" || inferredRole === "question";
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
    try {
      if (defaultRepoId) {
        localStorage.setItem(DEFAULT_REPOSITORY_STORAGE_KEY, defaultRepoId);
      } else {
        localStorage.removeItem(DEFAULT_REPOSITORY_STORAGE_KEY);
      }
    } catch (err) {
      console.error("Failed to persist default repository:", err);
    }
  }, [defaultRepoId]);

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
        const next = { ...prev };
        delete next[selectedWorkspace];
        return next;
      });
    } else {
      setMessages([]);
    }
  }, [selectedWorkspace]);

  useEffect(() => {
    const validWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
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
  }, [workspaces]);

  useEffect(() => {
    const unreadTotal = Object.values(unreadByWorkspace).reduce((sum, count) => sum + count, 0);
    getCurrentWindow()
      .setBadgeCount(unreadTotal > 0 ? unreadTotal : undefined)
      .catch(() => {
        // Ignore unsupported platform badge operations.
      });
  }, [unreadByWorkspace]);

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

  // Periodically sync workspace review states from GitHub PR state.
  useEffect(() => {
    const hasUnmerged = workspaces.some((ws) => ws.status !== "merged");
    if (!hasUnmerged || !selectedRepo) return;
    const sync = async () => {
      try {
        await invoke<string[]>("sync_pr_statuses");
        await loadWorkspaces(selectedRepo);
      } catch {
        // Silently ignore — gh CLI may not be available
      }
    };
    void sync();
    const interval = setInterval(() => void sync(), 60_000);
    return () => clearInterval(interval);
  }, [selectedRepo, workspaces.filter((ws) => ws.status !== "merged").length]);

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
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const normalized: PromptShortcut[] = parsed
          .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
          .map((item, index) => {
            const name = typeof item.name === "string" ? item.name : "";
            const prompt = typeof item.prompt === "string" ? item.prompt : "";
            const id =
              typeof item.id === "string" && item.id.trim()
                ? item.id
                : `${Date.now()}-${index}-${Math.floor(Math.random() * 100000)}`;
            return {
              id,
              name,
              prompt,
              autoRunOnCreate: item.autoRunOnCreate === true,
            };
          })
          .filter((item) => item.name.trim() && item.prompt.trim());
        setPromptShortcuts(normalized);
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
    try {
      const raw = localStorage.getItem(MODEL_STORAGE_KEY);
      if (raw && raw.trim().length > 0) {
        const normalized = raw.trim();
        const isKnownOption = MODEL_OPTIONS.some((option) => option.value === normalized);
        if (isKnownOption) {
          setSelectedModel(normalized);
        } else {
          setSelectedModel(DEFAULT_MODEL_ID);
        }
      }
    } catch (err) {
      console.error("Failed to load model selection:", err);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(MODEL_STORAGE_KEY, selectedModel);
    } catch (err) {
      console.error("Failed to persist model selection:", err);
    }
  }, [selectedModel]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(THINKING_MODE_STORAGE_KEY);
      if (raw === "off" || raw === "low" || raw === "medium" || raw === "high") {
        setThinkingMode(raw);
      }
    } catch (err) {
      console.error("Failed to load thinking mode:", err);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(THINKING_MODE_STORAGE_KEY, thinkingMode);
    } catch (err) {
      console.error("Failed to persist thinking mode:", err);
    }
  }, [thinkingMode]);

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
      setDiffContentsByTab({});
      setLoadingDiffTabId(null);
      setCenterTabs([{ id: "chat", type: "chat", title: "Chat" }]);
      setActiveCenterTabId("chat");
      setWorkspaceChanges([]);
      setCheckResults([]);
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
    setDiffContentsByTab({});
    setLoadingDiffTabId(null);
    setCenterTabs([{ id: "chat", type: "chat", title: "Chat" }]);
    setActiveCenterTabId("chat");
    setWorkspaceChanges([]);
    setCheckResults([]);
    setDetectedChecks([]);
    setTerminalInput("");
    setAttachedFiles([]);
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
    if (activeRightTab === "checks") {
      loadWorkspaceCheckDefinitions(selectedWorkspace);
    }
  }, [activeRightTab, selectedWorkspace]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    void ensureAgentForWorkspace(selectedWorkspace);
  }, [selectedWorkspace]);

  useEffect(() => {
    if (!selectedWorkspace) return;
    const pending = pendingAutoPromptsByWorkspace[selectedWorkspace] || [];
    if (pending.length === 0) return;

    const thinkingSince = thinkingSinceByWorkspace[selectedWorkspace] ?? null;
    if (thinkingSince !== null) return;

    const hasRunningAgent = agents.some(
      (agent) => agent.workspaceId === selectedWorkspace && agent.status === "running",
    );
    if (!hasRunningAgent) return;

    let cancelled = false;
    const nextPrompt = pending[0];
    const visibleLabel = `/auto ${nextPrompt.name}`;

    const runAutoPrompt = async () => {
      const sent = await sendMessage(nextPrompt.prompt, visibleLabel);
      if (cancelled) return;
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
    };

    void runAutoPrompt();
    return () => {
      cancelled = true;
    };
  }, [selectedWorkspace, pendingAutoPromptsByWorkspace, thinkingSinceByWorkspace, agents]);

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
      
      const ag = await invoke<Agent[]>("list_agents");
      setAgents(ag);
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
        if (repositories.length === 0) {
          setDefaultRepoId(repo.id);
        }
      }
    } catch (err) {
      console.error("Failed to add repository:", err);
      setError(String(err));
    }
  }

  function handleSelectRepository(repoId: string) {
    if (repoId === selectedRepo) return;
    setSelectedRepo(repoId);
    setSelectedWorkspace(null);
    setMessages([]);
  }

  function setDefaultRepository(repoId: string) {
    setDefaultRepoId(repoId);
    handleSelectRepository(repoId);
  }

  async function removeRepository(repoId: string) {
    try {
      const removedWorkspaceIds = new Set(
        workspaces.filter((workspace) => workspace.repoId === repoId).map((workspace) => workspace.id),
      );

      await invoke("remove_repository", { repoId });

      const remainingRepos = repositories.filter((repo) => repo.id !== repoId);
      setRepositories(remainingRepos);
      setWorkspaces((prev) => prev.filter((workspace) => workspace.repoId !== repoId));
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

  async function createWorkspace() {
    if (!newWorkspaceName.trim() || !selectedRepo) return;
    
    try {
      const workspace = await invoke<Workspace>("create_workspace", { 
        repoId: selectedRepo,
        name: newWorkspaceName.trim() 
      });
      const autoRunPrompts = promptShortcuts.filter((shortcut) => shortcut.autoRunOnCreate);
      setWorkspaces(prev => [...prev, workspace]);
      setNewWorkspaceName("");
      setShowCreateForm(false);
      if (autoRunPrompts.length > 0) {
        setPendingAutoPromptsByWorkspace((prev) => ({
          ...prev,
          [workspace.id]: autoRunPrompts,
        }));
      }
      setSelectedWorkspace(workspace.id);
      setIsLeftPanelOpen(false);
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
      setPendingAutoPromptsByWorkspace((prev) => {
        const next = { ...prev };
        delete next[workspaceId];
        return next;
      });
      if (selectedWorkspace === workspaceId) {
        const remaining = workspaces.filter(w => w.id !== workspaceId);
        const next = remaining.length > 0 ? remaining[0].id : null;
        setSelectedWorkspace(next);
        if (!next) setMessages([]);
      }
      if (renameWorkspaceId === workspaceId) {
        setShowRenameForm(false);
        setRenameWorkspaceId(null);
        setRenameWorkspaceName("");
      }
    } catch (err) {
      console.error("Failed to remove workspace:", err);
      setError(String(err));
    }
  }

  function openRenameWorkspaceForm(workspace: Workspace) {
    setRenameWorkspaceId(workspace.id);
    setRenameWorkspaceName(workspace.name);
    setShowRenameForm(true);
  }

  async function renameWorkspace() {
    if (!renameWorkspaceId || !renameWorkspaceName.trim()) return;
    try {
      const updated = await invoke<Workspace>("rename_workspace", {
        workspaceId: renameWorkspaceId,
        name: renameWorkspaceName.trim(),
      });
      setWorkspaces((prev) => prev.map((workspace) => (workspace.id === updated.id ? updated : workspace)));
      setShowRenameForm(false);
      setRenameWorkspaceId(null);
      setRenameWorkspaceName("");
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

  async function sendMessage(rawMessage?: string, visibleOverride?: string): Promise<boolean> {
    const composedInput = (rawMessage ?? inputMessage).trim();
    if (!composedInput) return false;
    if (selectedWorkspace) {
      dismissCredentialError(selectedWorkspace);
    }
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

    const workspace = workspaces.find((item) => item.id === selectedWorkspace);
    if (!workspace) {
      setError("Workspace not found");
      return false;
    }

    const attachedRelativePaths: string[] = [];
    if (attachedFiles.length > 0) {
      try {
        const attachmentSections: string[] = [];
        for (const absolutePath of attachedFiles) {
          const relativePath = toWorkspaceRelativePath(absolutePath, workspace.worktreePath);
          if (relativePath === null || !relativePath.trim()) {
            continue;
          }

          const content = await invoke<string>("read_workspace_file", {
            workspaceId: workspace.id,
            relativePath,
            maxBytes: 200000,
          });

          attachedRelativePaths.push(relativePath);
          attachmentSections.push(
            `<attached_file path="${relativePath}">\n${content}\n</attached_file>`,
          );
        }

        if (attachmentSections.length > 0) {
          messageToSend = `${messageToSend}\n\nUse these attached files as context:\n\n${attachmentSections.join("\n\n")}`;
        }
      } catch (err) {
        console.error("Failed to prepare attached files:", err);
        setError(String(err));
        return false;
      }
    }

    if (attachedRelativePaths.length > 0) {
      const fileSummary = `[Files: ${attachedRelativePaths.join(", ")}]`;
      visibleMessage = visibleMessage ? `${visibleMessage}\n${fileSummary}` : fileSummary;
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
        model: selectedModel,
        effort: thinkingMode === "off" ? null : thinkingMode,
      });
      if (!rawMessage) {
        setInputMessage("");
      }
      setAttachedFiles([]);
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

  async function addFilesToComposer() {
    const workspace = workspaces.find((item) => item.id === selectedWorkspace);
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
      let ignoredCount = 0;

      for (const item of pickedFiles) {
        if (typeof item !== "string") continue;
        const relativePath = toWorkspaceRelativePath(item, workspace.worktreePath);
        if (relativePath === null) {
          ignoredCount += 1;
          continue;
        }
        accepted.push(item);
      }

      if (accepted.length > 0) {
        setAttachedFiles((prev) => Array.from(new Set([...prev, ...accepted])));
      }
      if (ignoredCount > 0) {
        setError(`${ignoredCount} file(s) were ignored because they are outside the workspace.`);
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
    setEditingPromptId(null);
    setNewPromptName("");
    setNewPromptBody("");
    setNewPromptAutoRunOnCreate(false);
    setShowAddPromptForm(true);
  }

  function openEditPromptForm(shortcut: PromptShortcut) {
    setEditingPromptId(shortcut.id);
    setNewPromptName(shortcut.name);
    setNewPromptBody(shortcut.prompt);
    setNewPromptAutoRunOnCreate(shortcut.autoRunOnCreate === true);
    setShowAddPromptForm(true);
  }

  function deletePromptShortcut(promptId: string) {
    setPromptShortcuts((prev) => prev.filter((shortcut) => shortcut.id !== promptId));
  }

  function addPromptShortcut() {
    const name = newPromptName.trim();
    const prompt = newPromptBody.trim();
    if (!name || !prompt) return;

    const normalized = normalizePromptName(name);
    const hasDuplicate = promptShortcuts.some(
      (shortcut) =>
        shortcut.id !== editingPromptId && normalizePromptName(shortcut.name) === normalized,
    );
    if (hasDuplicate) {
      setError(`Prompt name already exists: ${name}`);
      return;
    }

    if (editingPromptId) {
      setPromptShortcuts((prev) =>
        prev.map((shortcut) =>
          shortcut.id === editingPromptId
            ? {
                ...shortcut,
                name,
                prompt,
                autoRunOnCreate: newPromptAutoRunOnCreate,
              }
            : shortcut,
        ),
      );
    } else {
      setPromptShortcuts((prev) => [
        ...prev,
        {
          id: `${Date.now()}-${Math.floor(Math.random() * 100000)}`,
          name,
          prompt,
          autoRunOnCreate: newPromptAutoRunOnCreate,
        },
      ]);
    }
    setEditingPromptId(null);
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
      setCheckResults(results);
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

  function normalizeChangeStatus(status: string): string {
    return status.trim() || status;
  }

  function getChangeStatusClass(status: string): string {
    const normalized = normalizeChangeStatus(status);
    if (normalized === "??" || normalized.includes("A")) return "text-emerald-300";
    if (normalized.includes("D")) return "text-rose-300";
    if (normalized.includes("R")) return "text-amber-300";
    if (normalized.includes("M")) return "text-sky-300";
    return "md-text-muted";
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

  function getDiffLineClass(line: string): string {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) return "text-indigo-300";
    if (line.startsWith("+")) return "text-emerald-300";
    if (line.startsWith("-")) return "text-rose-300";
    if (line.startsWith("@@")) return "text-amber-300";
    if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("new file mode") || line.startsWith("deleted file mode")) {
      return "md-text-muted";
    }
    return "md-text-primary";
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
      case "running": return "bg-emerald-400";
      case "inReview": return "bg-amber-400";
      case "merged": return "bg-violet-400";
      case "idle": return "bg-zinc-500";
      default: return "bg-zinc-500";
    }
  };

  const workspaceGroups = [
    {
      key: "in-progress",
      label: "In progress",
      items: workspaces.filter((ws) => ws.status === "running"),
    },
    {
      key: "in-review",
      label: "In review",
      items: workspaces.filter((ws) => ws.status === "inReview"),
    },
    {
      key: "ready",
      label: "Ready",
      items: workspaces.filter((ws) => ws.status === "idle"),
    },
    {
      key: "done",
      label: "Done",
      items: workspaces.filter((ws) => ws.status === "merged"),
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
  const derivedAnsweredQuestionTimestamps = useMemo(() => {
    const answered = new Set<string>();
    for (let i = 0; i < workspaceMessages.length; i += 1) {
      const current = workspaceMessages[i];
      if (current.role !== "question") continue;
      for (let j = i + 1; j < workspaceMessages.length; j += 1) {
        const next = workspaceMessages[j];
        if (next.role === "user" || next.agentId === "user") {
          answered.add(current.timestamp);
          break;
        }
        if (next.role === "question") {
          // A newer question supersedes an older pending one.
          answered.add(current.timestamp);
          break;
        }
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

          <div className="mb-4 flex items-center justify-between md-px-1">
            <h2 className="md-title-small">Workspaces</h2>
            <button
              type="button"
              onClick={openCreateWorkspaceForm}
              className="md-icon-plain rounded-full border md-outline disabled:cursor-not-allowed disabled:opacity-45"
              disabled={!selectedRepo}
              title={selectedRepo ? "Add workspace" : "Select a repository first"}
              aria-label={selectedRepo ? "Add workspace" : "Select a repository first"}
            >
              <span className="material-symbols-rounded !text-[18px]">add</span>
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
                  <div
                    key={workspace.id}
                    className={`md-list-item flex items-center gap-2 md-px-3 md-py-2 ${
                      selectedWorkspace === workspace.id
                        ? "md-list-item-active"
                        : ""
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => handleSelectWorkspace(workspace.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${getStatusColor(workspace.status)}`} />
                        <span className="truncate md-body-small md-text-primary">{workspace.name}</span>
                        {(unreadByWorkspace[workspace.id] || 0) > 0 && (
                          <span
                            className="inline-flex min-h-[18px] min-w-[18px] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold leading-none text-white"
                            title={`${unreadByWorkspace[workspace.id]} unread AI ${unreadByWorkspace[workspace.id] === 1 ? "response" : "responses"}`}
                          >
                            {unreadByWorkspace[workspace.id]}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 truncate md-body-small md-text-muted">{workspace.branch}</p>
                    </button>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => openRenameWorkspaceForm(workspace)}
                        className="md-icon-plain"
                        title="Rename workspace"
                        aria-label={`Rename ${workspace.name}`}
                      >
                        <span className="material-symbols-rounded !text-[16px]">edit</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void removeWorkspace(workspace.id);
                        }}
                        className="md-icon-plain md-icon-plain-danger"
                        title="Delete workspace"
                        aria-label={`Delete ${workspace.name}`}
                      >
                        <span className="material-symbols-rounded !text-[16px]">delete</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

      </aside>

      <div
        className="relative -ml-px z-10 hidden w-0.5 cursor-col-resize transition hover:w-1 hover:bg-violet-400/60 lg:block"
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
              <select
                value={workspaceOpenTarget}
                onChange={(e) => {
                  const target = e.target.value as WorkspaceOpenTarget;
                  setWorkspaceOpenTarget("");
                  void openCurrentWorkspaceTarget(target);
                }}
                className="md-select !w-auto !min-h-0 h-7 py-0 pl-2 pr-7 text-[11px]"
                title="Open current workspace"
                aria-label="Open current workspace"
              >
                <option value="">Open</option>
                <option value="vscode">VS Code</option>
                <option value="intellij">IntelliJ</option>
                <option value="terminal">Terminal</option>
              </select>
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

              <div className="flex-1 overflow-y-auto md-px-3 md-py-3">
                <div className="space-y-3">
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
                          <div key={row.id}>
                            <button
                              onClick={() => toggleActivityGroup(row.id)}
                              className="flex w-full items-center gap-2 py-1.5 text-left transition hover:bg-white/5"
                            >
                              <span className="text-xs md-text-faint">
                                Agent activity ({row.group.messages.length} events)
                              </span>
                              {isLatestRunningActivity && (
                                <span className="inline-flex items-center gap-1 rounded-full border border-amber-700/60 bg-amber-950/30 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
                                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-300" />
                                  running
                                </span>
                              )}
                              <span className="material-symbols-rounded ml-auto !text-sm md-text-faint">
                                {expanded ? "expand_more" : "chevron_right"}
                              </span>
                            </button>

                            {expanded && (
                              <div className="space-y-1.5 pl-2 pt-1 pb-1">
                                {row.group.lines.map((line, lineIdx) => (
                                  <div key={`${row.id}-line-${lineIdx}`} className="flex items-start gap-2 text-xs md-text-faint">
                                    <span className="mt-1 h-1 w-1 flex-none rounded-full bg-white/20" />
                                    <span className="break-all font-mono">{line.text}</span>
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
                              <pre className="overflow-x-auto whitespace-pre-wrap text-sm text-amber-200">{msg.content}</pre>
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
                            <pre className="overflow-x-auto whitespace-pre-wrap text-sm text-rose-200">{msg.content}</pre>
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
                            onAnswer={(answer) => {
                              setAnsweredQuestionTimestamps((prev) => {
                                const next = new Set(prev);
                                next.add(msg.timestamp);
                                return next;
                              });
                              void sendMessage(answer);
                            }}
                          />
                        );
                      }

                      if (isUser) {
                        return (
                          <div key={row.id} className="flex justify-end">
                            <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-sky-900/40 px-4 py-3">
                              <pre className="overflow-x-auto whitespace-pre-wrap text-sm leading-relaxed md-text-strong">
                                {msg.content.replace(/^>\s?/, "")}
                              </pre>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div key={row.id}>
                          <MarkdownMessage content={msg.content} />
                        </div>
                      );
                    })
                  ) : activeCenterTab.type === "file" ? (
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

              {workspaceAgents.length > 0 && activeCenterTab.type === "chat" && selectedWorkspace && credentialErrorWorkspaces.has(selectedWorkspace) && (
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

              {workspaceAgents.length > 0 && activeCenterTab.type === "chat" && (
                <div className="border-t md-outline md-surface-container-high md-px-3 md-py-2">
                  <div className="rounded-2xl border md-outline md-surface-container md-px-3 md-py-2">
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
                      placeholder="Ask to make changes... or /prompt name"
                      style={{ resize: "vertical" }}
                      className="w-full overflow-y-auto rounded-lg border md-outline bg-black/10 px-2 py-1 text-sm leading-relaxed outline-none md-text-primary placeholder:md-text-muted min-h-[96px] max-h-[45vh]"
                    />

                    {attachedFiles.length > 0 && (
                      <div className="flex flex-wrap gap-2 border-t md-outline pt-2">
                        {attachedFiles.map((path) => {
                          const relativePath = currentWorkspace
                            ? toWorkspaceRelativePath(path, currentWorkspace.worktreePath) ?? path.split("/").pop() ?? path
                            : path.split("/").pop() ?? path;
                          return (
                            <span key={path} className="md-chip gap-1">
                              <span className="material-symbols-rounded !text-sm">description</span>
                              <span className="max-w-[240px] truncate">{relativePath}</span>
                              <button
                                type="button"
                                className="md-icon-plain !h-4 !w-4"
                                onClick={() => removeAttachedFile(path)}
                                title="Remove attached file"
                              >
                                <span className="material-symbols-rounded !text-sm">close</span>
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    )}

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
                        <select
                          value={selectedModel}
                          onChange={(e) => setSelectedModel(e.target.value)}
                          className="md-select !min-h-0 h-7 py-0 pl-2 pr-6 text-[11px]"
                          style={{ width: "auto" }}
                          aria-label="Model selection"
                        >
                          {MODEL_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <select
                          value={thinkingMode}
                          onChange={(e) => setThinkingMode(e.target.value as "off" | "low" | "medium" | "high")}
                          className="md-select !min-h-0 h-7 py-0 pl-2 pr-6 text-[11px]"
                          style={{ width: "auto" }}
                          aria-label="Thinking mode"
                        >
                          <option value="off">Think off</option>
                          <option value="low">Think low</option>
                          <option value="medium">Think med</option>
                          <option value="high">Think high</option>
                        </select>

                        <div className="ml-auto flex items-center gap-1">
                          <button
                            onClick={() => setClaudeMode((prev) => (prev === "plan" ? "normal" : "plan"))}
                            className={`md-icon-plain !h-7 !w-7 ${claudeMode === "plan" ? "text-violet-300" : ""}`}
                            title={claudeMode === "plan" ? "Planning mode (click for normal)" : "Normal mode (click for plan)"}
                            aria-label={claudeMode === "plan" ? "Switch to normal mode" : "Switch to planning mode"}
                          >
                            <span className="material-symbols-rounded !text-[18px]">
                              {claudeMode === "plan" ? "schema" : "bolt"}
                            </span>
                          </button>

                          {isThinkingCurrentWorkspace && workspaceAgents.length > 0 ? (
                            <button
                              onClick={() => interruptAgent(workspaceAgents[0].id)}
                              className="md-icon-plain !h-7 !w-7 text-amber-400 hover:text-amber-300"
                              title="Interrupt current prompt"
                              aria-label="Interrupt agent"
                            >
                              <span className="material-symbols-rounded !text-[18px]">pause_circle</span>
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                void sendMessage();
                              }}
                              disabled={!inputMessage.trim()}
                              className="md-icon-plain !h-7 !w-7 text-sky-300 disabled:cursor-not-allowed disabled:opacity-30"
                              title="Send message"
                              aria-label="Send message"
                            >
                              <span className="material-symbols-rounded !text-[18px]">send</span>
                            </button>
                          )}
                        </div>
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

        <div className="min-h-0 flex-1 overflow-y-auto md-px-4 md-py-4">
          {activeRightTab === "prompts" && (
            <div className="space-y-2 text-sm">
              <p className="md-label-medium">Prompt Library</p>
              <div className="md-card p-3 md-text-secondary">
                {promptShortcuts.length === 0 ? (
                  <p className="text-xs md-text-muted">No prompt shortcuts yet.</p>
                ) : (
                  <div className="space-y-2">
                    {promptShortcuts.map((shortcut) => (
                      <div
                        key={shortcut.id}
                        className="md-card cursor-pointer md-px-2 md-py-2 transition hover:md-surface-subtle"
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
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm md-text-strong">{shortcut.name}</span>
                            {shortcut.autoRunOnCreate && (
                              <span className="md-chip !px-2 !py-0 text-[10px]">Auto-run on create</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                openEditPromptForm(shortcut);
                              }}
                              className="md-icon-plain"
                              title="Edit prompt"
                              aria-label={`Edit ${shortcut.name}`}
                            >
                              <span className="material-symbols-rounded !text-[16px]">edit</span>
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                deletePromptShortcut(shortcut.id);
                              }}
                              className="md-icon-plain md-icon-plain-danger"
                              title="Delete prompt"
                              aria-label={`Delete ${shortcut.name}`}
                            >
                              <span className="material-symbols-rounded !text-[16px]">delete</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex justify-center">
                  <button
                    type="button"
                    onClick={openAddPromptForm}
                    className="md-icon-plain !h-8 !w-8 rounded-full border md-outline hover:md-surface-subtle"
                    title="Add prompt shortcut"
                    aria-label="Add prompt shortcut"
                  >
                    <span className="material-symbols-rounded !text-[18px]">add</span>
                  </button>
                </div>
              </div>
              <p className="text-xs md-text-muted">
                Click a prompt to run it. Use `/prompt name` in chat, or enable auto-run for new workspaces.
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
            <div className="space-y-2 text-sm">
              <p className="md-label-medium">Workspace Changes</p>
              <div className="md-card p-3 md-text-secondary">
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
                  <div className="mt-3 max-h-[52vh] space-y-1 overflow-auto pr-1">
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
                            <span className="truncate">{change.path}</span>
                            <span className={`ml-auto w-8 flex-none text-right font-mono text-[11px] ${getChangeStatusClass(change.status)}`}>
                              {normalizeChangeStatus(change.status)}
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

              <p className="text-xs md-text-muted">Click any file here to open its diff in the center pane.</p>
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

              <div className="mb-3 border-b pb-3 md-outline">
                <p className="mb-2 md-text-dim">Detected checks</p>
                {isLoadingDetectedChecks && <p className="md-text-muted">Detecting checks...</p>}
                {!isLoadingDetectedChecks && detectedChecks.length === 0 && (
                  <p className="md-text-muted">No checks detected for this workspace.</p>
                )}
                {!isLoadingDetectedChecks && detectedChecks.length > 0 && (
                  <div className="space-y-2">
                    {detectedChecks.map((check) => (
                      <div key={`${check.name}-${check.command}`} className="md-card p-2">
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="md-text-secondary">{check.name}</span>
                        </div>
                        <p className="truncate font-mono text-[11px] md-text-muted">{check.command}</p>
                        <p className="mt-1 text-[11px] md-text-muted">{check.description}</p>
                      </div>
                    ))}
                  </div>
                )}
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
                      {!!check.stdout && (
                        <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-[11px] text-emerald-200">
                          {check.stdout}
                        </pre>
                      )}
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
                  <p className="md-text-dim">App updates</p>
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

              <div className="border-t md-outline pt-3">
                <p className="md-text-dim">Environment overrides (app-wide)</p>
                <p className="mb-2 text-[11px] md-text-muted">
                  Supports lines like `export KEY=VALUE` or `KEY=VALUE`. Applied to agents, chat and terminal commands.
                </p>
                <label className="mb-2 flex items-center gap-2 rounded-md border px-2 py-1.5 md-outline">
                  <input
                    type="checkbox"
                    checked={bedrockEnabled}
                    onChange={(e) => setBedrockEnabled(e.target.checked)}
                    className="h-4 w-4 accent-sky-500"
                  />
                  <span className="text-[11px] md-text-strong">Use AWS Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`)</span>
                </label>
                <textarea
                  value={envOverridesText}
                  onChange={(e) => setEnvOverridesText(e.target.value)}
                  rows={6}
                  className="md-field font-mono"
                  placeholder={"export CLAUDE_CODE_USE_BEDROCK=1\n# optional if not using default profile\nexport AWS_PROFILE=your-profile"}
                />
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

              <div className="border-t md-outline pt-3">
                <p className="md-text-dim">Connection URL</p>
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
                  setRenameWorkspaceId(null);
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

      {showAddPromptForm && (
        <div className="md-dialog-scrim fixed inset-0 z-50 flex items-center justify-center">
          <div className="md-dialog mx-4 w-full max-w-lg">
            <div className="border-b md-outline p-4">
              <h3 className="text-lg font-semibold md-text-strong">
                {editingPromptId ? "Edit Prompt Shortcut" : "Add Prompt Shortcut"}
              </h3>
              <p className="mt-1 text-sm md-text-muted">
                {editingPromptId
                  ? "Update a reusable prompt button and slash command."
                  : "Create a reusable prompt button and slash command."}
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
              <label className="flex items-start gap-2 rounded-lg border md-outline p-3 text-sm">
                <input
                  type="checkbox"
                  checked={newPromptAutoRunOnCreate}
                  onChange={(e) => setNewPromptAutoRunOnCreate(e.target.checked)}
                  className="mt-0.5 h-4 w-4"
                />
                <span>
                  <span className="block md-text-secondary">Auto-run on workspace creation</span>
                  <span className="block text-xs md-text-muted">
                    Execute this prompt automatically after a new workspace is created and its agent is ready.
                  </span>
                </span>
              </label>
            </div>

            <div className="flex justify-end gap-2 border-t md-outline p-4">
              <button
                onClick={() => {
                  setShowAddPromptForm(false);
                  setEditingPromptId(null);
                }}
                className="md-btn"
              >
                Cancel
              </button>
              <button
                onClick={addPromptShortcut}
                disabled={!newPromptName.trim() || !newPromptBody.trim()}
                className="md-btn md-btn-tonal disabled:opacity-50"
              >
                {editingPromptId ? "Save Prompt" : "Add Prompt"}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
