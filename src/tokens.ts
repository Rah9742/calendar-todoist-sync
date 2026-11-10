/** Serialized rotating-token access. Refresh persistence and later binding visibility are separate recovery boundaries. */
import { ApiError, json } from "./api";
export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}
/** Read or refresh one token bundle. Call only from the serialized queue consumer to prevent competing rotating-token writers. */
export async function todoistToken(
  env: Env,
  forceRefresh = false,
): Promise<string> {
  if (env.TODOIST_TOKEN_MODE === "legacy") {
    const token = (env as Env & { TODOIST_ACCESS_TOKEN?: string })
      .TODOIST_ACCESS_TOKEN;
    if (!token) throw new Error("missing_todoist_token");
    return token;
  }
  if (
    !env.TOKEN_STORE_ID ||
    !env.TODOIST_TOKEN_SECRET_ID ||
    !env.CF_SECRET_STORE_TOKEN
  )
    throw new Error("configure_token_store");
  const saved: Tokens = JSON.parse(await env.TODOIST_TOKENS.get());
  if (
    !saved.access_token ||
    !saved.refresh_token ||
    !Number.isFinite(saved.expires_at)
  )
    throw new Error("invalid_token_bundle");
  if (!forceRefresh && saved.expires_at > Date.now() + 120000)
    return saved.access_token;
  // Only the globally serialized queue consumer calls this function. Never refresh
  // from fetch/scheduled handlers or another Worker sharing the same token bundle.
  const response = await fetch("https://api.todoist.com/oauth/access_token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: env.TODOIST_CLIENT_ID,
      client_secret: env.TODOIST_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: saved.refresh_token,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new ApiError(response.status);
  const fresh = await response.json<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }>();
  if (!fresh.access_token || !fresh.refresh_token || !fresh.expires_in)
    throw new Error("invalid_refresh_response");
  const bundle: Tokens = {
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token,
    expires_at: Date.now() + fresh.expires_in * 1000,
  };
  // Secret Store has a read-only Worker binding. Rotation is a management operation,
  // so it uses the narrowly scoped management API credential kept as a Worker secret.
  const stored = await json<{ success: boolean }>(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/secrets_store/stores/${env.TOKEN_STORE_ID}/secrets/${env.TODOIST_TOKEN_SECRET_ID}`,
    env.CF_SECRET_STORE_TOKEN,
    {
      method: "PATCH",
      body: JSON.stringify({ value: JSON.stringify(bundle) }),
    },
  );
  if (!stored.success) throw new Error("token_storage_failed");
  return bundle.access_token;
}
