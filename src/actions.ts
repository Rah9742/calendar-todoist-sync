/** Durable cross-mapping moves and reverse deletion. Provider identity checks precede writes; journals survive lost responses. */
import type { AuthenticatedEnv } from "./runtime";
import { calendarCopyKey, savedCalendar } from "./identity";
import { ApiError, json } from "./api";
import {
  mappings,
  type Mapping,
  type Link,
  type Event,
  type Task,
} from "./model";
const TODO = "https://api.todoist.com/api/v1";
const base = (m: Mapping) =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(m.googleCalendarId)}/events`;
/** Treat 404/410 as absent while preserving other provider errors for retry; absence alone is not deletion evidence. */
export async function maybeGet<T>(
  url: string,
  token: string,
): Promise<T | null> {
  try {
    return await json<T>(url, token);
  } catch (e) {
    if (e instanceof ApiError && [404, 410].includes(e.status)) return null;
    throw e;
  }
}
export interface ActionContext {
  env: AuthenticatedEnv;
  mapping: Mapping;
  token: string;
  hold: (link: Link, reason: string) => Promise<void>;
}
async function relocate(
  c: ActionContext,
  link: Link,
  target: Mapping,
  g: Event,
  t: Task,
  detached = false,
  seriesId?: string,
) {
  const collision = await c.env.DB.prepare(
    "SELECT task_id,state FROM links WHERE mapping=? AND event_id=?",
  )
    .bind(target.id, g.id)
    .first<{ task_id: string | null; state: string }>();
  if (
    collision &&
    !(collision.state === "moved" && collision.task_id === null)
  ) {
    await c.hold(link, "move_collision");
    return;
  }
  // Keep a source tombstone to absorb delayed source-calendar cancellations.
  await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM links WHERE mapping=? AND event_id=? AND task_id IS NULL AND state='moved'",
    ).bind(target.id, g.id),
    c.env.DB.prepare(
      "UPDATE links SET mapping=?,event_id=?,series_id=?,kind=?,ical_uid=?,google_payload=?,state='active',reason=NULL,updated_at=? WHERE mapping=? AND event_id=?",
    ).bind(
      target.id,
      g.id,
      detached ? null : seriesId || link.series_id || null,
      detached ? "normal" : link.kind || "normal",
      g.iCalUID || null,
      JSON.stringify(g),
      Date.now(),
      link.mapping,
      link.event_id,
    ),
    c.env.DB.prepare(
      "INSERT INTO links(mapping,event_id,task_id,request_id,state,reason,updated_at,kind) VALUES(?,?,NULL,?,'moved','mapped_move',?,'normal')",
    ).bind(link.mapping, link.event_id, crypto.randomUUID(), Date.now()),
    c.env.DB.prepare(
      "UPDATE operations SET state='done',updated_at=? WHERE mapping=? AND event_id=?",
    ).bind(Date.now(), link.mapping, link.event_id),
  ]);
  await c.env.JOBS.send({ kind: "task", mapping: target.id, taskId: t.id });
}
async function beginMove(c: ActionContext, link: Link, target: Mapping) {
  const pending = await c.env.DB.prepare(
    "SELECT target_mapping,state,kind FROM operations WHERE mapping=? AND event_id=?",
  )
    .bind(link.mapping, link.event_id)
    .first<{ target_mapping: string; state: string; kind: string }>();
  if (
    pending?.state === "pending" &&
    !["cancel_check", "copy_wait"].includes(pending.kind) &&
    pending.target_mapping !== target.id
  ) {
    await c.hold(link, "concurrent_move_edit");
    throw new Error("pending_move_target_changed");
  }
  await c.env.DB.prepare(
    "INSERT INTO operations(mapping,event_id,kind,target_mapping,request_id,state,updated_at) VALUES(?,?,'move',?,?,'pending',?) ON CONFLICT(mapping,event_id) DO UPDATE SET target_mapping=excluded.target_mapping,payload=CASE WHEN (operations.state='done' OR operations.kind IN ('cancel_check','copy_wait')) THEN NULL ELSE operations.payload END,kind=CASE WHEN (operations.state='done' OR operations.kind IN ('cancel_check','copy_wait')) THEN 'move' ELSE operations.kind END,state='pending',updated_at=excluded.updated_at",
  )
    .bind(
      link.mapping,
      link.event_id,
      target.id,
      crypto.randomUUID(),
      Date.now(),
    )
    .run();
  return (await c.env.DB.prepare(
    "SELECT request_id FROM operations WHERE mapping=? AND event_id=?",
  )
    .bind(link.mapping, link.event_id)
    .first<{ request_id: string }>())!.request_id;
}
async function moveTaskProject(
  c: ActionContext,
  t: Task,
  target: Mapping,
  uuid: string,
) {
  if (t.project_id === target.todoistProjectId) return t;
  const result = await json<{ sync_status: Record<string, unknown> }>(
    `${TODO}/sync`,
    c.env.TODOIST_ACCESS_TOKEN,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        commands: JSON.stringify([
          {
            type: "item_move",
            uuid,
            args: { id: t.id, project_id: target.todoistProjectId },
          },
        ]),
      }),
    },
  );
  if (result.sync_status[uuid] !== "ok") throw new Error("todoist_move_failed");
  const live = await json<Task>(
    `${TODO}/tasks/${encodeURIComponent(t.id)}`,
    c.env.TODOIST_ACCESS_TOKEN,
  );
  if (live.project_id !== target.todoistProjectId)
    throw new Error("todoist_move_not_accepted");
  return live;
}
async function detachOccurrence(
  c: ActionContext,
  link: Link,
  t: Task,
  target: Mapping,
) {
  await beginMove(c, link, target);
  let operation = await c.env.DB.prepare(
    "SELECT payload FROM operations WHERE mapping=? AND event_id=?",
  )
    .bind(link.mapping, link.event_id)
    .first<{ payload: string | null }>();
  if (!operation?.payload) {
    const original = await maybeGet<Event>(
      `${base(c.mapping)}/${encodeURIComponent(link.event_id)}`,
      c.token,
    );
    if (!original || original.status === "cancelled") {
      await c.hold(link, "concurrent_delete_move");
      return;
    }
    const raw = original as Event & Record<string, unknown>;
    const payload: Record<string, unknown> = {
      id: "ts" + crypto.randomUUID().replaceAll("-", ""),
    };
    for (const key of [
      "summary",
      "description",
      "start",
      "end",
      "location",
      "colorId",
      "visibility",
      "transparency",
      "reminders",
      "attendees",
      "extendedProperties",
    ]) {
      if (raw[key] !== undefined) payload[key] = raw[key];
    }
    await c.env.DB.prepare(
      "UPDATE operations SET kind='detach',payload=? WHERE mapping=? AND event_id=?",
    )
      .bind(
        JSON.stringify({ event: payload, etag: original.etag }),
        link.mapping,
        link.event_id,
      )
      .run();
    operation = {
      payload: JSON.stringify({ event: payload, etag: original.etag }),
    };
  }
  const plan = JSON.parse(operation.payload!);
  let g = await maybeGet<Event>(`${base(target)}/${plan.event.id}`, c.token);
  if (!g) {
    try {
      g = await json<Event>(`${base(target)}?sendUpdates=none`, c.token, {
        method: "POST",
        body: JSON.stringify(plan.event),
      });
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) throw e;
      g = await json<Event>(`${base(target)}/${plan.event.id}`, c.token);
    }
  }
  if (g.status === "cancelled") {
    await c.hold(link, "move_collision");
    return;
  }
  const original = await maybeGet<Event>(
    `${base(c.mapping)}/${encodeURIComponent(link.event_id)}`,
    c.token,
  );
  if (original && original.status !== "cancelled") {
    if (original.etag !== plan.etag) {
      await c.hold(link, "concurrent_move_edit");
      return;
    }
    await json(
      `${base(c.mapping)}/${encodeURIComponent(link.event_id)}?sendUpdates=none`,
      c.token,
      {
        method: "DELETE",
        headers: original.etag ? { "If-Match": original.etag } : {},
      },
    );
  }
  // The source exception stays cancelled; the destination is an independent event.
  await relocate(c, link, target, g, t, true);
}
async function moveProjectedSeries(
  c: ActionContext,
  link: Link,
  target: Mapping,
  g: Event,
) {
  await beginMove(c, link, target);
  await c.env.DB.prepare(
    "UPDATE operations SET payload=? WHERE mapping=? AND event_id=?",
  )
    .bind(JSON.stringify({ googleEventId: g.id }), link.mapping, link.event_id)
    .run();
  const rows = await c.env.DB.prepare(
    "SELECT * FROM links WHERE mapping=? AND series_id=? AND task_id IS NOT NULL AND state NOT IN ('deleted','moved','history') ORDER BY event_id LIMIT 5",
  )
    .bind(link.mapping, link.event_id)
    .all<Link>();
  for (const child of rows.results) {
    let t = await maybeGet<Task>(
      `${TODO}/tasks/${encodeURIComponent(child.task_id!)}`,
      c.env.TODOIST_ACCESS_TOKEN,
    );
    const moved = await maybeGet<Event>(
      `${base(target)}/${encodeURIComponent(g.id === link.event_id ? child.event_id : g.id + child.event_id.slice(link.event_id.length))}`,
      c.token,
    );
    if (
      !t ||
      !moved ||
      moved.status === "cancelled" ||
      ![c.mapping.todoistProjectId, target.todoistProjectId].includes(
        t.project_id,
      )
    ) {
      await c.hold(child, "series_move_conflict");
      await c.hold(link, "series_move_conflict");
      return;
    }
    const uuid = await beginMove(c, child, target);
    t = await moveTaskProject(c, t, target, uuid);
    await relocate(c, child, target, moved, t, false, g.id);
  }
  if (rows.results.length === 5) {
    await c.env.JOBS.send({
      kind: "series",
      mapping: link.mapping,
      eventId: link.event_id,
    });
    return;
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      "DELETE FROM links WHERE mapping=? AND event_id=? AND task_id IS NULL AND state='moved'",
    ).bind(target.id, link.event_id),
    c.env.DB.prepare(
      "UPDATE links SET mapping=?,event_id=?,ical_uid=?,google_payload=?,state='series',reason=NULL,updated_at=? WHERE mapping=? AND event_id=?",
    ).bind(
      target.id,
      g.id,
      g.iCalUID || null,
      JSON.stringify(g),
      Date.now(),
      link.mapping,
      link.event_id,
    ),
    c.env.DB.prepare(
      "INSERT INTO links(mapping,event_id,request_id,state,kind,updated_at) VALUES(?,?,?,'moved','series',?)",
    ).bind(link.mapping, link.event_id, crypto.randomUUID(), Date.now()),
    c.env.DB.prepare(
      "DELETE FROM series WHERE mapping=? AND event_id=? AND state='moved'",
    ).bind(target.id, link.event_id),
    c.env.DB.prepare(
      "UPDATE series SET mapping=?,event_id=?,state='ready',updated_at=? WHERE mapping=? AND event_id=?",
    ).bind(target.id, g.id, Date.now(), link.mapping, link.event_id),
    c.env.DB.prepare(
      "UPDATE operations SET state='done' WHERE mapping=? AND event_id=?",
    ).bind(link.mapping, link.event_id),
  ]);
  await c.env.JOBS.send({ kind: "series", mapping: target.id, eventId: g.id });
}
/** Move the counterpart only between opted-in mappings; resume an existing move plan before starting another. */
export async function moveFromTask(
  c: ActionContext,
  link: Link,
  t: Task,
): Promise<boolean> {
  if (!c.mapping.mappedMoves) return false;
  const target = mappings(c.env).find(
    (m) =>
      m.enabled !== false &&
      m.mappedMoves &&
      m.todoistProjectId === t.project_id,
  );
  if (!target) return false;
  const pending = await c.env.DB.prepare(
    "SELECT payload FROM operations WHERE mapping=? AND event_id=? AND kind='move' AND state='pending'",
  )
    .bind(link.mapping, link.event_id)
    .first<{ payload: string | null }>();
  const planned = pending?.payload && JSON.parse(pending.payload).googleEventId;
  if (planned) {
    const moved = await json<Event>(
      `${base(target)}/${encodeURIComponent(planned)}`,
      c.token,
    );
    return moveFromGoogle(c, link, target, moved);
  }
  if (link.series_id) {
    await detachOccurrence(c, link, t, target);
    return true;
  }
  await beginMove(c, link, target);
  let g = await maybeGet<Event>(
    `${base(target)}/${encodeURIComponent(link.event_id)}`,
    c.token,
  );
  const original = await maybeGet<Event>(
    `${base(c.mapping)}/${encodeURIComponent(link.event_id)}`,
    c.token,
  );
  if (
    g &&
    g.status !== "cancelled" &&
    original &&
    original.status !== "cancelled"
  ) {
    await c.hold(link, "move_collision");
    return true;
  }
  if (!g || g.status === "cancelled") {
    if (!original || original.status === "cancelled") {
      await c.hold(link, "concurrent_delete_move");
      return true;
    }
    if (original.eventType && original.eventType !== "default") {
      await c.hold(link, "unsupported_move_type");
      return true;
    }
    const q = new URLSearchParams({
      destination: target.googleCalendarId,
      sendUpdates: "none",
    });
    g = await json<Event>(
      `${base(c.mapping)}/${encodeURIComponent(link.event_id)}/move?${q}`,
      c.token,
      { method: "POST" },
    );
  }
  await relocate(c, link, target, g, t);
  return true;
}
/** Retain Todoist identity after verifying the source is gone and the destination is live. */
export async function moveFromGoogle(
  c: ActionContext,
  link: Link,
  target: Mapping,
  g: Event,
): Promise<boolean> {
  if (
    !c.mapping.mappedMoves ||
    !target.mappedMoves ||
    target.enabled === false ||
    g.status === "cancelled"
  )
    return false;
  const original = await maybeGet<Event>(
    `${base(c.mapping)}/${encodeURIComponent(link.event_id)}`,
    c.token,
  );
  if (original && original.status !== "cancelled") {
    await c.hold(link, "move_collision");
    return true;
  }
  if (link.kind === "series") {
    await moveProjectedSeries(c, link, target, g);
    return true;
  }
  let t = await maybeGet<Task>(
    `${TODO}/tasks/${encodeURIComponent(link.task_id!)}`,
    c.env.TODOIST_ACCESS_TOKEN,
  );
  if (!t) {
    await c.hold(link, "concurrent_delete_move");
    return true;
  }
  if (
    ![c.mapping.todoistProjectId, target.todoistProjectId].includes(
      t.project_id,
    )
  ) {
    await c.hold(link, "project_move");
    return true;
  }
  const uuid = await beginMove(c, link, target);
  await c.env.DB.prepare(
    "UPDATE operations SET payload=? WHERE mapping=? AND event_id=?",
  )
    .bind(JSON.stringify({ googleEventId: g.id }), link.mapping, link.event_id)
    .run();
  t = await moveTaskProject(c, t, target, uuid);
  await relocate(c, link, target, g, t);
  return true;
}
async function recentCopies(c: ActionContext, target: Mapping, source: Event) {
  const key = calendarCopyKey(source);
  if (!key || !source.summary) return { exact: [], changed: false };
  const q = new URLSearchParams({
    q: source.summary,
    updatedMin: new Date(Date.now() - 300000).toISOString(),
    maxResults: "5",
    showDeleted: "false",
  });
  const page = await json<{ items?: Event[]; nextPageToken?: string }>(
    `${base(target)}?${q}`,
    c.token,
  );
  if (page.nextPageToken) throw new Error("move_candidates_incomplete");
  const recent = (page.items || []).filter(
    (e) =>
      e.status !== "cancelled" &&
      !!e.created &&
      Date.parse(e.created) > Date.now() - 300000,
  );
  return {
    exact: recent.filter((e) => calendarCopyKey(e) === key),
    changed: recent.some(
      (e) =>
        e.summary === source.summary &&
        JSON.stringify(e.start) === JSON.stringify(source.start) &&
        calendarCopyKey(e) !== key,
    ),
  };
}
/** Resolve a unique recent exact copy or defer its import while the source cancellation becomes visible. */
export async function findCopySource(
  c: ActionContext,
  g: Event,
): Promise<boolean> {
  if (
    !c.mapping.mappedMoves ||
    g.status === "cancelled" ||
    !g.created ||
    Date.parse(g.created) < Date.now() - 300000
  )
    return false;
  const rows = await c.env.DB.prepare(
    "SELECT * FROM links WHERE mapping!=? AND series_id IS NULL AND state IN ('active','series') AND (json_extract(google_payload,'$.summary')=? OR json_extract(google_snapshot,'$.title')=? OR json_extract(initial_payload,'$.summary')=?) LIMIT 6",
  )
    .bind(c.mapping.id, g.summary || "", g.summary || "", g.summary || "")
    .all<Link>();
  const key = calendarCopyKey(g);
  const matches = rows.results.filter((l) => {
    const old = savedCalendar(l);
    return old && key && calendarCopyKey(old) === key;
  });
  const possible = [];
  for (const l of matches) {
    const source = mappings(c.env).find(
      (m) => m.id === l.mapping && m.enabled !== false && m.mappedMoves,
    );
    if (source) possible.push({ l, source });
  }
  if (possible.length > 1) {
    for (const { l } of possible) await c.hold(l, "ambiguous_calendar_copy");
    return true;
  }
  if (!possible.length) return false;
  const { l, source } = possible[0];
  const old = await maybeGet<Event>(
    `${base(source)}/${encodeURIComponent(l.event_id)}`,
    c.token,
  );
  if (!old || old.status === "cancelled")
    return moveFromGoogle({ ...c, mapping: source }, l, c.mapping, g);
  const wait = await c.env.DB.prepare(
    "SELECT updated_at FROM operations WHERE mapping=? AND event_id=? AND kind='copy_wait'",
  )
    .bind(c.mapping.id, g.id)
    .first<{ updated_at: number }>();
  if (wait && Date.now() - wait.updated_at >= 60000) return false;
  if (!wait)
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO operations(mapping,event_id,kind,request_id,state,updated_at) VALUES(?,?,'copy_wait',?,'pending',?)",
    )
      .bind(c.mapping.id, g.id, crypto.randomUUID(), Date.now())
      .run();
  await c.env.JOBS.send(
    { kind: "event", mapping: c.mapping.id, eventId: g.id },
    { delaySeconds: 30 },
  );
  return true;
}
/** Check stable identity, pending journals and recent copies before cancellation propagates; grace periods prevent copy/delete races. */
export async function findGoogleMove(
  c: ActionContext,
  link: Link,
  grace = false,
): Promise<boolean> {
  if (!c.mapping.mappedMoves) return false;
  if (link.series_id) {
    const parent = await c.env.DB.prepare(
      "SELECT links.* FROM links JOIN operations ON links.mapping=operations.mapping AND links.event_id=operations.event_id WHERE links.mapping=? AND links.event_id=? AND operations.kind='move' AND operations.state='pending'",
    )
      .bind(link.mapping, link.series_id)
      .first<Link>();
    if (parent && (await findGoogleMove(c, parent, grace))) return true;
  }
  const operation = await c.env.DB.prepare(
    "SELECT target_mapping,payload FROM operations WHERE mapping=? AND event_id=? AND kind='move' AND state='pending'",
  )
    .bind(link.mapping, link.event_id)
    .first<{ target_mapping: string; payload: string | null }>();
  const planned =
    operation?.payload && JSON.parse(operation.payload).googleEventId;
  const destination =
    operation &&
    mappings(c.env).find(
      (m) =>
        m.id === operation.target_mapping &&
        m.enabled !== false &&
        m.mappedMoves,
    );
  if (planned && destination) {
    const moved = await json<Event>(
      `${base(destination)}/${encodeURIComponent(planned)}`,
      c.token,
    );
    return moveFromGoogle(c, link, destination, moved);
  }
  const source = savedCalendar(link);
  for (const target of mappings(c.env).filter(
    (m) => m.id !== c.mapping.id && m.enabled !== false && m.mappedMoves,
  )) {
    const exact = await maybeGet<Event>(
      `${base(target)}/${encodeURIComponent(link.event_id)}`,
      c.token,
    );
    if (exact && exact.status !== "cancelled")
      return moveFromGoogle(c, link, target, exact);
    const uid = link.ical_uid || source?.iCalUID;
    if (uid && !link.series_id) {
      const page = await json<{ items?: Event[] }>(
        `${base(target)}?${new URLSearchParams({ iCalUID: uid, maxResults: "5", showDeleted: "false" })}`,
        c.token,
      );
      const candidates = (page.items || []).filter(
        (e) => e.status !== "cancelled",
      );
      if (candidates.length === 1)
        return moveFromGoogle(c, link, target, candidates[0]);
      if (candidates.length > 1) {
        await c.hold(link, "ambiguous_calendar_copy");
        return true;
      }
    }
    if (source && !link.series_id && grace) {
      const found = await recentCopies(c, target, source),
        candidates = found.exact;
      if (!candidates.length && found.changed) {
        await c.hold(link, "possible_calendar_copy_changed");
        return true;
      }
      if (candidates.length === 1)
        return moveFromGoogle(c, link, target, candidates[0]);
      if (candidates.length > 1) {
        await c.hold(link, "ambiguous_calendar_copy");
        return true;
      }
    }
  }
  if (grace) {
    // Give CalDAV copy+delete moves time to become visible in the destination.
    const pending = await c.env.DB.prepare(
      "SELECT kind,updated_at,state FROM operations WHERE mapping=? AND event_id=?",
    )
      .bind(link.mapping, link.event_id)
      .first<{ kind: string; updated_at: number; state: string }>();
    if (
      pending &&
      pending.kind !== "cancel_check" &&
      pending.state === "pending"
    ) {
      await c.hold(link, "concurrent_delete_move");
      return true;
    }
    if (pending?.kind !== "cancel_check")
      await c.env.DB.prepare(
        "INSERT INTO operations(mapping,event_id,kind,request_id,state,updated_at) VALUES(?,?,'cancel_check',?,'pending',?) ON CONFLICT(mapping,event_id) DO UPDATE SET kind='cancel_check',state='pending',payload=NULL,updated_at=excluded.updated_at",
      )
        .bind(link.mapping, link.event_id, crypto.randomUUID(), Date.now())
        .run();
    if (
      pending?.kind !== "cancel_check" ||
      Date.now() - pending.updated_at < 60000
    ) {
      await c.env.JOBS.send(
        link.task_id
          ? { kind: "task", mapping: link.mapping, taskId: link.task_id }
          : { kind: "series", mapping: link.mapping, eventId: link.event_id },
        { delaySeconds: 30 },
      );
      return true;
    }
    await c.env.DB.prepare(
      "UPDATE operations SET state='done' WHERE mapping=? AND event_id=? AND kind='cancel_check'",
    )
      .bind(link.mapping, link.event_id)
      .run();
  }
  return false;
}
/** Delete only the current Google counterpart after task deletion evidence; completion and stale notifications are protected. */
export async function deleteAfterTaskDeletion(
  c: ActionContext,
  link: Link,
  confirmed = false,
): Promise<void> {
  if (!c.mapping.deleteGoogleOnTaskDeletion) {
    await c.hold(link, "task_deleted");
    return;
  }
  const t = await maybeGet<Task>(
    `${TODO}/tasks/${encodeURIComponent(link.task_id!)}`,
    c.env.TODOIST_ACCESS_TOKEN,
  );
  if (t && !t.is_deleted) {
    // Completion is never a deletion, even if a stale webhook says otherwise.
    await c.env.JOBS.send({
      kind: "task",
      mapping: c.mapping.id,
      taskId: t.id,
    });
    return;
  }
  if (!confirmed && !t?.is_deleted && link.state !== "deleting_google") {
    const page = await json<{
      results?: { event_type: string }[];
      events?: { event_type: string }[];
    }>(
      `${TODO}/activities?${new URLSearchParams({ object_type: "item", object_id: link.task_id!, limit: "10" })}`,
      c.env.TODOIST_ACCESS_TOKEN,
    );
    const terminal = (page.results || page.events || []).find((e) =>
      ["deleted", "completed", "uncompleted"].includes(e.event_type),
    );
    if (terminal?.event_type !== "deleted") {
      if (terminal?.event_type !== "completed")
        await c.hold(link, "task_missing_unconfirmed");
      return;
    }
  }
  if (await findGoogleMove(c, link)) return;
  const g = await maybeGet<Event>(
    `${base(c.mapping)}/${encodeURIComponent(link.event_id)}`,
    c.token,
  );
  if (g && g.status !== "cancelled") {
    await c.env.DB.prepare(
      "UPDATE links SET state='deleting_google',reason='todoist_deletion_pending',updated_at=? WHERE mapping=? AND event_id=?",
    )
      .bind(Date.now(), link.mapping, link.event_id)
      .run();
    const r = await fetch(
      `${base(c.mapping)}/${encodeURIComponent(link.event_id)}?sendUpdates=none`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${c.token}`,
          ...(g.etag ? { "If-Match": g.etag } : {}),
        },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!r.ok && ![404, 410].includes(r.status))
      throw new ApiError(r.status, Number(r.headers.get("retry-after")) || 30);
    await r.body?.cancel();
  }
  await c.env.DB.prepare(
    "UPDATE links SET state='deleted',reason='todoist_deleted_google_deleted',initial_payload=NULL,updated_at=? WHERE mapping=? AND event_id=?",
  )
    .bind(Date.now(), link.mapping, link.event_id)
    .run();
}
