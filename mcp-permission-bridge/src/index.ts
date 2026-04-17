/**
 * MCP Permission Bridge
 *
 * A tiny stdio MCP server that the Claude CLI spawns via --mcp-config.
 * Exposes two tools:
 *   - check_permission: permission-prompt handler (wired via --permission-prompt-tool)
 *   - render_html: push an HTML page to the orchestrator, which displays it in
 *     a sandboxed Canvas tab next to the chat. Use for charts, diagrams, UIs,
 *     or any visual that explains better than prose.
 *
 * Both tools forward to the orchestrator's HTTP server on 127.0.0.1.
 *
 * Environment variables:
 *   ORCHESTRATOR_HTTP_PORT — Port of the orchestrator HTTP server (default 3002)
 *   ORCHESTRATOR_WORKSPACE_ID — Workspace ID to include in requests
 *   ORCHESTRATOR_AGENT_ID — Agent ID to include in requests
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

// Explicit allowlist of bridge-owned tools that bypass the user permission
// prompt. Prefer this over a prefix match so that adding a new tool to this
// server is an opt-in security decision — a privileged tool added later
// without an entry here will correctly prompt the user.
const AUTO_ALLOW_TOOLS: ReadonlySet<string> = new Set([
  "mcp__perm_bridge__render_html",
]);

server.tool(
  "check_permission",
  "Check if a tool use is permitted by the orchestrator user",
  {
    tool_name: z.string().describe("Name of the tool requesting permission"),
    input: z.record(z.unknown()).describe("Tool input parameters"),
  },
  async ({ tool_name, input }) => {
    if (AUTO_ALLOW_TOOLS.has(tool_name)) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ behavior: "allow", updatedInput: input }),
          },
        ],
      };
    }

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

      // Claude CLI validates a discriminated union on the `behavior` field:
      //   Allow: { behavior: "allow", updatedInput?: <record> }
      //   Deny:  { behavior: "deny", message: <string> }
      // The orchestrator returns { behavior: "allow" | "deny", message?: ... },
      // so we transform allow responses to include the original input.
      const response =
        decision.behavior === "allow"
          ? { behavior: "allow" as const, updatedInput: input }
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

server.tool(
  "render_html",
  "Render an HTML page in the orchestrator UI's Canvas tab, next to the chat. " +
    "Use when a chart, diagram, timeline, or interactive widget would help the user " +
    "more than prose. Return a single self-contained HTML document — load any libraries " +
    "(Chart.js, D3, Recharts, etc.) from a CDN. The document renders in a sandboxed iframe " +
    "and cannot access local files or the network beyond what the iframe sandbox allows. " +
    "When updating a previous artifact, reuse its `identifier` to replace it in place.",
  {
    title: z.string().describe("Short title shown on the Canvas tab (e.g. 'Sales Chart')"),
    html: z.string().describe("Complete HTML document, from <!DOCTYPE html> to </html>"),
    identifier: z
      .string()
      .optional()
      .describe(
        "Optional stable key for in-place updates. Reusing the same identifier in the " +
          "same workspace replaces the previous artifact rather than stacking a new tab."
      ),
  },
  async ({ title, html, identifier }) => {
    if (!WORKSPACE_ID) {
      return {
        content: [
          {
            type: "text" as const,
            text: "render_html bridge misconfigured: ORCHESTRATOR_WORKSPACE_ID env var is not set.",
          },
        ],
        isError: true,
      };
    }
    try {
      const res = await fetch(
        `http://127.0.0.1:${ORCHESTRATOR_PORT}/api/render_html`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace_id: WORKSPACE_ID,
            title,
            html,
            identifier: identifier ?? null,
          }),
        },
      );

      if (!res.ok) {
        const errorText = await res.text();
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to render HTML (HTTP ${res.status}): ${errorText}`,
            },
          ],
          isError: true,
        };
      }

      const result = (await res.json()) as { id: string; title: string };
      return {
        content: [
          {
            type: "text" as const,
            text: `Rendered artifact '${result.title}' (id=${result.id}) in the Canvas tab.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `render_html bridge error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
