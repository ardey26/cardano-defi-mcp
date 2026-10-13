#!/usr/bin/env node
// Lists the tools an MCP server really exposes, by connecting and calling tools/list.
//
//   node scripts/mcp-tools.mjs --connect '{"transport":"http","url":"https://…/mcp"}'
//       print the server's tool names, one per line (for writing a taxonomy/mcps/ entry)
//   node scripts/mcp-tools.mjs --snapshot <id>
//       write taxonomy/snapshots/<id>.json: the name, description and dereferenced
//       input schema of every tool the gateway exposes, at the pinned packages
//   node scripts/mcp-tools.mjs --check [--out report.json]
//       for every taxonomy/mcps/ entry with auth "none" (except this repo's own,
//       which the unit tests cover), compare declared tools with the live list;
//       exit 1 if any declared tool is missing or a server cannot be reached
//
// It RUNS the server it connects to: stdio entries are spawned with their own
// command. Run it only where that is acceptable — a scratch machine, or a CI
// job with no secrets and no write permissions.

import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_DIR = join(ROOT, "taxonomy", "mcps");
const SNAPSHOT_DIR = join(ROOT, "taxonomy", "snapshots");
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

/** Connects to a server, runs fn(client), and always closes it. stdio children get `env` when given. */
async function withClient(connect, fn, env) {
  const transport =
    connect.transport === "stdio"
      ? new StdioClientTransport({ command: connect.command, args: connect.args, stderr: "ignore", ...(env ? { env } : {}) })
      : new StreamableHTTPClientTransport(new URL(connect.url));
  const client = new Client({ name: "taxonomy-mcp-tools", version: "0.1.0" });
  try {
    await withTimeout(client.connect(transport), "connect");
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/** Every tool the server lists, following cursors. */
async function liveTools(client) {
  const tools = [];
  let cursor;
  do {
    const page = await withTimeout(client.listTools(cursor ? { cursor } : undefined), "tools/list");
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

async function listTools(connect, env) {
  return withClient(connect, async (client) => (await liveTools(client)).map((t) => t.name).sort(), env);
}

// Inline local "#/a/b" refs so the schema is self-contained (zod's fromJSONSchema cannot follow them).
function deref(node, root = node, seen = new Set()) {
  if (Array.isArray(node)) return node.map((n) => deref(n, root, seen));
  if (!node || typeof node !== "object") return node;
  if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
    if (seen.has(node.$ref)) throw new Error(`circular $ref ${node.$ref}`);
    const target = node.$ref
      .slice(2)
      .split("/")
      .reduce((at, key) => at?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], root);
    if (target === undefined) throw new Error(`unresolvable $ref ${node.$ref}`);
    const { $ref, ...rest } = node;
    return { ...deref(target, root, new Set([...seen, $ref])), ...deref(rest, root, seen) };
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(v, root, seen)]));
}

/** npx arguments that name packages: every `-p <spec>`, else the first positional. Mirrors src/gateway/eligibility.ts. */
function packageSpecs(args) {
  const specs = [];
  let positional;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-p" || args[i] === "--package") specs.push(args[++i] ?? "");
    else if (!args[i].startsWith("-") && positional === undefined) positional = args[i];
  }
  return specs.length > 0 ? specs : positional !== undefined ? [positional] : [];
}

/** What a stdio child sees: no secrets, no install scripts. Mirrors childEnv in src/gateway/upstream.ts. */
async function cleanEnv() {
  return {
    PATH: process.env.PATH ?? "",
    HOME: await mkdtemp(join(tmpdir(), "mcp-tools-home-")),
    npm_config_ignore_scripts: "true",
    npm_config_yes: "true",
    npm_config_update_notifier: "false",
  };
}

const exposed = (tool) => tool.effect !== "signs" && !tool.env;

async function snapshot(id) {
  const mcp = JSON.parse(await readFile(join(MCP_DIR, `${id}.json`), "utf8"));
  const connect = mcp.connect.find((c) => c.transport === "stdio" && c.command === "npx");
  if (!connect) throw new Error(`${id} has no npx stdio connect entry to snapshot`);
  const wanted = mcp.tools.filter(exposed).map((t) => t.name);
  const live = await withClient(connect, liveTools, await cleanEnv());
  const missing = wanted.filter((name) => !live.some((t) => t.name === name));
  if (missing.length > 0) {
    console.error(`${id}: exposed tools missing from the live list: ${missing.join(", ")}`);
    process.exit(1);
  }
  const tools = live
    .filter((t) => wanted.includes(t.name))
    .map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: deref(t.inputSchema) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const record = { mcp: id, packages: packageSpecs(connect.args), captured: new Date().toISOString().slice(0, 10), tools };
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  await writeFile(join(SNAPSHOT_DIR, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  console.log(`wrote taxonomy/snapshots/${id}.json (${tools.length} tools)`);
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
      const env = connect.transport === "stdio" ? await cleanEnv() : undefined;
      const liveList = await withClient(connect, liveTools, env);
      const live = new Set(liveList.map((t) => t.name));
      const declared = mcp.tools.map((t) => t.name);
      const missing = declared.filter((n) => !live.has(n));
      const undeclared = [...live].filter((n) => !declared.includes(n));
      // What agents see through the gateway must still be what reviewers approved.
      const changed = [];
      const snap = await readFile(join(SNAPSHOT_DIR, `${mcp.id}.json`), "utf8").then(JSON.parse, () => undefined);
      for (const t of snap?.tools ?? []) {
        const now = liveList.find((l) => l.name === t.name);
        if (!now) continue;
        if ((now.description ?? "") !== t.description) changed.push({ tool: t.name, field: "description" });
        if (JSON.stringify(deref(now.inputSchema)) !== JSON.stringify(t.inputSchema)) changed.push({ tool: t.name, field: "inputSchema" });
      }
      report.push({ id: mcp.id, ok: missing.length === 0 && changed.length === 0, missing, undeclared, changed });
    } catch (err) {
      report.push({ id: mcp.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const r of report) {
    const problems = [
      r.missing?.length ? `missing: ${r.missing.join(", ")}` : "",
      r.changed?.length ? `changed since snapshot: ${r.changed.map((c) => `${c.tool}.${c.field}`).join(", ")}` : "",
    ].filter(Boolean);
    const detail = r.error ?? (problems.join("; ") || "ok");
    console.log(`${r.ok ? "ok  " : "FAIL"} ${r.id} — ${detail}`);
  }
  if (out) await writeFile(out, JSON.stringify(report, null, 2));
  if (report.some((r) => !r.ok)) process.exit(1);
}

const { values } = parseArgs({
  options: { connect: { type: "string" }, check: { type: "boolean" }, out: { type: "string" }, snapshot: { type: "string" } },
});

if (values.connect) {
  for (const name of await listTools(JSON.parse(values.connect))) console.log(name);
} else if (values.snapshot) {
  await snapshot(values.snapshot);
} else if (values.check) {
  await check(values.out);
} else {
  console.error("usage: mcp-tools.mjs --connect '<connect JSON>' | --snapshot <id> | --check [--out <file>]");
  process.exit(2);
}
