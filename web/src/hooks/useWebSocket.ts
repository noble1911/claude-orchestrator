import { useCallback, useEffect, useRef } from "react";
import { WsClient } from "../services/ws-client";
import { useConnectionStore } from "../stores/connection";
import { useRepositoryStore } from "../stores/repositories";
import { useWorkspaceStore } from "../stores/workspaces";
import { useAgentStore } from "../stores/agents";
import { useFileStore } from "../stores/files";
import type { WsResponse } from "../types";

export function useWebSocket(wsUrl: string, pairingCode: string) {
  const clientRef = useRef<WsClient | null>(null);

  const setConnState = useConnectionStore((s) => s.setState);
  const setClientId = useConnectionStore((s) => s.setClientId);
  const setWsClient = useConnectionStore((s) => s.setWsClient);
  const setError = useConnectionStore((s) => s.setError);

  const setRepositories = useRepositoryStore((s) => s.setRepositories);
  const setWorkspaces = useWorkspaceStore((s) => s.setWorkspaces);
  const updateWorkspace = useWorkspaceStore((s) => s.updateWorkspace);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const removeWorkspace = useWorkspaceStore((s) => s.removeWorkspace);

  const setMessages = useAgentStore((s) => s.setMessages);
  const upsertMessage = useAgentStore((s) => s.upsertMessage);
  const setRunning = useAgentStore((s) => s.setRunning);
  const addSubscription = useAgentStore((s) => s.addSubscription);
  const removeSubscription = useAgentStore((s) => s.removeSubscription);

  const setFiles = useFileStore((s) => s.setFiles);
  const setFileContent = useFileStore((s) => s.setFileContent);
  const setChanges = useFileStore((s) => s.setChanges);
  const setChecks = useFileStore((s) => s.setChecks);

  const handleMessage = useCallback(
    (response: WsResponse) => {
      switch (response.type) {
        case "connected":
          setConnState("authenticating");
          break;

        case "authenticated":
          setConnState("connected");
          setClientId(response.client_id);
          // Fetch initial data
          clientRef.current?.send({ type: "list_repositories" });
          clientRef.current?.send({ type: "list_workspaces" });
          break;

        case "authentication_failed":
          setConnState("disconnected");
          setError(response.reason);
          clientRef.current?.disconnect();
          break;

        case "repository_list":
          setRepositories(response.repositories);
          break;

        case "workspace_list":
          setWorkspaces(response.workspaces);
          break;

        case "workspace_created":
          addWorkspace(response.workspace);
          break;

        case "workspace_renamed":
        case "workspace_updated":
          updateWorkspace(response.workspace);
          break;

        case "workspace_removed":
          removeWorkspace(response.workspace_id);
          break;

        case "message_history":
          setMessages(response.workspace_id, response.messages);
          break;

        case "agent_message":
          upsertMessage(response.workspace_id, {
            agent_id: "",
            role: response.role,
            content: response.content,
            is_error: response.is_error,
            timestamp: response.timestamp,
          });
          break;

        case "agent_run_state":
          setRunning(response.workspace_id, response.running);
          break;

        case "agent_started":
          setRunning(response.workspace_id, true);
          break;

        case "agent_stopped":
        case "agent_interrupted":
          setRunning(response.workspace_id, false);
          break;

        case "subscribed":
          addSubscription(response.workspace_id);
          break;

        case "unsubscribed":
          removeSubscription(response.workspace_id);
          break;

        case "files_list":
          setFiles(response.entries, response.relative_path);
          break;

        case "file_content":
          setFileContent(response.path, response.content);
          break;

        case "changes_list":
          setChanges(response.changes);
          break;

        case "checks_result":
          setChecks(response.checks);
          break;

        case "error":
          setError(response.message);
          break;
      }
    },
    [
      setConnState, setClientId, setError,
      setRepositories, setWorkspaces, updateWorkspace, addWorkspace, removeWorkspace,
      setMessages, upsertMessage, setRunning, addSubscription, removeSubscription,
      setFiles, setFileContent, setChanges, setChecks,
    ]
  );

  useEffect(() => {
    if (!wsUrl || !pairingCode) return;

    setConnState("connecting");
    const client = new WsClient(wsUrl, pairingCode, handleMessage);
    clientRef.current = client;
    setWsClient(client);
    client.connect();

    return () => {
      client.disconnect();
      clientRef.current = null;
      setWsClient(null);
      setConnState("disconnected");
    };
  }, [wsUrl, pairingCode, handleMessage, setConnState, setWsClient]);
}
