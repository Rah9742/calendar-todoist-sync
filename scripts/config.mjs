/** Local configuration helpers. Never include private values in error messages. */
import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";

/** Parse JSONC strictly: comments/trailing commas are allowed, syntax errors are not. */
export function parseConfig(text) {
  const errors = [];
  const result = parse(text, errors, { allowTrailingComma: true });
  if (
    errors.length ||
    !result ||
    typeof result !== "object" ||
    Array.isArray(result)
  )
    throw new Error("Invalid configuration JSONC.");
  return result;
}

/** Require the ignored local deployment file for every command that can contact an account. */
export function loadConfig(file = "wrangler.local.jsonc") {
  try {
    return parseConfig(readFileSync(file, "utf8"));
  } catch {
    throw new Error("Configure wrangler.local.jsonc first; see docs/SETUP.md.");
  }
}

/** Read explicit one-to-one calendar/project pairs; empty lists and duplicate endpoints are rejected. */
export function loadMappings(file = "config/mappings.local.json") {
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(
      "Configure config/mappings.local.json first; see docs/SETUP.md.",
    );
  }
  const pairs = Array.isArray(value) ? value : value?.mappings;
  const seen = [new Set(), new Set(), new Set()];
  const flags = [
    "enabled",
    "extendedRecurrence",
    "complexRecurrence",
    "mappedMoves",
    "deleteTasksOnGoogleDeletion",
    "deleteGoogleOnTaskDeletion",
  ];
  if (!Array.isArray(pairs) || !pairs.length || pairs.length > 20)
    throw new Error("Mappings must contain 1–20 explicit pairs.");
  for (const pair of pairs) {
    if (!pair || typeof pair !== "object") throw new Error("Invalid mapping.");
    for (const [index, key] of [
      "id",
      "googleCalendarId",
      "todoistProjectId",
    ].entries()) {
      if (
        typeof pair[key] !== "string" ||
        !pair[key].trim() ||
        seen[index].has(pair[key])
      )
        throw new Error(
          "Mapping IDs and endpoints must be nonempty and unique.",
        );
      seen[index].add(pair[key]);
    }
    if (flags.some((key) => key in pair && typeof pair[key] !== "boolean"))
      throw new Error("Mapping flags must be booleans.");
  }
  return pairs;
}

/** Reject unfilled templates before any real deployment, without reflecting private identifiers. */
export function validateDeployment(config, pairs) {
  const account = config.vars?.CF_ACCOUNT_ID;
  const store = config.vars?.TOKEN_STORE_ID;
  const secret = config.vars?.TODOIST_TOKEN_SECRET_ID;
  if (
    [account, store, secret].some(
      (value) =>
        typeof value !== "string" ||
        !/^[a-f0-9]{32}$/i.test(value) ||
        /^0+$/.test(value),
    )
  )
    throw new Error(
      "Fill in the private Cloudflare account/store identifiers before deployment.",
    );
  if (
    !config.d1_databases?.length ||
    config.d1_databases.some(
      (db) => !db.database_id || /^0+-0+-0+-0+-0+$/.test(db.database_id),
    )
  )
    throw new Error("Fill in the private D1 binding before deployment.");
  if (
    pairs.some((pair) =>
      [pair.googleCalendarId, pair.todoistProjectId].some((value) =>
        /REPLACE_WITH|YOUR_|example\.invalid/i.test(value),
      ),
    )
  )
    throw new Error("Replace example mapping endpoints before deployment.");
  let url;
  try {
    url = new URL(config.vars.PUBLIC_URL);
  } catch {
    throw new Error("Configure the private public URL before deployment.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    /YOUR_SUBDOMAIN/i.test(url.hostname)
  )
    throw new Error("Configure a clean HTTPS public URL before deployment.");
}
