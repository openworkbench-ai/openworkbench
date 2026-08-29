import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { McpServerConfig } from "./app-loader.js";

/**
 * Bridges MCP servers into a single Pi tool instead of registering every MCP
 * tool as its own Pi tool. Registering N MCP tools directly costs their full
 * schemas in every request regardless of use; with many servers/tools that
 * adds up fast. Inspired by pi-mcp-adapter's proxy-tool pattern
 * (https://github.com/nicobailon/pi-mcp-adapter): one lightweight `mcp` tool
 * with list/search/describe/call actions, discovering tools on demand.
 */

const ENV_REF_PATTERN = /^\$\{([A-Z0-9_]+)\}$/;
const MAX_RESULT_CHARS = 4000;
const DEFAULT_SEARCH_LIMIT = 12;

interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
}

interface ConnectedServer {
  name: string;
  url: string;
  client?: Client;
  tools: McpToolInfo[];
  error?: string;
}

function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      const match = ENV_REF_PATTERN.exec(value);
      if (!match) return [key, value];
      const envValue = process.env[match[1]];
      if (!envValue) {
        throw new Error(`Missing environment variable "${match[1]}" referenced by MCP server header "${key}".`);
      }
      return [key, envValue];
    })
  );
}

async function connectServer(config: McpServerConfig): Promise<ConnectedServer> {
  try {
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: resolveHeaders(config.headers) },
    });
    const client = new Client({ name: "openworkbench", version: "0.1.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    return {
      name: config.name,
      url: config.url,
      client,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
      })),
    };
  } catch (error) {
    return {
      name: config.name,
      url: config.url,
      tools: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n...[truncated ${text.length - MAX_RESULT_CHARS} more characters]`;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text: truncate(text) }], details: undefined };
}

function listServers(servers: ConnectedServer[]) {
  const lines = servers.map((s) =>
    s.error ? `- ${s.name}: unavailable (${s.error})` : `- ${s.name}: connected, ${s.tools.length} tool(s)`
  );
  return textResult(
    `Connected MCP servers:\n${lines.join("\n")}\n\n` +
      `Use mcp({ server: "<name>" }) to list a server's tools, mcp({ search: "<keyword>" }) to search across all servers, ` +
      `mcp({ describe: "<tool>" }) for a tool's parameter schema, or mcp({ tool: "<tool>", args: {...} }) to call one.`
  );
}

function serverInfo(server: ConnectedServer) {
  if (server.error) return textResult(`Server "${server.name}" is unavailable: ${server.error}`);
  const lines = server.tools.map((tool) => `- ${tool.name}: ${tool.description}`);
  return textResult(`Tools on "${server.name}":\n${lines.join("\n")}`);
}

function searchTools(servers: ConnectedServer[], query: string, limit: number) {
  const needle = query.toLowerCase();
  const matches = servers
    .filter((s) => !s.error)
    .flatMap((server) =>
      server.tools
        .filter((tool) => `${server.name} ${tool.name} ${tool.description}`.toLowerCase().includes(needle))
        .map((tool) => ({
          server: server.name,
          tool,
          score: tool.name.toLowerCase().includes(needle) ? 2 : 1,
        }))
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (matches.length === 0) return textResult(`No tools matched "${query}".`);
  const lines = matches.map((m) => `- ${m.tool.name} (server: ${m.server}): ${m.tool.description}`);
  return textResult(`Matches for "${query}":\n${lines.join("\n")}`);
}

function describeTool(servers: ConnectedServer[], toolName: string, serverName: string | undefined) {
  const candidates = servers
    .filter((s) => !s.error && (!serverName || s.name === serverName))
    .flatMap((s) => s.tools.filter((t) => t.name === toolName).map((tool) => ({ server: s.name, tool })));

  if (candidates.length === 0) {
    return textResult(`No tool named "${toolName}" found${serverName ? ` on server "${serverName}"` : ""}.`);
  }
  if (candidates.length > 1) {
    return textResult(
      `Multiple servers have a tool named "${toolName}": ${candidates.map((c) => c.server).join(", ")}. Pass "server" to disambiguate.`
    );
  }
  const { server, tool } = candidates[0];
  return textResult(
    `${tool.name} (server: ${server})\n${tool.description}\n\nParameters:\n${JSON.stringify(tool.inputSchema, null, 2)}`
  );
}

async function callTool(
  servers: ConnectedServer[],
  toolName: string,
  serverName: string | undefined,
  args: Record<string, unknown> | undefined
) {
  const candidates = servers.filter(
    (s) => !s.error && (!serverName || s.name === serverName) && s.tools.some((t) => t.name === toolName)
  );
  if (candidates.length === 0) {
    throw new Error(
      `No tool named "${toolName}" found${serverName ? ` on server "${serverName}"` : ""}. Use mcp({ search: "..." }) to find the right name.`
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `Multiple servers have a tool named "${toolName}": ${candidates.map((c) => c.name).join(", ")}. Pass "server" to disambiguate.`
    );
  }

  const server = candidates[0];
  const result = await server.client!.callTool({ name: toolName, arguments: args ?? {} });
  const rawContent = "content" in result && Array.isArray(result.content) ? result.content : [];
  const content = rawContent.map((block: { type: string; text?: string; data?: string; mimeType?: string }) => {
    if (block.type === "text" && typeof block.text === "string") {
      return { type: "text" as const, text: truncate(block.text) };
    }
    if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      return { type: "image" as const, data: block.data, mimeType: block.mimeType };
    }
    return { type: "text" as const, text: truncate(JSON.stringify(block)) };
  });

  if ("isError" in result && result.isError) {
    throw new Error(content.find((c) => c.type === "text")?.text ?? "MCP tool call failed.");
  }
  return {
    content: content.length > 0 ? content : [{ type: "text" as const, text: "(empty result)" }],
    details: result,
  };
}

/**
 * Connects to every configured MCP server up front and returns a single
 * proxy tool that can list servers, search/describe their tools, and call
 * one by name. Returns undefined when no servers are configured, so the
 * caller can omit it from customTools entirely.
 */
export async function createMcpProxyTool(servers: McpServerConfig[]): Promise<ToolDefinition | undefined> {
  if (servers.length === 0) return undefined;

  const connected = await Promise.all(servers.map(connectServer));
  for (const server of connected) {
    if (server.error) {
      console.error(`[mcp] failed to connect to "${server.name}" (${server.url}): ${server.error}`);
    }
  }

  return defineTool({
    name: "mcp",
    label: "MCP",
    description:
      "Discover and call tools exposed by connected MCP servers, without loading every tool's schema into context up front. " +
      "Call with no arguments to list connected servers. Pass `server` alone for that server's tool list. " +
      "Pass `search` to find tools by keyword across all servers. Pass `describe` (a tool name) to see its full parameter schema. " +
      "Pass `tool` (with optional `server` and `args`) to call a tool.",
    promptSnippet: "mcp - discover and call tools from connected MCP servers (list/search/describe/call)",
    parameters: Type.Object({
      server: Type.Optional(Type.String({ description: "Restrict to this server name (see the server list)." })),
      search: Type.Optional(Type.String({ description: "Keyword to search tool names/descriptions across all servers." })),
      describe: Type.Optional(Type.String({ description: "Tool name to show the full parameter schema for." })),
      tool: Type.Optional(Type.String({ description: "Tool name to call." })),
      args: Type.Optional(Type.Unsafe<Record<string, unknown>>({ type: "object", additionalProperties: true })),
    }),
    async execute(_toolCallId, params) {
      if (params.tool) return callTool(connected, params.tool, params.server, params.args);
      if (params.describe) return describeTool(connected, params.describe, params.server);
      if (params.search) return searchTools(connected, params.search, DEFAULT_SEARCH_LIMIT);
      if (params.server) {
        const server = connected.find((s) => s.name === params.server);
        return server ? serverInfo(server) : textResult(`No server named "${params.server}".`);
      }
      return listServers(connected);
    },
  });
}
