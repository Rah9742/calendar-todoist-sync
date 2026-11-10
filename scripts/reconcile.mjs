/** Explicitly request recovery; the admin credential remains in memory and the Authorization header. */
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { loadConfig } from "./config.mjs";
try {
  const config = loadConfig(),
    local = parseEnv(readFileSync(".dev.vars", "utf8")),
    url = new URL(config.vars.PUBLIC_URL);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !local.ADMIN_TOKEN
  )
    throw new Error("invalid_config");
  const r = await fetch(new URL("/admin/reconcile", url), {
    method: "POST",
    headers: { Authorization: `Bearer ${local.ADMIN_TOKEN}` },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (r.status !== 202) throw new Error("request_failed");
  console.log("Recovery queued for the enabled mappings.");
} catch {
  console.error(
    "Could not queue recovery. Check private configuration, admin authorization and deployment. No credentials were printed.",
  );
  process.exitCode = 1;
}
