#!/usr/bin/env node
// Lists the tools an MCP server really exposes, by connecting and calling tools/list.
//
//   node scripts/mcp-tools.mjs --connect '{"transport":"http","url":"https://…/mcp"}'
//       print the server's tool names, one per line (for writing a taxonomy/mcps/ entry)
//   node scripts/mcp-tools.mjs --check [--out report.json]
//       for every taxonomy/mcps/ entry with auth "none" (except this repo's own,
//       which the unit tests cover), compare declared tools with the live list;
//       exit 1 if any declared tool is missing or a server cannot be reached
//
// It RUNS the server it connects to: stdio entries are spawned with their own
// command. Run it only where that is acceptable — a scratch machine, or a CI
// job with no secrets and no write permissions.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_DIR = join(ROOT, "taxonomy", "mcps");
const OWN_MCPS = ["cardano-defi-mcp", "cardano-defi-mcp-wallet"];

// Covers a free-tier cold start and a first `npx -y` install.
const TIMEOUT_MS = 120_000;

function withTimeout(promise, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function listTools(connect) {
  const transport =
    connect.transport === "stdio"
      ? new StdioClientTransport({ command: connect.command, args: connect.args, stderr: "ignore" })
      : new StreamableHTTPClientTransport(new URL(connect.url));
  const client = new Client({ name: "taxonomy-mcp-tools", version: "0.1.0" });
  try {
    await withTimeout(client.connect(transport), "connect");
    const names = [];
    let cursor;
    do {
      const page = await withTimeout(client.listTools(cursor ? { cursor } : undefined), "tools/list");
      names.push(...page.tools.map((t) => t.name));
      cursor = page.nextCursor;
    } while (cursor);
    return names.sort();
  } finally {
    await client.close().catch(() => {});
  }
}

async function check(out) {
  const files = (await readdir(MCP_DIR)).filter((f) => f.endsWith(".json")).sort();
  const entries = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(MCP_DIR, f), "utf8"))));
  const report = [];

  for (const mcp of entries) {
    if (mcp.auth !== "none" || OWN_MCPS.includes(mcp.id)) continue;
    // Prefer HTTP: it runs nothing locally.
    const connect = mcp.connect.find((c) => c.transport === "http") ?? mcp.connect[0];
    try {
      const live = new Set(await listTools(connect));
      const declared = mcp.tools.map((t) => t.name);
      const missing = declared.filter((n) => !live.has(n));
      const undeclared = [...live].filter((n) => !declared.includes(n));
      report.push({ id: mcp.id, ok: missing.length === 0, missing, undeclared });
    } catch (err) {
      report.push({ id: mcp.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const r of report) {
    const detail = r.error ?? (r.missing.length ? `missing: ${r.missing.join(", ")}` : "ok");
    console.log(`${r.ok ? "ok  " : "FAIL"} ${r.id} — ${detail}`);
  }
  if (out) await writeFile(out, JSON.stringify(report, null, 2));
  if (report.some((r) => !r.ok)) process.exit(1);
}

const { values } = parseArgs({
  options: { connect: { type: "string" }, check: { type: "boolean" }, out: { type: "string" } },
});

if (values.connect) {
  for (const name of await listTools(JSON.parse(values.connect))) console.log(name);
} else if (values.check) {
  await check(values.out);
} else {
  console.error("usage: mcp-tools.mjs --connect '<connect JSON>' | --check [--out <file>]");
  process.exit(2);
}
