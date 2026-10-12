#!/usr/bin/env node
// Builds docs/index.html (a static browser for the taxonomy) and docs/taxonomy.json
// (the machine-readable v2 bundle). No validation here — the taxonomy tests and
// scripts/validate-taxonomy.mjs own the schema.

import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAXONOMY = join(ROOT, "taxonomy");
const TEMPLATE = join(ROOT, "scripts", "explorer.template.html");
const OUT = join(ROOT, "docs", "index.html");

const REPO_URL = "https://github.com/ardey26/cardano-defi-mcp";

// This repo's taxonomy/mcps/ entries: their tools are what "here" means on the page.
const OWN_MCPS = ["cardano-defi-mcp", "cardano-defi-mcp-wallet"];

// Display order for the register; unknown categories sort last, alphabetically.
const CATEGORY_ORDER = ["dex", "lending", "cdp", "stablecoin", "derivatives"];

const rank = (category) => {
  const i = CATEGORY_ORDER.indexOf(category);
  return i === -1 ? CATEGORY_ORDER.length : i;
};

async function readDir(dir) {
  const files = (await readdir(join(TAXONOMY, dir))).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(TAXONOMY, dir, f), "utf8"))));
}

const capabilities = JSON.parse(await readFile(join(TAXONOMY, "capabilities.json"), "utf8"));
const venues = await readDir("venues");
const mcps = await readDir("mcps");

// The page's status badge: what an agent can do at this venue, and through whom.
// The ids reuse the template's existing styles.
function agentAccess(venueId) {
  const tools = mcps.flatMap((m) =>
    m.tools.filter((t) => t.venues?.includes(venueId)).map((t) => ({ mcp: m.id, ...t }))
  );
  const own = tools.filter((t) => OWN_MCPS.includes(t.mcp));
  const integration = own.some((t) => t.effect !== "read")
    ? "adapter_live"
    : own.length > 0
      ? "read_only"
      : tools.length > 0
        ? "external"
        : "indexed";
  return { integration, paths: tools.map((t) => `${t.mcp} · ${t.name}`) };
}

const view = venues
  .map((v) => ({ ...v, ...agentAccess(v.id) }))
  .sort((a, b) => rank(a.category) - rank(b.category) || a.name.localeCompare(b.name, "en"));

// Escaping `<` keeps a record string from closing the inline <script>.
const inline = (value) => JSON.stringify(value, null, 2).replaceAll("<", "\\u003c");

const template = await readFile(TEMPLATE, "utf8");
const html = template
  .replaceAll("{{VENUES_JSON}}", inline(view))
  .replaceAll("{{CAPABILITIES_JSON}}", inline(capabilities))
  .replaceAll("{{REPO_URL}}", REPO_URL);

const leftover = html.match(/\{\{[A-Z_]+\}\}/g);
if (leftover) throw new Error(`Unfilled template placeholders: ${leftover.join(", ")}`);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, html);

// Machine-consumable bundle published next to the page: anyone can consume the
// taxonomy over HTTP without cloning the repo or running the MCP server.
const bundle = JSON.stringify(
  {
    schema: "cardano-defi-taxonomy/v2",
    generatedFrom: REPO_URL,
    counts: { capabilities: capabilities.length, venues: venues.length, mcps: mcps.length },
    capabilities,
    venues,
    mcps,
  },
  null,
  2
);
await writeFile(join(ROOT, "docs", "taxonomy.json"), bundle);

console.log(`docs/taxonomy.json — ${capabilities.length} capabilities, ${venues.length} venues, ${mcps.length} MCPs`);
console.log(`docs/index.html — ${html.length} bytes`);
for (const v of view) console.log(`  ${v.integration.padEnd(12)} ${v.category.padEnd(12)} ${v.id}`);
