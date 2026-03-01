import React, { useEffect, useMemo, useRef, useState } from "react";
import { SafeAreaView, StatusBar, StyleSheet, Text, TextInput, TouchableOpacity, View, FlatList, KeyboardAvoidingView, Platform, ScrollView } from "react-native";

type WorkspaceInfo = {
  id: string;
  name: string;
  branch: string;
  status: string;
  has_agent: boolean;
};

type MessageInfo = {
  agent_id: string;
  content: string;
  is_error: boolean;
  timestamp: string;
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

type WsResponse =
  | { type: "connected" }
  | { type: "workspace_list"; workspaces: WorkspaceInfo[] }
  | { type: "message_history"; workspace_id: string; messages: MessageInfo[] }
  | { type: "files_list"; workspace_id: string; relative_path: string; entries: FileEntryInfo[] }
  | { type: "file_content"; workspace_id: string; path: string; content: string }
  | { type: "changes_list"; workspace_id: string; changes: ChangeInfo[] }
  | { type: "checks_result"; workspace_id: string; checks: CheckInfo[] }
  | { type: "agent_started"; workspace_id: string; agent_id: string }
  | { type: "agent_message"; workspace_id: string; content: string; is_error: boolean; timestamp: string }
  | { type: "error"; message: string }
  | { type: string; [key: string]: any };

function App() {
  const wsRef = useRef<WebSocket | null>(null);
  const [wsUrl, setWsUrl] = useState("ws://192.168.1.42:3001");
  const [connected, setConnected] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [messagesByWorkspace, setMessagesByWorkspace] = useState<Record<string, MessageInfo[]>>({});
  const [input, setInput] = useState("");
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [rightTab, setRightTab] = useState<"all_files" | "changes" | "checks">("all_files");
  const [statusText, setStatusText] = useState("");
  const [filesPath, setFilesPath] = useState("");
  const [fileEntries, setFileEntries] = useState<FileEntryInfo[]>([]);
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [selectedFileContent, setSelectedFileContent] = useState("");
  const [changes, setChanges] = useState<ChangeInfo[]>([]);
  const [checks, setChecks] = useState<CheckInfo[]>([]);
  const [checksRunning, setChecksRunning] = useState(false);
  const [filesLoading, setFilesLoading] = useState(false);
  const [changesLoading, setChangesLoading] = useState(false);

  const selectedWorkspace = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) || null,
    [workspaces, selectedWorkspaceId],
  );

  const currentMessages = selectedWorkspaceId ? messagesByWorkspace[selectedWorkspaceId] || [] : [];

  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

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
      sendJson({ type: "list_workspaces" });
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
        setWorkspaces(parsed.workspaces || []);
        if (!selectedWorkspaceId && parsed.workspaces && parsed.workspaces.length > 0) {
          const first = parsed.workspaces[0].id;
          setSelectedWorkspaceId(first);
          bootstrapWorkspace(first);
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
          agent_id: parsed.is_error ? "error" : "assistant",
          content: parsed.content,
          is_error: parsed.is_error,
          timestamp: parsed.timestamp,
        };
        setMessagesByWorkspace((prev) => ({
          ...prev,
          [parsed.workspace_id]: [...(prev[parsed.workspace_id] || []), item],
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
        if (parsed.workspace_id !== selectedWorkspaceId) return;
        setStatusText(`Agent running: ${parsed.agent_id.slice(0, 8)}`);
        return;
      }

      if (parsed.type === "error") {
        setFilesLoading(false);
        setChangesLoading(false);
        setChecksRunning(false);
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

  function sendMessage() {
    if (!selectedWorkspaceId || !input.trim()) return;

    const messageText = input.trim();
    const localUser: MessageInfo = {
      agent_id: "user",
      content: messageText,
      is_error: false,
      timestamp: new Date().toISOString(),
    };

    setMessagesByWorkspace((prev) => ({
      ...prev,
      [selectedWorkspaceId]: [...(prev[selectedWorkspaceId] || []), localUser],
    }));

    sendJson({ type: "send_message", workspace_id: selectedWorkspaceId, message: messageText });
    setInput("");
  }

  function openRightDrawer(tab: "all_files" | "changes" | "checks") {
    setRightTab(tab);
    setRightOpen(true);
    if (!selectedWorkspaceId) return;
    if (tab === "all_files") {
      refreshFiles(selectedWorkspaceId, filesPath || "");
    } else if (tab === "changes") {
      refreshChanges(selectedWorkspaceId);
    }
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

  function runChecks() {
    if (!selectedWorkspaceId || checksRunning) return;
    setChecksRunning(true);
    sendJson({ type: "run_checks", workspace_id: selectedWorkspaceId });
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />

      <View style={styles.header}>
        <TouchableOpacity style={styles.smallButton} onPress={() => setLeftOpen(true)}>
          <Text style={styles.smallButtonText}>Menu</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{selectedWorkspace?.name || "Select Workspace"}</Text>
        <TouchableOpacity style={styles.smallButton} onPress={() => openRightDrawer("all_files")}>
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
          data={currentMessages}
          keyExtractor={(_, idx) => String(idx)}
          contentContainerStyle={styles.messagesList}
          renderItem={({ item }) => {
            const isUser = item.agent_id === "user";
            return (
              <View style={[styles.messageRow, isUser ? styles.messageRowUser : styles.messageRowAi]}>
                <View
                  style={[
                    styles.messageBubble,
                    isUser ? styles.userBubble : styles.aiBubble,
                    item.is_error ? styles.errorBubble : null,
                  ]}
                >
                  <Text style={styles.messageText}>{item.content}</Text>
                </View>
              </View>
            );
          }}
        />

        <View style={styles.inputRow}>
          <TextInput
            value={input}
            onChangeText={setInput}
            style={styles.messageInput}
            placeholder="Ask to make changes..."
            placeholderTextColor="#7a7a7a"
            multiline
          />
          <TouchableOpacity style={styles.sendButton} onPress={sendMessage}>
            <Text style={styles.sendButtonText}>Send</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {leftOpen && (
        <View style={styles.overlay}>
          <TouchableOpacity style={styles.backdrop} onPress={() => setLeftOpen(false)} />
          <View style={styles.leftDrawer}>
            <Text style={styles.drawerTitle}>Workspaces</Text>
            <ScrollView>
              {workspaces.map((ws) => (
                <TouchableOpacity key={ws.id} style={styles.wsItem} onPress={() => selectWorkspace(ws.id)}>
                  <Text style={styles.wsName}>{ws.name}</Text>
                  <Text style={styles.wsMeta}>{ws.branch} · {ws.status}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      )}

      {rightOpen && (
        <View style={styles.overlay}>
          <TouchableOpacity style={styles.backdrop} onPress={() => setRightOpen(false)} />
          <View style={styles.rightDrawer}>
            <View style={styles.tabRow}>
              {(["all_files", "changes", "checks"] as const).map((tab) => (
                <TouchableOpacity key={tab} style={[styles.tabButton, rightTab === tab && styles.tabButtonActive]} onPress={() => openRightDrawer(tab)}>
                  <Text style={[styles.tabText, rightTab === tab && styles.tabTextActive]}>{tab.replace("_", " ")}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.drawerContent}>
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
                  <View style={styles.drawerActions}>
                    <TouchableOpacity style={styles.secondaryButton} onPress={() => selectedWorkspaceId && refreshChanges(selectedWorkspaceId)}>
                      <Text style={styles.secondaryButtonText}>Refresh</Text>
                    </TouchableOpacity>
                  </View>
                  {changesLoading ? <Text style={styles.drawerText}>Loading changes...</Text> : null}
                  <ScrollView>
                    {changes.length === 0 ? <Text style={styles.drawerText}>No local changes.</Text> : null}
                    {changes.map((c, idx) => (
                      <View key={`${c.path}-${idx}`} style={styles.changeItem}>
                        <Text style={styles.changeStatus}>{c.status}</Text>
                        <Text style={styles.changePath}>{c.path}</Text>
                      </View>
                    ))}
                  </ScrollView>
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
                    {checks.length === 0 ? <Text style={styles.drawerText}>No check results yet.</Text> : null}
                    {checks.map((check, idx) => (
                      <View key={`${check.name}-${idx}`} style={styles.checkItem}>
                        <Text style={styles.checkTitle}>
                          {check.success ? "PASS" : "FAIL"} · {check.name}
                        </Text>
                        <Text style={styles.checkMeta}>{check.command}</Text>
                        {check.stdout ? <Text style={styles.checkOutput}>{check.stdout.trim()}</Text> : null}
                        {check.stderr ? <Text style={styles.checkOutputError}>{check.stderr.trim()}</Text> : null}
                      </View>
                    ))}
                  </ScrollView>
                </>
              )}
            </View>
          </View>
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
  headerTitle: { color: "#e6e0da", fontSize: 14, fontWeight: "600", maxWidth: "60%" },
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
  messagesList: { padding: 12, gap: 8 },
  messageRow: { flexDirection: "row" },
  messageRowUser: { justifyContent: "flex-end" },
  messageRowAi: { justifyContent: "flex-start" },
  messageBubble: { maxWidth: "82%", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 8 },
  userBubble: { backgroundColor: "#1f3d57", borderWidth: 1, borderColor: "#2f5e86" },
  aiBubble: { backgroundColor: "#1c1815", borderWidth: 1, borderColor: "#39312b" },
  errorBubble: { backgroundColor: "#4a1f1f", borderColor: "#7f2f2f" },
  messageText: { color: "#ece8e4", fontSize: 14 },
  inputRow: { flexDirection: "row", padding: 10, gap: 8, borderTopWidth: 1, borderTopColor: "#2b2623" },
  messageInput: {
    flex: 1,
    minHeight: 42,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: "#3a332f",
    borderRadius: 8,
    backgroundColor: "#1c1815",
    color: "#e6e0da",
    paddingHorizontal: 10,
    paddingTop: 10,
  },
  sendButton: { alignSelf: "flex-end", backgroundColor: "#2b5d8a", borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
  sendButtonText: { color: "#fff", fontWeight: "600" },
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 30, flexDirection: "row" },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)" },
  leftDrawer: { width: "72%", maxWidth: 320, backgroundColor: "#171311", padding: 12, borderRightWidth: 1, borderRightColor: "#2b2623" },
  rightDrawer: { width: "78%", maxWidth: 340, backgroundColor: "#171311", padding: 12, borderLeftWidth: 1, borderLeftColor: "#2b2623" },
  drawerTitle: { color: "#e6e0da", fontSize: 16, fontWeight: "700", marginBottom: 10 },
  wsItem: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#2b2623" },
  wsName: { color: "#ece8e4", fontSize: 14, fontWeight: "600" },
  wsMeta: { color: "#a79e96", fontSize: 12, marginTop: 2 },
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
  changeItem: { paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: "#2b2623" },
  changeStatus: { color: "#dfc27d", fontSize: 12, marginBottom: 2 },
  changePath: { color: "#ddd4cd", fontSize: 12 },
  checkItem: { marginBottom: 10, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: "#2b2623" },
  checkTitle: { color: "#ece8e4", fontSize: 12, fontWeight: "700" },
  checkMeta: { color: "#8d847d", fontSize: 11, marginTop: 3 },
  checkOutput: { color: "#c7beb7", fontSize: 11, marginTop: 6 },
  checkOutputError: { color: "#da8e8e", fontSize: 11, marginTop: 6 },
});

export default App;
