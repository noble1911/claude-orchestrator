/**
 * MCP Permission Bridge
 *
 * A tiny stdio MCP server that the Claude CLI spawns via --permission-prompt-tool.
 * When the CLI needs a permission decision, it calls our `check_permission` tool.
 * We forward the request to the orchestrator's HTTP server (long-poll) and return
 * the user's allow/deny decision.
 *
 * Environment variables:
 *   ORCHESTRATOR_HTTP_PORT — Port of the orchestrator HTTP server (default 3002)
 *   ORCHESTRATOR_WORKSPACE_ID — Workspace ID to include in permission requests
 *   ORCHESTRATOR_AGENT_ID — Agent ID to include in permission requests
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ORCHESTRATOR_PORT = process.env.ORCHESTRATOR_HTTP_PORT || "3002";
const WORKSPACE_ID = process.env.ORCHESTRATOR_WORKSPACE_ID || "";
const AGENT_ID = process.env.ORCHESTRATOR_AGENT_ID || "";

const server = new McpServer({
  name: "perm_bridge",
  version: "1.0.0",
});

server.tool(
  "check_permission",
  "Check if a tool use is permitted by the orchestrator user",
  {
    tool_name: z.string().describe("Name of the tool requesting permission"),
    input: z.record(z.unknown()).describe("Tool input parameters"),
  },
  async ({ tool_name, input }) => {
    const requestId = crypto.randomUUID();

    try {
      const res = await fetch(
        `http://127.0.0.1:${ORCHESTRATOR_PORT}/api/permission`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_id: WORKSPACE_ID,
            agent_id: AGENT_ID,
            request_id: requestId,
            tool_name,
            input,
          }),
          // No timeout — long-poll waits for user decision
        },
      );

      if (!res.ok) {
        const errorText = await res.text();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                behavior: "deny",
                message: `Orchestrator error (${res.status}): ${errorText}`,
              }),
            },
          ],
        };
      }

      const decision = await res.json();

      // Claude CLI expects either { updatedInput: <record> } for allow
      // or { behavior: "deny", message: <string> } for deny.
      // The orchestrator returns { behavior: "allow" | "deny", message?: ... },
      // so we transform allow responses into the expected shape.
      const response =
        decision.behavior === "allow"
          ? { updatedInput: input }
          : { behavior: "deny" as const, message: decision.message ?? "Permission denied" };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response) }],
      };
    } catch (err) {
      // If the orchestrator isn't reachable, deny by default
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              behavior: "deny",
              message: `Permission bridge error: ${err instanceof Error ? err.message : String(err)}`,
            }),
          },
        ],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
