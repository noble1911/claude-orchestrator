import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Dimensions,
  Linking,
} from "react-native";
import Markdown from "react-native-markdown-display";
import MarkdownIt from "markdown-it";

type WorkspaceInfo = {
  id: string;
  repo_id: string;
  name: string;
  branch: string;
  status: string;
  has_agent: boolean;
  pinned_at?: string | null;
  notes?: string | null;
  pr_url?: string | null;
};

type RepositoryInfo = {
  id: string;
  path: string;
  name: string;
  default_branch: string;
  added_at: string;
};

type MessageInfo = {
  agent_id: string;
  role?: string;
  content: string;
  is_error: boolean;
  timestamp: string;
};

type QuestionOption = {
  label: string;
  description?: string;
};

type QuestionItem = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: QuestionOption[];
};

type AskUserQuestionPayload = {
  questions: QuestionItem[];
};

type PromptShortcut = {
  id: string;
  name: string;
  prompt: string;
};

type FileEntryInfo = {
  name: string;
  path: string;
  is_dir: boolean;
};

type ChangeInfo = {
  status: string;
  path: string;
  old_path?: string | null;
};

type CheckInfo = {
  name: string;
  command: string;
  success: boolean;
  exit_code?: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  skipped: boolean;
};

type TerminalEntry = {
  id: string;
  command: string;
  stdout: string;
  stderr: string;
  exit_code?: number | null;
  running: boolean;
};

type WsResponse =
  | { type: "connected"; server_name?: string; features?: string[] }
  | { type: "authenticated"; client_id: string }
  | { type: "authentication_failed"; reason: string }
  | { type: "repository_list"; repositories: RepositoryInfo[] }
  | { type: "repository_added"; repository: RepositoryInfo }
  | { type: "repository_removed"; repo_id: string }
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
  | { type: "agent_started"; workspace_id: string; agent_id: string }
  | { type: "agent_message"; workspace_id: string; role?: string; content: string; is_error: boolean; timestamp: string }
  | { type: "agent_run_state"; workspace_id: string; agent_id: string; running: boolean; timestamp: string }
  | { type: "agent_stopped"; workspace_id: string }
  | { type: "agent_interrupted"; workspace_id: string }
  | { type: "error"; message: string }
  | { type: string; [key: string]: any };

type ActivityLine = {
  text: string;
  count: number;
};

type ActivityGroup = {
  id: string;
  messages: MessageInfo[];
  lines: ActivityLine[];
};

type ChatRow =
  | { kind: "message"; id: string; message: MessageInfo }
  | { kind: "activity"; id: string; group: ActivityGroup };

const MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];
const THINKING_LEVELS: Array<"off" | "low" | "medium" | "high"> = ["off", "low", "medium", "high"];
const DRAWER_ANIMATION_MS = 220;
const NAME_ADJECTIVES = ["swift", "brisk", "neat", "solid", "lively", "calm", "bold", "quiet"];
const NAME_NOUNS = ["otter", "falcon", "maple", "harbor", "comet", "forest", "breeze", "ember"];
const MARKDOWN_IT = MarkdownIt({
  breaks: true,
  linkify: true,
  typographer: false,
});
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

function statusColor(status: string): string {
  switch (status) {
    case "running": return "#34d399";
    case "idle": return "#71717a";
    case "inReview": return "#fbbf24";
    case "merged": return "#a78bfa";
    case "initializing": return "#fbbf24";
    default: return "#71717a";
  }
}

function normalizeExternalUrl(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
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

function splitTextWithUrls(text: string): Array<{ text: string; href?: string }> {
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

    const href = normalizeExternalUrl(candidate);
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

function LinkifiedText({
  text,
  style,
  linkStyle,
}: {
  text: string;
  style: any;
  linkStyle?: any;
}) {
  const segments = splitTextWithUrls(text);
  return (
    <Text style={style}>
      {segments.map((segment, index) => {
        if (!segment.href) {
          return (
            <Text key={`plain-${index}`} style={style}>
              {segment.text}
            </Text>
          );
        }
        return (
          <Text
            key={`link-${index}`}
            style={[style, linkStyle]}
            onPress={() => {
              Linking.openURL(segment.href || "").catch(() => {});
            }}
          >
            {segment.text}
          </Text>
        );
      })}
    </Text>
  );
}

function MarkdownText({ content }: { content: string }) {
  const normalized = content.replace(/\r\n/g, "\n");
  return (
    <Markdown
      markdownit={MARKDOWN_IT}
      style={markdownStyles}
      mergeStyle={false}
      onLinkPress={(url) => {
        Linking.openURL(url).catch(() => {});
        return false;
      }}
    >
      {normalized}
    </Markdown>
  );
}

function parseAskUserQuestionPayload(raw: string): AskUserQuestionPayload | null {
  try {
    const parsed = JSON.parse(raw) as { questions?: unknown };
    if (!parsed || !Array.isArray(parsed.questions)) {
      return null;
    }

    const questions: QuestionItem[] = [];
    for (const item of parsed.questions) {
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
          const normalized: QuestionOption = { label };
          if (typeof optSource.description === "string" && optSource.description.trim()) {
            normalized.description = optSource.description.trim();
          }
          options.push(normalized);
        }
      }
      if (question || options.length > 0) {
        questions.push({ question, header, multiSelect, options });
      }
    }

    return questions.length > 0 ? { questions } : null;
  } catch {
    return null;
  }
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

type QuestionCardProps = {
  message: MessageInfo;
  rowId: string;
  isAnswered: boolean;
  onAnswer: (answer: string) => void;
};

function QuestionCard({ message, rowId, isAnswered, onAnswer }: QuestionCardProps) {
  const payload = useMemo(() => parseAskUserQuestionPayload(message.content), [message.content]);
  const [selectedAnswersByQuestion, setSelectedAnswersByQuestion] = useState<Record<number, string[]>>({});

  useEffect(() => {
    setSelectedAnswersByQuestion({});
  }, [message.timestamp, message.content]);

  if (!payload) {
    return (
      <View style={styles.questionCard}>
        <MarkdownText content={message.content} />
      </View>
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
    <View style={styles.questionCard}>
      <Text style={styles.questionLabel}>QUESTION</Text>
      {payload.questions.map((question, qIdx) => (
        <View key={`${rowId}-q-${qIdx}`} style={styles.questionBlock}>
          {question.header ? <Text style={styles.questionHeader}>{question.header}</Text> : null}
          {question.question ? <Text style={styles.questionText}>{question.question}</Text> : null}
          {question.options && question.options.length > 0 ? (
            <View style={styles.questionOptions}>
              {question.options.map((option, optionIdx) => {
                const isSelected = canBundleAnswers
                  ? (selectedAnswersByQuestion[qIdx] || []).includes(option.label)
                  : false;
                return (
                  <TouchableOpacity
                    key={`${rowId}-o-${qIdx}-${optionIdx}`}
                    style={[
                      styles.questionOption,
                      isSelected ? styles.questionOptionSelected : null,
                      isAnswered ? styles.questionOptionDisabled : null,
                    ]}
                    disabled={isAnswered}
                    onPress={() => selectOption(qIdx, question, option.label)}
                  >
                    <Text style={styles.questionOptionText}>{option.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : null}
        </View>
      ))}
      {!isAnswered && canBundleAnswers ? (
        <View style={styles.questionSubmitRow}>
          <TouchableOpacity
            style={[
              styles.questionSubmitButton,
              !canSubmitBundledAnswers ? styles.questionOptionDisabled : null,
            ]}
            disabled={!canSubmitBundledAnswers}
            onPress={submitBundledAnswers}
          >
            <Text style={styles.questionSubmitButtonText}>Submit answers</Text>
          </TouchableOpacity>
          <Text style={styles.questionHint}>
            {canSubmitBundledAnswers
              ? "Ready to send all answers."
              : "Select one option for each question before submitting."}
          </Text>
        </View>
      ) : null}
      {!isAnswered ? <Text style={styles.questionHint}>Or type a custom answer in the main chat box below.</Text> : null}
    </View>
  );
}

function compactActivityLines(messages: MessageInfo[]): ActivityLine[] {
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

function messageIdentity(message: MessageInfo): string {
  return `${message.timestamp}::${message.agent_id}::${message.role ?? ""}`;
}

function isAssistantStreamingMessage(message: MessageInfo): boolean {
  return (message.role ?? "") === "assistant" && !message.is_error;
}

function upsertMessageByIdentity(messages: MessageInfo[], incoming: MessageInfo): MessageInfo[] {
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
    existing.is_error === incoming.is_error &&
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

function generateWorkspaceName(): string {
  const adjective = NAME_ADJECTIVES[Math.floor(Math.random() * NAME_ADJECTIVES.length)];
  const noun = NAME_NOUNS[Math.floor(Math.random() * NAME_NOUNS.length)];
  const suffix = Math.floor(Math.random() * 900) + 100;
  return `${adjective}-${noun}-${suffix}`;
}

function App() {
  const wsRef = useRef<WebSocket | null>(null);
  const [wsUrl, setWsUrl] = useState("ws://192.168.1.42:3001");
  const [connected, setConnected] = useState(false);
  const [repositories, setRepositories] = useState<RepositoryInfo[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [defaultRepoId, setDefaultRepoId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [messagesByWorkspace, setMessagesByWorkspace] = useState<Record<string, MessageInfo[]>>({});
  const [input, setInput] = useState("");
  const [selectedModel, setSelectedModel] = useState("opus");
  const [claudeMode, setClaudeMode] = useState<"normal" | "plan">("normal");
  const [thinkingMode, setThinkingMode] = useState<"off" | "low" | "medium" | "high">("off");
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [renderLeftOverlay, setRenderLeftOverlay] = useState(false);
  const [renderRightOverlay, setRenderRightOverlay] = useState(false);
  const [rightTab, setRightTab] = useState<"prompts" | "all_files" | "changes" | "checks" | "terminal">("prompts");
  const [statusText, setStatusText] = useState("");
  const [showAddRepoForm, setShowAddRepoForm] = useState(false);
  const [newRepoPath, setNewRepoPath] = useState("");
  const [showAddWorkspaceForm, setShowAddWorkspaceForm] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [renameWorkspaceId, setRenameWorkspaceId] = useState<string | null>(null);
  const [renameWorkspaceName, setRenameWorkspaceName] = useState("");
  const [filesPath, setFilesPath] = useState("");
  const [fileEntries, setFileEntries] = useState<FileEntryInfo[]>([]);
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [selectedFileContent, setSelectedFileContent] = useState("");
  const [loadingChangedFilePath, setLoadingChangedFilePath] = useState<string | null>(null);
  const [changes, setChanges] = useState<ChangeInfo[]>([]);
  const [checks, setChecks] = useState<CheckInfo[]>([]);
  const [promptShortcuts, setPromptShortcuts] = useState<PromptShortcut[]>([]);
  const [showAddPromptForm, setShowAddPromptForm] = useState(false);
  const [newPromptName, setNewPromptName] = useState("");
  const [newPromptBody, setNewPromptBody] = useState("");
  const [checksRunning, setChecksRunning] = useState(false);
  const [filesLoading, setFilesLoading] = useState(false);
  const [changesLoading, setChangesLoading] = useState(false);
  const [runningByWorkspace, setRunningByWorkspace] = useState<Record<string, boolean>>({});
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  const [diffContent, setDiffContent] = useState<string | null>(null);
  const [diffFilePath, setDiffFilePath] = useState<string | null>(null);
  const [terminalHistory, setTerminalHistory] = useState<TerminalEntry[]>([]);
  const [terminalRunning, setTerminalRunning] = useState(false);
  const [terminalInput, setTerminalInput] = useState("");
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesValue, setNotesValue] = useState("");
  const [workspaceSearch, setWorkspaceSearch] = useState("");
  const [expandedActivityIdsByWorkspace, setExpandedActivityIdsByWorkspace] = useState<Record<string, string[]>>({});
  const [answeredQuestionTimestampsByWorkspace, setAnsweredQuestionTimestampsByWorkspace] =
    useState<Record<string, string[]>>({});
  const leftDrawerAnim = useRef(new Animated.Value(0)).current;
  const rightDrawerAnim = useRef(new Animated.Value(0)).current;

  const selectedWorkspace = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) || null,
    [workspaces, selectedWorkspaceId],
  );
  const selectedRepository = useMemo(
    () => repositories.find((repo) => repo.id === selectedRepoId) || null,
    [repositories, selectedRepoId],
  );
  const filteredWorkspaces = useMemo(() => {
    if (!workspaceSearch) return workspaces;
    const q = workspaceSearch.toLowerCase();
    return workspaces.filter(
      (ws) => ws.name.toLowerCase().includes(q) || ws.branch.toLowerCase().includes(q),
    );
  }, [workspaces, workspaceSearch]);
  const workspaceGroups = useMemo(
    () => [
      { key: "running", label: "In progress", items: filteredWorkspaces.filter((ws) => ws.status === "running") },
      { key: "inReview", label: "In review", items: filteredWorkspaces.filter((ws) => ws.status === "inReview") },
      { key: "idle", label: "Ready", items: filteredWorkspaces.filter((ws) => ws.status === "idle" || ws.status === "initializing") },
      { key: "merged", label: "Done", items: filteredWorkspaces.filter((ws) => ws.status === "merged") },
    ],
    [filteredWorkspaces],
  );

  const currentMessages = selectedWorkspaceId ? messagesByWorkspace[selectedWorkspaceId] || [] : [];
  const isRunning = selectedWorkspaceId ? (runningByWorkspace[selectedWorkspaceId] ?? false) : false;
  const topInset = Platform.OS === "android" ? StatusBar.currentHeight || 0 : 0;
  const drawerSlideDistance = useMemo(
    () => Math.min(420, Math.round(Dimensions.get("window").width * 0.84)),
    [],
  );
  const leftDrawerTranslateX = useMemo(
    () =>
      leftDrawerAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [-drawerSlideDistance, 0],
      }),
    [leftDrawerAnim, drawerSlideDistance],
  );
  const rightDrawerTranslateX = useMemo(
    () =>
      rightDrawerAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [drawerSlideDistance, 0],
      }),
    [rightDrawerAnim, drawerSlideDistance],
  );
  const leftBackdropOpacity = useMemo(
    () =>
      leftDrawerAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [0, 1],
      }),
    [leftDrawerAnim],
  );
  const rightBackdropOpacity = useMemo(
    () =>
      rightDrawerAnim.interpolate({
        inputRange: [0, 1],
        outputRange: [0, 1],
      }),
    [rightDrawerAnim],
  );
  const answeredQuestionSet = useMemo(() => {
    if (!selectedWorkspaceId) return new Set<string>();
    return new Set(answeredQuestionTimestampsByWorkspace[selectedWorkspaceId] || []);
  }, [answeredQuestionTimestampsByWorkspace, selectedWorkspaceId]);
  const derivedAnsweredQuestionSet = useMemo(() => {
    const answered = new Set<string>();
    for (let i = 0; i < currentMessages.length; i += 1) {
      const current = currentMessages[i];
      if (current.role !== "question") continue;
      for (let j = i + 1; j < currentMessages.length; j += 1) {
        const next = currentMessages[j];
        const nextRole = next.role || (next.agent_id === "user" ? "user" : "assistant");
        if (nextRole === "user" || next.agent_id === "user") {
          answered.add(current.timestamp);
          break;
        }
        if (nextRole === "question") {
          // A newer question supersedes an older pending one.
          answered.add(current.timestamp);
          break;
        }
      }
    }
    return answered;
  }, [currentMessages]);
  const expandedActivityIds = selectedWorkspaceId
    ? expandedActivityIdsByWorkspace[selectedWorkspaceId] || []
    : [];
  const selectedModelLabel = useMemo(
    () => MODEL_OPTIONS.find((model) => model.value === selectedModel)?.label ?? "Opus",
    [selectedModel],
  );
  const chatRows = useMemo<ChatRow[]>(() => {
    const rows: ChatRow[] = [];
    let systemBuffer: MessageInfo[] = [];
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

    for (const message of currentMessages) {
      const role = message.role || (message.agent_id === "user" ? "user" : "assistant");
      const isSystemActivity = role === "system" && !message.is_error;
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
  }, [currentMessages]);
  const sortedChanges = useMemo(
    () =>
      [...changes].sort((a, b) => {
        const byPath = a.path.localeCompare(b.path);
        if (byPath !== 0) return byPath;
        return a.status.localeCompare(b.status);
      }),
    [changes],
  );

  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (leftOpen) {
      setRenderLeftOverlay(true);
      Animated.timing(leftDrawerAnim, {
        toValue: 1,
        duration: DRAWER_ANIMATION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return;
    }
    if (!renderLeftOverlay) return;
    Animated.timing(leftDrawerAnim, {
      toValue: 0,
      duration: DRAWER_ANIMATION_MS,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) {
        setRenderLeftOverlay(false);
      }
    });
  }, [leftOpen, leftDrawerAnim, renderLeftOverlay]);

  useEffect(() => {
    if (rightOpen) {
      setRenderRightOverlay(true);
      Animated.timing(rightDrawerAnim, {
        toValue: 1,
        duration: DRAWER_ANIMATION_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return;
    }
    if (!renderRightOverlay) return;
    Animated.timing(rightDrawerAnim, {
      toValue: 0,
      duration: DRAWER_ANIMATION_MS,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) {
        setRenderRightOverlay(false);
      }
    });
  }, [rightOpen, rightDrawerAnim, renderRightOverlay]);

  // Drain one queued message when agent becomes idle
  useEffect(() => {
    if (!isRunning && queuedMessages.length > 0 && selectedWorkspaceId) {
      const [next, ...rest] = queuedMessages;
      setQueuedMessages(rest);
      sendJson({
        type: "send_message",
        workspace_id: selectedWorkspaceId,
        message: next,
        permission_mode: claudeMode === "plan" ? "plan" : "bypassPermissions",
        model: selectedModel,
        effort: thinkingMode === "off" ? undefined : thinkingMode,
      });
    }
  }, [isRunning, selectedWorkspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear queue and terminal when switching workspaces
  useEffect(() => {
    setQueuedMessages([]);
    setDiffContent(null);
    setDiffFilePath(null);
    setTerminalHistory([]);
    setTerminalRunning(false);
    setTerminalInput("");
    setEditingNotes(false);
    setNotesValue(selectedWorkspace?.notes ?? "");
  }, [selectedWorkspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  function sendJson(payload: Record<string, any>) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  function connect() {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setStatusText("Connected");
      sendJson({ type: "connect", client_name: "mobile" });
      sendJson({ type: "list_repositories" });
    };

    ws.onclose = () => {
      setConnected(false);
      setStatusText("Disconnected");
    };

    ws.onerror = () => {
      setConnected(false);
      setStatusText("WebSocket error");
    };

    ws.onmessage = (event) => {
      let parsed: WsResponse;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (parsed.type === "workspace_list") {
        const next: WorkspaceInfo[] = parsed.workspaces ?? [];
        setWorkspaces(next);
        const stillSelected = next.some((item) => item.id === selectedWorkspaceId);
        if (stillSelected) {
          return;
        }
        if (next.length > 0) {
          const first = next[0].id;
          setSelectedWorkspaceId(first);
          bootstrapWorkspace(first);
        } else {
          setSelectedWorkspaceId(null);
        }
        return;
      }

      if (parsed.type === "repository_list") {
        const nextRepos: RepositoryInfo[] = parsed.repositories ?? [];
        setRepositories(nextRepos);
        let nextSelectedRepo = selectedRepoId;
        if (!nextSelectedRepo || !nextRepos.some((repo) => repo.id === nextSelectedRepo)) {
          nextSelectedRepo =
            (defaultRepoId && nextRepos.some((repo) => repo.id === defaultRepoId) ? defaultRepoId : null) ||
            (nextRepos[0]?.id ?? null);
        }
        setSelectedRepoId(nextSelectedRepo);
        if (nextSelectedRepo) {
          sendJson({ type: "list_workspaces", repo_id: nextSelectedRepo });
        } else {
          setWorkspaces([]);
          setSelectedWorkspaceId(null);
        }
        return;
      }

      if (parsed.type === "repository_added" || parsed.type === "repository_removed") {
        sendJson({ type: "list_repositories" });
        return;
      }

      if (parsed.type === "workspace_updated") {
        setWorkspaces((prev) =>
          prev.map((ws) => (ws.id === parsed.workspace.id ? parsed.workspace : ws)),
        );
        return;
      }

      if (parsed.type === "workspace_created" || parsed.type === "workspace_renamed" || parsed.type === "workspace_removed") {
        if (selectedRepoId) {
          sendJson({ type: "list_workspaces", repo_id: selectedRepoId });
        } else {
          sendJson({ type: "list_workspaces" });
        }
        return;
      }

      if (parsed.type === "message_history") {
        setMessagesByWorkspace((prev) => ({
          ...prev,
          [parsed.workspace_id]: parsed.messages || [],
        }));
        return;
      }

      if (parsed.type === "agent_message") {
        const item: MessageInfo = {
          agent_id: parsed.role === "user" ? "user" : parsed.is_error ? "error" : "assistant",
          role: parsed.role || (parsed.is_error ? "error" : "assistant"),
          content: parsed.content,
          is_error: parsed.is_error,
          timestamp: parsed.timestamp,
        };
        setMessagesByWorkspace((prev) => ({
          ...prev,
          [parsed.workspace_id]: upsertMessageByIdentity(prev[parsed.workspace_id] || [], item),
        }));
        return;
      }

      if (parsed.type === "files_list") {
        if (parsed.workspace_id !== selectedWorkspaceId) return;
        setFilesPath(parsed.relative_path || "");
        setFileEntries(parsed.entries || []);
        setFilesLoading(false);
        return;
      }

      if (parsed.type === "file_content") {
        if (parsed.workspace_id !== selectedWorkspaceId) return;
        setSelectedFilePath(parsed.path);
        setSelectedFileContent(parsed.content || "");
        setLoadingChangedFilePath((prev) => (prev === parsed.path ? null : prev));
        return;
      }

      if (parsed.type === "changes_list") {
        if (parsed.workspace_id !== selectedWorkspaceId) return;
        setChanges(parsed.changes || []);
        setChangesLoading(false);
        return;
      }

      if (parsed.type === "checks_result") {
        if (parsed.workspace_id !== selectedWorkspaceId) return;
        setChecks(parsed.checks || []);
        setChecksRunning(false);
        return;
      }

      if (parsed.type === "agent_started") {
        setRunningByWorkspace((prev) => ({ ...prev, [parsed.workspace_id]: true }));
        if (parsed.workspace_id === selectedWorkspaceId) {
          setStatusText(`Agent running: ${parsed.agent_id.slice(0, 8)}`);
        }
        return;
      }

      if (parsed.type === "agent_run_state") {
        setRunningByWorkspace((prev) => ({ ...prev, [parsed.workspace_id]: parsed.running }));
        return;
      }

      if (parsed.type === "agent_stopped" || parsed.type === "agent_interrupted") {
        setRunningByWorkspace((prev) => ({ ...prev, [parsed.workspace_id]: false }));
        return;
      }

      if (parsed.type === "change_diff") {
        if (parsed.workspace_id !== selectedWorkspaceId) return;
        setDiffFilePath(parsed.file_path);
        setDiffContent(parsed.diff);
        setLoadingChangedFilePath(null);
        return;
      }

      if (parsed.type === "terminal_output") {
        if (parsed.workspace_id !== selectedWorkspaceId) return;
        setTerminalHistory((prev) => {
          if (prev.length === 0) return prev;
          const updated = [...prev];
          const last = { ...updated[updated.length - 1] };
          last.stdout += parsed.stdout || "";
          last.stderr += parsed.stderr || "";
          if (parsed.exit_code != null) {
            last.exit_code = parsed.exit_code;
            last.running = false;
          }
          updated[updated.length - 1] = last;
          return updated;
        });
        if (parsed.exit_code != null) {
          setTerminalRunning(false);
        }
        return;
      }

      if (parsed.type === "error") {
        setFilesLoading(false);
        setChangesLoading(false);
        setChecksRunning(false);
        setLoadingChangedFilePath(null);
        setStatusText(parsed.message || "Request failed");
      }
    };
  }

  function disconnect() {
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
  }

  function bootstrapWorkspace(workspaceId: string) {
    sendJson({ type: "start_agent", workspace_id: workspaceId });
    sendJson({ type: "subscribe", workspace_id: workspaceId });
    sendJson({ type: "get_messages", workspace_id: workspaceId });
    refreshFiles(workspaceId, "");
    refreshChanges(workspaceId);
  }

  function refreshFiles(workspaceId: string, relativePath: string) {
    setFilesLoading(true);
    sendJson({
      type: "list_files",
      workspace_id: workspaceId,
      relative_path: relativePath || undefined,
    });
  }

  function refreshChanges(workspaceId: string) {
    setChangesLoading(true);
    sendJson({ type: "list_changes", workspace_id: workspaceId });
  }

  function selectRepository(repoId: string) {
    setSelectedRepoId(repoId);
    setSelectedWorkspaceId(null);
    setWorkspaces([]);
    sendJson({ type: "list_workspaces", repo_id: repoId });
  }

  function addRepository() {
    const path = newRepoPath.trim();
    if (!path) return;
    sendJson({ type: "add_repository", path });
    setNewRepoPath("");
    setShowAddRepoForm(false);
  }

  function removeRepository(repoId: string) {
    sendJson({ type: "remove_repository", repo_id: repoId });
    if (selectedRepoId === repoId) {
      setSelectedRepoId(null);
      setSelectedWorkspaceId(null);
      setWorkspaces([]);
    }
  }

  function createWorkspace() {
    if (!selectedRepoId) return;
    const name = newWorkspaceName.trim() || generateWorkspaceName();
    sendJson({ type: "create_workspace", repo_id: selectedRepoId, name });
    setNewWorkspaceName("");
    setShowAddWorkspaceForm(false);
  }

  function beginRenameWorkspace(workspace: WorkspaceInfo) {
    setRenameWorkspaceId(workspace.id);
    setRenameWorkspaceName(workspace.name);
  }

  function saveRenameWorkspace() {
    if (!renameWorkspaceId) return;
    const name = renameWorkspaceName.trim();
    if (!name) return;
    sendJson({ type: "rename_workspace", workspace_id: renameWorkspaceId, name });
    setRenameWorkspaceId(null);
    setRenameWorkspaceName("");
  }

  function removeWorkspace(workspaceId: string) {
    sendJson({ type: "remove_workspace", workspace_id: workspaceId });
    if (selectedWorkspaceId === workspaceId) {
      setSelectedWorkspaceId(null);
    }
  }

  function selectWorkspace(workspaceId: string) {
    setSelectedWorkspaceId(workspaceId);
    setLeftOpen(false);
    setSelectedFilePath("");
    setSelectedFileContent("");
    setFilesPath("");
    setFileEntries([]);
    setChanges([]);
    setChecks([]);
    bootstrapWorkspace(workspaceId);
  }

  function sendMessage(rawMessage?: string) {
    if (!selectedWorkspaceId) return;
    const messageText = (rawMessage ?? input).trim();
    if (!messageText) return;

    // Queue if agent is running and this is from the input box (not a shortcut/action)
    if (isRunning && !rawMessage) {
      setQueuedMessages((prev) => [...prev, messageText]);
      setInput("");
      return;
    }

    const localUser: MessageInfo = {
      agent_id: "user",
      role: "user",
      content: messageText,
      is_error: false,
      timestamp: new Date().toISOString(),
    };

    setMessagesByWorkspace((prev) => ({
      ...prev,
      [selectedWorkspaceId]: [...(prev[selectedWorkspaceId] || []), localUser],
    }));

    sendJson({
      type: "send_message",
      workspace_id: selectedWorkspaceId,
      message: messageText,
      permission_mode: claudeMode === "plan" ? "plan" : "bypassPermissions",
      model: selectedModel,
      effort: thinkingMode === "off" ? undefined : thinkingMode,
    });
    if (!rawMessage) {
      setInput("");
    }
  }

  function openRightDrawer(tab: "prompts" | "all_files" | "changes" | "checks" | "terminal") {
    setRightTab(tab);
    setRightOpen(true);
    if (!selectedWorkspaceId) return;
    if (tab === "prompts" || tab === "terminal") {
      return;
    }
    if (tab === "all_files") {
      refreshFiles(selectedWorkspaceId, filesPath || "");
    } else if (tab === "changes") {
      setDiffContent(null);
      setDiffFilePath(null);
      refreshChanges(selectedWorkspaceId);
    }
  }

  function runPromptShortcut(shortcut: PromptShortcut) {
    if (!selectedWorkspaceId) return;
    sendMessage(shortcut.prompt);
    setRightOpen(false);
  }

  function addPromptShortcut() {
    const name = newPromptName.trim();
    const prompt = newPromptBody.trim();
    if (!name || !prompt) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setPromptShortcuts((prev) => [...prev, { id, name, prompt }]);
    setNewPromptName("");
    setNewPromptBody("");
    setShowAddPromptForm(false);
  }

  function deletePromptShortcut(id: string) {
    setPromptShortcuts((prev) => prev.filter((item) => item.id !== id));
  }

  function navigateUp() {
    if (!selectedWorkspaceId) return;
    const path = filesPath.trim();
    if (!path) return;
    const idx = path.lastIndexOf("/");
    const parent = idx === -1 ? "" : path.slice(0, idx);
    refreshFiles(selectedWorkspaceId, parent);
  }

  function openEntry(entry: FileEntryInfo) {
    if (!selectedWorkspaceId) return;
    if (entry.is_dir) {
      refreshFiles(selectedWorkspaceId, entry.path);
      return;
    }
    sendJson({
      type: "read_file",
      workspace_id: selectedWorkspaceId,
      relative_path: entry.path,
      max_bytes: 120000,
    });
  }

  function openChangedFile(change: ChangeInfo) {
    if (!selectedWorkspaceId) return;
    setSelectedFilePath(change.path);
    setSelectedFileContent("");
    setLoadingChangedFilePath(change.path);
    sendJson({
      type: "read_file",
      workspace_id: selectedWorkspaceId,
      relative_path: change.path,
      max_bytes: 120000,
    });
  }

  function runChecks() {
    if (!selectedWorkspaceId || checksRunning) return;
    setChecksRunning(true);
    sendJson({ type: "run_checks", workspace_id: selectedWorkspaceId });
  }

  function isActivityExpanded(id: string): boolean {
    return expandedActivityIds.includes(id);
  }

  function toggleActivityGroup(id: string) {
    if (!selectedWorkspaceId) return;
    setExpandedActivityIdsByWorkspace((prev) => {
      const current = prev[selectedWorkspaceId] || [];
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
      return { ...prev, [selectedWorkspaceId]: next };
    });
  }

  function markQuestionAnswered(timestamp: string) {
    if (!selectedWorkspaceId) return;
    setAnsweredQuestionTimestampsByWorkspace((prev) => {
      const current = prev[selectedWorkspaceId] || [];
      if (current.includes(timestamp)) return prev;
      return { ...prev, [selectedWorkspaceId]: [...current, timestamp] };
    });
  }

  function cycleModel() {
    setSelectedModel((prev) => {
      const index = MODEL_OPTIONS.findIndex((model) => model.value === prev);
      if (index < 0) return MODEL_OPTIONS[0].value;
      return MODEL_OPTIONS[(index + 1) % MODEL_OPTIONS.length].value;
    });
  }

  function cycleMode() {
    setClaudeMode((prev) => (prev === "plan" ? "normal" : "plan"));
  }

  function cycleThinking() {
    setThinkingMode((prev) => {
      const index = THINKING_LEVELS.indexOf(prev);
      if (index < 0) return "off";
      return THINKING_LEVELS[(index + 1) % THINKING_LEVELS.length];
    });
  }

  function stopAgent() {
    if (!selectedWorkspaceId) return;
    sendJson({ type: "interrupt_agent", workspace_id: selectedWorkspaceId });
  }

  function viewDiff(filePath: string) {
    if (!selectedWorkspaceId) return;
    setDiffFilePath(filePath);
    setDiffContent(null);
    setLoadingChangedFilePath(filePath);
    sendJson({ type: "read_change_diff", workspace_id: selectedWorkspaceId, file_path: filePath });
  }

  function runTerminalCommand() {
    const cmd = terminalInput.trim();
    if (!cmd || terminalRunning || !selectedWorkspaceId) return;
    const entry: TerminalEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      command: cmd,
      stdout: "",
      stderr: "",
      running: true,
    };
    setTerminalHistory((prev) => [...prev, entry]);
    setTerminalRunning(true);
    sendJson({ type: "run_terminal_command", workspace_id: selectedWorkspaceId, command: cmd });
    setTerminalInput("");
  }

  function saveNotes() {
    if (!selectedWorkspaceId) return;
    sendJson({ type: "update_workspace_notes", workspace_id: selectedWorkspaceId, notes: notesValue });
    setEditingNotes(false);
  }

  function removeQueuedMessage(idx: number) {
    setQueuedMessages((prev) => prev.filter((_, i) => i !== idx));
  }

  return (
    <SafeAreaView style={[styles.safe, { paddingTop: topInset }]}>
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />

      <View style={styles.header}>
        <TouchableOpacity style={styles.smallButton} onPress={() => setLeftOpen(true)}>
          <Text style={styles.smallButtonText}>Menu</Text>
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <View style={[styles.statusDot, { backgroundColor: isRunning ? "#34d399" : "#71717a" }]} />
          <Text style={styles.headerTitle} numberOfLines={1}>{selectedWorkspace?.name || "Select Workspace"}</Text>
        </View>
        <TouchableOpacity style={styles.smallButton} onPress={() => openRightDrawer("prompts")}>
          <Text style={styles.smallButtonText}>Tools</Text>
        </TouchableOpacity>
      </View>
      {!!statusText && <Text style={styles.statusText}>{statusText}</Text>}

      <View style={styles.connectRow}>
        <TextInput
          value={wsUrl}
          onChangeText={setWsUrl}
          style={styles.urlInput}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="ws://host:3001"
          placeholderTextColor="#888"
        />
        {!connected ? (
          <TouchableOpacity style={styles.connectButton} onPress={connect}>
            <Text style={styles.connectButtonText}>Connect</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={[styles.connectButton, styles.disconnectButton]} onPress={disconnect}>
            <Text style={styles.connectButtonText}>Disconnect</Text>
          </TouchableOpacity>
        )}
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.main}>
        <FlatList
          data={chatRows}
          keyExtractor={(row) => row.id}
          contentContainerStyle={styles.messagesList}
          renderItem={({ item: row, index }) => {
            if (row.kind === "activity") {
              const isLatest = index === chatRows.length - 1;
              const isLatestRunningActivity = isRunning && isLatest;
              const expanded = isLatest || isActivityExpanded(row.id);
              return (
                <View style={styles.activityCard}>
                  <TouchableOpacity style={styles.activityHeader} onPress={() => toggleActivityGroup(row.id)}>
                    <View style={styles.activityTitleRow}>
                      <Text style={styles.activityTitle}>Agent activity ({row.group.messages.length} events)</Text>
                      {isLatestRunningActivity && (
                        <View style={styles.runningBadge}>
                          <View style={styles.runningBadgeDot} />
                          <Text style={styles.runningBadgeText}>RUNNING</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.activityChevron}>{expanded ? "▼" : "▶"}</Text>
                  </TouchableOpacity>
                  {expanded && (
                    <View style={styles.activityBody}>
                      {row.group.lines.map((line, lineIdx) => (
                        <View key={`${row.id}-line-${lineIdx}`} style={styles.activityLineRow}>
                          <Text style={styles.activityBullet}>•</Text>
                          <LinkifiedText
                            text={line.text}
                            style={styles.activityLineText}
                            linkStyle={styles.activityLink}
                          />
                          {line.count > 1 ? <Text style={styles.activityLineCount}>x{line.count}</Text> : null}
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              );
            }

            const item = row.message;
            const role = item.role || (item.agent_id === "user" ? "user" : "assistant");
            const isUser = role === "user" || item.agent_id === "user";
            if (role === "question") {
              const isAnswered =
                answeredQuestionSet.has(item.timestamp) || derivedAnsweredQuestionSet.has(item.timestamp);
              return (
                <QuestionCard
                  message={item}
                  rowId={row.id}
                  isAnswered={isAnswered}
                  onAnswer={(answer) => {
                    markQuestionAnswered(item.timestamp);
                    sendMessage(answer);
                  }}
                />
              );
            }

            if (item.is_error) {
              const isCredentialError = role === "credential_error";
              return (
                <View
                  style={[
                    styles.errorCard,
                    isCredentialError ? styles.credentialErrorCard : null,
                  ]}
                >
                  <Text style={[styles.errorLabel, isCredentialError ? styles.credentialErrorLabel : null]}>
                    {isCredentialError ? "CREDENTIAL ERROR" : "ERROR"}
                  </Text>
                  <Text style={[styles.errorContent, isCredentialError ? styles.credentialErrorContent : null]}>
                    {item.content}
                  </Text>
                </View>
              );
            }

            return (
              <View style={[styles.messageRow, isUser ? styles.messageRowUser : styles.messageRowAi]}>
                <View
                  style={[
                    styles.messageBubble,
                    isUser ? styles.userBubble : styles.aiBubble,
                  ]}
                >
                  <MarkdownText content={item.content} />
                </View>
              </View>
            );
          }}
        />

        <View style={styles.composerCard}>
          {/* Queued messages */}
          {queuedMessages.length > 0 && (
            <View style={styles.queueSection}>
              <Text style={styles.queueLabel}>QUEUED ({queuedMessages.length})</Text>
              {queuedMessages.map((msg, idx) => (
                <View key={`q-${idx}`} style={styles.queueItem}>
                  <Text style={styles.queueIndex}>#{idx + 1}</Text>
                  <Text style={styles.queueText} numberOfLines={2}>{msg}</Text>
                  <TouchableOpacity onPress={() => removeQueuedMessage(idx)} style={styles.queueRemove}>
                    <Text style={styles.queueRemoveText}>✕</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          <View style={styles.inputRow}>
            <TextInput
              value={input}
              onChangeText={setInput}
              style={styles.messageInput}
              placeholder="Ask to make changes..."
              placeholderTextColor="#7a7a7a"
              multiline
            />
            <View style={styles.sendButtonGroup}>
              {isRunning && (
                <TouchableOpacity style={styles.stopButton} onPress={stopAgent}>
                  <Text style={styles.stopButtonText}>■</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.sendButton, !input.trim() ? styles.sendButtonDisabled : null]}
                onPress={() => sendMessage()}
              >
                <Text style={styles.sendButtonText}>{isRunning ? "⏳" : "➤"}</Text>
              </TouchableOpacity>
            </View>
          </View>
          <View style={styles.composerMetaRow}>
            {isRunning && (
              <View style={[styles.metaChip, styles.metaChipRunning]}>
                <Text style={[styles.metaChipText, { color: "#34d399" }]}>● Running</Text>
              </View>
            )}
            <TouchableOpacity style={styles.metaChip} onPress={cycleModel}>
              <Text style={styles.metaChipText}>Model {selectedModelLabel}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.metaChip} onPress={cycleMode}>
              <Text style={styles.metaChipText}>{claudeMode === "plan" ? "Plan on" : "Plan off"}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.metaChip} onPress={cycleThinking}>
              <Text style={styles.metaChipText}>Think {thinkingMode}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>

      {renderLeftOverlay && (
        <View style={styles.overlay}>
          <Animated.View style={[styles.backdrop, { opacity: leftBackdropOpacity }]}>
            <TouchableOpacity
              style={StyleSheet.absoluteFill}
              activeOpacity={1}
              onPress={() => setLeftOpen(false)}
            />
          </Animated.View>
          <Animated.View
            style={[
              styles.leftDrawer,
              { paddingTop: topInset + 12, transform: [{ translateX: leftDrawerTranslateX }] },
            ]}
          >
            <Text style={styles.drawerTitle}>History</Text>
            <ScrollView>
              <View style={styles.drawerSection}>
                <View style={styles.drawerSectionHeader}>
                  <Text style={styles.drawerSectionTitle}>Repositories</Text>
                  <TouchableOpacity style={styles.iconButton} onPress={() => setShowAddRepoForm((prev) => !prev)}>
                    <Text style={styles.iconButtonText}>+</Text>
                  </TouchableOpacity>
                </View>
                {showAddRepoForm ? (
                  <View style={styles.inlineForm}>
                    <TextInput
                      value={newRepoPath}
                      onChangeText={setNewRepoPath}
                      placeholder="/path/to/repository"
                      placeholderTextColor="#7a726c"
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={styles.inlineFormInput}
                    />
                    <TouchableOpacity style={styles.inlineFormButton} onPress={addRepository}>
                      <Text style={styles.inlineFormButtonText}>Add</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
                {repositories.length === 0 ? (
                  <Text style={styles.emptyText}>No repositories yet.</Text>
                ) : (
                  repositories.map((repo) => (
                    <View
                      key={repo.id}
                      style={[
                        styles.repoItem,
                        selectedRepoId === repo.id ? styles.repoItemActive : null,
                      ]}
                    >
                      <TouchableOpacity
                        style={styles.repoMainButton}
                        onPress={() => selectRepository(repo.id)}
                      >
                        <Text style={styles.repoName} numberOfLines={1}>
                          {repo.name}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.iconButton} onPress={() => setDefaultRepoId(repo.id)}>
                        <Text style={[styles.iconButtonText, defaultRepoId === repo.id ? styles.iconButtonActive : null]}>
                          {defaultRepoId === repo.id ? "★" : "☆"}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.iconButton} onPress={() => removeRepository(repo.id)}>
                        <Text style={[styles.iconButtonText, styles.iconButtonDanger]}>🗑</Text>
                      </TouchableOpacity>
                    </View>
                  ))
                )}
              </View>

              <View style={styles.drawerSection}>
                <View style={styles.drawerSectionHeader}>
                  <Text style={styles.drawerSectionTitle}>Workspaces</Text>
                  <TouchableOpacity
                    style={styles.iconButton}
                    disabled={!selectedRepoId}
                    onPress={() => {
                      setShowAddWorkspaceForm((prev) => !prev);
                      if (!newWorkspaceName.trim()) {
                        setNewWorkspaceName(generateWorkspaceName());
                      }
                    }}
                  >
                    <Text
                      style={[
                        styles.iconButtonText,
                        !selectedRepoId ? styles.iconButtonDisabled : null,
                      ]}
                    >
                      +
                    </Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.drawerCaption}>
                  {selectedRepository ? selectedRepository.name : "Select a repository"}
                </Text>
                <View style={styles.searchRow}>
                  <TextInput
                    value={workspaceSearch}
                    onChangeText={setWorkspaceSearch}
                    placeholder="Filter workspaces..."
                    placeholderTextColor="#7a726c"
                    style={styles.searchInput}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  {workspaceSearch ? (
                    <TouchableOpacity style={styles.searchClear} onPress={() => setWorkspaceSearch("")}>
                      <Text style={styles.searchClearText}>✕</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
                {showAddWorkspaceForm && selectedRepoId ? (
                  <View style={styles.inlineForm}>
                    <TextInput
                      value={newWorkspaceName}
                      onChangeText={setNewWorkspaceName}
                      placeholder="workspace-name"
                      placeholderTextColor="#7a726c"
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={styles.inlineFormInput}
                    />
                    <TouchableOpacity style={styles.inlineFormButton} onPress={createWorkspace}>
                      <Text style={styles.inlineFormButtonText}>Create</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
                {!selectedRepoId ? (
                  <Text style={styles.emptyText}>Choose a repository to see workspaces.</Text>
                ) : workspaces.length === 0 ? (
                  <Text style={styles.emptyText}>No workspaces yet.</Text>
                ) : (
                  workspaceGroups.map((group) => (
                    <View key={group.key} style={styles.workspaceGroup}>
                      <Text style={styles.workspaceGroupTitle}>
                        {group.label} {group.items.length}
                      </Text>
                      {group.items.map((ws) => (
                        <View
                          key={ws.id}
                          style={[
                            styles.wsItem,
                            selectedWorkspaceId === ws.id ? styles.wsItemActive : null,
                          ]}
                        >
                          {renameWorkspaceId === ws.id ? (
                            <View style={styles.wsRenameRow}>
                              <TextInput
                                value={renameWorkspaceName}
                                onChangeText={setRenameWorkspaceName}
                                style={styles.wsRenameInput}
                                autoFocus
                              />
                              <TouchableOpacity style={styles.iconButton} onPress={saveRenameWorkspace}>
                                <Text style={styles.iconButtonText}>✓</Text>
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={styles.iconButton}
                                onPress={() => {
                                  setRenameWorkspaceId(null);
                                  setRenameWorkspaceName("");
                                }}
                              >
                                <Text style={styles.iconButtonText}>✕</Text>
                              </TouchableOpacity>
                            </View>
                          ) : (
                            <>
                              <View style={[styles.wsStatusDot, { backgroundColor: runningByWorkspace[ws.id] ? "#34d399" : statusColor(ws.status) }]} />
                              <TouchableOpacity style={styles.wsMainButton} onPress={() => selectWorkspace(ws.id)}>
                                <Text style={styles.wsName} numberOfLines={1}>
                                  {ws.name}
                                </Text>
                                <View style={styles.wsMetaRow}>
                                  <Text style={styles.wsMeta} numberOfLines={1}>
                                    {ws.branch}
                                  </Text>
                                  {ws.pr_url ? (
                                    <TouchableOpacity onPress={() => Linking.openURL(ws.pr_url!).catch(() => {})}>
                                      <Text style={styles.wsPrBadge}>PR</Text>
                                    </TouchableOpacity>
                                  ) : null}
                                  {ws.pinned_at ? <Text style={styles.wsPinIcon}>📌</Text> : null}
                                </View>
                              </TouchableOpacity>
                              <TouchableOpacity style={styles.iconButton} onPress={() => beginRenameWorkspace(ws)}>
                                <Text style={styles.iconButtonText}>✎</Text>
                              </TouchableOpacity>
                              <TouchableOpacity style={styles.iconButton} onPress={() => removeWorkspace(ws.id)}>
                                <Text style={[styles.iconButtonText, styles.iconButtonDanger]}>🗑</Text>
                              </TouchableOpacity>
                            </>
                          )}
                        </View>
                      ))}
                    </View>
                  ))
                )}
              </View>
            </ScrollView>
          </Animated.View>
        </View>
      )}

      {renderRightOverlay && (
        <View style={styles.overlay}>
          <Animated.View style={[styles.backdrop, { opacity: rightBackdropOpacity }]}>
            <TouchableOpacity
              style={StyleSheet.absoluteFill}
              activeOpacity={1}
              onPress={() => setRightOpen(false)}
            />
          </Animated.View>
          <Animated.View
            style={[
              styles.rightDrawer,
              { paddingTop: topInset + 12, transform: [{ translateX: rightDrawerTranslateX }] },
            ]}
          >
            {/* Workspace info header */}
            {selectedWorkspace && (
              <View style={styles.drawerWorkspaceHeader}>
                <View style={styles.drawerWorkspaceInfo}>
                  <Text style={styles.drawerWorkspaceStatus}>{selectedWorkspace.status === "running" ? "Running" : selectedWorkspace.status === "idle" ? "Idle" : selectedWorkspace.status === "inReview" ? "In Review" : selectedWorkspace.status === "merged" ? "Merged" : selectedWorkspace.status}</Text>
                  <Text style={styles.drawerWorkspaceBranch} numberOfLines={1}>{selectedWorkspace.branch}</Text>
                </View>
                {selectedWorkspace.pr_url && (
                  <TouchableOpacity style={styles.prBadge} onPress={() => Linking.openURL(selectedWorkspace.pr_url!).catch(() => {})}>
                    <Text style={styles.prBadgeText}>🔗 Pull Request</Text>
                  </TouchableOpacity>
                )}
                {/* Notes */}
                <View style={styles.notesSection}>
                  {editingNotes ? (
                    <View style={styles.notesEditContainer}>
                      <TextInput
                        value={notesValue}
                        onChangeText={setNotesValue}
                        style={styles.notesInput}
                        multiline
                        placeholder="Workspace notes..."
                        placeholderTextColor="#7a726c"
                        autoFocus
                      />
                      <View style={styles.notesActions}>
                        <TouchableOpacity onPress={() => { setNotesValue(selectedWorkspace.notes ?? ""); setEditingNotes(false); }}>
                          <Text style={styles.notesCancelText}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={saveNotes}>
                          <Text style={styles.notesSaveText}>Save</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  ) : (
                    <TouchableOpacity onPress={() => { setNotesValue(selectedWorkspace.notes ?? ""); setEditingNotes(true); }}>
                      <Text style={selectedWorkspace.notes ? styles.notesText : styles.notesPlaceholder} numberOfLines={2}>
                        {selectedWorkspace.notes || "Add notes..."}
                      </Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            )}

            <View style={styles.tabRow}>
              {(["prompts", "all_files", "changes", "checks", "terminal"] as const).map((tab) => (
                <TouchableOpacity key={tab} style={[styles.tabButton, rightTab === tab && styles.tabButtonActive]} onPress={() => openRightDrawer(tab)}>
                  <Text style={[styles.tabText, rightTab === tab && styles.tabTextActive]}>
                    {tab === "all_files" ? "files" : tab === "terminal" ? "term" : tab}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.drawerContent}>
              {rightTab === "prompts" && (
                <>
                  <View style={styles.drawerActions}>
                    <TouchableOpacity style={styles.secondaryButton} onPress={() => setShowAddPromptForm((prev) => !prev)}>
                      <Text style={styles.secondaryButtonText}>{showAddPromptForm ? "Close" : "Add Prompt"}</Text>
                    </TouchableOpacity>
                  </View>
                  {showAddPromptForm ? (
                    <View style={styles.promptForm}>
                      <TextInput
                        value={newPromptName}
                        onChangeText={setNewPromptName}
                        style={styles.promptNameInput}
                        placeholder="Prompt name"
                        placeholderTextColor="#7a726c"
                      />
                      <TextInput
                        value={newPromptBody}
                        onChangeText={setNewPromptBody}
                        style={styles.promptBodyInput}
                        placeholder="Prompt text"
                        placeholderTextColor="#7a726c"
                        multiline
                      />
                      <TouchableOpacity style={styles.secondaryButton} onPress={addPromptShortcut}>
                        <Text style={styles.secondaryButtonText}>Save Prompt</Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                  <ScrollView>
                    {promptShortcuts.length === 0 ? <Text style={styles.drawerText}>No prompt shortcuts yet.</Text> : null}
                    {promptShortcuts.map((shortcut) => (
                      <View key={shortcut.id} style={styles.promptItem}>
                        <TouchableOpacity style={styles.promptMainButton} onPress={() => runPromptShortcut(shortcut)}>
                          <Text style={styles.promptName}>{shortcut.name}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.iconButton} onPress={() => deletePromptShortcut(shortcut.id)}>
                          <Text style={[styles.iconButtonText, styles.iconButtonDanger]}>🗑</Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                  </ScrollView>
                  {selectedWorkspaceId ? (
                    <View style={styles.actionsSection}>
                      <Text style={styles.actionsSectionTitle}>Actions</Text>
                      <TouchableOpacity
                        style={styles.actionItem}
                        onPress={() => {
                          sendMessage(
                            "Push this branch to origin and create a pull request using `gh pr create`. Write a clear, descriptive PR title and body based on the changes on this branch. Use `git log main..HEAD` and `git diff main` to understand what changed."
                          );
                          setRightOpen(false);
                        }}
                      >
                        <Text style={styles.actionIcon}>⎇</Text>
                        <Text style={styles.actionLabel}>Open Pull Request</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.actionItem}
                        onPress={() => {
                          sendMessage(
                            "Review the code changes on this branch. Use `git diff main` to see what changed. For each file, analyze the changes and provide feedback on:\n- Correctness and potential bugs\n- Code quality and readability\n- Performance concerns\n- Security issues\n- Suggestions for improvement\n\nBe specific with line references and provide actionable feedback. Summarize with an overall assessment."
                          );
                          setRightOpen(false);
                        }}
                      >
                        <Text style={styles.actionIcon}>✎</Text>
                        <Text style={styles.actionLabel}>Code Review</Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                </>
              )}
              {rightTab === "all_files" && (
                <>
                  <View style={styles.drawerActions}>
                    <TouchableOpacity style={styles.secondaryButton} onPress={navigateUp} disabled={!filesPath}>
                      <Text style={styles.secondaryButtonText}>Up</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.secondaryButton} onPress={() => selectedWorkspaceId && refreshFiles(selectedWorkspaceId, filesPath)}>
                      <Text style={styles.secondaryButtonText}>Refresh</Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.pathText}>/{filesPath || ""}</Text>
                  {filesLoading ? <Text style={styles.drawerText}>Loading files...</Text> : null}
                  <ScrollView style={styles.filesList}>
                    {fileEntries.map((entry) => (
                      <TouchableOpacity key={entry.path} style={styles.fileItem} onPress={() => openEntry(entry)}>
                        <Text style={styles.fileItemText}>
                          {entry.is_dir ? "▸ " : "  "}
                          {entry.name}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                  {!!selectedFilePath && (
                    <>
                      <Text style={styles.fileTitle}>{selectedFilePath}</Text>
                      <ScrollView style={styles.fileContentBox}>
                        <Text style={styles.fileContentText}>{selectedFileContent}</Text>
                      </ScrollView>
                    </>
                  )}
                </>
              )}
              {rightTab === "changes" && (
                <>
                  {diffContent !== null && diffFilePath ? (
                    <>
                      <View style={styles.drawerActions}>
                        <TouchableOpacity style={styles.secondaryButton} onPress={() => { setDiffContent(null); setDiffFilePath(null); }}>
                          <Text style={styles.secondaryButtonText}>← Back</Text>
                        </TouchableOpacity>
                      </View>
                      <Text style={styles.fileTitle}>{diffFilePath}</Text>
                      <ScrollView style={styles.diffBox}>
                        {diffContent.split("\n").map((line, i) => {
                          let color = "#c7beb7";
                          if (line.startsWith("+") && !line.startsWith("+++")) color = "#4ade80";
                          else if (line.startsWith("-") && !line.startsWith("---")) color = "#f87171";
                          else if (line.startsWith("@@")) color = "#22d3ee";
                          else if (line.startsWith("diff") || line.startsWith("index")) color = "#6d645e";
                          return (
                            <Text key={i} style={[styles.diffLine, { color }]}>
                              {line || " "}
                            </Text>
                          );
                        })}
                      </ScrollView>
                    </>
                  ) : (
                    <>
                      <View style={styles.drawerActions}>
                        <TouchableOpacity style={styles.secondaryButton} onPress={() => selectedWorkspaceId && refreshChanges(selectedWorkspaceId)}>
                          <Text style={styles.secondaryButtonText}>Refresh</Text>
                        </TouchableOpacity>
                      </View>
                      <Text style={styles.pathText}>Changed files ({changes.length})</Text>
                      {changesLoading ? <Text style={styles.drawerText}>Loading changes...</Text> : null}
                      <ScrollView style={styles.changesList}>
                        {changes.length === 0 ? <Text style={styles.drawerText}>No local changes.</Text> : null}
                        {sortedChanges.map((c, idx) => {
                          const statusBadgeColor =
                            c.status === "M" ? "#facc15" :
                            c.status === "A" || c.status === "??" ? "#4ade80" :
                            c.status === "D" ? "#f87171" : "#8d847d";
                          return (
                            <View key={`${c.path}-${idx}`}>
                              <TouchableOpacity
                                style={styles.changeItem}
                                onPress={() => viewDiff(c.path)}
                              >
                                <Text style={[styles.changeStatusBadge, { color: statusBadgeColor }]}>
                                  {c.status.padEnd(2)}
                                </Text>
                                <Text style={styles.changePath} numberOfLines={1}>
                                  {c.path}
                                </Text>
                                <Text style={styles.changeChevron}>▶</Text>
                              </TouchableOpacity>
                              {c.old_path ? (
                                <Text style={styles.changeOldPath} numberOfLines={1}>
                                  from: {c.old_path}
                                </Text>
                              ) : null}
                            </View>
                          );
                        })}
                      </ScrollView>
                      {loadingChangedFilePath ? (
                        <Text style={styles.drawerText}>Loading {loadingChangedFilePath}...</Text>
                      ) : null}
                    </>
                  )}
                </>
              )}
              {rightTab === "checks" && (
                <>
                  <View style={styles.drawerActions}>
                    <TouchableOpacity style={styles.secondaryButton} onPress={runChecks} disabled={checksRunning}>
                      <Text style={styles.secondaryButtonText}>{checksRunning ? "Running..." : "Run Checks"}</Text>
                    </TouchableOpacity>
                  </View>
                  <ScrollView>
                    {checks.length === 0 ? <Text style={styles.drawerText}>Click "Run Checks" to start.</Text> : null}
                    {checks.map((check, idx) => (
                      <View key={`${check.name}-${idx}`} style={styles.checkItem}>
                        <View style={styles.checkTitleRow}>
                          <Text style={[styles.checkIcon, check.success ? styles.checkPass : styles.checkFail]}>
                            {check.skipped ? "—" : check.success ? "✓" : "✕"}
                          </Text>
                          <Text style={styles.checkTitle}>{check.name}</Text>
                          {check.duration_ms > 0 && (
                            <Text style={styles.checkDuration}>{(check.duration_ms / 1000).toFixed(1)}s</Text>
                          )}
                        </View>
                        <Text style={styles.checkMeta}>{check.command}</Text>
                        {check.stdout ? (
                          <Text style={styles.checkOutput}>{check.stdout.trim().slice(0, 2000)}</Text>
                        ) : null}
                        {check.stderr ? (
                          <Text style={styles.checkOutputError}>{check.stderr.trim().slice(0, 2000)}</Text>
                        ) : null}
                      </View>
                    ))}
                  </ScrollView>
                </>
              )}
              {rightTab === "terminal" && (
                <>
                  <ScrollView style={styles.terminalOutput}>
                    {terminalHistory.length === 0 ? (
                      <Text style={styles.drawerText}>Run shell commands in workspace context.</Text>
                    ) : null}
                    {terminalHistory.map((entry) => (
                      <View key={entry.id} style={styles.terminalEntry}>
                        <View style={styles.terminalCommandRow}>
                          <Text style={styles.terminalPrompt}>$</Text>
                          <Text style={styles.terminalCommand}>{entry.command}</Text>
                          {entry.running ? <View style={styles.terminalRunningDot} /> : null}
                        </View>
                        {entry.stdout ? <Text style={styles.terminalStdout}>{entry.stdout}</Text> : null}
                        {entry.stderr ? <Text style={styles.terminalStderr}>{entry.stderr}</Text> : null}
                        {entry.exit_code != null && entry.exit_code !== 0 && (
                          <Text style={styles.terminalExitCode}>exit {entry.exit_code}</Text>
                        )}
                      </View>
                    ))}
                  </ScrollView>
                  <View style={styles.terminalInputRow}>
                    <Text style={styles.terminalInputPrompt}>$</Text>
                    <TextInput
                      value={terminalInput}
                      onChangeText={setTerminalInput}
                      style={styles.terminalInputField}
                      placeholder="command..."
                      placeholderTextColor="#6a625c"
                      autoCapitalize="none"
                      autoCorrect={false}
                      editable={!terminalRunning}
                      onSubmitEditing={runTerminalCommand}
                      returnKeyType="go"
                    />
                    {terminalHistory.length > 0 && (
                      <TouchableOpacity onPress={() => { setTerminalHistory([]); setTerminalRunning(false); }}>
                        <Text style={styles.terminalClear}>Clear</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </>
              )}
            </View>
          </Animated.View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#120f0d" },
  header: {
    height: 48,
    borderBottomWidth: 1,
    borderBottomColor: "#2b2623",
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerCenter: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1, justifyContent: "center", maxWidth: "60%" },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  headerTitle: { color: "#e6e0da", fontSize: 14, fontWeight: "600", flexShrink: 1 },
  smallButton: { paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: "#3a332f", borderRadius: 8 },
  smallButtonText: { color: "#d6d1cb", fontSize: 12 },
  connectRow: { flexDirection: "row", padding: 10, gap: 8, borderBottomWidth: 1, borderBottomColor: "#2b2623" },
  urlInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#3a332f",
    borderRadius: 8,
    color: "#e6e0da",
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: "#1c1815",
  },
  connectButton: { backgroundColor: "#2b5d8a", paddingHorizontal: 12, borderRadius: 8, justifyContent: "center" },
  disconnectButton: { backgroundColor: "#7f2f2f" },
  connectButtonText: { color: "#fff", fontWeight: "600" },
  statusText: { color: "#a79e96", fontSize: 12, paddingHorizontal: 12, paddingTop: 6 },
  main: { flex: 1 },
  messagesList: { padding: 12, gap: 12 },
  activityCard: {
    borderWidth: 1,
    borderColor: "#35302b",
    borderRadius: 10,
    backgroundColor: "#171412",
    marginBottom: 6,
  },
  activityHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  activityTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
  activityTitle: { color: "#b9b0a8", fontSize: 12 },
  runningBadge: { flexDirection: "row", alignItems: "center", gap: 4, borderWidth: 1, borderColor: "rgba(217,119,6,0.4)", backgroundColor: "rgba(120,53,15,0.3)", borderRadius: 999, paddingHorizontal: 6, paddingVertical: 2 },
  runningBadgeDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#fbbf24" },
  runningBadgeText: { color: "#fbbf24", fontSize: 9, fontWeight: "700", letterSpacing: 0.5 },
  activityChevron: { color: "#938a83", fontSize: 12 },
  activityBody: { paddingHorizontal: 10, paddingBottom: 8, gap: 4 },
  activityLineRow: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  activityBullet: { color: "#6a5f57", fontSize: 11, marginTop: 1 },
  activityLineText: { color: "#9f968f", fontSize: 11, flex: 1, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  activityLink: { color: "#8cbbe6", textDecorationLine: "underline" },
  activityLineCount: { color: "#6d645e", fontSize: 10 },
  messageRow: { flexDirection: "row" },
  messageRowUser: { justifyContent: "flex-end" },
  messageRowAi: { justifyContent: "flex-start" },
  messageBubble: { maxWidth: "82%", borderRadius: 14, paddingHorizontal: 12, paddingVertical: 10 },
  userBubble: { backgroundColor: "#1f3d57", borderWidth: 1, borderColor: "#2f5e86" },
  aiBubble: { backgroundColor: "#1c1815", borderWidth: 1, borderColor: "#39312b" },
  errorCard: { borderWidth: 1, borderColor: "rgba(225,29,72,0.4)", backgroundColor: "rgba(76,5,25,0.2)", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  credentialErrorCard: { borderColor: "rgba(217,119,6,0.4)", backgroundColor: "rgba(120,53,15,0.25)" },
  errorLabel: { color: "#fda4af", fontSize: 10, fontWeight: "700", letterSpacing: 0.5, marginBottom: 4 },
  credentialErrorLabel: { color: "#fbbf24" },
  errorContent: { color: "#fecdd3", fontSize: 13, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  credentialErrorContent: { color: "#fde68a" },
  questionCard: {
    borderWidth: 1,
    borderColor: "#3c332d",
    borderRadius: 12,
    backgroundColor: "#171412",
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  questionLabel: { color: "#8f857d", fontSize: 11, fontWeight: "700", marginBottom: 6 },
  questionBlock: { marginBottom: 8, gap: 4 },
  questionHeader: { color: "#a9a099", fontSize: 12 },
  questionText: { color: "#ece8e4", fontSize: 15, lineHeight: 20 },
  questionOptions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  questionOption: {
    borderWidth: 1,
    borderColor: "#4a4038",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#201b17",
  },
  questionOptionSelected: {
    borderColor: "#8d7a68",
    backgroundColor: "#2b231d",
  },
  questionOptionDisabled: { opacity: 0.5 },
  questionOptionText: { color: "#d8d0c8", fontSize: 12 },
  questionSubmitRow: { marginTop: 4, gap: 8 },
  questionSubmitButton: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "#5f5449",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#1f1a16",
  },
  questionSubmitButtonText: { color: "#d8d0c8", fontSize: 12, fontWeight: "600" },
  questionHint: { color: "#9a9088", fontSize: 12, marginTop: 2 },
  composerCard: {
    borderTopWidth: 1,
    borderTopColor: "#2b2623",
    paddingHorizontal: 10,
    paddingTop: 9,
    paddingBottom: 8,
    backgroundColor: "#15110f",
    gap: 8,
  },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  messageInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: "#3a332f",
    borderRadius: 12,
    backgroundColor: "#1c1815",
    color: "#e6e0da",
    paddingHorizontal: 10,
    paddingTop: 9,
    paddingBottom: 9,
    fontSize: 14,
  },
  sendButton: {
    alignSelf: "flex-end",
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#2b5d8a",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#3a6f9d",
  },
  sendButtonDisabled: {
    opacity: 0.55,
  },
  sendButtonText: { color: "#fff", fontWeight: "700", fontSize: 14, marginLeft: 1 },
  composerMetaRow: {
    flexDirection: "row",
    gap: 6,
    flexWrap: "wrap",
  },
  metaChip: {
    borderWidth: 1,
    borderColor: "#3f3832",
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
    backgroundColor: "#1b1714",
  },
  metaChipText: { color: "#beb4ac", fontSize: 11, fontWeight: "600" },
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 30 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.5)" },
  leftDrawer: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: "72%",
    maxWidth: 320,
    backgroundColor: "#171311",
    padding: 12,
    borderRightWidth: 1,
    borderRightColor: "#2b2623",
  },
  rightDrawer: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: "78%",
    maxWidth: 340,
    backgroundColor: "#171311",
    padding: 12,
    borderLeftWidth: 1,
    borderLeftColor: "#2b2623",
  },
  drawerTitle: { color: "#e6e0da", fontSize: 16, fontWeight: "700", marginBottom: 10 },
  drawerSection: { marginBottom: 14 },
  drawerSectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  drawerSectionTitle: { color: "#cfc7c1", fontSize: 13, fontWeight: "700" },
  drawerCaption: { color: "#918880", fontSize: 11, marginBottom: 8 },
  emptyText: { color: "#8f857d", fontSize: 12, marginTop: 2, marginBottom: 6 },
  iconButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#4a4038",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1d1916",
  },
  iconButtonText: { color: "#d5ccc5", fontSize: 13, lineHeight: 14 },
  iconButtonActive: { color: "#f7ca6a" },
  iconButtonDanger: { color: "#d98b8b" },
  iconButtonDisabled: { color: "#6a625c" },
  inlineForm: { flexDirection: "row", gap: 8, marginBottom: 8 },
  inlineFormInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#433a34",
    borderRadius: 8,
    backgroundColor: "#14110f",
    color: "#e8e1db",
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12,
  },
  inlineFormButton: {
    borderWidth: 1,
    borderColor: "#5b4f46",
    borderRadius: 8,
    backgroundColor: "#26211d",
    paddingHorizontal: 10,
    justifyContent: "center",
  },
  inlineFormButtonText: { color: "#d9d1ca", fontSize: 12, fontWeight: "600" },
  repoItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: "#36302a",
    borderRadius: 10,
    backgroundColor: "#171411",
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 6,
  },
  repoItemActive: { borderColor: "#6a5b52", backgroundColor: "#221d19" },
  repoMainButton: { flex: 1, minWidth: 0 },
  repoName: { color: "#ece8e4", fontSize: 13, fontWeight: "600" },
  workspaceGroup: { marginBottom: 10 },
  workspaceGroupTitle: { color: "#8f857d", fontSize: 11, marginBottom: 6 },
  wsItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: "#36302a",
    borderRadius: 10,
    backgroundColor: "#171411",
    paddingHorizontal: 8,
    paddingVertical: 7,
    marginBottom: 6,
  },
  wsItemActive: { borderColor: "#6a5b52", backgroundColor: "#221d19" },
  wsMainButton: { flex: 1, minWidth: 0 },
  wsName: { color: "#ece8e4", fontSize: 13, fontWeight: "600" },
  wsMeta: { color: "#a79e96", fontSize: 11, marginTop: 2 },
  wsRenameRow: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1 },
  wsRenameInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#4a4038",
    borderRadius: 8,
    backgroundColor: "#14110f",
    color: "#ece8e4",
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 12,
  },
  tabRow: { flexDirection: "row", gap: 6, marginBottom: 12 },
  tabButton: { borderWidth: 1, borderColor: "#39312b", borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6 },
  tabButtonActive: { backgroundColor: "#2a2320", borderColor: "#6a5b52" },
  tabText: { color: "#a79e96", fontSize: 12 },
  tabTextActive: { color: "#ece8e4" },
  drawerContent: { borderWidth: 1, borderColor: "#39312b", borderRadius: 8, padding: 10, backgroundColor: "#1c1815" },
  drawerText: { color: "#b8aea7", fontSize: 13 },
  drawerActions: { flexDirection: "row", gap: 8, marginBottom: 8 },
  secondaryButton: { borderWidth: 1, borderColor: "#5a4f47", borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  secondaryButtonText: { color: "#d9d1ca", fontSize: 12 },
  pathText: { color: "#938a83", fontSize: 12, marginBottom: 8 },
  filesList: { maxHeight: 220, marginBottom: 10 },
  fileItem: { paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: "#2b2623" },
  fileItemText: { color: "#ddd4cd", fontSize: 13 },
  fileTitle: { color: "#ece8e4", fontSize: 12, fontWeight: "600", marginBottom: 6 },
  fileContentBox: { maxHeight: 220, borderWidth: 1, borderColor: "#2f2925", borderRadius: 6, backgroundColor: "#161311", padding: 8 },
  fileContentText: { color: "#c7beb7", fontSize: 12, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  changesList: { maxHeight: 250, marginBottom: 8 },
  changeItem: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: "#2f2925",
    borderRadius: 8,
    backgroundColor: "#171411",
    marginBottom: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  changePath: { color: "#ddd4cd", fontSize: 12, flex: 1 },
  changeOldPath: { color: "#8d847d", fontSize: 11, marginBottom: 6, marginLeft: 8 },
  checkItem: { marginBottom: 10, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: "#2b2623" },
  checkTitle: { color: "#ece8e4", fontSize: 12, fontWeight: "700" },
  checkMeta: { color: "#8d847d", fontSize: 11, marginTop: 3 },
  checkOutput: { color: "#c7beb7", fontSize: 11, marginTop: 6 },
  checkOutputError: { color: "#da8e8e", fontSize: 11, marginTop: 6 },
  promptForm: { marginBottom: 10, gap: 8 },
  promptNameInput: {
    borderWidth: 1,
    borderColor: "#433a34",
    borderRadius: 8,
    backgroundColor: "#14110f",
    color: "#e8e1db",
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12,
  },
  promptBodyInput: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: "#433a34",
    borderRadius: 8,
    backgroundColor: "#14110f",
    color: "#e8e1db",
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12,
    textAlignVertical: "top",
  },
  promptItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: "#35302b",
    borderRadius: 10,
    backgroundColor: "#171411",
    marginBottom: 8,
    paddingHorizontal: 8,
    paddingVertical: 7,
  },
  promptMainButton: { flex: 1 },
  promptName: { color: "#ece8e4", fontSize: 13, fontWeight: "600" },
  actionsSection: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "#2b2623",
  },
  actionsSectionTitle: {
    color: "#cfc7c1",
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 8,
  },
  actionItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: "#35302b",
    borderRadius: 10,
    backgroundColor: "#171411",
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  actionIcon: { color: "#918880", fontSize: 15 },
  actionLabel: { color: "#ece8e4", fontSize: 13, fontWeight: "500" },

  // Queue styles
  queueSection: { marginBottom: 8, gap: 6 },
  queueLabel: { color: "#6d645e", fontSize: 10, fontWeight: "700", letterSpacing: 0.8 },
  queueItem: { flexDirection: "row", alignItems: "flex-start", gap: 8, borderWidth: 1, borderColor: "rgba(56,189,248,0.2)", backgroundColor: "rgba(8,47,73,0.2)", borderRadius: 8, borderStyle: "dashed", paddingHorizontal: 10, paddingVertical: 8 },
  queueIndex: { color: "rgba(56,189,248,0.5)", fontSize: 10, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", marginTop: 2 },
  queueText: { flex: 1, color: "#beb4ac", fontSize: 12 },
  queueRemove: { paddingLeft: 4 },
  queueRemoveText: { color: "#6d645e", fontSize: 12 },

  // Stop button
  sendButtonGroup: { flexDirection: "column", alignItems: "center", gap: 4 },
  stopButton: { width: 40, height: 28, borderRadius: 8, backgroundColor: "#7f2f2f", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#a33" },
  stopButtonText: { color: "#fca5a5", fontSize: 10, fontWeight: "700" },
  metaChipRunning: { borderColor: "rgba(52,211,153,0.3)", backgroundColor: "rgba(6,78,59,0.2)" },

  // Search
  searchRow: { flexDirection: "row", alignItems: "center", marginBottom: 8, borderWidth: 1, borderColor: "#433a34", borderRadius: 8, backgroundColor: "#14110f", paddingHorizontal: 8 },
  searchInput: { flex: 1, color: "#e8e1db", fontSize: 12, paddingVertical: 7 },
  searchClear: { paddingLeft: 6 },
  searchClearText: { color: "#6d645e", fontSize: 13 },

  // Workspace status dot and meta
  wsStatusDot: { width: 10, height: 10, borderRadius: 5, marginRight: 2 },
  wsMetaRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  wsPrBadge: { color: "#c084fc", fontSize: 10, fontWeight: "600", borderWidth: 1, borderColor: "rgba(168,85,247,0.3)", backgroundColor: "rgba(107,33,168,0.15)", borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1, overflow: "hidden" },
  wsPinIcon: { fontSize: 10 },

  // Drawer workspace header (right drawer)
  drawerWorkspaceHeader: { paddingHorizontal: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#2b2623", marginBottom: 8 },
  drawerWorkspaceInfo: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  drawerWorkspaceStatus: { color: "#a79e96", fontSize: 11 },
  drawerWorkspaceBranch: { color: "#6d645e", fontSize: 11, flex: 1, textAlign: "right", marginLeft: 8 },
  prBadge: { marginTop: 6, alignSelf: "flex-start", borderWidth: 1, borderColor: "rgba(168,85,247,0.3)", backgroundColor: "rgba(107,33,168,0.1)", borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  prBadgeText: { color: "#c4b5fd", fontSize: 11 },

  // Notes
  notesSection: { marginTop: 6 },
  notesEditContainer: { gap: 6 },
  notesInput: { borderWidth: 1, borderColor: "#433a34", borderRadius: 8, backgroundColor: "#14110f", color: "#e8e1db", paddingHorizontal: 8, paddingVertical: 6, fontSize: 12, minHeight: 50, textAlignVertical: "top" },
  notesActions: { flexDirection: "row", justifyContent: "flex-end", gap: 12 },
  notesCancelText: { color: "#6d645e", fontSize: 11 },
  notesSaveText: { color: "#38bdf8", fontSize: 11 },
  notesText: { color: "#b8aea7", fontSize: 11 },
  notesPlaceholder: { color: "#6d645e", fontSize: 11, fontStyle: "italic" },

  // Diff viewer
  diffBox: { maxHeight: 350, borderWidth: 1, borderColor: "#2f2925", borderRadius: 6, backgroundColor: "#0d0b0a", padding: 8 },
  diffLine: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 11, lineHeight: 16 },

  // Change status badge (colored)
  changeStatusBadge: { fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 11, fontWeight: "700", width: 22 },
  changeChevron: { color: "#6d645e", fontSize: 10 },

  // Check enhancements
  checkTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  checkIcon: { fontSize: 14, fontWeight: "700" },
  checkPass: { color: "#4ade80" },
  checkFail: { color: "#f87171" },
  checkDuration: { color: "#6d645e", fontSize: 10, marginLeft: "auto" },

  // Terminal
  terminalOutput: { flex: 1, padding: 8 },
  terminalEntry: { marginBottom: 12 },
  terminalCommandRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
  terminalPrompt: { color: "rgba(56,189,248,0.5)", fontSize: 12, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  terminalCommand: { color: "#38bdf8", fontSize: 12, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", flex: 1 },
  terminalRunningDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#34d399" },
  terminalStdout: { color: "rgba(134,239,172,0.8)", fontSize: 11, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  terminalStderr: { color: "rgba(252,165,165,0.8)", fontSize: 11, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  terminalExitCode: { color: "rgba(248,113,113,0.7)", fontSize: 10, marginTop: 2 },
  terminalInputRow: { flexDirection: "row", alignItems: "center", gap: 6, borderTopWidth: 1, borderTopColor: "#2b2623", paddingHorizontal: 8, paddingVertical: 8 },
  terminalInputPrompt: { color: "rgba(56,189,248,0.4)", fontSize: 12, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  terminalInputField: { flex: 1, color: "#38bdf8", fontSize: 12, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", paddingVertical: 4 },
  terminalClear: { color: "#6d645e", fontSize: 11 },
});

const markdownStyles = StyleSheet.create({
  body: {
    color: "#ece8e4",
    fontSize: 14,
    lineHeight: 21,
    marginTop: 0,
    marginBottom: 0,
  },
  paragraph: {
    marginTop: 0,
    marginBottom: 8,
  },
  text: {
    color: "#ece8e4",
  },
  strong: {
    color: "#f7f2ed",
    fontWeight: "700",
  },
  em: {
    fontStyle: "italic",
  },
  code_inline: {
    color: "#e6ddd6",
    backgroundColor: "#2a2521",
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 12,
  },
  code_block: {
    color: "#ddd4cd",
    backgroundColor: "#151210",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#3a312b",
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 12,
  },
  fence: {
    color: "#ddd4cd",
    backgroundColor: "#151210",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#3a312b",
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 12,
  },
  link: {
    color: "#8cbbe6",
    textDecorationLine: "underline",
  },
  blockquote: {
    borderLeftWidth: 2,
    borderLeftColor: "#5c534d",
    paddingLeft: 8,
    marginTop: 4,
    marginBottom: 8,
  },
  bullet_list: {
    marginTop: 4,
    marginBottom: 8,
  },
  ordered_list: {
    marginTop: 4,
    marginBottom: 8,
  },
  list_item: {
    marginTop: 2,
    marginBottom: 2,
  },
  heading1: {
    color: "#f0e9e2",
    fontSize: 20,
    fontWeight: "700",
    marginTop: 6,
    marginBottom: 8,
  },
  heading2: {
    color: "#f0e9e2",
    fontSize: 18,
    fontWeight: "700",
    marginTop: 6,
    marginBottom: 8,
  },
  heading3: {
    color: "#ece8e4",
    fontSize: 16,
    fontWeight: "700",
    marginTop: 5,
    marginBottom: 7,
  },
  heading4: {
    color: "#ece8e4",
    fontSize: 15,
    fontWeight: "600",
    marginTop: 4,
    marginBottom: 6,
  },
  heading5: {
    color: "#d6cdc5",
    fontSize: 14,
    fontWeight: "600",
    marginTop: 4,
    marginBottom: 6,
  },
  heading6: {
    color: "#c4b9b0",
    fontSize: 13,
    fontWeight: "600",
    marginTop: 3,
    marginBottom: 5,
  },
  hr: {
    backgroundColor: "#3f3630",
    height: 1,
    marginVertical: 6,
  },
  table: {
    borderWidth: 1,
    borderColor: "#4a4038",
    borderRadius: 6,
    overflow: "hidden",
    marginVertical: 4,
  },
  thead: {
    backgroundColor: "#201a16",
  },
  tr: {
    borderBottomWidth: 1,
    borderBottomColor: "#3a312b",
  },
  th: {
    color: "#f0e9e2",
    fontSize: 12,
    fontWeight: "700",
    paddingHorizontal: 6,
    paddingVertical: 5,
    borderRightWidth: 1,
    borderRightColor: "#3a312b",
  },
  td: {
    color: "#ddd4cd",
    fontSize: 12,
    paddingHorizontal: 6,
    paddingVertical: 5,
    borderRightWidth: 1,
    borderRightColor: "#3a312b",
  },
});

export default App;
