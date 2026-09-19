#!/usr/bin/env node
// Builds docs/index.html: a static, self-contained browser for taxonomy/venues/*.json.
// No validation here — the taxonomy tests own the schema.

import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENUE_DIR = join(ROOT, "taxonomy", "venues");
const TEMPLATE = join(ROOT, "scripts", "explorer.template.html");
const OUT = join(ROOT, "docs", "index.html");

// Placeholder until the repo is published.
const REPO_URL = "https://github.com/bazaarswap/bazaarswap-cardano";

// Display order for the register; unknown categories sort last, alphabetically.
const CATEGORY_ORDER = ["dex", "lending", "cdp", "stablecoin", "derivatives"];

const rank = (category) => {
  const i = CATEGORY_ORDER.indexOf(category);
  return i === -1 ? CATEGORY_ORDER.length : i;
};

const files = (await readdir(VENUE_DIR)).filter((f) => f.endsWith(".json")).sort();
const venues = await Promise.all(
  files.map(async (f) => JSON.parse(await readFile(join(VENUE_DIR, f), "utf8")))
);

venues.sort(
  (a, b) => rank(a.category) - rank(b.category) || a.name.localeCompare(b.name, "en")
);

// Escaping `<` keeps a venue string from closing the inline <script>.
const json = JSON.stringify(venues, null, 2).replaceAll("<", "\\u003c");

const template = await readFile(TEMPLATE, "utf8");
const html = template
  .replaceAll("{{VENUES_JSON}}", json)
  .replaceAll("{{REPO_URL}}", REPO_URL);

const leftover = html.match(/\{\{[A-Z_]+\}\}/g);
if (leftover) throw new Error(`Unfilled template placeholders: ${leftover.join(", ")}`);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, html);

console.log(`docs/index.html — ${venues.length} venues, ${html.length} bytes`);
for (const v of venues) console.log(`  ${v.integration.padEnd(12)} ${v.category.padEnd(12)} ${v.id}`);
