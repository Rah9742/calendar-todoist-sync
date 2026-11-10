import { loadConfig } from "./config.mjs";
// Read-only status; the admin credential stays in memory and out of arguments.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

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
  const response = await fetch(new URL("/admin/status", base), {
    headers: { Authorization: `Bearer ${local.ADMIN_TOKEN}` },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    console.error(
      `Status request failed (HTTP ${response.status}). Check the local admin credential and deployment.`,
    );
    process.exitCode = 1;
  } else {
    const status = await response.json();
    if (process.argv.includes("--json"))
      console.log(JSON.stringify(status, null, 2));
    else {
      console.log(`Sync: ${status.status} · checked ${status.generatedAt}`);
      console.log(
        `Window: ${status.window.start} through ${status.window.end} (end exclusive, Europe/London)`,
      );
      for (const m of status.mappings) {
        const count = (state) =>
          m.links
            .filter((r) => r.state === state)
            .reduce((total, r) => total + r.count, 0);
        console.log(
          `\n${m.id}: ${m.enabled ? "enabled" : "disabled"} · ${count("active")} active · ${count("held")} held · ${count("deleted")} deleted`,
        );
        console.log(
          `  Google watch expires: ${m.googleWatchExpiresAt || "not registered"}`,
        );
        for (const r of m.recovery)
          console.log(
            `  ${r.kind} recovery: ${r.lastCompletedScan || "not yet recorded"}${r.stale ? " (missing or stale)" : ""}`,
          );
        for (const r of m.links.filter((r) => r.state === "held"))
          console.log(`  Held: ${r.reason} (${r.count})`);
        for (const r of m.issues)
          console.log(`  Review: ${r.source} ${r.reason} (${r.count})`);
        for (const f of m.failures)
          console.log(
            `  Error: ${f.kind} ${f.code} (${f.count} jobs, ${f.retryLimitReached} reached retry limit) · last ${f.lastFailed}`,
          );
        if (m.alerts.length) console.log(`  Attention: ${m.alerts.join(", ")}`);
      }
      console.log(
        status.email?.enabled
          ? `\nEmail alerts enabled · last delivery: ${status.email.deliveryState || "none yet"} · ${status.email.lastSentAt || "not yet sent"}`
          : "\nRead-only snapshot. Email alerts are disabled.",
      );
    }
  }
} catch {
  console.error(
    "Could not read sync status. Check .dev.vars, wrangler.jsonc, network access and the deployed Worker. No credentials were printed.",
  );
  process.exitCode = 1;
}
