#!/usr/bin/env node
// Fast, dependency-free check of taxonomy/ for PR feedback: the capability
// tree, venue records, MCP records, and the references between them. The zod
// schemas in src/taxonomy/schema.ts are the source of truth and are enforced
// by vitest; the rules below are duplicated on purpose so this runs with no
// install step and reports every problem with its filename. TAXONOMY_DIR
// points it at another tree, for tests.

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAXONOMY = process.env.TAXONOMY_DIR ?? join(ROOT, "taxonomy");

const CATEGORIES = ["dex", "lending", "cdp", "stablecoin", "derivatives"];
const EFFECTS = ["read", "unsigned_tx", "signs"];
const AUTHS = ["none", "api_key", "oauth"];
const CAPABILITY_ID = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;
const VENUE_FIELDS = ["id", "name", "category", "url", "description", "assets", "capabilities", "notes"];
const MCP_FIELDS = ["id", "name", "publisher", "official", "repo", "connect", "auth", "tools", "notes"];
const TOOL_FIELDS = ["name", "capability", "venues", "effect", "official", "notes"];

const errors = [];
const fail = (where, message) => errors.push(`${where}: ${message}`);

const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isUrl = (v) => isNonEmptyString(v) && URL.canParse(v);

async function readJson(file) {
  try {
    return JSON.parse(await readFile(join(TAXONOMY, file), "utf8"));
  } catch (err) {
    fail(file, `could not read or parse JSON (${err.message})`);
    return undefined;
  }
}

/** Every <dir>/*.json that parses to an object, with filename/id and duplicate-id checks. */
async function readRecords(dir) {
  let names;
  try {
    names = (await readdir(join(TAXONOMY, dir))).filter((f) => f.endsWith(".json")).sort();
  } catch {
    fail(`${dir}/`, "directory is missing");
    return [];
  }

  const records = [];
  const seenIds = new Map();
  for (const name of names) {
    const file = `${dir}/${name}`;
    const record = await readJson(file);
    if (record === undefined) continue;
    if (!isObject(record)) {
      fail(file, "must be a JSON object");
      continue;
    }

    const expectedId = name.replace(/\.json$/, "");
    if (record.id !== expectedId) {
      fail(file, `"id" is ${JSON.stringify(record.id)} but the filename requires "${expectedId}"`);
    }
    if (isNonEmptyString(record.id)) {
      const first = seenIds.get(record.id);
      if (first) fail(file, `duplicate id "${record.id}", already used by ${first}`);
      else seenIds.set(record.id, file);
    }
    records.push({ file, record });
  }
  return records;
}

function checkFields(where, record, allowed) {
  for (const key of Object.keys(record)) {
    if (allowed.includes(key)) continue;
    const hint = key === "integration" ? " (removed in v2: agent access is now derived from taxonomy/mcps/)" : "";
    fail(where, `unknown field "${key}"${hint}`);
  }
}

function requireStrings(where, record, fields) {
  for (const field of fields) {
    if (!isNonEmptyString(record[field])) fail(where, `"${field}" must be a non-empty string`);
  }
}

function checkNotes(where, record) {
  if (record.notes !== undefined && !isNonEmptyString(record.notes)) {
    fail(where, '"notes", when present, must be a non-empty string');
  }
}

// --- capabilities.json -------------------------------------------------------

const capabilityIds = new Set();
const tree = await readJson("capabilities.json");
if (tree !== undefined && !Array.isArray(tree)) fail("capabilities.json", "must be a JSON array of capability nodes");

for (const [i, node] of (Array.isArray(tree) ? tree : []).entries()) {
  const where = `capabilities.json[${i}]`;
  if (!isObject(node)) {
    fail(where, "must be an object");
    continue;
  }
  checkFields(where, node, ["id", "label", "description"]);
  if (typeof node.id !== "string" || !CAPABILITY_ID.test(node.id)) {
    fail(where, `"id" must look like "group.action" in lowercase (got ${JSON.stringify(node.id)})`);
  } else if (capabilityIds.has(node.id)) {
    fail(where, `duplicate id "${node.id}"`);
  } else {
    capabilityIds.add(node.id);
  }
  requireStrings(where, node, ["label", "description"]);
}

function checkCapability(where, value) {
  if (!capabilityIds.has(value)) fail(where, `capability ${JSON.stringify(value)} is not a node in capabilities.json`);
}

// --- venues/ -----------------------------------------------------------------

const venues = await readRecords("venues");
if (venues.length === 0) fail("venues/", "no venue files found");
const venueIds = new Set(venues.map(({ record }) => record.id));

for (const { file, record: venue } of venues) {
  checkFields(file, venue, VENUE_FIELDS);
  requireStrings(file, venue, ["id", "name", "description"]);
  if (!isUrl(venue.url)) fail(file, `"url" must be a valid URL (got ${JSON.stringify(venue.url)})`);
  if (!CATEGORIES.includes(venue.category)) {
    fail(file, `"category" must be one of ${CATEGORIES.join(", ")} (got ${JSON.stringify(venue.category)})`);
  }
  if (!Array.isArray(venue.assets) || !venue.assets.every(isNonEmptyString)) {
    fail(file, '"assets" must be an array of non-empty strings');
  }
  if (!Array.isArray(venue.capabilities) || venue.capabilities.length === 0) {
    fail(file, '"capabilities" must be a non-empty array of capability ids');
  } else {
    for (const cap of venue.capabilities) checkCapability(file, cap);
  }
  checkNotes(file, venue);
}

// --- mcps/ -------------------------------------------------------------------

function checkConnect(where, entry) {
  if (!isObject(entry)) return fail(where, "must be an object");
  if (entry.transport === "stdio") {
    checkFields(where, entry, ["transport", "command", "args"]);
    if (!isNonEmptyString(entry.command)) fail(where, 'stdio needs a non-empty "command"');
    if (!Array.isArray(entry.args) || !entry.args.every((a) => typeof a === "string")) {
      fail(where, 'stdio needs "args" as an array of strings');
    }
  } else if (entry.transport === "http") {
    checkFields(where, entry, ["transport", "url"]);
    if (!isUrl(entry.url)) fail(where, 'http needs a valid "url"');
  } else {
    fail(where, `"transport" must be "stdio" or "http" (got ${JSON.stringify(entry.transport)})`);
  }
}

function checkTool(where, tool, seenNames) {
  if (!isObject(tool)) return fail(where, "must be an object");
  checkFields(where, tool, TOOL_FIELDS);
  if (!isNonEmptyString(tool.name)) fail(where, '"name" must be a non-empty string');
  else if (seenNames.has(tool.name)) fail(where, `duplicate tool name "${tool.name}"`);
  else seenNames.add(tool.name);
  checkCapability(where, tool.capability);
  if (!EFFECTS.includes(tool.effect)) {
    fail(where, `"effect" must be one of ${EFFECTS.join(", ")} (got ${JSON.stringify(tool.effect)})`);
  }
  if (tool.venues !== undefined) {
    if (!Array.isArray(tool.venues) || tool.venues.length === 0) {
      fail(where, '"venues", when present, must be a non-empty array (omit it for a venue-agnostic tool)');
    } else {
      for (const v of tool.venues) {
        if (!venueIds.has(v)) fail(where, `venue ${JSON.stringify(v)} is not a file in venues/`);
      }
    }
  }
  if (tool.official !== undefined && typeof tool.official !== "boolean") {
    fail(where, '"official", when present, must be true or false');
  }
  checkNotes(where, tool);
}

const mcps = await readRecords("mcps");

for (const { file, record: mcp } of mcps) {
  checkFields(file, mcp, MCP_FIELDS);
  requireStrings(file, mcp, ["id", "name", "publisher"]);
  if (typeof mcp.official !== "boolean") fail(file, '"official" must be true or false');
  if (!isUrl(mcp.repo)) fail(file, `"repo" must be a valid URL (got ${JSON.stringify(mcp.repo)})`);
  if (!AUTHS.includes(mcp.auth)) fail(file, `"auth" must be one of ${AUTHS.join(", ")} (got ${JSON.stringify(mcp.auth)})`);

  if (!Array.isArray(mcp.connect) || mcp.connect.length === 0) fail(file, '"connect" must be a non-empty array');
  else mcp.connect.forEach((entry, i) => checkConnect(`${file} connect[${i}]`, entry));

  if (!Array.isArray(mcp.tools) || mcp.tools.length === 0) {
    fail(file, '"tools" must be a non-empty array');
  } else {
    const seenNames = new Set();
    mcp.tools.forEach((tool, i) => checkTool(`${file} tools[${i}]`, tool, seenNames));
  }
  checkNotes(file, mcp);
}

if (errors.length > 0) {
  console.error(`${errors.length} problem(s) in taxonomy/:\n`);
  for (const e of errors) console.error(`  ${e}`);
  console.error("\nSchema: src/taxonomy/schema.ts");
  process.exit(1);
}

console.log(`${capabilityIds.size} capabilities, ${venues.length} venues, ${mcps.length} MCPs OK`);
