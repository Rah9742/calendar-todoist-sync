/** Bounded provider requests, redacted failures and idempotent Todoist commands. Never log credentials or response bodies here. */
import type { AuthenticatedEnv } from "./runtime";
import { timingSafeEqual } from "node:crypto";
export class ApiError extends Error {
  constructor(
    public status: number,
    public retryAfter: number = 30,
  ) {
    super(`upstream_${status}`);
  }
}
/** Fetch JSON with a bounded timeout; throw a status-only ApiError and never expose upstream bodies. */
export async function json<T>(
  url: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new ApiError(
      response.status,
      Number(response.headers.get("retry-after")) || 30,
    );
  return response.status === 204 ? (undefined as T) : await response.json<T>();
}
/** Exchange the stored offline Google credential in memory; never persist access tokens in D1. */
export async function googleToken(env: Env): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new ApiError(response.status);
  return (await response.json<{ access_token: string }>()).access_token;
}
/** Compare hashed secrets in constant time, including when input lengths differ. */
export async function equalSecret(a: string, b: string): Promise<boolean> {
  const digest = async (s: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  return timingSafeEqual(new Uint8Array(x), new Uint8Array(y));
}
/** Verify the HMAC over the original request bytes; parsing or reserialization would change the signed payload. */
export async function verifyTodoist(
  body: ArrayBuffer,
  signature: string,
  secret: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  try {
    return await crypto.subtle.verify(
      "HMAC",
      key,
      Uint8Array.from(atob(signature), (c) => c.charCodeAt(0)),
      body,
    );
  } catch {
    return false;
  }
}
// Sync commands have a documented UUID idempotency guarantee. REST request IDs
// alone are not used as an exactly-once contract.
/** Create through a stable Sync command UUID so retrying a lost response cannot duplicate a task. */
export async function createTask(
  env: AuthenticatedEnv,
  requestId: string,
  args: Record<string, unknown>,
): Promise<import("./model").Task> {
  const result = await json<{
    sync_status: Record<string, unknown>;
    temp_id_mapping: Record<string, string>;
  }>("https://api.todoist.com/api/v1/sync", env.TODOIST_ACCESS_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      commands: JSON.stringify([
        { type: "item_add", uuid: requestId, temp_id: requestId, args },
      ]),
    }),
  });
  if (result.sync_status[requestId] !== "ok")
    throw new Error("todoist_command_failed");
  const id = result.temp_id_mapping[requestId];
  if (!id) throw new Error("todoist_mapping_missing");
  return json(
    `https://api.todoist.com/api/v1/tasks/${encodeURIComponent(id)}`,
    env.TODOIST_ACCESS_TOKEN,
  );
}
/** Update the native due object through Sync, preserving explicit recurring metadata. */
export async function updateRecurringTask(
  env: AuthenticatedEnv,
  id: string,
  due: NonNullable<import("./model").Task["due"]>,
): Promise<import("./model").Task> {
  const uuid = crypto.randomUUID();
  const result = await json<{ sync_status: Record<string, unknown> }>(
    "https://api.todoist.com/api/v1/sync",
    env.TODOIST_ACCESS_TOKEN,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        commands: JSON.stringify([
          { type: "item_update", uuid, args: { id, due } },
        ]),
      }),
    },
  );
  if (result.sync_status[uuid] !== "ok")
    throw new Error("todoist_command_failed");
  return json(
    `https://api.todoist.com/api/v1/tasks/${encodeURIComponent(id)}`,
    env.TODOIST_ACCESS_TOKEN,
  );
}

/** Delete a confirmed counterpart; repeated not-found responses count as already applied. */
export async function deleteTask(
  env: AuthenticatedEnv,
  id: string,
): Promise<void> {
  const response = await fetch(
    `https://api.todoist.com/api/v1/tasks/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${env.TODOIST_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok && response.status !== 404 && response.status !== 410)
    throw new ApiError(
      response.status,
      Number(response.headers.get("retry-after")) || 30,
    );
  await response.body?.cancel();
}
