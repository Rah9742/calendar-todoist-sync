/** Offline release guard. Report paths/rule names only; never print matching values. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { loadConfig, loadMappings } from "./config.mjs";
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
const personal = new Set();
if (existsSync(".dev.vars"))
  for (const [key, value] of Object.entries(
    parseEnv(readFileSync(".dev.vars", "utf8")),
  ))
    if (/TOKEN|SECRET|CLIENT_ID|USER_ID/.test(key) && value.length >= 8)
      personal.add(value);
if (existsSync("wrangler.local.jsonc")) {
  const c = loadConfig();
  for (const key of [
    "CF_ACCOUNT_ID",
    "TOKEN_STORE_ID",
    "TODOIST_TOKEN_SECRET_ID",
    "PUBLIC_URL",
    "ALERT_EMAIL",
  ])
    if (c.vars?.[key]?.length >= 8) personal.add(c.vars[key]);
  for (const db of c.d1_databases || [])
    if (db.database_id) personal.add(db.database_id);
  if (c.name) personal.add(c.name);
}
if (existsSync("config/mappings.local.json"))
  for (const m of loadMappings())
    for (const key of ["googleCalendarId", "todoistProjectId"])
      personal.add(m[key]);
const rules = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["Google client secret", /GOCSPX-[A-Za-z0-9_-]{15,}/],
  ["Google token", /(?:ya29\.[A-Za-z0-9._-]{20,}|1\/\/[A-Za-z0-9_-]{30,})/],
  [
    "GitHub token",
    /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/,
  ],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["Slack token", /xox[baprs]-[A-Za-z0-9-]{20,}/],
];
let checked = 0;
const findings = [];
function check(name, text) {
  checked++;
  for (const [rule, pattern] of rules)
    if (pattern.test(text)) findings.push(`${name}: ${rule}`);
  if ([...personal].some((v) => text.includes(v)))
    findings.push(`${name}: private installation value`);
}
const files = [
  ...new Set(
    git("ls-files", "-co", "--exclude-standard", "-z")
      .split("\0")
      .filter(Boolean),
  ),
];
const forbidden =
  /(?:^|\/)(?:\.dev\.vars(?:\..*)?|\.env(?:\..*)?|wrangler\.(?:local|dev\.local|bootstrap\.local)\.jsonc|mappings\.local\.json|worker-configuration\.d\.ts|client_secret[^/]*|todist secrets\.rtf)$|^(?:docs\/private\/|\.wrangler\/|dist\/|node_modules\/)|\.(?:pem|key)$/;
for (const file of files) {
  if (!file.endsWith(".example") && forbidden.test(file)) {
    findings.push(
      "Private/generated file is eligible for publication (name redacted).",
    );
    continue;
  }
  try {
    check(file, readFileSync(file, "utf8"));
  } catch {}
}
if (process.argv.includes("--history")) {
  const entries = git("rev-list", "--objects", "--branches", "--tags")
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const entry of entries) {
    const oid = entry.split(" ")[0];
    if (git("cat-file", "-t", oid).trim() !== "blob") continue;
    check(`history:${oid.slice(0, 12)}`, git("cat-file", "blob", oid));
  }
}
if (findings.length) {
  console.error(
    `Privacy audit found ${findings.length} issue(s):\n${[...new Set(findings)].join("\n")}`,
  );
  process.exitCode = 1;
} else
  console.log(
    `Privacy audit passed for ${checked} candidate files/blobs. No matching values were printed. Use an independent secret scanner too.`,
  );
