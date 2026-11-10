/** Worker entry points. Authenticate before enqueue; all provider writes and token rotation run through one serialized consumer. */
import { ApiError, equalSecret, verifyTodoist } from "./api";
import { assertReady, mappings, type Job, type MigrationPlan } from "./model";
import { processJob } from "./sync";
import { informationPage } from "./pages";
import { reviewCursor, reviewList } from "./review";
import {
  syncStatus,
  recordSuccess,
  recordFailure,
  failureCode,
} from "./monitoring";
const reply = (status: number, code: string) =>
  Response.json(
    { status: code },
    { status, headers: { "Cache-Control": "no-store" } },
  );
async function receive(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "GET") {
    const page = informationPage(path);
    if (page) return page;
  }
  if (path === "/health" && request.method === "GET")
    return reply(200, env.SYNC_ENABLED === "true" ? "enabled" : "paused");
  if (path === "/admin/status" || path === "/admin/review") {
    const headers = {
      "Cache-Control": "no-store",
      Vary: "Authorization",
      "X-Content-Type-Options": "nosniff",
    };
    if (
      !env.ADMIN_TOKEN ||
      !(await equalSecret(
        request.headers.get("Authorization") || "",
        `Bearer ${env.ADMIN_TOKEN}`,
      ))
    )
      return Response.json(
        { status: "unauthorized" },
        { status: 401, headers },
      );
    if (request.method !== "GET")
      return Response.json(
        { status: "method_not_allowed" },
        { status: 405, headers },
      );
    if (path === "/admin/review") {
      let cursor: ReturnType<typeof reviewCursor>;
      try {
        cursor = reviewCursor(new URL(request.url).searchParams.get("cursor"));
      } catch {
        return Response.json(
          { status: "invalid_cursor" },
          { status: 400, headers },
        );
      }
      return Response.json(await reviewList(env, cursor), { headers });
    }
    return Response.json(await syncStatus(env), { headers });
  }
  if (request.method !== "POST") return reply(405, "method_not_allowed");
  const configured = mappings(env);
  const pairs = configured.filter((m) => m.enabled !== false);
  if (env.SYNC_ENABLED === "true") {
    try {
      assertReady(env);
    } catch {
      return reply(503, "configure_sync");
    }
  }
  if (
    path === "/admin/test-email" ||
    path === "/admin/notify" ||
    path === "/admin/reconcile" ||
    path === "/admin/refresh-todoist" ||
    path === "/admin/migration"
  ) {
    if (
      !env.ADMIN_TOKEN ||
      !(await equalSecret(
        request.headers.get("Authorization") || "",
        `Bearer ${env.ADMIN_TOKEN}`,
      ))
    )
      return reply(401, "unauthorized");
    if (env.SYNC_ENABLED !== "true") return reply(409, "paused");
    if (path === "/admin/notify") {
      if (env.EMAIL_ALERTS !== "true") return reply(409, "email_not_enabled");
      if (!pairs.length) return reply(409, "no_mapping");
      await env.JOBS.send({ kind: "notify", mapping: pairs[0].id });
      return reply(202, "queued");
    }
    if (path === "/admin/test-email") {
      if (env.EMAIL_ALERTS !== "true") return reply(409, "email_not_enabled");
      if (!pairs.length) return reply(409, "no_mapping");
      await env.JOBS.send({
        kind: "notify",
        mapping: pairs[0].id,
        test: true,
        testId: crypto.randomUUID(),
      });
      return reply(202, "queued");
    }
    if (path === "/admin/migration") {
      const reader = request.body?.getReader();
      if (!reader) return reply(400, "invalid_plan");
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) {
          await reader.cancel();
          return reply(413, "body_too_large");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.length;
      }
      let payload: { mapping: string; plan: MigrationPlan };
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return reply(400, "invalid_plan");
      }
      const m = configured.find((m) => m.id === payload?.mapping);
      if (!m || m.enabled !== false)
        return reply(409, "migration_requires_disabled_mapping");
      const plan = payload.plan;
      const id = (v: unknown) =>
        typeof v === "string" && v.length > 0 && v.length <= 512;
      if (
        !plan ||
        !Array.isArray(plan.pairs) ||
        !Array.isArray(plan.guards) ||
        plan.pairs.length + plan.guards.length > 50 ||
        !plan.pairs.every(
          (p) =>
            p &&
            id(p.eventId) &&
            id(p.taskId) &&
            (p.authority === undefined || p.authority === "google"),
        ) ||
        !plan.guards.every(
          (g) =>
            g && (g.source === "google" || g.source === "todoist") && id(g.id),
        )
      )
        return reply(400, "invalid_plan");
      await env.JOBS.send({ kind: "migration", mapping: m.id, plan });
      return reply(202, "queued");
    }
    if (path === "/admin/refresh-todoist") {
      if (!pairs.length) return reply(409, "no_mapping");
      await env.JOBS.send({ kind: "refresh-token", mapping: pairs[0].id });
      return reply(202, "queued");
    }
    for (const m of pairs)
      for (const kind of [
        "renew",
        "google",
        "window",
        "tasks",
        "links",
      ] as const)
        await env.JOBS.send({ kind, mapping: m.id });
    return reply(202, "queued");
  }
  if (env.SYNC_ENABLED !== "true") return reply(503, "paused");
  if (path === "/webhooks/google") {
    if (
      !env.GOOGLE_CHANNEL_SECRET ||
      !(await equalSecret(
        request.headers.get("X-Goog-Channel-Token") || "",
        env.GOOGLE_CHANNEL_SECRET,
      ))
    )
      return reply(401, "unauthorized");
    const row = await env.DB.prepare(
      "SELECT mapping,resource_id FROM channels WHERE id=? AND expires>?",
    )
      .bind(request.headers.get("X-Goog-Channel-ID") || "", Date.now())
      .first<{ mapping: string; resource_id: string | null }>();
    if (
      !row ||
      (row.resource_id &&
        row.resource_id !== request.headers.get("X-Goog-Resource-ID")) ||
      !pairs.some((m) => m.id === row.mapping)
    )
      return reply(403, "unknown_channel");
    await env.JOBS.send({ kind: "google", mapping: row.mapping });
    return reply(200, "queued");
  }
  if (path === "/webhooks/todoist") {
    const reader = request.body?.getReader();
    if (!reader) return reply(400, "missing_body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 262144) {
        await reader.cancel();
        return reply(413, "body_too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    if (
      !env.TODOIST_CLIENT_SECRET ||
      !(await verifyTodoist(
        bytes.buffer,
        request.headers.get("X-Todoist-Hmac-SHA256") || "",
        env.TODOIST_CLIENT_SECRET,
      ))
    )
      return reply(401, "unauthorized");
    let payload: {
      user_id: string;
      event_name: string;
      event_data: { id: string; project_id: string };
      event_data_extra?: { update_intent?: string };
    };
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return reply(400, "invalid_json");
    }
    if (!env.TODOIST_USER_ID || String(payload.user_id) !== env.TODOIST_USER_ID)
      return reply(403, "wrong_account");
    if (
      ![
        "item:added",
        "item:updated",
        "item:deleted",
        "item:completed",
        "item:uncompleted",
      ].includes(payload.event_name)
    )
      return reply(200, "ignored");
    const id = payload.event_data?.id;
    if (typeof id !== "string") return reply(400, "invalid_task");
    const existing = await env.DB.prepare(
      "SELECT mapping FROM links WHERE task_id=?",
    )
      .bind(id)
      .first<{ mapping: string }>();
    const m = existing
      ? pairs.find((m) => m.id === existing.mapping)
      : pairs.find((m) => m.todoistProjectId === payload.event_data.project_id);
    if (!m) return reply(200, "unmapped");
    const delivery = request.headers.get("X-Todoist-Delivery-ID");
    if (
      delivery &&
      (await env.DB.prepare("SELECT id FROM deliveries WHERE id=?")
        .bind(delivery)
        .first())
    )
      return reply(200, "duplicate");
    // Record after durable enqueue. A crash in between can duplicate delivery, never lose it.
    await env.JOBS.send({
      kind: "task",
      mapping: m.id,
      taskId: id,
      deleted: payload.event_name === "item:deleted",
      ...(payload.event_name === "item:uncompleted" ||
      payload.event_data_extra?.update_intent === "item_uncompleted"
        ? { reopened: true }
        : {}),
      ...(payload.event_name === "item:completed" ||
      payload.event_data_extra?.update_intent === "item_completed"
        ? {
            completionKey: Array.from(
              new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
              (b) => b.toString(16).padStart(2, "0"),
            ).join(""),
          }
        : {}),
    });
    if (delivery)
      await env.DB.prepare(
        "INSERT OR IGNORE INTO deliveries(id,received_at) VALUES(?,?)",
      )
        .bind(delivery, Date.now())
        .run();
    return reply(200, "queued");
  }
  return reply(404, "not_found");
}
export default {
  async fetch(request, env) {
    try {
      return await receive(request, env);
    } catch {
      return reply(500, "request_failed");
    }
  },
  async queue(batch, env) {
    for (const msg of batch.messages) {
      if (env.SYNC_ENABLED !== "true") {
        msg.retry({ delaySeconds: 300 });
        continue;
      }
      const job = msg.body as Job;
      try {
        assertReady(env);
        const m = mappings(env).find(
          (m) =>
            m.id === job.mapping &&
            (m.enabled !== false || job.kind === "migration"),
        );
        if (m) {
          const completed = await processJob(env, m, job);
          await recordSuccess(env, msg.id, job, completed);
        }
        msg.ack();
      } catch (e) {
        console.warn(
          JSON.stringify({
            code: failureCode(e),
            attempt: msg.attempts,
          }),
        );
        const delaySeconds = Math.min(
          43200,
          e instanceof ApiError && e.status === 429
            ? e.retryAfter
            : Math.min(3600, 2 ** msg.attempts * 10),
        );
        try {
          await recordFailure(env, msg.id, job, e, msg.attempts, delaySeconds);
        } catch {
          console.warn(JSON.stringify({ code: "status_write_failed" }));
        }
        msg.retry({ delaySeconds });
      }
    }
  },
  async scheduled(_controller, env) {
    if (env.SYNC_ENABLED !== "true") return;
    assertReady(env);
    const kinds: ("renew" | "google" | "window" | "tasks" | "links")[] = [
      "renew",
      "google",
    ];
    // Full Todoist/project and linked-item scans run four times a day to keep
    // personal multi-calendar accounts within the free queue operation budget.
    if (_controller.scheduledTime % (6 * 3600000) < 15 * 60000)
      kinds.push("window", "tasks", "links");
    for (const m of mappings(env).filter((m) => m.enabled !== false))
      for (const kind of kinds) await env.JOBS.send({ kind, mapping: m.id });
    const first = mappings(env).find((m) => m.enabled !== false);
    if (first && env.EMAIL_ALERTS === "true")
      await env.JOBS.send({ kind: "notify", mapping: first.id });
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM notifications WHERE id!='email' AND attempted_at<?",
      ).bind(Date.now() - 30 * 86400000),
      env.DB.prepare("DELETE FROM job_failures WHERE last_failed<?").bind(
        Date.now() - 30 * 86400000,
      ),
      env.DB.prepare("DELETE FROM deliveries WHERE received_at<?").bind(
        Date.now() - 7 * 86400000,
      ),
      env.DB.prepare("DELETE FROM channels WHERE expires<?").bind(
        Date.now() - 86400000,
      ),
    ]);
  },
} satisfies ExportedHandler<Env, Job>;
