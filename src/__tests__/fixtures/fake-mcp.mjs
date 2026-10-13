// A tiny stdio MCP server for gateway tests. Never shipped.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake", version: "0.0.0" });
const text = (t) => ({ content: [{ type: "text", text: t }] });
server.registerTool("echo", { description: "echo", inputSchema: { msg: z.string() } }, async ({ msg }) => text(`echo:${msg}`));
server.registerTool("build", { description: "build", inputSchema: { address: z.string() } }, async ({ address }) => text(`cbor-for:${address}`));
server.registerTool("sign", { description: "sign", inputSchema: {} }, async () => text("signed"));
server.registerTool("env", { description: "env", inputSchema: {} }, async () => text(JSON.stringify(process.env)));
server.registerTool("pid", { description: "pid", inputSchema: {} }, async () => text(String(process.pid)));
server.registerTool("slow", { description: "slow", inputSchema: {} }, async () => new Promise(() => {}));
server.registerTool("big", { description: "big", inputSchema: {} }, async () => text("x".repeat(300 * 1024)));
server.registerTool("crash", { description: "crash", inputSchema: {} }, async () => process.exit(1));
server.registerTool("fail", { description: "fail", inputSchema: {} }, async () => ({ isError: true, content: [{ type: "text", text: "upstream said no" }] }));
await server.connect(new StdioServerTransport());
