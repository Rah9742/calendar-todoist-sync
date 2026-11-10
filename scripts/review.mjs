import { loadConfig } from "./config.mjs";
// Read-only hold review; the admin secret stays in memory, never in arguments.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
const clean = (value) =>
  String(value ?? "unavailable").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
try {
  const local = parseEnv(readFileSync(".dev.vars", "utf8"));
  if (!local.ADMIN_TOKEN) throw new Error("missing_configuration");
  const config = loadConfig();
  const base = new URL(config.vars.PUBLIC_URL);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("invalid_configuration");
  const items = [];
  let cursor = null;
  const seen = new Set();
  do {
    const url = new URL("/admin/review", base);
    if (cursor) url.searchParams.set("cursor", cursor);
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${local.ADMIN_TOKEN}` },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error("review_unavailable");
    const page = await r.json();
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error("repeated_cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  if (process.argv.includes("--json"))
    console.log(
      JSON.stringify(
        {
          notice:
            "Last saved sync snapshots, not current provider values. Read-only; no pair is changed or released.",
          items,
        },
        null,
        2,
      ),
    );
  else {
    console.log(
      `${items.length} held pairs. Last saved sync snapshots below; these may differ from the providers now.`,
    );
    for (const item of items) {
      console.log(
        `\n${clean(item.mapping)} · ${clean(item.reason)} · held since ${clean(item.heldSince)}`,
      );
      for (const source of ["google", "todoist"]) {
        const saved = item.lastSaved[source];
        console.log(
          `  ${source}: ${saved ? `${clean(saved.title)} · ${clean(saved.start)}` : "no saved snapshot"}`,
        );
      }
      console.log(`  Review reference: ${clean(item.ref)}`);
    }
    console.log(
      "\nVerify current provider values before resolving a hold. This command makes no changes.",
    );
  }
} catch {
  console.error(
    "Could not read held pairs. Check local configuration, admin authorization and network access. No credentials were printed; no holds were changed.",
  );
  process.exitCode = 1;
}
