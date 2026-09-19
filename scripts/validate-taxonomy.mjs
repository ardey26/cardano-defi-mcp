#!/usr/bin/env node
// Fast, dependency-free check of taxonomy/venues/*.json for PR feedback.
// The zod schema in src/taxonomy/schema.ts is the source of truth and is
// enforced by vitest; the field list below is duplicated on purpose so this
// runs with no install step and reports every problem with its filename.

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENUE_DIR = join(ROOT, "taxonomy", "venues");

const CATEGORIES = ["dex", "lending", "cdp", "stablecoin", "derivatives"];
const CAPABILITIES = [
  "swap",
  "liquidity_provision",
  "supply",
  "borrow",
  "cdp_mint",
  "stability_pool",
  "staking",
  "perps",
  "stablecoin_mint",
];
const INTEGRATIONS = ["indexed", "adapter_live", "read_only"];

const errors = [];
const fail = (file, message) => errors.push(`${file}: ${message}`);

const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;

function checkVenue(file, venue) {
  const expectedId = file.replace(/\.json$/, "");

  for (const field of ["id", "name", "description"]) {
    if (!isNonEmptyString(venue[field])) fail(file, `"${field}" must be a non-empty string`);
  }

  if (venue.id !== undefined && venue.id !== expectedId) {
    fail(file, `"id" is "${venue.id}" but the filename requires "${expectedId}"`);
  }

  if (!isNonEmptyString(venue.url)) {
    fail(file, '"url" must be a non-empty string');
  } else if (!URL.canParse(venue.url)) {
    fail(file, `"url" is not a valid URL: ${venue.url}`);
  }

  if (!CATEGORIES.includes(venue.category)) {
    fail(file, `"category" must be one of ${CATEGORIES.join(", ")} (got ${JSON.stringify(venue.category)})`);
  }

  if (!INTEGRATIONS.includes(venue.integration)) {
    fail(file, `"integration" must be one of ${INTEGRATIONS.join(", ")} (got ${JSON.stringify(venue.integration)})`);
  }

  if (!Array.isArray(venue.assets) || !venue.assets.every(isNonEmptyString)) {
    fail(file, '"assets" must be an array of non-empty strings');
  }

  if (!Array.isArray(venue.capabilities) || venue.capabilities.length === 0) {
    fail(file, '"capabilities" must be a non-empty array');
  } else {
    for (const cap of venue.capabilities) {
      if (!CAPABILITIES.includes(cap)) {
        fail(file, `"capabilities" has unknown value ${JSON.stringify(cap)}; allowed: ${CAPABILITIES.join(", ")}`);
      }
    }
  }

  if (venue.notes !== undefined && !isNonEmptyString(venue.notes)) {
    fail(file, '"notes", when present, must be a non-empty string');
  }
}

const files = (await readdir(VENUE_DIR)).filter((f) => f.endsWith(".json")).sort();
if (files.length === 0) {
  console.error("No venue files found in taxonomy/venues/");
  process.exit(1);
}

const seenIds = new Map();

for (const file of files) {
  let venue;
  try {
    venue = JSON.parse(await readFile(join(VENUE_DIR, file), "utf8"));
  } catch (err) {
    fail(file, `not valid JSON (${err.message})`);
    continue;
  }

  if (venue === null || typeof venue !== "object" || Array.isArray(venue)) {
    fail(file, "must be a JSON object");
    continue;
  }

  checkVenue(file, venue);

  if (isNonEmptyString(venue.id)) {
    const first = seenIds.get(venue.id);
    if (first) fail(file, `duplicate id "${venue.id}", already used by ${first}`);
    else seenIds.set(venue.id, file);
  }
}

if (errors.length > 0) {
  console.error(`${errors.length} problem(s) in ${files.length} venue file(s):\n`);
  for (const e of errors) console.error(`  ${e}`);
  console.error("\nSchema: src/taxonomy/schema.ts");
  process.exit(1);
}

console.log(`${files.length} venue files OK`);
