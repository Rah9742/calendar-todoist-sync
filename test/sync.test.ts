import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { createHmac } from "node:crypto";
import { Sync } from "../src/sync";
import {
  recordFailure,
  recordSuccess,
  syncStatus,
  QUEUE_MAX_RETRIES,
} from "../src/monitoring";
import { ApiError } from "../src/api";
import { notify } from "../src/notifications";
import worker from "../src/index";
import { type Event, type Task, type Job } from "../src/model";
const mapping = {
  extendedRecurrence: true,
  id: "test",
  googleCalendarId: "test-calendar",
  todoistProjectId: "test-project",
};
let mf: Miniflare, env: Env, sync: Sync;
let events: Map<string, Event>,
  tasks: Map<string, Task>,
  jobs: Job[],
  writes: { url: string; body: Record<string, unknown>; headers: Headers }[],
  created: Map<string, Task>;
let failures = 0;
let activities: {
  id: string;
  event_type: string;
  event_date: string;
  extra_data?: { due_date: string; has_time: boolean };
}[] = [];
let calendars: Map<string, Map<string, Event>>, instances: Map<string, Event[]>;
const calendar = (id: string) =>
  id === mapping.googleCalendarId
    ? events
    : calendars.get(id) ||
      (() => {
        const rows = new Map<string, Event>();
        calendars.set(id, rows);
        return rows;
      })();
const event = (id = "event1"): Event => ({
  id,
  summary: "Initial",
  description: "Notes",
  etag: '"v1"',
  start: { dateTime: "2026-11-03T10:00:00Z" },
  end: { dateTime: "2026-11-03T11:00:00Z" },
});
const task = (id = "task1"): Task => ({
  id,
  project_id: mapping.todoistProjectId,
  content: "Initial",
  description: "Notes",
  due: { date: "2026-11-03T10:00:00Z" },
  duration: { amount: 60, unit: "minute" },
});
function applyTask(t: Task, b: Record<string, unknown>): Task {
  return {
    ...t,
    content: (b.content as string) || t.content,
    description: (b.description as string) ?? t.description,
    due: b.due_date
      ? { date: b.due_date as string }
      : b.due_datetime
        ? { date: b.due_datetime as string }
        : t.due,
    duration:
      typeof b.duration === "number"
        ? { amount: b.duration, unit: "minute" }
        : t.duration,
  };
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
async function upstream(input: string | URL | Request, init: RequestInit = {}) {
  const url = new URL(String(input)),
    path = url.pathname;
  const method = init.method || "GET";
  if (url.hostname === "oauth2.googleapis.com")
    return response({ access_token: "test-token" });
  const b = init.body
    ? path === "/api/v1/sync"
      ? Object.fromEntries(new URLSearchParams(String(init.body)))
      : JSON.parse(String(init.body))
    : {};
  if (method !== "GET")
    writes.push({
      url: url.toString(),
      body: b,
      headers: new Headers(init.headers),
    });
  if (url.hostname === "api.todoist.com") {
    if (path === "/api/v1/activities") return response({ results: activities });
    const id = path.split("/").at(-1)!;
    if (path === "/api/v1/sync") {
      const command = JSON.parse(b.commands)[0],
        key = command.uuid;
      const args = command.args;
      if (command.type === "item_move") {
        tasks.set(args.id, {
          ...tasks.get(args.id)!,
          project_id: args.project_id,
        });
        return response({ sync_status: { [key]: "ok" } });
      }
      if (command.type === "item_update") {
        tasks.set(args.id, { ...tasks.get(args.id)!, due: args.due });
        return response({ sync_status: { [key]: "ok" } });
      }
      let t = created.get(key);
      if (!t) {
        t = {
          ...task(`task${tasks.size + 1}`),
          content: args.content,
          description: args.description,
          due: args.due,
          duration: args.duration,
        };
        created.set(key, t);
        tasks.set(t.id, t);
      }
      if (failures-- > 0)
        throw new TypeError("simulated connection lost after create");
      return response({
        sync_status: { [key]: "ok" },
        temp_id_mapping: { [key]: t.id },
      });
    }
    if (path === "/api/v1/tasks" && method === "GET")
      return response({ results: [...tasks.values()], next_cursor: null });
    if (!tasks.has(id)) return response({}, 404);
    if (method === "DELETE") {
      tasks.delete(id);
      return new Response(null, { status: 204 });
    }
    if (method === "POST") {
      const t = applyTask(tasks.get(id)!, b);
      tasks.set(id, t);
      return response(t);
    }
    return response(tasks.get(id));
  }
  const calId = decodeURIComponent(
    path.split("/calendars/")[1]?.split("/")[0] || mapping.googleCalendarId,
  );
  const cal = calendar(calId);
  if (path.endsWith("/move")) {
    const id = path.split("/").at(-2)!;
    const source = cal.get(id);
    if (!source || source.status === "cancelled") return response({}, 404);
    const moved = { ...source, status: "confirmed" };
    calendar(url.searchParams.get("destination")!).set(id, moved);
    cal.set(id, { ...source, status: "cancelled" });
    return response(moved);
  }
  if (path.endsWith("/instances")) {
    const id = path.split("/").at(-2)!;
    const master = cal.get(id);
    if (instances.has(id)) {
      let rows = instances.get(id)!.map((e) => cal.get(e.id) || e);
      const original = url.searchParams.get("originalStart");
      if (original)
        rows = rows.filter(
          (e) =>
            Date.parse(
              e.originalStartTime?.dateTime ||
                e.originalStartTime?.date ||
                e.start?.dateTime ||
                e.start?.date ||
                "",
            ) === Date.parse(original),
        );
      if (url.searchParams.get("showDeleted") !== "true")
        rows = rows.filter((e) => e.status !== "cancelled");
      const min = url.searchParams.get("timeMin"),
        max = url.searchParams.get("timeMax");
      rows = rows.filter((e) => {
        const start =
          e.start?.dateTime ||
          e.start?.date ||
          e.originalStartTime?.dateTime ||
          e.originalStartTime?.date ||
          "";
        const end = e.end?.dateTime || e.end?.date || start;
        return (
          (!min || Date.parse(end) >= Date.parse(min)) &&
          (!max || Date.parse(start) < Date.parse(max))
        );
      });
      const offset = Number(url.searchParams.get("pageToken") || 0),
        limit = Number(url.searchParams.get("maxResults") || 5);
      return response({
        items: rows.slice(offset, offset + limit),
        ...(offset + limit < rows.length
          ? { nextPageToken: String(offset + limit) }
          : {}),
      });
    }
    return response({
      items: master
        ? [
            {
              ...master,
              id: id + "_instance",
              recurrence: undefined,
              recurringEventId: id,
            },
          ]
        : [],
    });
  }
  if (path.endsWith("/events/watch"))
    return response({
      resourceId: "resource",
      expiration: String(Date.now() + 7 * 86400000),
    });
  if (path.endsWith("/events") && method === "GET") {
    let items = [...cal.values()];
    if (url.searchParams.has("iCalUID"))
      items = items.filter(
        (e) =>
          e.iCalUID === url.searchParams.get("iCalUID") &&
          e.status !== "cancelled" &&
          !e.recurringEventId,
      );
    if (url.searchParams.has("q"))
      items = items.filter(
        (e) =>
          e.summary === url.searchParams.get("q") &&
          !e.recurringEventId &&
          e.status !== "cancelled",
      );
    if (url.searchParams.has("updatedMin"))
      items = items.filter(
        (e) =>
          Date.parse(e.updated || e.created || "") >=
          Date.parse(url.searchParams.get("updatedMin")!),
      );
    return response({ items, nextSyncToken: "next" });
  }
  if (path.endsWith("/events") && method === "POST") {
    const id = b.id as string;
    if (cal.has(id)) return response({}, 409);
    const e = { ...b, id, etag: '"v1"' } as Event;
    cal.set(id, e);
    return response(e);
  }
  const id = path.split("/").at(-1)!;
  if (!cal.has(id)) return response({}, 404);
  if (method === "DELETE") {
    cal.set(id, { ...cal.get(id)!, status: "cancelled" });
    return new Response(null, { status: 204 });
  }
  if (method === "PATCH") {
    const e = { ...cal.get(id)!, ...b };
    cal.set(id, e);
    return response(e);
  }
  return response(cal.get(id));
}
beforeAll(async () => {
  mf = new Miniflare({
    enableDevRegistry: false,
    workers: [
      {
        config: {
          name: "test",
          compatibilityDate: "2026-10-30",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents: 'export default {fetch(){return new Response("ok")}}',
              },
            },
          },
          env: { DB: { type: "d1", id: "test-db" } },
        },
      },
    ],
  });
  const db = await mf.getD1Database("DB");
  // D1 exec accepts one statement per line; split migration statements explicitly.
  for (const migration of readdirSync("migrations")
    .filter((p) => p.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(`migrations/${migration}`, "utf8")
      .split(";")
      .filter((s) => s.trim()))
      await db.prepare(statement).run();
  env = {
    DB: db,
    SYNC_ENABLED: "true",
    PUBLIC_URL: "https://test.example",
    MAPPINGS_JSON: JSON.stringify([mapping]),
    COMPLETION_MODE: "checkmark",
    DEFAULT_DURATION_MINUTES: "30",
    IMPORT_START: "2026-11-01",
    IMPORT_END: "2027-01-01",
    ADMIN_TOKEN: "test-admin",
    GOOGLE_CLIENT_ID: "test-client",
    GOOGLE_CLIENT_SECRET: "test-secret",
    GOOGLE_REFRESH_TOKEN: "test-refresh",
    GOOGLE_CHANNEL_SECRET: "test-channel",
    TODOIST_ACCESS_TOKEN: "test-token",
    TODOIST_CLIENT_SECRET: "test-hmac",
    TODOIST_USER_ID: "test-user",
    JOBS: {
      send: async (j: Job) => {
        jobs.push(j);
      },
    },
  } as Env;
});
afterAll(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  activities = [];
  await env.DB.batch(
    [
      "links",
      "channels",
      "cursors",
      "deliveries",
      "issues",
      "migration_guards",
      "job_status",
      "job_failures",
      "series",
      "operations",
      "notifications",
      "notification_health",
      "rolling_advances",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  events = new Map();
  calendars = new Map();
  instances = new Map();
  tasks = new Map();
  created = new Map();
  jobs = [];
  writes = [];
  failures = 0;
  vi.stubGlobal("fetch", vi.fn(upstream));
  sync = new Sync(env, mapping, "test-token");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const state = () =>
  env.DB.prepare("SELECT * FROM links").first<{
    state: string;
    reason: string;
    task_id: string;
    event_id: string;
  }>();
async function seed() {
  const e = event();
  events.set(e.id, e);
  await sync.event(e);
  writes = [];
  return (await state())!;
}
async function request(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return worker.fetch(
    new Request(`https://test.example${path}`, {
      method: body ? "POST" : "GET",
      body: body ? JSON.stringify(body) : undefined,
      headers,
    }),
    env,
    {} as ExecutionContext,
  );
}
describe("two-way sync with real D1", () => {
  it("applies an explicitly Google-authoritative migration only after activation, without changing Google", async () => {
    const e = event(),
      t = { ...task(), due: { date: "2026-11-03T12:00:00Z" } };
    events.set(e.id, e);
    tasks.set(t.id, t);
    await new Sync(
      env,
      { ...mapping, enabled: false },
      "test-token",
    ).prepareMigration({
      pairs: [{ eventId: e.id, taskId: t.id, authority: "google" }],
      guards: [],
    });
    expect(writes).toHaveLength(0);
    expect((await state())?.state).toBe("import_google");
    await sync.task(t.id);
    expect(tasks.get(t.id)?.due?.date).toBe("2026-11-03T10:00:00.000Z");
    expect(events.get(e.id)).toEqual(e);
    expect((await state())?.state).toBe("active");
    expect(
      writes.every((w) => new URL(w.url).hostname === "api.todoist.com"),
    ).toBe(true);
  });
  it("holds a pending import if the Todoist copy changes after migration preparation", async () => {
    const e = event(),
      t = task();
    events.set(e.id, e);
    tasks.set(t.id, t);
    await new Sync(
      env,
      { ...mapping, enabled: false },
      "test-token",
    ).prepareMigration({
      pairs: [{ eventId: e.id, taskId: t.id, authority: "google" }],
      guards: [],
    });
    tasks.set(t.id, { ...t, content: "New user edit" });
    await sync.task(t.id);
    expect((await state())?.reason).toBe("concurrent_changes");
    expect(writes).toHaveLength(0);
  });
  it("adopts existing pairs without provider writes and never resets replayed snapshots", async () => {
    const e = event(),
      t = task();
    events.set(e.id, e);
    tasks.set(t.id, t);
    const migration = new Sync(
      env,
      { ...mapping, enabled: false },
      "test-token",
    );
    const plan = { pairs: [{ eventId: e.id, taskId: t.id }], guards: [] };
    await migration.prepareMigration(plan);
    expect(writes).toHaveLength(0);
    await sync.event(e);
    await sync.task(t.id);
    expect(events.size).toBe(1);
    expect(tasks.size).toBe(1);
    expect(writes).toHaveLength(0);
    await env.DB.prepare("UPDATE links SET state='held',reason='review'").run();
    await migration.prepareMigration(plan);
    expect((await state())?.state).toBe("held");
  });
  it("rejects migration mismatches atomically and excludes guarded sources from both imports", async () => {
    const e = event(),
      t = { ...task(), content: "Different" };
    events.set(e.id, e);
    tasks.set(t.id, t);
    const migration = new Sync(
      env,
      { ...mapping, enabled: false },
      "test-token",
    );
    await expect(
      migration.prepareMigration({
        pairs: [{ eventId: e.id, taskId: t.id }],
        guards: [],
      }),
    ).rejects.toThrow("migration_pair_needs_review");
    expect(await state()).toBeNull();
    await migration.prepareMigration({
      pairs: [],
      guards: [
        { source: "google", id: e.id },
        { source: "todoist", id: t.id },
      ],
    });
    await sync.event(e);
    await sync.task(t.id);
    expect(await state()).toBeNull();
    expect(writes).toHaveLength(0);
  });
  it("keeps review mappings out of reconciliation and rejects active migration targets", async () => {
    const original = env.MAPPINGS_JSON;
    env.MAPPINGS_JSON = JSON.stringify([
      mapping,
      {
        id: "review",
        googleCalendarId: "review-g",
        todoistProjectId: "review-t",
        enabled: false,
      },
    ]);
    try {
      expect(
        (
          await request(
            "/admin/reconcile",
            {},
            { Authorization: "Bearer test-admin" },
          )
        ).status,
      ).toBe(202);
      expect(jobs.every((j) => j.mapping === mapping.id)).toBe(true);
      expect(
        (
          await request(
            "/admin/migration",
            { mapping: mapping.id, plan: { pairs: [], guards: [] } },
            { Authorization: "Bearer test-admin" },
          )
        ).status,
      ).toBe(409);
      const queued = jobs.length;
      await worker.queue(
        {
          messages: [
            {
              body: { kind: "google", mapping: "review" },
              ack: vi.fn(),
              retry: vi.fn(),
            },
          ],
        } as unknown as MessageBatch<Job>,
        env,
        {} as ExecutionContext,
      );
      expect(jobs).toHaveLength(queued);
      expect(writes).toHaveLength(0);
    } finally {
      env.MAPPINGS_JSON = original;
    }
  });
  it("imports a Google event once and suppresses echo notifications", async () => {
    const link = await seed();
    await sync.event(event());
    await sync.task(link.task_id);
    expect(tasks.size).toBe(1);
    expect(writes).toHaveLength(0);
  });
  it("exports a task once with a deterministic Google ID", async () => {
    const t = task();
    tasks.set(t.id, t);
    await sync.task(t.id);
    await sync.task(t.id);
    expect(events.size).toBe(1);
    expect(
      writes.filter((w) => w.url.endsWith("sendUpdates=none")),
    ).toHaveLength(1);
  });
  it("recovers after a remote task create succeeds but the connection is lost", async () => {
    const e = event();
    events.set(e.id, e);
    failures = 1;
    await expect(sync.event(e)).rejects.toThrow();
    await sync.event(e);
    expect(tasks.size).toBe(1);
    expect((await state())?.task_id).toBeTruthy();
    expect(JSON.parse(writes[0].body.commands as string)[0].uuid).toBe(
      JSON.parse(writes[1].body.commands as string)[0].uuid,
    );
  });
  it("propagates edits in each direction without a write loop", async () => {
    const l = await seed();
    events.set(l.event_id, {
      ...events.get(l.event_id)!,
      summary: "Google edit",
    });
    await sync.event(events.get(l.event_id)!);
    expect(tasks.get(l.task_id)?.content).toBe("Google edit");
    tasks.set(l.task_id, { ...tasks.get(l.task_id)!, content: "Todoist edit" });
    await sync.task(l.task_id);
    expect(events.get(l.event_id)?.summary).toBe("Todoist edit");
    writes = [];
    await sync.task(l.task_id);
    expect(writes).toHaveLength(0);
  });
  it("retains completed tasks, decorates events and reverses the marker on reopening", async () => {
    const l = await seed();
    tasks.set(l.task_id, { ...tasks.get(l.task_id)!, checked: true });
    await sync.task(l.task_id);
    expect(events.get(l.event_id)?.summary).toBe("✓ Initial");
    await sync.event(events.get(l.event_id)!);
    expect(tasks.size).toBe(1);
    tasks.set(l.task_id, { ...tasks.get(l.task_id)!, checked: false });
    await sync.task(l.task_id);
    expect(events.get(l.event_id)?.summary).toBe("Initial");
  });
  it("holds conflicting simultaneous changes without overwriting either side", async () => {
    const l = await seed();
    events.set(l.event_id, { ...events.get(l.event_id)!, summary: "Google" });
    tasks.set(l.task_id, { ...tasks.get(l.task_id)!, content: "Todoist" });
    await sync.task(l.task_id);
    expect((await state())?.reason).toBe("concurrent_changes");
    expect(writes).toHaveLength(0);
  });
  it("keeps deletion tombstones and never recreates the counterpart", async () => {
    const l = await seed();
    await sync.task(l.task_id, true);
    await sync.event(event());
    expect((await state())?.state).toBe("held");
    expect(writes).toHaveLength(0);
  });
  it("holds project moves and changes to recurrence", async () => {
    const l = await seed();
    tasks.set(l.task_id, { ...tasks.get(l.task_id)!, project_id: "other" });
    await sync.task(l.task_id);
    expect((await state())?.reason).toBe("project_move");
    expect(writes).toHaveLength(0);
  });
  it("skips new events outside the explicit import horizon", async () => {
    const e = {
      ...event(),
      start: { date: "2020-01-01" },
      end: { date: "2020-01-02" },
    };
    events.set(e.id, e);
    await sync.event(e);
    expect(tasks.size).toBe(0);
  });
  it("saves sync tokens only after the final page", async () => {
    await sync.googlePage({ kind: "google", mapping: mapping.id });
    expect(
      await env.DB.prepare("SELECT sync_token FROM cursors").first(),
    ).toEqual({ sync_token: "next" });
  });
  it("registers a channel for renewal and avoids renewing it twice", async () => {
    await sync.renew();
    await sync.renew();
    expect(writes).toHaveLength(1);
    expect(writes[0].body.address).toBe("https://test.example/webhooks/google");
  });
});
describe("webhook boundary", () => {
  it("reports paused status without credentials", async () => {
    const r = await worker.fetch(
      new Request("https://test.example/health"),
      { ...env, SYNC_ENABLED: "false" },
      {} as ExecutionContext,
    );
    expect(await r.json()).toEqual({ status: "paused" });
  });
  it("rejects unauthenticated admin requests", async () => {
    expect((await request("/admin/reconcile", {})).status).toBe(401);
    expect((await request("/admin/refresh-todoist", {})).status).toBe(401);
    expect((await request("/admin/migration", {})).status).toBe(401);
    expect(jobs).toHaveLength(0);
  });
  it("rejects forged Todoist payloads", async () => {
    expect(
      (await request("/webhooks/todoist", { event_name: "item:added" })).status,
    ).toBe(401);
  });
  it("deduplicates verified Todoist deliveries after durable enqueue", async () => {
    const b = {
      user_id: "test-user",
      event_name: "item:added",
      event_data: { id: "task1", project_id: mapping.todoistProjectId },
    };
    const headers = {
      "X-Todoist-Hmac-SHA256": createHmac("sha256", env.TODOIST_CLIENT_SECRET)
        .update(JSON.stringify(b))
        .digest("base64"),
      "X-Todoist-Delivery-ID": "delivery",
    };
    expect((await request("/webhooks/todoist", b, headers)).status).toBe(200);
    await request("/webhooks/todoist", b, headers);
    expect(jobs).toHaveLength(1);
  });
  it("rejects unknown or mismatched Google channels", async () => {
    expect(
      (
        await request(
          "/webhooks/google",
          {},
          {
            "X-Goog-Channel-Token": "test-channel",
            "X-Goog-Channel-ID": "unknown",
          },
        )
      ).status,
    ).toBe(403);
  });
  it("accepts the initial Google sync race before resource ID is saved", async () => {
    await env.DB.prepare(
      "INSERT INTO channels(id,mapping,expires) VALUES(?,?,?)",
    )
      .bind("channel", mapping.id, Date.now() + 10000)
      .run();
    expect(
      (
        await request(
          "/webhooks/google",
          {},
          {
            "X-Goog-Channel-Token": "test-channel",
            "X-Goog-Channel-ID": "channel",
            "X-Goog-Resource-ID": "resource",
          },
        )
      ).status,
    ).toBe(200);
    expect(jobs).toHaveLength(1);
  });
});
describe("recovery and scope", () => {
  it("queues Google page continuations without advancing the checkpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ items: [], nextPageToken: "page2" })),
    );
    await sync.googlePage({
      kind: "google",
      mapping: mapping.id,
      token: "old",
    });
    expect(jobs).toEqual([
      { kind: "google", mapping: mapping.id, page: "page2", token: "old" },
    ]);
    expect(await env.DB.prepare("SELECT * FROM cursors").first()).toBeNull();
  });
  it("resets expired Google tokens without erasing links", async () => {
    await seed();
    await env.DB.prepare("INSERT INTO cursors(mapping,sync_token) VALUES(?,?)")
      .bind(mapping.id, "expired")
      .run();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({}, 410)),
    );
    await sync.googlePage({ kind: "google", mapping: mapping.id });
    expect(await env.DB.prepare("SELECT * FROM cursors").first()).toBeNull();
    expect(await state()).toBeTruthy();
    expect(jobs).toEqual([{ kind: "google", mapping: mapping.id }]);
  });
  it("recovers an interrupted Google create and applies subsequent task edits", async () => {
    const t = task();
    tasks.set(t.id, t);
    let dropped = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit = {}) => {
        const result = await upstream(input, init);
        if (
          !dropped &&
          init.method === "POST" &&
          String(input).includes("/events?")
        ) {
          dropped = true;
          throw new TypeError("lost create response");
        }
        return result;
      }),
    );
    await expect(sync.task(t.id)).rejects.toThrow();
    tasks.set(t.id, { ...t, content: "Edited after uncertain create" });
    await sync.task(t.id);
    expect(events.size).toBe(1);
    expect([...events.values()][0].summary).toBe(
      "Edited after uncertain create",
    );
  });
  it("preserves multi-day all-day spans across task title edits", async () => {
    const e = {
      ...event(),
      start: { date: "2026-11-03" },
      end: { date: "2026-11-06" },
    };
    events.set(e.id, e);
    await sync.event(e);
    const l = (await state())!;
    tasks.set(l.task_id, { ...tasks.get(l.task_id)!, content: "New title" });
    await sync.task(l.task_id);
    expect(events.get(l.event_id)?.end).toEqual({ date: "2026-11-06" });
  });
  it("preserves Google duration when Todoist cannot represent it, including reschedules", async () => {
    const e = event();
    events.set(e.id, e);
    await sync.event(e);
    const l = (await state())!;
    const t = { ...tasks.get(l.task_id)!, duration: undefined };
    tasks.set(l.task_id, t);
    await sync.task(l.task_id);
    tasks.set(l.task_id, { ...t, content: "Renamed" });
    await sync.task(l.task_id);
    expect(events.get(e.id)?.end?.dateTime).toBe("2026-11-03T11:00:00.000Z");
    tasks.set(l.task_id, {
      ...t,
      content: "Renamed",
      due: { date: "2026-11-04T12:00:00Z" },
    });
    await sync.task(l.task_id);
    expect(events.get(e.id)?.end?.dateTime).toBe("2026-11-04T13:00:00.000Z");
  });
  it("ignores correctly signed events belonging to an unmapped project", async () => {
    const b = {
      user_id: "test-user",
      event_name: "item:added",
      event_data: { id: "task1", project_id: "other" },
    };
    const headers = {
      "X-Todoist-Hmac-SHA256": createHmac("sha256", env.TODOIST_CLIENT_SECRET)
        .update(JSON.stringify(b))
        .digest("base64"),
    };
    expect((await request("/webhooks/todoist", b, headers)).status).toBe(200);
    expect(jobs).toHaveLength(0);
  });
  it("rejects a valid signature for a different Todoist account", async () => {
    const b = {
      user_id: "another-user",
      event_name: "item:added",
      event_data: { id: "task1", project_id: mapping.todoistProjectId },
    };
    const headers = {
      "X-Todoist-Hmac-SHA256": createHmac("sha256", env.TODOIST_CLIENT_SECRET)
        .update(JSON.stringify(b))
        .digest("base64"),
    };
    expect((await request("/webhooks/todoist", b, headers)).status).toBe(403);
    expect(jobs).toHaveLength(0);
  });
  it("rejects oversized webhook requests before enqueueing", async () => {
    const r = await worker.fetch(
      new Request("https://test.example/webhooks/todoist", {
        method: "POST",
        body: "x".repeat(262145),
      }),
      env,
      {} as ExecutionContext,
    );
    expect(r.status).toBe(413);
    expect(jobs).toHaveLength(0);
  });
});
it("does not modify Google when a task is ticked or unticked in retain mode", async () => {
  const l = await seed();
  const retain = new Sync(
    { ...env, COMPLETION_MODE: "retain" },
    mapping,
    "test-token",
  );
  const original = JSON.stringify(events.get(l.event_id));
  tasks.set(l.task_id, { ...tasks.get(l.task_id)!, checked: true });
  await retain.task(l.task_id);
  tasks.set(l.task_id, { ...tasks.get(l.task_id)!, checked: false });
  await retain.task(l.task_id);
  expect(JSON.stringify(events.get(l.event_id))).toBe(original);
  expect(writes).toHaveLength(0);
});
describe("queue and maintenance", () => {
  it("retries rate-limited work using the provider backoff", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        String(input).includes("oauth2.googleapis.com")
          ? response({ access_token: "google-token" })
          : new Response("{}", {
              status: 429,
              headers: { "Retry-After": "120" },
            }),
      ),
    );
    const msg = {
      id: "test-message",
      body: { kind: "task", mapping: mapping.id, taskId: "task1" },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await worker.queue(
      { messages: [msg] } as MessageBatch<Job>,
      { ...env, TODOIST_TOKEN_MODE: "legacy" },
      {} as ExecutionContext,
    );
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    warn.mockRestore();
  });
  it("leaves work retryable while writes are paused", async () => {
    const msg = {
      id: "test-message",
      body: { kind: "task", mapping: mapping.id, taskId: "task1" },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await worker.queue(
      { messages: [msg] } as MessageBatch<Job>,
      { ...env, SYNC_ENABLED: "false" },
      {} as ExecutionContext,
    );
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
    expect(writes).toHaveLength(0);
  });
  it("runs lightweight maintenance every fifteen minutes and full recovery every six hours", async () => {
    await worker.scheduled(
      {
        scheduledTime: Date.parse("2026-11-01T01:15:00Z"),
      } as ScheduledController,
      env,
      {} as ExecutionContext,
    );
    expect(jobs.map((j) => j.kind)).toEqual(["renew", "google"]);
    jobs = [];
    await worker.scheduled(
      {
        scheduledTime: Date.parse("2026-11-01T06:00:00Z"),
      } as ScheduledController,
      env,
      {} as ExecutionContext,
    );
    expect(jobs.map((j) => j.kind)).toEqual([
      "renew",
      "google",
      "window",
      "tasks",
      "links",
    ]);
  });
});
describe("native recurring pairs", () => {
  it("stages extended recurrence until it is enabled for the mapping", async () => {
    const disabled = new Sync(
      env,
      { ...mapping, extendedRecurrence: false },
      "test-token",
    );
    const e = {
      ...event(),
      start: { date: "2026-11-15" },
      end: { date: "2026-11-16" },
      recurrence: ["RRULE:FREQ=MONTHLY"],
    };
    events.set(e.id, e);
    await disabled.event(e);
    const t = {
      ...task(),
      due: { date: "2026-11-15", string: "every year", is_recurring: true },
    };
    tasks.set(t.id, t);
    await disabled.task(t.id);
    expect(await state()).toBeNull();
    expect(writes).toHaveLength(0);
    const rows = await env.DB.prepare("SELECT reason FROM issues").all<{
      reason: string;
    }>();
    expect(rows.results).toHaveLength(2);
    expect(
      rows.results.every((r) => r.reason === "recurrence_rollout_pending"),
    ).toBe(true);
  });
  it("adopts matching recurring pairs without provider writes and rejects occurrence mismatches", async () => {
    const e = {
      ...event(),
      start: { dateTime: "2026-11-15T10:00:00Z", timeZone: "Europe/London" },
      end: { dateTime: "2026-11-15T11:00:00Z", timeZone: "Europe/London" },
      recurrence: ["RRULE:FREQ=YEARLY"],
    };
    const t = {
      ...task(),
      due: {
        date: "2026-11-15T10:00:00Z",
        string: "every 15 November at 10:00",
        is_recurring: true,
      },
    };
    events.set(e.id, e);
    tasks.set(t.id, t);
    const migration = new Sync(
      env,
      { ...mapping, enabled: false },
      "test-token",
    );
    await migration.prepareMigration({
      pairs: [{ eventId: e.id, taskId: t.id }],
      guards: [],
    });
    expect(writes).toHaveLength(0);
    expect((await state())?.task_id).toBe(t.id);
    tasks.set(t.id, { ...t, due: { ...t.due, date: "2027-11-15T10:00:00Z" } });
    await expect(
      migration.prepareMigration({
        pairs: [{ eventId: e.id, taskId: t.id }],
        guards: [],
      }),
    ).rejects.toThrow("migration_occurrence_needs_review");
  });
  it.each(["MONTHLY", "YEARLY"])(
    "imports and advances a native %s task without moving Google history",
    async (frequency) => {
      const e = {
        ...event(),
        start: { dateTime: "2026-11-15T10:00:00Z", timeZone: "Europe/London" },
        end: { dateTime: "2026-11-15T11:00:00Z", timeZone: "Europe/London" },
        recurrence: [`RRULE:FREQ=${frequency}`],
      };
      events.set(e.id, e);
      await sync.event(e);
      const l = (await state())!;
      const t = tasks.get(l.task_id)!;
      expect(t.due?.string).toBe(
        `every ${frequency === "MONTHLY" ? "month" : "year"} at 10:00`,
      );
      const next =
        frequency === "MONTHLY"
          ? "2026-12-15T10:00:00Z"
          : "2027-11-15T10:00:00Z";
      tasks.set(t.id, { ...t, due: { ...t.due!, date: next } });
      writes = [];
      await sync.task(t.id);
      await sync.event(e);
      expect(events.get(e.id)).toEqual(e);
      expect(writes).toHaveLength(0);
      expect(tasks.size).toBe(1);
      expect((await state())?.state).toBe("active");
    },
  );
  const weeklyEvent = (): Event => ({
    ...event(),
    start: { dateTime: "2026-11-03T10:00:00Z", timeZone: "Europe/London" },
    end: { dateTime: "2026-11-03T11:00:00Z", timeZone: "Europe/London" },
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
  });
  const weeklyTask = (): Task => ({
    ...task(),
    due: {
      date: "2026-11-03T10:00:00Z",
      timezone: "Europe/London",
      is_recurring: true,
      string: "every week at 10:00",
    },
  });
  it("imports one native Google series into one native Todoist task", async () => {
    const e = weeklyEvent();
    events.set(e.id, e);
    await sync.event(e);
    await sync.event(e);
    expect(tasks.size).toBe(1);
    expect([...tasks.values()][0].due?.is_recurring).toBe(true);
    expect([...tasks.values()][0].due?.string).toBe("every week at 10:00");
    expect((await state())?.state).toBe("active");
  });
  it("exports one native Todoist task as one Google RRULE series", async () => {
    const t = weeklyTask();
    tasks.set(t.id, t);
    await sync.task(t.id);
    expect(events.size).toBe(1);
    expect([...events.values()][0].recurrence).toEqual([
      "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU",
    ]);
    expect((await state())?.state).toBe("active");
  });
  it("lets Todoist advance without changing Google or creating another series", async () => {
    const t = weeklyTask();
    tasks.set(t.id, t);
    await sync.task(t.id);
    const original = JSON.stringify([...events.values()][0]);
    writes = [];
    tasks.set(t.id, { ...t, due: { ...t.due!, date: "2026-11-10T10:00:00Z" } });
    await sync.task(t.id);
    await sync.event([...events.values()][0]);
    expect(JSON.stringify([...events.values()][0])).toBe(original);
    expect(writes).toHaveLength(0);
    expect(events.size).toBe(1);
    expect((await state())?.state).toBe("active");
  });
  it("syncs recurring titles both ways while preserving the due rule", async () => {
    const t = weeklyTask();
    tasks.set(t.id, t);
    await sync.task(t.id);
    const l = (await state())!;
    events.set(l.event_id, {
      ...events.get(l.event_id)!,
      summary: "Google title",
    });
    await sync.event(events.get(l.event_id)!);
    expect(tasks.get(t.id)?.content).toBe("Google title");
    expect(tasks.get(t.id)?.due?.string).toBe("every week at 10:00");
    tasks.set(t.id, { ...tasks.get(t.id)!, content: "Todoist title" });
    await sync.task(t.id);
    expect(events.get(l.event_id)?.summary).toBe("Todoist title");
  });
  it("holds a Google instance exception instead of importing a duplicate task", async () => {
    const e = weeklyEvent();
    events.set(e.id, e);
    await sync.event(e);
    writes = [];
    await sync.event({
      ...e,
      id: "exception",
      recurrence: undefined,
      recurringEventId: e.id,
    });
    expect((await state())?.reason).toBe("recurring_instance_exception");
    expect(tasks.size).toBe(1);
    expect(writes).toHaveLength(0);
  });
  it("holds recurring schedule edits instead of shifting past occurrences", async () => {
    const t = weeklyTask();
    tasks.set(t.id, t);
    await sync.task(t.id);
    writes = [];
    tasks.set(t.id, {
      ...t,
      due: {
        ...t.due!,
        date: "2026-11-03T12:00:00Z",
        string: "every week at 12:00",
      },
    });
    await sync.task(t.id);
    expect((await state())?.reason).toBe("recurring_schedule_edit");
    expect(writes).toHaveLength(0);
  });
  it("carries a Google clock change onto the next task occurrence without rewriting Google or rewinding completion", async () => {
    const t = weeklyTask();
    tasks.set(t.id, t);
    await sync.task(t.id);
    const l = (await state())!;
    tasks.set(t.id, { ...t, due: { ...t.due!, date: "2026-11-10T10:00:00Z" } });
    const g = {
      ...events.get(l.event_id)!,
      start: { dateTime: "2026-11-03T15:00:00Z", timeZone: "Europe/London" },
      end: { dateTime: "2026-11-03T16:00:00Z", timeZone: "Europe/London" },
    };
    events.set(g.id, g);
    writes = [];
    await sync.event(g);
    expect(tasks.get(t.id)?.due).toMatchObject({
      date: "2026-11-10T15:00:00.000Z",
      is_recurring: true,
      string: "every week at 15:00",
    });
    expect(events.get(g.id)).toEqual(g);
    expect(
      writes.every((w) => new URL(w.url).hostname === "api.todoist.com"),
    ).toBe(true);
    expect((await state())?.state).toBe("active");
    writes = [];
    await sync.event(g);
    await sync.task(t.id);
    expect(writes).toHaveLength(0);
  });
  it("keeps Google anchor-date changes held instead of treating them as clock changes", async () => {
    const t = weeklyTask();
    tasks.set(t.id, t);
    await sync.task(t.id);
    const l = (await state())!;
    const g = {
      ...events.get(l.event_id)!,
      start: { dateTime: "2026-11-10T15:00:00Z", timeZone: "Europe/London" },
      end: { dateTime: "2026-11-10T16:00:00Z", timeZone: "Europe/London" },
    };
    events.set(g.id, g);
    writes = [];
    await sync.event(g);
    expect((await state())?.reason).toBe("recurring_schedule_edit");
    expect(writes).toHaveLength(0);
  });
});

describe("rolling discovery", () => {
  it("discovers an unchanged event entering the window without replacing the incremental token or duplicating it", async () => {
    const rolling = new Sync(
      { ...env, HORIZON_DAYS: "90" },
      mapping,
      "test-token",
    );
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-11-01T12:00:00Z"));
    const e = {
      ...event("future"),
      start: { date: "2027-02-02" },
      end: { date: "2027-02-03" },
    };
    events.set(e.id, e);
    await rolling.event(e);
    expect(tasks.size).toBe(0);
    await env.DB.prepare("INSERT INTO cursors(mapping,sync_token) VALUES(?,?)")
      .bind(mapping.id, "preserve-me")
      .run();
    now.mockReturnValue(Date.parse("2026-11-08T12:00:00Z"));
    await rolling.googlePage({ kind: "window", mapping: mapping.id });
    expect(tasks.size).toBe(1);
    expect(
      await env.DB.prepare("SELECT sync_token FROM cursors").first(),
    ).toEqual({ sync_token: "preserve-me" });
    writes = [];
    await rolling.googlePage({ kind: "window", mapping: mapping.id });
    expect(tasks.size).toBe(1);
    expect(writes).toHaveLength(0);
    await rolling.task((await state())!.task_id, true);
    await rolling.googlePage({ kind: "window", mapping: mapping.id });
    expect((await state())?.state).toBe("held");
    expect(tasks.size).toBe(1);
  });
  it("pins discovery bounds across midnight and does not combine them with a sync token", async () => {
    const rolling = new Sync(
      { ...env, HORIZON_DAYS: "90" },
      mapping,
      "test-token",
    );
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-11-08T23:59:00Z"));
    const urls: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input);
        urls.push(url);
        return response(
          url.searchParams.has("pageToken")
            ? { items: [], nextSyncToken: "ignored" }
            : { items: [], nextPageToken: "second" },
        );
      }),
    );
    await rolling.googlePage({ kind: "window", mapping: mapping.id });
    const next = jobs[0];
    expect(next.kind).toBe("window");
    now.mockReturnValue(Date.parse("2026-11-09T00:01:00Z"));
    if (next.kind !== "window") throw new Error("wrong continuation");
    await rolling.googlePage(next);
    expect(urls[0].searchParams.get("timeMin")).toBe(
      urls[1].searchParams.get("timeMin"),
    );
    expect(urls[0].searchParams.get("timeMax")).toBe(
      urls[1].searchParams.get("timeMax"),
    );
    expect(urls.every((u) => !u.searchParams.has("syncToken"))).toBe(true);
    expect(await env.DB.prepare("SELECT * FROM cursors").first()).toBeNull();
  });
  it("admits new tasks within the advancing window and preserves linked edits after they fall into the past", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-08T12:00:00Z"));
    const rolling = new Sync(
      { ...env, HORIZON_DAYS: "90" },
      mapping,
      "test-token",
    );
    const t = { ...task(), due: { date: "2027-02-05" } };
    tasks.set(t.id, t);
    await rolling.task(t.id);
    expect(events.size).toBe(1);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2027-03-01T12:00:00Z"));
    tasks.set(t.id, { ...t, content: "Historical edit" });
    await rolling.task(t.id);
    expect([...events.values()][0].summary).toBe("Historical edit");
    const outside = { ...task("outside"), due: { date: "2027-05-30" } };
    tasks.set(outside.id, outside);
    await rolling.task(outside.id);
    expect(events.size).toBe(1);
  });
});

it("imports a historical recurring anchor using its next in-window occurrence", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-08T12:00:00Z"));
  const rolling = new Sync(
    { ...env, HORIZON_DAYS: "90" },
    mapping,
    "test-token",
  );
  const e = {
    ...event("historical-yearly"),
    recurrence: ["RRULE:FREQ=YEARLY"],
    start: { dateTime: "2025-02-02T11:00:00Z", timeZone: "Europe/London" },
    end: { dateTime: "2025-02-02T11:30:00Z", timeZone: "Europe/London" },
  };
  events.set(e.id, e);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const u = new URL(input);
      if (u.pathname.endsWith("/instances")) {
        expect(u.searchParams.get("timeMin")).toBe("2026-11-08T00:00:00.000Z");
        expect(u.searchParams.get("timeMax")).toBe("2027-02-06T00:00:00.000Z");
        return response({
          items: [
            {
              ...e,
              recurrence: undefined,
              recurringEventId: e.id,
              start: { dateTime: "2027-02-02T11:00:00Z" },
              end: { dateTime: "2027-02-02T11:30:00Z" },
            },
          ],
        });
      }
      return upstream(input, init);
    }),
  );
  await rolling.googlePage({ kind: "window", mapping: mapping.id });
  expect(tasks.size).toBe(1);
  expect([...tasks.values()][0].due?.date).toContain("2027-02-02");
  expect(events.get(e.id)).toEqual(e);
});

describe("private operational status", () => {
  const job: Job = { kind: "google", mapping: mapping.id };
  const auth = { Authorization: "Bearer test-admin" };
  const run = async (body: Job, id: string, attempts = 1, settings = env) => {
    const msg = { id, body, attempts, ack: vi.fn(), retry: vi.fn() };
    await worker.queue(
      { messages: [msg] } as MessageBatch<Job>,
      { ...settings, TODOIST_TOKEN_MODE: "legacy" },
      {} as ExecutionContext,
    );
    return msg;
  };
  it("requires header authentication, ignores URL tokens and never caches status", async () => {
    for (const path of ["/admin/status", "/admin/status?token=test-admin"]) {
      const r = await request(path);
      expect(r.status).toBe(401);
      expect(r.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(
      (
        await request("/admin/status", undefined, {
          Authorization: "Bearer wrong",
        })
      ).status,
    ).toBe(401);
    expect((await request("/admin/status", {}, auth)).status).toBe(405);
  });
  it("reports missing recovery rather than implying an enabled switch is healthy", async () => {
    const r = await request("/admin/status", undefined, auth);
    expect(r.status).toBe(200);
    expect(r.headers.get("Vary")).toBe("Authorization");
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    const status = (await r.json()) as Awaited<ReturnType<typeof syncStatus>>;
    expect(status.status).toBe("attention");
    expect(status.mappings[0].alerts).toContain("recovery_missing_or_stale");
    expect(status.mappings[0].alerts).toContain(
      "google_watch_missing_or_expired",
    );
    expect(writes).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("returns only aggregates, never snapshots, provider IDs or exception messages", async () => {
    await seed();
    await env.DB.prepare(
      "INSERT INTO issues(mapping,source,source_id,reason,updated_at) VALUES(?,?,?,?,?)",
    )
      .bind(
        mapping.id,
        "google",
        "private-event-id",
        "unsupported_recurrence",
        Date.now(),
      )
      .run();
    await recordFailure(
      env,
      "private-message-id",
      job,
      new Error("SECRET: title and token"),
      1,
      30,
    );
    const r = await request("/admin/status", undefined, auth);
    const text = await r.text();
    for (const secret of [
      "SECRET",
      "Initial",
      "test-calendar",
      "test-project",
      "private-event-id",
      "private-message-id",
      "test-admin",
      "test-token",
      "google_snapshot",
      "task_id",
      "event_id",
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain("sync_failed");
    expect(text).toContain("unsupported_recurrence");
  });
  it("retains failed jobs across unrelated successes and clears only the successful retry", async () => {
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-11-08T12:00:00Z"));
    await recordFailure(env, "failure", job, new ApiError(429), 1, 120);
    now.mockReturnValue(Date.parse("2026-11-08T12:02:00Z"));
    await recordFailure(env, "failure", job, new ApiError(503), 2, 60);
    await recordSuccess(env, "unrelated", job, true);
    let failure = (await syncStatus(env)).mappings[0].failures[0];
    expect(failure.count).toBe(1);
    expect(failure.code).toBe("upstream_503");
    expect(failure.maxAttempts).toBe(2);
    expect(failure.firstFailed).toBe("2026-11-08T12:00:00.000Z");
    expect(failure.lastFailed).toBe("2026-11-08T12:02:00.000Z");
    await recordSuccess(env, "failure", job, true);
    expect((await syncStatus(env)).mappings[0].failures).toEqual([]);
  });
  it("tracks actual queue failures and successful retries before acknowledgment", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({}, 503)),
    );
    const failed = await run(job, "retry-message");
    expect(failed.ack).not.toHaveBeenCalled();
    expect(failed.retry).toHaveBeenCalled();
    expect((await syncStatus(env)).mappings[0].failures[0].code).toBe(
      "upstream_503",
    );
    vi.stubGlobal("fetch", vi.fn(upstream));
    const retried = await run(job, "retry-message", 2);
    expect(retried.ack).toHaveBeenCalled();
    expect(retried.retry).not.toHaveBeenCalled();
    expect((await syncStatus(env)).mappings[0].failures).toEqual([]);
    warn.mockRestore();
  });
  it("records final-page recovery completion rather than counting intermediate pages as completed scans", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        String(input).includes("oauth2.googleapis.com")
          ? response({ access_token: "test" })
          : response({ items: [], nextPageToken: "second" }),
      ),
    );
    expect((await run(job, "first-page")).ack).toHaveBeenCalled();
    let recovery = (await syncStatus(env)).mappings[0].recovery[0];
    expect(recovery.lastSuccessfulPage).not.toBeNull();
    expect(recovery.lastCompletedScan).toBeNull();
    const next = jobs[0];
    vi.stubGlobal("fetch", vi.fn(upstream));
    expect((await run(next, "second-page")).ack).toHaveBeenCalled();
    recovery = (await syncStatus(env)).mappings[0].recovery[0];
    expect(recovery.lastCompletedScan).not.toBeNull();
    expect(recovery.stale).toBe(false);
  });
  it("flags stale scans and expired watches even after unrelated recent work", async () => {
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-11-08T12:00:00Z"));
    await env.DB.prepare(
      "INSERT INTO channels(id,mapping,resource_id,expires) VALUES(?,?,?,?)",
    )
      .bind("watch", mapping.id, "registered", Date.now() + 3600000)
      .run();
    for (const kind of ["google", "window", "tasks", "links"] as const)
      await recordSuccess(env, kind, { kind, mapping: mapping.id }, true);
    expect((await syncStatus(env)).status).toBe("ok");
    now.mockReturnValue(Date.parse("2026-11-08T13:00:00Z"));
    await recordSuccess(
      env,
      "text-edit",
      { kind: "task", mapping: mapping.id, taskId: "task" },
      true,
    );
    const status = await syncStatus(env);
    expect(status.mappings[0].alerts).toEqual([
      "google_watch_missing_or_expired",
      "recovery_missing_or_stale",
    ]);
    expect(status.mappings[0].recovery[0].stale).toBe(true);
    expect(status.mappings[0].recovery[1].stale).toBe(false);
  });
  it("retains exhausted failures for review without claiming confirmed dead-letter delivery", async () => {
    const config = JSON.parse(
      readFileSync("wrangler.jsonc", "utf8").replace(/,\s*([}\]])/g, "$1"),
    );
    expect(config.queues.consumers[0].max_retries).toBe(QUEUE_MAX_RETRIES);
    await recordFailure(
      env,
      "exhausted",
      job,
      new ApiError(401),
      QUEUE_MAX_RETRIES + 1,
      30,
    );
    const status = await syncStatus(env);
    expect(status.mappings[0].failures[0].retryLimitReached).toBe(1);
    expect(status.mappings[0].failures[0].nextRetryAt).toBeNull();
    expect(status.mappings[0].alerts).toContain("unresolved_job_failures");
  });
  it("reports paused state read-only and removes failures after the retention period", async () => {
    await recordFailure(env, "old", job, new Error("no details"), 1, 30);
    await env.DB.prepare("UPDATE job_failures SET last_failed=?")
      .bind(Date.now() - 31 * 86400000)
      .run();
    const paused = { ...env, SYNC_ENABLED: "false" };
    const r = await worker.fetch(
      new Request("https://test.example/admin/status", { headers: auth }),
      paused,
      {} as ExecutionContext,
    );
    expect(((await r.json()) as { status: string }).status).toBe("paused");
    expect((await syncStatus(env)).mappings[0].failures).toEqual([]);
    await worker.scheduled(
      {
        scheduledTime: Date.parse("2026-11-08T12:15:00Z"),
      } as ScheduledController,
      env,
      {} as ExecutionContext,
    );
    expect(
      await env.DB.prepare("SELECT * FROM job_failures").first(),
    ).toBeNull();
  });
});

it("keeps retryable and exhausted failures visible together", async () => {
  const job: Job = { kind: "google", mapping: mapping.id };
  await recordFailure(env, "retrying", job, new ApiError(503), 1, 30);
  await recordFailure(
    env,
    "limit",
    job,
    new ApiError(503),
    QUEUE_MAX_RETRIES + 1,
    30,
  );
  const failure = (await syncStatus(env)).mappings[0].failures[0];
  expect(failure.count).toBe(2);
  expect(failure.retryLimitReached).toBe(1);
  expect(failure.nextRetryAt).not.toBeNull();
});
it("keeps status readable when all mappings are disabled and redacts database errors", async () => {
  const disabled = {
    ...env,
    MAPPINGS_JSON: JSON.stringify([{ ...mapping, enabled: false }]),
  };
  expect((await syncStatus(disabled)).status).toBe("paused");
  const broken = {
    ...env,
    DB: {
      batch: async () => {
        throw new Error("private secret database error");
      },
    },
  } as Env;
  const r = await worker.fetch(
    new Request("https://test.example/admin/status", {
      headers: { Authorization: "Bearer test-admin" },
    }),
    broken,
    {} as ExecutionContext,
  );
  expect(r.status).toBe(500);
  expect(r.headers.get("Cache-Control")).toBe("no-store");
  expect(await r.text()).not.toContain("private secret");
});

describe("protected held-pair review", () => {
  const auth = { Authorization: "Bearer test-admin" };
  async function held(
    id: string,
    mappingId = mapping.id,
    google: string | null = JSON.stringify({
      title: "Saved title",
      start: "2026-11-09",
      end: "2026-11-10",
      allDay: true,
      description: "PRIVATE-DESCRIPTION",
      attendees: ["PRIVATE-ATTENDEE"],
    }),
    todoist: string | null = null,
  ) {
    await env.DB.prepare(
      "INSERT INTO links(mapping,event_id,task_id,request_id,state,reason,updated_at,google_snapshot,todoist_snapshot,initial_payload) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        mappingId,
        id,
        null,
        crypto.randomUUID(),
        "held",
        "calendar_deleted",
        Date.now(),
        google,
        todoist,
        JSON.stringify({ secret: "PRIVATE-PAYLOAD" }),
      )
      .run();
  }
  it("rejects unauthenticated or query-token access and non-read methods without caching", async () => {
    for (const path of ["/admin/review", "/admin/review?token=test-admin"]) {
      const r = await request(path);
      expect(r.status).toBe(401);
      expect(r.headers.get("Cache-Control")).toBe("no-store");
    }
    expect((await request("/admin/review", {}, auth)).status).toBe(405);
  });
  it("returns labelled saved values while omitting recovery payloads and unneeded private fields", async () => {
    await held("private-source-id");
    const r = await request("/admin/review", undefined, auth);
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.headers.get("Vary")).toBe("Authorization");
    const body = (await r.json()) as {
      notice: string;
      items: { lastSaved: { google: { title: string; start: string } } }[];
    };
    expect(body.notice).toContain("not current provider values");
    expect(body.items[0].lastSaved.google.title).toBe("Saved title");
    expect(body.items[0].lastSaved.google.start).toBe("2026-11-09");
    for (const secret of [
      "PRIVATE-DESCRIPTION",
      "PRIVATE-ATTENDEE",
      "PRIVATE-PAYLOAD",
      "private-source-id",
      "test-admin",
      "google_snapshot",
    ])
      expect(JSON.stringify(body)).not.toContain(secret);
  });
  it("paginates deterministically without exposing unmapped or active links", async () => {
    for (let i = 0; i < 26; i++)
      await held(`review-${String(i).padStart(2, "0")}`);
    await held("hidden", "unmapped");
    await held("active");
    await env.DB.prepare(
      "UPDATE links SET state='active' WHERE event_id='active'",
    ).run();
    const first = (await (
      await request("/admin/review", undefined, auth)
    ).json()) as { items: { ref: string }[]; nextCursor: string };
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).toBeTruthy();
    const second = (await (
      await request(
        `/admin/review?cursor=${encodeURIComponent(first.nextCursor)}`,
        undefined,
        auth,
      )
    ).json()) as { items: { ref: string }[]; nextCursor: null };
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((r) => r.ref)).size,
    ).toBe(26);
  });
  it("rejects malformed cursor values before querying records", async () => {
    for (const cursor of [
      "",
      "!",
      Buffer.from(JSON.stringify([1, 2])).toString("base64url"),
      "a".repeat(2049),
    ]) {
      const r = await request(
        `/admin/review?cursor=${encodeURIComponent(cursor)}`,
        undefined,
        auth,
      );
      expect(r.status).toBe(400);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not fetch providers, enqueue jobs, release holds or update snapshots", async () => {
    await held("unchanged");
    const before = await env.DB.prepare("SELECT * FROM links").first();
    await request("/admin/review", undefined, auth);
    expect(await env.DB.prepare("SELECT * FROM links").first()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });
  it("works while paused or mapping-disabled and handles absent or malformed snapshots", async () => {
    await held("partial", mapping.id, "{broken", null);
    const r = await worker.fetch(
      new Request("https://test.example/admin/review", { headers: auth }),
      {
        ...env,
        SYNC_ENABLED: "false",
        MAPPINGS_JSON: JSON.stringify([{ ...mapping, enabled: false }]),
      },
      {} as ExecutionContext,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      items: { lastSaved: { google: null; todoist: null } }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].lastSaved).toEqual({ google: null, todoist: null });
  });
});

describe("approved Google deletion propagation", () => {
  const enabled = () =>
    new Sync(
      env,
      { ...mapping, deleteTasksOnGoogleDeletion: true },
      "test-token",
    );
  async function cancel(completed = false) {
    const l = await seed();
    tasks.set(l.task_id, { ...tasks.get(l.task_id)!, checked: completed });
    events.set(l.event_id, { ...events.get(l.event_id)!, status: "cancelled" });
    return l;
  }
  for (const completed of [false, true])
    it(`deletes a confirmed cancelled event's ${completed ? "completed" : "incomplete"} task and keeps a tombstone`, async () => {
      const l = await cancel(completed);
      await enabled().event(events.get(l.event_id)!);
      expect(tasks.has(l.task_id)).toBe(false);
      expect((await state())?.state).toBe("deleted");
      expect(
        writes.filter(
          (w) => w.url.startsWith("https://api.todoist.com/") && w.headers,
        ),
      ).toHaveLength(1);
      expect(writes.some((w) => w.url.includes("googleapis.com"))).toBe(false);
      writes = [];
      await enabled().event({ ...event(l.event_id), status: "confirmed" });
      await enabled().task(l.task_id, true);
      await enabled().event({
        ...event("exception"),
        recurringEventId: l.event_id,
        status: "cancelled",
      });
      expect(tasks.size).toBe(0);
      expect(writes).toHaveLength(0);
      expect(
        (await env.DB.prepare("SELECT * FROM issues").all()).results,
      ).toHaveLength(0);
    });
  it("keeps the previous hold behaviour until the policy is enabled", async () => {
    const l = await cancel();
    await sync.event(events.get(l.event_id)!);
    expect((await state())?.reason).toBe("calendar_deleted");
    expect(tasks.has(l.task_id)).toBe(true);
    await enabled().linkedPage();
    expect(tasks.has(l.task_id)).toBe(false);
    expect((await state())?.state).toBe("deleted");
  });
  it("does not treat stale cancellation notifications or access failures as confirmed deletions", async () => {
    const l = await seed();
    await enabled().event({ ...event(l.event_id), status: "cancelled" });
    expect((await state())?.reason).toBe("calendar_deletion_unconfirmed");
    expect(tasks.has(l.task_id)).toBe(true);
    expect(writes).toHaveLength(0);
  });
  it("does not delete a task that has moved to another project", async () => {
    const l = await cancel();
    tasks.set(l.task_id, { ...tasks.get(l.task_id)!, project_id: "other" });
    await enabled().event(events.get(l.event_id)!);
    expect((await state())?.reason).toBe("project_move");
    expect(tasks.has(l.task_id)).toBe(true);
    expect(writes).toHaveLength(0);
  });
  it("recovers a DELETE whose response was lost without recreating either side", async () => {
    const l = await cancel();
    let lost = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit = {}) => {
        const result = await upstream(input, init);
        if (init.method === "DELETE" && lost) {
          lost = false;
          throw new TypeError("connection lost after deletion");
        }
        return result;
      }),
    );
    await expect(enabled().event(events.get(l.event_id)!)).rejects.toThrow();
    expect((await state())?.state).toBe("deleting");
    expect((await syncStatus(env)).mappings[0].alerts).toContain(
      "task_deletion_pending",
    );
    await enabled().task(l.task_id);
    expect((await state())?.state).toBe("deleted");
    expect(tasks.has(l.task_id)).toBe(false);
    expect(
      writes.filter((w) => w.url.includes("api.todoist.com")),
    ).toHaveLength(1);
  });
  it("never deletes the rolling task for a single cancelled recurring occurrence", async () => {
    const l = await seed();
    await enabled().event({
      ...event("instance"),
      status: "cancelled",
      recurringEventId: l.event_id,
    });
    expect((await state())?.reason).toBe("recurring_instance_exception");
    expect(tasks.has(l.task_id)).toBe(true);
    expect(writes).toHaveLength(0);
  });
  it("retains holds for ambiguous missing Google events and retries authorization failures", async () => {
    const l = await cancel();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({}, 404)),
    );
    await enabled().event(events.get(l.event_id)!);
    expect((await state())?.reason).toBe("calendar_deletion_unconfirmed");
    expect(tasks.has(l.task_id)).toBe(true);
    await env.DB.prepare("UPDATE links SET state='active',reason=NULL").run();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({}, 403)),
    );
    await expect(
      enabled().event(events.get(l.event_id)!),
    ).rejects.toBeInstanceOf(ApiError);
    expect(tasks.has(l.task_id)).toBe(true);
  });
  it("handles calendar cancellation discovered during linked-task recovery", async () => {
    const l = await cancel(true);
    await enabled().task(l.task_id);
    expect((await state())?.state).toBe("deleted");
    expect(tasks.has(l.task_id)).toBe(false);
  });
});

describe("two-way deletion and mapped movement", () => {
  const target = {
    ...mapping,
    id: "other",
    googleCalendarId: "other-calendar",
    todoistProjectId: "other-project",
    mappedMoves: true,
    deleteTasksOnGoogleDeletion: true,
    deleteGoogleOnTaskDeletion: true,
  };
  function enabled() {
    const source = {
      ...mapping,
      mappedMoves: true,
      deleteTasksOnGoogleDeletion: true,
      deleteGoogleOnTaskDeletion: true,
    };
    const settings = {
      ...env,
      MAPPINGS_JSON: JSON.stringify([source, target]),
    };
    return { settings, source, sync: new Sync(settings, source, "test-token") };
  }
  it("deletes Google only after a linked task really disappeared", async () => {
    const l = await seed(),
      s = enabled();
    tasks.delete(l.task_id);
    await s.sync.task(l.task_id, true);
    expect(events.get(l.event_id)?.status).toBe("cancelled");
    expect((await state())?.state).toBe("deleted");
    writes = [];
    await s.sync.task(l.task_id, true);
    await s.sync.event(event());
    expect(writes).toHaveLength(0);
    expect(tasks.size).toBe(0);
  });
  it("never treats completion or a stale deleted webhook as task deletion", async () => {
    const l = await seed(),
      s = enabled();
    tasks.set(l.task_id, { ...tasks.get(l.task_id)!, checked: true });
    const original = JSON.stringify(events.get(l.event_id));
    await s.sync.task(l.task_id, true);
    expect(JSON.stringify(events.get(l.event_id))).toBe(original);
    expect(writes).toHaveLength(0);
  });
  it("moves a Todoist counterpart into its mapped Google calendar without duplicating either side", async () => {
    const l = await seed(),
      s = enabled();
    tasks.set(l.task_id, {
      ...tasks.get(l.task_id)!,
      project_id: target.todoistProjectId,
    });
    await s.sync.task(l.task_id);
    expect(calendar(target.googleCalendarId).get(l.event_id)?.status).toBe(
      "confirmed",
    );
    expect(events.get(l.event_id)?.status).toBe("cancelled");
    expect(tasks.size).toBe(1);
    expect(
      await env.DB.prepare("SELECT mapping,state FROM links WHERE task_id=?")
        .bind(l.task_id)
        .first(),
    ).toEqual({ mapping: target.id, state: "active" });
    writes = [];
    await s.sync.event({ ...event(), status: "cancelled" });
    expect(writes).toHaveLength(0);
  });
  it("recognizes a Google move before propagating its source cancellation as a deletion", async () => {
    const l = await seed(),
      s = enabled();
    const g = events.get(l.event_id)!;
    calendar(target.googleCalendarId).set(g.id, g);
    events.set(g.id, { ...g, status: "cancelled" });
    await s.sync.event(events.get(g.id)!);
    expect(tasks.get(l.task_id)?.project_id).toBe(target.todoistProjectId);
    expect(tasks.size).toBe(1);
    expect(
      await env.DB.prepare("SELECT mapping FROM links WHERE task_id=?")
        .bind(l.task_id)
        .first(),
    ).toEqual({ mapping: target.id });
  });
  it("recovers a lost Google move response without moving twice", async () => {
    const l = await seed(),
      s = enabled();
    tasks.set(l.task_id, {
      ...tasks.get(l.task_id)!,
      project_id: target.todoistProjectId,
    });
    let lost = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit = {}) => {
        const r = await upstream(input, init);
        if (String(input).includes("/move?") && lost) {
          lost = false;
          throw new TypeError("lost response");
        }
        return r;
      }),
    );
    await expect(s.sync.task(l.task_id)).rejects.toThrow();
    await s.sync.task(l.task_id);
    expect(writes.filter((w) => w.url.includes("/move?"))).toHaveLength(1);
    expect(
      await env.DB.prepare("SELECT mapping FROM links WHERE task_id=?")
        .bind(l.task_id)
        .first(),
    ).toEqual({ mapping: target.id });
  });
  it("holds collisions and unmapped project moves rather than merging or deleting", async () => {
    const l = await seed(),
      s = enabled();
    calendar(target.googleCalendarId).set(l.event_id, event());
    tasks.set(l.task_id, {
      ...tasks.get(l.task_id)!,
      project_id: target.todoistProjectId,
    });
    await s.sync.task(l.task_id);
    expect((await state())?.reason).toBe("move_collision");
    expect(writes).toHaveLength(0);
  });
});

describe("Google occurrence projection", () => {
  const projected = () =>
    new Sync(
      { ...env, COMPLETION_MODE: "retain" },
      {
        ...mapping,
        complexRecurrence: true,
        deleteTasksOnGoogleDeletion: true,
        deleteGoogleOnTaskDeletion: true,
      },
      "test-token",
    );
  function fixture(master: Event, rows: Event[]) {
    events.set(master.id, master);
    instances.set(master.id, rows);
    for (const row of rows) events.set(row.id, row);
  }
  const occurrence = (
    id: string,
    date: string,
    changes: Partial<Event> = {},
  ): Event => ({
    ...event(id),
    start: { date },
    end: {
      date: new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10),
    },
    recurringEventId: "complex",
    originalStartTime: { date },
    ...changes,
  });
  async function drain(s: Sync) {
    for (let i = 0; i < 40; i++) {
      const job = jobs.shift();
      if (!job) return;
      if (job.kind === "series") await s.seriesPage(job);
    }
    throw new Error("unexpected projection loop");
  }
  it("expands finite/month-end/compound Google rules as independent tasks, with pagination and idempotent replay", async () => {
    const master = {
      ...event("complex"),
      start: { date: "2026-10-31" },
      end: { date: "2026-11-01" },
      recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=8"],
    };
    fixture(
      master,
      Array.from({ length: 7 }, (_, i) =>
        occurrence(
          `instance-${i}`,
          `2026-11-${String(i + 3).padStart(2, "0")}`,
        ),
      ),
    );
    const s = projected();
    await s.event(master);
    await drain(s);
    expect(tasks.size).toBe(7);
    expect([...tasks.values()].every((t) => !t.due?.is_recurring)).toBe(true);
    writes = [];
    await s.event(master);
    await drain(s);
    expect(tasks.size).toBe(7);
    expect(writes).toHaveLength(0);
  });
  it("syncs moved and renamed occurrences without changing the series master", async () => {
    const master = {
      ...event("complex"),
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
    };
    const row = occurrence("instance", "2026-11-10");
    fixture(master, [row]);
    const s = projected();
    await s.event(master);
    await drain(s);
    const original = JSON.stringify(events.get(master.id));
    const edited = {
      ...row,
      summary: "Only this occurrence",
      start: { date: "2026-11-12" },
      end: { date: "2026-11-13" },
    };
    events.set(row.id, edited);
    instances.set(master.id, [edited]);
    await s.event(edited);
    expect([...tasks.values()][0].content).toBe("Only this occurrence");
    expect([...tasks.values()][0].due?.date).toBe("2026-11-12");
    expect(JSON.stringify(events.get(master.id))).toBe(original);
    const t = [...tasks.values()][0];
    tasks.set(t.id, { ...t, checked: true });
    await s.task(t.id);
    expect(JSON.stringify(events.get(row.id))).toBe(JSON.stringify(edited));
  });
  it("deletes only the task of a cancelled occurrence", async () => {
    const master = {
      ...event("complex"),
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
    };
    const rows = [
      occurrence("one", "2026-11-10"),
      occurrence("two", "2026-11-17"),
    ];
    fixture(master, rows);
    const s = projected();
    await s.event(master);
    await drain(s);
    events.set("one", { ...rows[0], status: "cancelled" });
    await s.event(events.get("one")!);
    expect(tasks.size).toBe(1);
    expect(events.get("complex")?.status).not.toBe("cancelled");
  });
  it("converts an existing native pair durably while retaining its current task identity and completed cursor", async () => {
    const master = {
      ...event("complex"),
      start: { date: "2026-11-03" },
      end: { date: "2026-11-04" },
      recurrence: ["RRULE:FREQ=WEEKLY"],
    };
    fixture(master, [occurrence("current", "2026-11-03")]);
    await sync.event(master);
    const id = [...tasks.keys()][0];
    // The native task has already advanced one occurrence; conversion must not
    // recreate its earlier completed Google occurrence as a new Todoist task.
    const t = tasks.get(id)!;
    tasks.set(id, {
      ...t,
      due: { date: "2026-11-10", is_recurring: true, string: "every week" },
    });
    await sync.task(id);
    const changed = { ...master, recurrence: ["RRULE:FREQ=WEEKLY;COUNT=4"] };
    fixture(changed, [
      occurrence("past", "2026-11-03"),
      occurrence("now", "2026-11-10"),
      occurrence("future", "2026-11-17"),
    ]);
    const s = projected();
    await s.event(changed);
    await drain(s);
    expect(tasks.has(id)).toBe(true);
    expect(tasks.get(id)?.due?.is_recurring).not.toBe(true);
    expect(tasks.size).toBe(2);
    expect(
      await env.DB.prepare(
        "SELECT kind,state FROM links WHERE event_id='complex'",
      ).first(),
    ).toEqual({ kind: "series", state: "series" });
    expect(
      await env.DB.prepare("SELECT event_id FROM links WHERE task_id=?")
        .bind(id)
        .first(),
    ).toEqual({ event_id: "now" });
  });
});

describe("recurring edits and completion history", () => {
  const enhanced = () =>
    new Sync(
      { ...env, COMPLETION_MODE: "retain" },
      { ...mapping, complexRecurrence: true },
      "test-token",
    );
  async function native(rule = "RRULE:FREQ=WEEKLY") {
    const g = {
      ...event("native"),
      recurrence: [rule],
      start: { dateTime: "2026-11-03T10:00:00Z", timeZone: "Europe/London" },
      end: { dateTime: "2026-11-03T11:00:00Z", timeZone: "Europe/London" },
    };
    events.set(g.id, g);
    await sync.event(g);
    return { g, t: [...tasks.values()][0] };
  }
  it("keeps native monthly completion on the native pair instead of splitting each month", async () => {
    const { g, t } = await native("RRULE:FREQ=MONTHLY");
    tasks.set(t.id, { ...t, due: { ...t.due!, date: "2026-12-03T10:00:00Z" } });
    await enhanced().task(t.id, false, "completion");
    expect(events.get(g.id)).toEqual(g);
    expect(events.size).toBe(1);
    expect((await state())?.state).toBe("active");
  });
  it("splits a native rule change at the pending occurrence and preserves the past anchor", async () => {
    const { g, t } = await native();
    tasks.set(t.id, { ...t, due: { ...t.due!, date: "2026-11-10T10:00:00Z" } });
    await sync.task(t.id);
    tasks.set(t.id, {
      ...t,
      due: {
        date: "2026-11-17T10:00:00Z",
        is_recurring: true,
        string: "every day",
        timezone: "Europe/London",
      },
    });
    const s = enhanced();
    await s.task(t.id);
    expect(events.get(g.id)?.recurrence?.[0]).toContain(
      "UNTIL=20261110T095959Z",
    );
    expect(events.get(g.id)?.start).toEqual(g.start);
    const link = await env.DB.prepare("SELECT * FROM links WHERE task_id=?")
      .bind(t.id)
      .first<{ event_id: string; kind: string; state: string }>();
    expect(link?.event_id).not.toBe(g.id);
    expect(link?.state).toBe("active");
    expect(events.get(link!.event_id)?.recurrence).toEqual([
      "RRULE:FREQ=DAILY;INTERVAL=1",
    ]);
    writes = [];
    await s.task(t.id);
    expect(writes).toHaveLength(0);
  });
  it("projects a single native date override and retains the existing task identity", async () => {
    const { g, t } = await native();
    t.due!.string = "every Tuesday at 10:00";
    tasks.set(t.id, t);
    await env.DB.prepare("UPDATE links SET task_due_rule=? WHERE task_id=?")
      .bind(t.due!.string, t.id)
      .run();
    const row = {
      ...g,
      id: "native-instance",
      recurrence: undefined,
      recurringEventId: g.id,
      originalStartTime: g.start,
    };
    events.set(row.id, row);
    instances.set(g.id, [row]);
    tasks.set(t.id, { ...t, due: { ...t.due!, date: "2026-11-04T10:00:00Z" } });
    await enhanced().task(t.id);
    expect(events.get(g.id)).toEqual(g);
    expect(events.get(row.id)?.start?.dateTime).toBe(
      "2026-11-04T10:00:00.000Z",
    );
    expect(tasks.get(t.id)?.due?.is_recurring).not.toBe(true);
    expect(
      await env.DB.prepare("SELECT event_id,kind FROM links WHERE task_id=?")
        .bind(t.id)
        .first(),
    ).toEqual({ event_id: row.id, kind: "occurrence" });
  });
  it("keeps unsupported Todoist rules native and creates another Google event on completion, once across recovery and replay", async () => {
    const t = {
      ...task(),
      due: { date: "2026-11-30", string: "every last day", is_recurring: true },
    };
    tasks.set(t.id, t);
    const s = enhanced();
    await s.task(t.id);
    const initial = [...events.values()][0];
    expect(initial.recurrence).toBeUndefined();
    await env.DB.prepare(
      "UPDATE links SET updated_at=?,completion_cursor=strftime('%Y-%m-%dT%H:%M:%fZ',?/1000.0,'unixepoch')",
    )
      .bind(Date.now() - 10000, Date.now() - 10000)
      .run();
    activities = [
      {
        id: "completion1",
        event_type: "completed",
        event_date: new Date(Date.now() - 1000).toISOString(),
      },
    ];
    tasks.set(t.id, { ...t, due: { ...t.due, date: "2026-12-31" } });
    await s.task(t.id); // missed webhook recovery
    expect(events.size).toBe(2);
    expect(events.get(initial.id)).toEqual(initial);
    await s.task(t.id, false, "webhook-hash");
    await s.task(t.id, false, "webhook-hash");
    expect(events.size).toBe(2);
    expect(tasks.get(t.id)?.due?.is_recurring).toBe(true);
  });
  it("does not overwrite a rolling Google occurrence when the Google echo sees Todoist completion first", async () => {
    const t = {
      ...task(),
      due: { date: "2026-11-30", string: "every last day", is_recurring: true },
    };
    tasks.set(t.id, t);
    const s = enhanced();
    await s.task(t.id);
    const initial = [...events.values()][0];
    await env.DB.prepare(
      "UPDATE links SET updated_at=?,completion_cursor=strftime('%Y-%m-%dT%H:%M:%fZ',?/1000.0,'unixepoch')",
    )
      .bind(Date.now() - 10000, Date.now() - 10000)
      .run();
    activities = [
      {
        id: "completion1",
        event_type: "completed",
        event_date: new Date(Date.now() - 1000).toISOString(),
      },
    ];
    tasks.set(t.id, { ...t, due: { ...t.due, date: "2026-12-31" } });
    await s.event(initial);
    expect(events.get(initial.id)).toEqual(initial);
    expect(events.size).toBe(2);
  });
  it("waits for activity propagation before acting on a completion webhook", async () => {
    const t = {
      ...task(),
      due: { date: "2026-11-30", string: "every last day", is_recurring: true },
    };
    tasks.set(t.id, t);
    const s = enhanced();
    await s.task(t.id);
    tasks.set(t.id, { ...t, due: { ...t.due, date: "2026-12-31" } });
    await expect(s.task(t.id, false, "completion")).rejects.toThrow(
      "completion_activity_pending",
    );
    expect(events.size).toBe(1);
  });
});

describe("projected mapped moves", () => {
  const source = {
    ...mapping,
    complexRecurrence: true,
    mappedMoves: true,
    deleteTasksOnGoogleDeletion: true,
    deleteGoogleOnTaskDeletion: true,
  };
  const target = {
    ...source,
    id: "target",
    googleCalendarId: "other-calendar",
    todoistProjectId: "other-project",
  };
  const settings = () => ({
    ...env,
    COMPLETION_MODE: "retain",
    MAPPINGS_JSON: JSON.stringify([source, target]),
  });
  async function fixture(count = 2) {
    const g = {
      ...event("series-master"),
      recurrence: ["RRULE:FREQ=DAILY;COUNT=7"],
    };
    events.set(g.id, g);
    const rows = Array.from({ length: count }, (_, i) => ({
      ...event(`child-${i}`),
      recurringEventId: g.id,
      originalStartTime: {
        dateTime: `2026-11-${String(i + 10).padStart(2, "0")}T10:00:00Z`,
      },
      start: {
        dateTime: `2026-11-${String(i + 10).padStart(2, "0")}T10:00:00Z`,
      },
      end: { dateTime: `2026-11-${String(i + 10).padStart(2, "0")}T11:00:00Z` },
    }));
    instances.set(g.id, rows);
    for (const row of rows) events.set(row.id, row);
    const e = settings(),
      s = new Sync(e, source, "test-token");
    await s.event(g);
    while (jobs.length) {
      const j = jobs.shift()!;
      if (j.kind === "series") await s.seriesPage(j);
    }
    writes = [];
    return { s, e, g, rows };
  }
  it("moves one projected task as an independent event and cancels only its original occurrence", async () => {
    const { s, g, rows } = await fixture();
    const t = [...tasks.values()][0];
    tasks.set(t.id, { ...t, project_id: target.todoistProjectId });
    await s.task(t.id);
    expect(events.get(g.id)?.status).not.toBe("cancelled");
    expect(events.get(rows[0].id)?.status).toBe("cancelled");
    expect(events.get(rows[1].id)?.status).not.toBe("cancelled");
    const l = await env.DB.prepare(
      "SELECT mapping,event_id,series_id,kind FROM links WHERE task_id=?",
    )
      .bind(t.id)
      .first<{
        mapping: string;
        event_id: string;
        series_id: null;
        kind: string;
      }>();
    expect(l?.mapping).toBe(target.id);
    expect(l?.series_id).toBeNull();
    expect(l?.kind).toBe("normal");
    expect(
      calendar(target.googleCalendarId).get(l!.event_id)?.recurringEventId,
    ).toBeUndefined();
    await s.event(events.get(rows[0].id)!);
    expect(tasks.has(t.id)).toBe(true);
  });
  it("moves a projected Google series and every task in bounded pages, including a replay", async () => {
    const { s, e, g, rows } = await fixture(7);
    for (const row of [g, ...rows]) {
      calendar(target.googleCalendarId).set(row.id, {
        ...row,
        status: "confirmed",
      });
      events.set(row.id, { ...row, status: "cancelled" });
    }
    await s.event(events.get(g.id)!);
    jobs = []; // simulate a lost series continuation; linked recovery must resume it
    const remaining = await env.DB.prepare(
      "SELECT task_id FROM links WHERE mapping=? AND series_id=? AND task_id IS NOT NULL AND state='active' LIMIT 1",
    )
      .bind(source.id, g.id)
      .first<{ task_id: string }>();
    await s.task(remaining!.task_id);
    for (let i = 0; i < 20 && jobs.length; i++) {
      const j = jobs.shift()!;
      if (j.kind === "series")
        await new Sync(
          e,
          j.mapping === source.id ? source : target,
          "test-token",
        ).seriesPage(j);
    }
    expect(
      [...tasks.values()].every(
        (t) => t.project_id === target.todoistProjectId,
      ),
    ).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM links WHERE mapping=? AND task_id IS NOT NULL AND state='active'",
      )
        .bind(target.id)
        .first(),
    ).toEqual({ count: 7 });
    await s.event(events.get(g.id)!);
    expect(tasks.size).toBe(7);
    expect(
      writes.some(
        (w) => w.url.includes("sendUpdates") && w.headers.get("If-Match"),
      ),
    ).toBe(false);
  });
});

describe("private email failure notifications", () => {
  const settings = () => ({
    ...env,
    EMAIL_ALERTS: "true",
    ALERT_EMAIL: "owner@example.com",
  });
  async function healthy() {
    await env.DB.prepare(
      "INSERT INTO channels(id,mapping,resource_id,expires) VALUES('watch',?,'registered',?)",
    )
      .bind(mapping.id, Date.now() + 86400000)
      .run();
    for (const kind of ["google", "window", "tasks", "links"] as const)
      await recordSuccess(env, kind, { kind, mapping: mapping.id }, true);
  }
  function mail() {
    return writes.filter((w) => w.url.includes("gmail.googleapis.com"));
  }
  function provider() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit = {}) => {
        if (String(input).includes("gmail.googleapis.com")) {
          writes.push({
            url: String(input),
            body: JSON.parse(String(init.body)),
            headers: new Headers(init.headers),
          });
          return response({ id: "message1" });
        }
        return upstream(input, init);
      }),
    );
  }
  it("sends a private setup message once even if the test job is replayed", async () => {
    provider();
    await notify(settings(), true, "setup1");
    await notify(settings(), true, "setup1");
    expect(mail()).toHaveLength(1);
    const mime = Buffer.from(
      String(mail()[0].body.raw),
      "base64url",
    ).toString();
    expect(mime).toContain("To: owner@example.com");
    expect(mime).not.toContain(env.ADMIN_TOKEN);
    expect((await syncStatus(settings())).email.enabled).toBe(true);
  });
  it("does not email a healthy initial state or a transient retry, but reports persistent failure with a daily cooldown", async () => {
    provider();
    await healthy();
    await notify(settings());
    expect(mail()).toHaveLength(0);
    await recordFailure(
      env,
      "failure",
      { kind: "task", mapping: mapping.id, taskId: "private-task" },
      new ApiError(503),
      1,
      30,
    );
    await notify(settings());
    expect(mail()).toHaveLength(0);
    await env.DB.prepare("UPDATE job_failures SET first_failed=?")
      .bind(Date.now() - 31 * 60000)
      .run();
    await notify(settings());
    await notify(settings());
    expect(mail()).toHaveLength(1);
    expect(
      await env.DB.prepare(
        "SELECT state FROM notifications WHERE id='email'",
      ).first(),
    ).toEqual({ state: "sent" });
    const mime = Buffer.from(
      String(mail()[0].body.raw),
      "base64url",
    ).toString();
    expect(mime).not.toContain("private-task");
  });
  it("records uncertain delivery without immediately sending a duplicate", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit = {}) => {
        if (String(input).includes("gmail.googleapis.com")) {
          calls++;
          throw new TypeError("lost response");
        }
        return upstream(input, init);
      }),
    );
    await notify(settings());
    await env.DB.prepare("UPDATE notification_health SET since=?")
      .bind(Date.now() - 31 * 60000)
      .run();
    await expect(notify(settings())).rejects.toThrow();
    await notify(settings());
    expect(calls).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT state FROM notifications WHERE id='email'",
      ).first(),
    ).toEqual({ state: "uncertain" });
  });
  it("keeps short retry/recovery cycles silent and preserves the daily budget across recovery", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T10:00:00Z"));
    provider();
    await healthy();
    const tick = (minutes: number) =>
      vi.setSystemTime(Date.now() + minutes * 60000);
    const fail = async (id: string) =>
      recordFailure(
        env,
        id,
        { kind: "google", mapping: mapping.id },
        new ApiError(429),
        1,
        30,
      );
    const clear = async (id: string) =>
      recordSuccess(env, id, { kind: "google", mapping: mapping.id }, true);
    for (let i = 0; i < 3; i++) {
      await fail("transient");
      tick(16);
      await notify(settings());
      await clear("transient");
      await notify(settings());
      tick(31);
      await notify(settings());
    }
    expect(mail()).toHaveLength(0);
    await fail("persistent");
    tick(31);
    await notify(settings());
    expect(mail()).toHaveLength(1);
    await clear("persistent");
    await notify(settings());
    tick(30);
    await notify(settings());
    expect(mail()).toHaveLength(2);
    await fail("again");
    tick(31);
    await notify(settings());
    expect(mail()).toHaveLength(2);
    // Changed problem counts and categories cannot bypass the daily limit.
    await fail("another");
    tick(31);
    await notify(settings());
    expect(mail()).toHaveLength(2);
    tick(24 * 60);
    await notify(settings());
    await notify(settings());
    expect(mail()).toHaveLength(3);
  });
  it("sends basic explanations to a plus alias using the configured sender", async () => {
    provider();
    await healthy();
    await recordFailure(
      env,
      "private-task",
      { kind: "google", mapping: mapping.id },
      new ApiError(503),
      2,
      30,
    );
    await env.DB.prepare("UPDATE job_failures SET first_failed=?")
      .bind(Date.now() - 31 * 60000)
      .run();
    await notify({
      ...settings(),
      ALERT_EMAIL: "owner+todoist@example.com",
      ALERT_FROM: "owner@example.com",
    });
    const mime = Buffer.from(
      String(mail()[0].body.raw),
      "base64url",
    ).toString();
    expect(mime).toContain("From: owner@example.com");
    expect(mime).toContain("To: owner+todoist@example.com");
    const plain = Buffer.from(
      mime
        .split("Content-Transfer-Encoding: base64\r\n\r\n")[1]
        .split("\r\n")[0],
      "base64",
    ).toString();
    expect(plain).toContain("Some updates are still failing");
    expect(plain).toContain("provider HTTP 503");
    expect(plain).toContain("retrying automatically");
    expect(plain).not.toMatch(/private-task|Ask Codex|unresolved_job_failures/);
    await expect(
      notify(
        { ...settings(), ALERT_FROM: "a@example.com\r\nBcc:other@example.com" },
        true,
      ),
    ).rejects.toThrow("configure_alert_email");
  });
  it("does not let an old retired mapping failure promote a new active retry", async () => {
    provider();
    await healthy();
    await recordFailure(
      env,
      "old",
      { kind: "google", mapping: "retired" },
      new ApiError(404),
      5,
      30,
    );
    await env.DB.prepare("UPDATE job_failures SET first_failed=?")
      .bind(Date.now() - 86400000)
      .run();
    await recordFailure(
      env,
      "new",
      { kind: "google", mapping: mapping.id },
      new ApiError(503),
      1,
      30,
    );
    await notify(settings());
    expect(mail()).toHaveLength(0);
  });
  it("rejects header injection and never sends while disabled", async () => {
    provider();
    await notify(env, true);
    expect(mail()).toHaveLength(0);
    await expect(
      notify(
        {
          ...settings(),
          ALERT_EMAIL: "a@example.com\r\nBcc:other@example.com",
        },
        true,
      ),
    ).rejects.toThrow("configure_alert_email");
    expect(mail()).toHaveLength(0);
  });
});

describe("CalDAV copy/delete moves", () => {
  const source = {
    ...mapping,
    mappedMoves: true,
    deleteTasksOnGoogleDeletion: true,
    deleteGoogleOnTaskDeletion: true,
    complexRecurrence: true,
  };
  const target = {
    ...source,
    id: "destination",
    googleCalendarId: "destination-calendar",
    todoistProjectId: "destination-project",
  };
  const settings = () => ({
    ...env,
    COMPLETION_MODE: "retain",
    MAPPINGS_JSON: JSON.stringify([source, target]),
  });
  it("preserves the task identity when a client changes both event id and iCalUID", async () => {
    const l = await seed(),
      e = settings(),
      s = new Sync(e, source, "test-token");
    const moved = {
      ...event("replacement"),
      iCalUID: "new-uuid",
      created: new Date().toISOString(),
    };
    calendar(target.googleCalendarId).set(moved.id, moved);
    events.set(l.event_id, { ...event(), status: "cancelled" });
    await s.event(events.get(l.event_id)!);
    expect(tasks.size).toBe(1);
    expect(tasks.get(l.task_id)?.project_id).toBe(target.todoistProjectId);
    expect(
      await env.DB.prepare("SELECT mapping,event_id FROM links WHERE task_id=?")
        .bind(l.task_id)
        .first(),
    ).toEqual({ mapping: target.id, event_id: moved.id });
  });
  it("waits for a destination-first copy to become a move without creating a duplicate task", async () => {
    const l = await seed(),
      e = settings(),
      dest = new Sync(e, target, "test-token");
    const moved = {
      ...event("replacement"),
      created: new Date().toISOString(),
    };
    calendar(target.googleCalendarId).set(moved.id, moved);
    await dest.event(moved);
    expect(tasks.size).toBe(1);
    expect(jobs.some((j) => j.kind === "event")).toBe(true);
    events.set(l.event_id, { ...event(), status: "cancelled" });
    await dest.event(moved);
    expect(tasks.size).toBe(1);
    expect(tasks.get(l.task_id)?.project_id).toBe(target.todoistProjectId);
  });
  it("gives confirmed deletions a grace period, then deletes when no exact recent copy exists", async () => {
    const l = await seed(),
      e = settings(),
      s = new Sync(e, source, "test-token");
    events.set(l.event_id, { ...event(), status: "cancelled" });
    await s.event(events.get(l.event_id)!);
    expect(tasks.has(l.task_id)).toBe(true);
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
    await s.task(l.task_id);
    expect(tasks.has(l.task_id)).toBe(false);
    now.mockRestore();
  });
  it("does not infer a move from a pre-existing matching event or from a changed description", async () => {
    const l = await seed(),
      s = new Sync(settings(), source, "test-token");
    events.set(l.event_id, { ...event(), status: "cancelled" });
    calendar(target.googleCalendarId).set("old", {
      ...event("old"),
      created: new Date(Date.now() - 3600000).toISOString(),
    });
    calendar(target.googleCalendarId).set("new", {
      ...event("new"),
      description: "different",
      created: new Date().toISOString(),
    });
    await s.event(events.get(l.event_id)!);
    expect(tasks.get(l.task_id)?.project_id).toBe(source.todoistProjectId);
    expect(writes).toHaveLength(0);
  });
  it("holds ambiguous recent copies without deleting or merging tasks", async () => {
    const l = await seed(),
      s = new Sync(settings(), source, "test-token");
    events.set(l.event_id, { ...event(), status: "cancelled" });
    for (const id of ["copy1", "copy2"])
      calendar(target.googleCalendarId).set(id, {
        ...event(id),
        created: new Date().toISOString(),
      });
    await s.event(events.get(l.event_id)!);
    expect((await state())?.reason).toBe("ambiguous_calendar_copy");
    expect(tasks.has(l.task_id)).toBe(true);
  });
  it("translates every projected occurrence id when a CalDAV client replaces the master id", async () => {
    const e = settings(),
      s = new Sync(e, source, "test-token");
    const g = {
      ...event("master-old"),
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"],
      iCalUID: "old-uid",
    };
    const rows = ["20261110T100000Z", "20261117T100000Z"].map((suffix, i) => ({
      ...event(`master-old_${suffix}`),
      recurringEventId: g.id,
      originalStartTime: { dateTime: `2026-11-${i ? 17 : 10}T10:00:00Z` },
      start: { dateTime: `2026-11-${i ? 17 : 10}T10:00:00Z` },
      end: { dateTime: `2026-11-${i ? 17 : 10}T11:00:00Z` },
    }));
    events.set(g.id, g);
    instances.set(g.id, rows);
    for (const row of rows) events.set(row.id, row);
    await s.event(g);
    while (jobs.length) {
      const j = jobs.shift()!;
      if (j.kind === "series") await s.seriesPage(j);
    }
    const ids = [...tasks.keys()];
    const replacement = {
      ...g,
      id: "master-new",
      iCalUID: "new-uid",
      created: new Date().toISOString(),
      recurrence: ["RRULE:COUNT=2;FREQ=WEEKLY;BYDAY=TU"],
    };
    calendar(target.googleCalendarId).set(replacement.id, replacement);
    events.set(g.id, { ...g, status: "cancelled" });
    for (const row of rows) {
      calendar(target.googleCalendarId).set(
        row.id.replace("master-old", "master-new"),
        {
          ...row,
          id: row.id.replace("master-old", "master-new"),
          recurringEventId: replacement.id,
        },
      );
      events.set(row.id, { ...row, status: "cancelled" });
    }
    await s.event(events.get(g.id)!);
    expect([...tasks.keys()]).toEqual(ids);
    expect(
      [...tasks.values()].every(
        (t) => t.project_id === target.todoistProjectId,
      ),
    ).toBe(true);
    expect(
      await env.DB.prepare("SELECT event_id FROM series WHERE mapping=?")
        .bind(target.id)
        .first(),
    ).toEqual({ event_id: replacement.id });
    expect(
      (
        await env.DB.prepare(
          "SELECT series_id FROM links WHERE mapping=? AND task_id IS NOT NULL",
        )
          .bind(target.id)
          .all()
      ).results,
    ).toEqual([{ series_id: replacement.id }, { series_id: replacement.id }]);
  });
});

describe("ordered rolling completion recovery", () => {
  it("preserves intermediate Google events after several completions arrive before their webhooks", async () => {
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-11-09T20:00:00Z"));
    const e = { ...env, COMPLETION_MODE: "retain" },
      s = new Sync(e, { ...mapping, complexRecurrence: true }, "test-token");
    const t = {
      ...task(),
      due: { date: "2026-11-30", string: "every last day", is_recurring: true },
    };
    tasks.set(t.id, t);
    await s.task(t.id);
    activities = [
      {
        id: "first",
        event_type: "completed",
        event_date: "2026-11-09T20:01:00Z",
        extra_data: { due_date: "2026-12-31T23:59:59Z", has_time: false },
      },
      {
        id: "second",
        event_type: "completed",
        event_date: "2026-11-09T20:02:00Z",
        extra_data: { due_date: "2027-01-31T23:59:59Z", has_time: false },
      },
    ];
    tasks.set(t.id, { ...t, due: { ...t.due, date: "2027-01-31" } });
    clock.mockReturnValue(Date.parse("2026-11-09T20:03:00Z"));
    await s.task(t.id, false, "delayed-second");
    await s.task(t.id, false, "delayed-first");
    await s.task(t.id, false, "replayed-first");
    expect([...events.values()].map((g) => g.start?.date).sort()).toEqual([
      "2026-11-30",
      "2026-12-31",
      "2027-01-31",
    ]);
    expect(
      (
        await env.DB.prepare(
          "SELECT state,COUNT(*) AS count FROM links GROUP BY state ORDER BY state",
        ).all()
      ).results,
    ).toEqual([
      { state: "active", count: 1 },
      { state: "history", count: 2 },
    ]);
    clock.mockRestore();
  });
});

it("never treats a completed task's active-endpoint 404 as Google deletion", async () => {
  const l = await seed(),
    g = events.get(l.event_id)!;
  tasks.delete(l.task_id);
  activities = [
    {
      id: "done",
      event_type: "completed",
      event_date: new Date().toISOString(),
    },
  ];
  const s = new Sync(
    { ...env, COMPLETION_MODE: "retain" },
    { ...mapping, deleteGoogleOnTaskDeletion: true },
    "test-token",
  );
  await s.task(l.task_id);
  expect(events.get(l.event_id)).toEqual(g);
  expect(writes).toHaveLength(0);
  expect((await state())?.state).toBe("active");
});

it("emails recovery only after stable health following a delivered failure notice", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T10:00:00Z"));
  const e = { ...env, EMAIL_ALERTS: "true", ALERT_EMAIL: "owner@example.com" };
  let mail = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      if (String(input).includes("gmail.googleapis.com")) {
        mail++;
        return response({ id: "message" + mail });
      }
      return upstream(input, init);
    }),
  );
  await notify(e);
  expect(mail).toBe(0);
  vi.setSystemTime(Date.now() + 31 * 60000);
  await notify(e);
  expect(mail).toBe(1);
  await env.DB.prepare(
    "INSERT INTO channels(id,mapping,resource_id,expires) VALUES('watch',?,'registered',?)",
  )
    .bind(mapping.id, Date.now() + 86400000)
    .run();
  for (const kind of ["google", "window", "tasks", "links"] as const)
    await recordSuccess(e, kind, { kind, mapping: mapping.id }, true);
  await notify(e);
  expect(mail).toBe(1);
  vi.setSystemTime(Date.now() + 30 * 60000);
  await notify(e);
  await notify(e);
  expect(mail).toBe(2);
  const denied = await worker.fetch(
    new Request("https://test.example/admin/notify", { method: "POST" }),
    e,
    {} as ExecutionContext,
  );
  expect(denied.status).toBe(401);
  const queued = await worker.fetch(
    new Request("https://test.example/admin/notify", {
      method: "POST",
      headers: { Authorization: "Bearer test-admin" },
    }),
    e,
    {} as ExecutionContext,
  );
  expect(queued.status).toBe(202);
  expect(jobs.at(-1)?.kind).toBe("notify");
});

describe("reopening recurring tasks without Google writes", () => {
  it.each([true, false])(
    "retains a native Google series when reopening is discovered by webhook=%s",
    async (explicit) => {
      const g = {
        ...event("native-reopen"),
        recurrence: ["RRULE:FREQ=WEEKLY"],
        start: { dateTime: "2026-11-03T10:00:00Z", timeZone: "Europe/London" },
        end: { dateTime: "2026-11-03T11:00:00Z", timeZone: "Europe/London" },
      };
      events.set(g.id, g);
      await sync.event(g);
      const t = [...tasks.values()][0];
      tasks.set(t.id, {
        ...t,
        due: { ...t.due!, date: "2026-11-10T10:00:00Z" },
      });
      await sync.task(t.id);
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10000);
      activities = [
        {
          id: "undo",
          event_type: "uncompleted",
          event_date: new Date(Date.now() - 1000).toISOString(),
        },
      ];
      tasks.set(t.id, t);
      writes = [];
      const s = new Sync(
        { ...env, COMPLETION_MODE: "retain" },
        { ...mapping, complexRecurrence: true },
        "test-token",
      );
      await s.task(t.id, false, undefined, explicit);
      expect(events.get(g.id)).toEqual(g);
      expect(writes).toHaveLength(0);
      expect((await state())?.state).toBe("active");
      clock.mockRestore();
    },
  );
  it("reactivates a known rolling occurrence and reuses its parked next event after re-completion", async () => {
    // Keep constructor timestamps and Date.now aligned across simulated actions.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T10:00:00Z"));
    const s = new Sync(
      { ...env, COMPLETION_MODE: "retain" },
      { ...mapping, complexRecurrence: true },
      "test-token",
    );
    const t = {
      ...task(),
      due: { date: "2026-11-30", string: "every last day", is_recurring: true },
    };
    tasks.set(t.id, t);
    await s.task(t.id);
    const original = [...events.keys()][0];
    vi.setSystemTime(new Date("2026-11-10T10:02:00Z"));
    activities = [
      {
        id: "first",
        event_type: "completed",
        event_date: "2026-11-10T10:01:00Z",
        extra_data: { due_date: "2026-12-31T23:59:59Z", has_time: false },
      },
    ];
    tasks.set(t.id, { ...t, due: { ...t.due, date: "2026-12-31" } });
    await s.task(t.id);
    const google = JSON.stringify([...events]);
    vi.setSystemTime(new Date("2026-11-10T10:03:00Z"));
    tasks.set(t.id, t);
    await s.task(t.id, false, undefined, true);
    expect(JSON.stringify([...events])).toBe(google);
    expect(
      await env.DB.prepare("SELECT event_id FROM links WHERE task_id=?")
        .bind(t.id)
        .first(),
    ).toEqual({ event_id: original });
    vi.setSystemTime(new Date("2026-11-10T10:05:00Z"));
    activities.push({
      id: "redo",
      event_type: "completed",
      event_date: "2026-11-10T10:04:00Z",
      extra_data: { due_date: "2026-12-31T23:59:59Z", has_time: false },
    });
    tasks.set(t.id, { ...t, due: { ...t.due, date: "2026-12-31" } });
    await s.task(t.id);
    expect(JSON.stringify([...events])).toBe(google);
    expect(events.size).toBe(2);
  });
});
