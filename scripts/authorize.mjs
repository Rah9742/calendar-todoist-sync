import { loadConfig, loadMappings } from "./config.mjs";
// Run locally in a user-owned terminal. No credentials or OAuth responses are logged.
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
const provider = process.argv[2];
if (!["google", "todoist"].includes(provider))
  throw new Error("Usage: node scripts/authorize.mjs google|todoist");
const local = parseEnv(readFileSync(".dev.vars", "utf8"));
const config = loadConfig();
const callback = `http://localhost:8788/oauth/${provider}/callback`;
const prefix = provider.toUpperCase();
for (const name of [`${prefix}_CLIENT_ID`, `${prefix}_CLIENT_SECRET`])
  if (!local[name])
    throw new Error(`Set ${name} in the ignored .dev.vars file first.`);
if (
  provider === "todoist" &&
  (!config.vars.TOKEN_STORE_ID || !config.vars.TODOIST_TOKEN_SECRET_ID)
)
  throw new Error("Configure the remote token store and secret ID first.");
if (provider === "todoist" && !local.CF_SECRET_STORE_TOKEN)
  throw new Error(
    "Set CF_SECRET_STORE_TOKEN locally before authorizing Todoist.",
  );
function cli(args, value) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "node_modules/wrangler/bin/wrangler.js",
        ...args,
        "--config",
        "wrangler.local.jsonc",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          WRANGLER_LOG_PATH: "/tmp/calendar-sync-oauth-wrangler.log",
        },
      },
    );
    child.stdout.resume();
    child.stderr.resume();
    child.on("error", () => reject(new Error("Could not run Wrangler")));
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              "Secret upload failed. Check Wrangler login and resource permissions.",
            ),
          ),
    );
    child.stdin.end(value + "\n");
  });
}
const put = (name, value) => cli(["secret", "put", name], value);
const state = randomBytes(32).toString("hex");
let used = false;
const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  try {
    const url = new URL(req.url, "http://localhost:8788");
    if (url.pathname !== `/oauth/${provider}/callback`) {
      res.writeHead(404).end();
      return;
    }
    const received = Buffer.from(url.searchParams.get("state") || "");
    if (
      used ||
      received.length !== state.length ||
      !timingSafeEqual(received, Buffer.from(state))
    ) {
      res.writeHead(403).end("Invalid OAuth state.");
      return;
    }
    used = true;
    const code = url.searchParams.get("code");
    if (!code) throw new Error("Authorization was not granted.");
    const form = new URLSearchParams({
      client_id: local[`${prefix}_CLIENT_ID`],
      client_secret: local[`${prefix}_CLIENT_SECRET`],
      code,
      redirect_uri: callback,
      grant_type: "authorization_code",
    });
    const response = await fetch(
      provider === "google"
        ? "https://oauth2.googleapis.com/token"
        : "https://api.todoist.com/oauth/access_token",
      { method: "POST", body: form, signal: AbortSignal.timeout(20000) },
    );
    if (!response.ok) throw new Error("OAuth token exchange failed.");
    const token = await response.json();
    if (provider === "google") {
      if (!token.refresh_token)
        throw new Error("No Google offline refresh token returned.");
      await put("GOOGLE_REFRESH_TOKEN", token.refresh_token);
    } else {
      if (!token.access_token || !token.refresh_token || !token.expires_in)
        throw new Error("Expected a rotating Todoist OAuth token.");
      const profile = await fetch("https://api.todoist.com/api/v1/user", {
        headers: { Authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(20000),
      });
      if (!profile.ok) throw new Error("Todoist account validation failed.");
      const user = await profile.json();
      await cli(
        [
          "secrets-store",
          "secret",
          "update",
          config.vars.TOKEN_STORE_ID,
          "--secret-id",
          config.vars.TODOIST_TOKEN_SECRET_ID,
          "--remote",
        ],
        JSON.stringify({
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          expires_at: Date.now() + token.expires_in * 1000,
        }),
      );
      await put("TODOIST_USER_ID", String(user.id));
      if (!local.CF_SECRET_STORE_TOKEN)
        throw new Error(
          "Set CF_SECRET_STORE_TOKEN locally before authorizing Todoist.",
        );
      await put("CF_SECRET_STORE_TOKEN", local.CF_SECRET_STORE_TOKEN);
    }
    await put(`${prefix}_CLIENT_ID`, local[`${prefix}_CLIENT_ID`]);
    await put(`${prefix}_CLIENT_SECRET`, local[`${prefix}_CLIENT_SECRET`]);
    if (provider === "google") {
      await put(
        "ADMIN_TOKEN",
        local.ADMIN_TOKEN || randomBytes(32).toString("hex"),
      );
      await put(
        "GOOGLE_CHANNEL_SECRET",
        local.GOOGLE_CHANNEL_SECRET || randomBytes(32).toString("hex"),
      );
    }
    res
      .writeHead(200, { "Content-Type": "text/plain" })
      .end(
        "Authorization saved in Cloudflare secret storage. You can close this tab.",
      );
    console.log(
      `${provider} authorization saved. Token values were not displayed.`,
    );
  } catch (error) {
    res
      .writeHead(500, { "Content-Type": "text/plain" })
      .end("Setup failed. Return to your terminal.");
    console.error(error instanceof Error ? error.message : "Setup failed.");
  } finally {
    if (used) {
      clearTimeout(timeout);
      server.close();
    }
  }
});
const timeout = setTimeout(() => {
  server.close();
  console.error("Authorization timed out after 30 minutes.");
}, 1800000);
server.listen(8788, "127.0.0.1", () => {
  const url = new URL(
    provider === "google"
      ? "https://accounts.google.com/o/oauth2/v2/auth"
      : "https://app.todoist.com/oauth/authorize",
  );
  url.search = new URLSearchParams({
    client_id: local[`${prefix}_CLIENT_ID`],
    redirect_uri: callback,
    response_type: "code",
    state,
    scope:
      provider === "google"
        ? "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly" +
          (config.vars.EMAIL_ALERTS === "true" ||
          process.argv.includes("--email")
            ? " https://www.googleapis.com/auth/gmail.send"
            : "")
        : loadMappings().some((m) => m.deleteTasksOnGoogleDeletion)
          ? "data:read_write,data:delete"
          : "data:read_write",
    ...(provider === "google"
      ? { access_type: "offline", prompt: "consent" }
      : {}),
  }).toString();
  console.log(`Registered callback must be ${callback}`);
  console.log("Opening the provider consent screen…");
  const child = spawn("open", [url.toString()], { stdio: "ignore" });
  child.on("error", () =>
    console.error(
      "Could not open the browser. Run this script on macOS with a browser available.",
    ),
  );
});
