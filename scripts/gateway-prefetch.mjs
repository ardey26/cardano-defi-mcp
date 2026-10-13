#!/usr/bin/env node
// Installs every gateway upstream from its committed lockfile (taxonomy/locks/<id>/)
// into GATEWAY_CACHE_DIR, so the first agent call does not wait on an install.
// `npm ci` with install scripts disabled; no package code runs here.
//
// Runs after `npm run build` (it uses dist/). Never fails the build: a failed
// prefetch only costs first-call latency, since the server installs on demand.

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (p) => pathToFileURL(join(ROOT, "dist", "gateway", p)).href;

if (!existsSync(join(ROOT, "dist", "gateway", "install.js"))) {
  console.log("gateway prefetch skipped: run `npm run build` first");
  process.exit(0);
}

const { gatewayMcps } = await import(dist("eligibility.js"));
const { installUpstream } = await import(dist("install.js"));
const { DEFAULT_UPSTREAM_OPTIONS } = await import(dist("upstream.js"));
const root = join(ROOT, "taxonomy");

for (const { mcp, connect } of gatewayMcps(root)) {
  try {
    const target = await installUpstream(mcp.id, connect, root, DEFAULT_UPSTREAM_OPTIONS.cacheDir);
    console.log(`prefetched ${mcp.id} -> ${target.args[0]}`);
  } catch (err) {
    console.log(`prefetch failed for ${mcp.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
