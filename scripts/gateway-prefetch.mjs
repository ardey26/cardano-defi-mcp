#!/usr/bin/env node
// Warms the npm cache the gateway uses, so the first agent call to a third-party
// MCP server does not wait on `npx` downloading it. For each gateway MCP it runs
// the pinned connect command once with stdin closed: the server installs, starts,
// sees EOF and exits. Install scripts stay disabled.
//
// Never fails the build: a failed prefetch only costs first-call latency.
// GATEWAY_CACHE_DIR must match the running server's (render.yaml sets both).

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_DIR = join(ROOT, "taxonomy", "mcps");
const CACHE = process.env.GATEWAY_CACHE_DIR || join(ROOT, ".gateway-cache");
const OWN_MCPS = ["cardano-defi-mcp", "cardano-defi-mcp-wallet"];
const EXACT_VERSION = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d+\.\d+\.\d+(?:-[\w.]+)?$/;
const LIMIT_MS = 180_000;

function packageSpecs(args) {
  const specs = [];
  let positional;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-p" || args[i] === "--package") specs.push(args[++i] ?? "");
    else if (!args[i].startsWith("-") && positional === undefined) positional = args[i];
  }
  return specs.length > 0 ? specs : positional !== undefined ? [positional] : [];
}

async function prefetch(mcp, connect) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: await mkdtemp(join(tmpdir(), "gateway-prefetch-")),
    npm_config_cache: CACHE,
    npm_config_ignore_scripts: "true",
    npm_config_yes: "true",
    npm_config_update_notifier: "false",
  };
  return new Promise((resolve) => {
    const child = spawn(connect.command, connect.args, { env, stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), LIMIT_MS);
    child.on("error", (err) => { clearTimeout(timer); resolve(`prefetch failed for ${mcp.id}: ${err.message}`); });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(signal === "SIGKILL" ? `prefetch failed for ${mcp.id}: still running after ${LIMIT_MS / 1000}s` : `prefetched ${mcp.id} (exit ${code})`);
    });
  });
}

const files = (await readdir(MCP_DIR)).filter((f) => f.endsWith(".json")).sort();
for (const file of files) {
  const mcp = JSON.parse(await readFile(join(MCP_DIR, file), "utf8"));
  if (mcp.auth !== "none" || OWN_MCPS.includes(mcp.id)) continue;
  if (!mcp.tools.some((t) => t.effect !== "signs" && !t.env)) continue;
  const connect = mcp.connect.find(
    (c) => c.transport === "stdio" && c.command === "npx" && packageSpecs(c.args).every((s) => EXACT_VERSION.test(s)),
  );
  if (connect) console.log(await prefetch(mcp, connect));
}
