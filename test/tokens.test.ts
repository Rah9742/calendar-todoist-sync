import { afterEach, expect, it, vi } from "vitest";
import { todoistToken } from "../src/tokens";
import { processJob } from "../src/sync";
afterEach(() => vi.unstubAllGlobals());
it("verifies rotated credentials in a separate job and retries stale binding reads without rotating again", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const mapping = { id: "test", googleCalendarId: "g", todoistProjectId: "t" };
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode("new-access"),
      ),
    ),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const job = {
    kind: "verify-token" as const,
    mapping: "test",
    fingerprint: digest,
  };
  await expect(
    processJob(env({ access_token: "old" }), mapping, job),
  ).rejects.toThrow("token_store_propagation_pending");
  await processJob(env({ access_token: "new-access" }), mapping, job);
  expect(fetch).not.toHaveBeenCalled();
});
function env(bundle: unknown) {
  return {
    TODOIST_TOKEN_MODE: "rotating",
    TOKEN_STORE_ID: "store",
    TODOIST_TOKEN_SECRET_ID: "secret",
    CF_ACCOUNT_ID: "account",
    CF_SECRET_STORE_TOKEN: "management-token",
    TODOIST_CLIENT_ID: "client",
    TODOIST_CLIENT_SECRET: "client-secret",
    TODOIST_TOKENS: { get: async () => JSON.stringify(bundle) },
  } as Env;
}
it("reads unexpired OAuth tokens without a refresh or database write", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(
    await todoistToken(
      env({
        access_token: "access",
        refresh_token: "refresh",
        expires_at: Date.now() + 3600000,
      }),
    ),
  ).toBe("access");
  expect(fetch).not.toHaveBeenCalled();
});
it.each([false, true])(
  "saves both rotated tokens before returning the access token (forced=%s)",
  async (forced) => {
    const calls: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(init);
        return Response.json(
          url.includes("api.todoist.com")
            ? {
                access_token: "new-access",
                refresh_token: "new-refresh",
                expires_in: 3600,
              }
            : { success: true },
        );
      }),
    );
    expect(
      await todoistToken(
        env({
          access_token: "old",
          refresh_token: "old-refresh",
          expires_at: forced ? Date.now() + 3600000 : 0,
        }),
        forced,
      ),
    ).toBe("new-access");
    expect(calls[1].method).toBe("PATCH");
    expect(
      JSON.parse(JSON.parse(String(calls[1].body)).value).refresh_token,
    ).toBe("new-refresh");
  },
);
it("fails closed when rotated credentials cannot be persisted", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("api.todoist.com")
        ? Response.json({
            access_token: "new",
            refresh_token: "new-refresh",
            expires_in: 3600,
          })
        : Response.json({}, { status: 503 }),
    ),
  );
  await expect(
    todoistToken(
      env({ access_token: "old", refresh_token: "refresh", expires_at: 0 }),
    ),
  ).rejects.toThrow("upstream_503");
});
