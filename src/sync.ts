/** Queued reconciliation state machine. Preserve completed Google history, journal external writes and bound every recovery page. */
import type { AuthenticatedEnv } from "./runtime";
import {
  recurrenceString,
  recurrenceRule,
  scheduleSignature,
  retimedOccurrence,
  localParts,
  zonedInstant,
} from "./recurrence";
import {
  maybeGet,
  moveFromTask,
  moveFromGoogle,
  findGoogleMove,
  findCopySource,
  deleteAfterTaskDeletion,
  type ActionContext,
} from "./actions";
import { notify } from "./notifications";
import { todoistToken } from "./tokens";
import {
  ApiError,
  googleToken,
  json,
  createTask,
  deleteTask,
  updateRecurringTask,
} from "./api";
import {
  inHorizon,
  mappings,
  horizon,
  direction,
  eventBody,
  eventValue,
  snapshot,
  taskBody,
  taskValue,
  type Event,
  type Task,
  type Link,
  type Mapping,
  type Job,
  type MigrationPlan,
} from "./model";
const TODO = "https://api.todoist.com/api/v1";
const base = (m: Mapping) =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(m.googleCalendarId)}/events`;
/** Per-mapping reconciler. Its authenticated environment is scoped to one queued invocation. */
export class Sync {
  constructor(
    private env: AuthenticatedEnv,
    private mapping: Mapping,
    private token: string,
  ) {}
  private get actions(): ActionContext {
    return {
      env: this.env,
      mapping: this.mapping,
      token: this.token,
      hold: (l, r) => this.hold(l, r),
    };
  }
  private get db() {
    return this.env.DB;
  }
  private async recurrenceAllowed(
    source: "google" | "todoist",
    id: string,
    v: import("./model").Value | null,
  ) {
    if (!v?.recurrence) return true;
    if (
      ["MONTHLY", "YEARLY"].includes(v.recurrence.frequency) &&
      this.mapping.extendedRecurrence !== true
    ) {
      await this.issue(source, id, "recurrence_rollout_pending");
      return false;
    }
    await this.db
      .prepare(
        "DELETE FROM issues WHERE mapping=? AND source=? AND source_id=? AND reason IN ('unsupported_recurrence','recurrence_rollout_pending')",
      )
      .bind(this.mapping.id, source, id)
      .run();
    return true;
  }
  private async guarded(source: "google" | "todoist", id: string) {
    return !!(await this.db
      .prepare(
        "SELECT source_id FROM migration_guards WHERE mapping=? AND source=? AND source_id=?",
      )
      .bind(this.mapping.id, source, id)
      .first());
  }
  /** Validate and journal explicit adoption only for disabled mappings; never auto-match by title. */
  async prepareMigration(plan: MigrationPlan): Promise<void> {
    if (this.mapping.enabled !== false)
      throw new Error("migration_requires_disabled_mapping");
    if (
      new Set(plan.pairs.map((p) => p.eventId)).size !== plan.pairs.length ||
      new Set(plan.pairs.map((p) => p.taskId)).size !== plan.pairs.length
    )
      throw new Error("migration_plan_collision");
    const statements: D1PreparedStatement[] = [];
    for (const pair of plan.pairs) {
      const g = await json<Event>(
        `${base(this.mapping)}/${encodeURIComponent(pair.eventId)}`,
        this.token,
      );
      const t = await json<Task>(
        `${TODO}/tasks/${encodeURIComponent(pair.taskId)}`,
        this.env.TODOIST_ACCESS_TOKEN,
      );
      const gv = eventValue(g),
        tv = taskValue(t, Number(this.env.DEFAULT_DURATION_MINUTES));
      if (
        !gv ||
        !tv ||
        JSON.stringify(gv.recurrence) !== JSON.stringify(tv.recurrence) ||
        g.id !== pair.eventId ||
        t.id !== pair.taskId ||
        t.project_id !== this.mapping.todoistProjectId ||
        t.is_deleted ||
        t.checked ||
        t.is_completed ||
        t.completed_at ||
        (!gv.recurrence &&
          pair.authority !== "google" &&
          (gv.title !== tv.title ||
            gv.start !== tv.start ||
            gv.allDay !== tv.allDay))
      )
        throw new Error("migration_pair_needs_review");
      if (gv.recurrence) {
        if (
          gv.title !== tv.title ||
          gv.allDay !== tv.allDay ||
          (this.mapping.extendedRecurrence !== true &&
            ["MONTHLY", "YEARLY"].includes(gv.recurrence.frequency))
        )
          throw new Error("migration_pair_needs_review");
        const day = tv.start.slice(0, 10),
          next = new Date(
            Date.parse(day + "T00:00:00Z") + 86400000,
          ).toISOString();
        const query = new URLSearchParams({
          timeMin: day + "T00:00:00Z",
          timeMax: next,
          maxResults: "5",
        });
        const instances = await json<{
          items: Event[];
          nextPageToken?: string;
        }>(
          `${base(this.mapping)}/${encodeURIComponent(g.id)}/instances?${query}`,
          this.token,
        );
        const match = instances.items.find((i) => {
          const value = eventValue({
            ...i,
            recurringEventId: undefined,
            recurrence: undefined,
          });
          const original =
            i.originalStartTime?.dateTime || i.originalStartTime?.date;
          return (
            value &&
            value.start === tv.start &&
            value.title === gv.title &&
            value.description === gv.description &&
            (!original || Date.parse(original) === Date.parse(value.start))
          );
        });
        if (!match || instances.nextPageToken)
          throw new Error("migration_occurrence_needs_review");
      }
      if (
        pair.authority !== "google" &&
        ((await this.guarded("google", g.id)) ||
          (await this.guarded("todoist", t.id)))
      )
        throw new Error("migration_pair_guarded");
      const existing = await this.db
        .prepare(
          "SELECT * FROM links WHERE (mapping=? AND event_id=?) OR task_id=?",
        )
        .bind(this.mapping.id, g.id, t.id)
        .all<Link>();
      if (
        existing.results.some(
          (l) =>
            l.mapping !== this.mapping.id ||
            l.event_id !== g.id ||
            l.task_id !== t.id,
        )
      )
        throw new Error("migration_link_collision");
      // Preserve both provider baselines, including description/duration differences.
      // Replays must not reset snapshots or release a held link.
      statements.push(
        this.db
          .prepare(
            "INSERT OR IGNORE INTO links(mapping,event_id,task_id,request_id,google_snapshot,todoist_snapshot,updated_at,state) VALUES(?,?,?,?,?,?,?,?)",
          )
          .bind(
            this.mapping.id,
            g.id,
            t.id,
            crypto.randomUUID(),
            snapshot(gv),
            snapshot(tv),
            Date.now(),
            pair.authority === "google" ? "import_google" : "active",
          ),
      );
      if (pair.authority === "google")
        for (const [source, id] of [
          ["google", g.id],
          ["todoist", t.id],
        ])
          statements.push(
            this.db
              .prepare(
                "DELETE FROM migration_guards WHERE mapping=? AND source=? AND source_id=? AND reason='migration_review'",
              )
              .bind(this.mapping.id, source, id),
          );
    }
    for (const guard of plan.guards) {
      if (
        plan.pairs.some((p) =>
          guard.source === "google"
            ? p.eventId === guard.id
            : p.taskId === guard.id,
        )
      )
        throw new Error("migration_plan_collision");
      statements.push(
        this.db
          .prepare(
            "INSERT OR IGNORE INTO migration_guards(mapping,source,source_id,reason,updated_at) VALUES(?,?,?,?,?)",
          )
          .bind(
            this.mapping.id,
            guard.source,
            guard.id,
            "migration_review",
            Date.now(),
          ),
      );
    }
    if (statements.length) await this.db.batch(statements);
    console.info(
      JSON.stringify({
        code: "migration_prepared",
        mapping: this.mapping.id,
        pairs: plan.pairs.length,
        guards: plan.guards.length,
      }),
    );
  }
  private async issue(
    source: "google" | "todoist",
    id: string,
    reason: string,
  ) {
    await this.db
      .prepare(
        "INSERT INTO issues(mapping,source,source_id,reason,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(mapping,source,source_id) DO UPDATE SET reason=excluded.reason,updated_at=excluded.updated_at",
      )
      .bind(this.mapping.id, source, id, reason, Date.now())
      .run();
  }
  private async hold(link: Link, reason: string) {
    await this.db
      .prepare(
        "UPDATE links SET state=?,reason=?,updated_at=? WHERE mapping=? AND event_id=?",
      )
      .bind("held", reason, Date.now(), link.mapping, link.event_id)
      .run();
  }
  /** Freshly confirm cancellation and the task's project before destructive propagation. */
  private async deleteAfterGoogleCancellation(
    link: Link,
    parent?: Event,
  ): Promise<void> {
    if (link.mapping !== this.mapping.id) {
      await this.hold(link, "project_move");
      return;
    }
    if (!this.mapping.deleteTasksOnGoogleDeletion || !link.task_id) {
      await this.hold(link, "calendar_deleted");
      return;
    }
    // A notification or an old hold alone is not enough: verify cancellation
    // with current Google data, then check the task's current project.
    let g: Event;
    try {
      g =
        parent && parent.id === link.series_id && parent.status === "cancelled"
          ? parent
          : await json<Event>(
              `${base(this.mapping)}/${encodeURIComponent(link.event_id)}`,
              this.token,
            );
    } catch (error) {
      if (error instanceof ApiError && [404, 410].includes(error.status)) {
        if (await findGoogleMove(this.actions, link, true)) return;
        await this.hold(link, "calendar_deletion_unconfirmed");
        return;
      }
      throw error;
    }
    if (
      g.status === "cancelled" &&
      !parent &&
      (await findGoogleMove(this.actions, link, true))
    )
      return;
    if (
      g.status !== "cancelled" ||
      (g.recurringEventId && g.recurringEventId !== link.series_id)
    ) {
      await this.hold(link, "calendar_deletion_unconfirmed");
      return;
    }
    let task: Task | undefined;
    try {
      task = await json<Task>(
        `${TODO}/tasks/${encodeURIComponent(link.task_id)}`,
        this.env.TODOIST_ACCESS_TOKEN,
      );
    } catch (error) {
      if (!(error instanceof ApiError && [404, 410].includes(error.status)))
        throw error;
    }
    if (task && task.project_id !== this.mapping.todoistProjectId) {
      await this.hold(link, "project_move");
      return;
    }
    // No completion exemption: the user explicitly chose all linked tasks.
    if (task && !task.is_deleted) {
      await this.db
        .prepare(
          "UPDATE links SET state='deleting',reason='google_deletion_pending',updated_at=? WHERE mapping=? AND event_id=?",
        )
        .bind(Date.now(), link.mapping, link.event_id)
        .run();
      await deleteTask(this.env, link.task_id);
    }
    // Keep the IDs as a tombstone. A retry after a lost DELETE response or a
    // delayed webhook must never recreate the removed task or event.
    await this.db
      .prepare(
        "UPDATE links SET state='deleted',reason='google_deleted_task_deleted',updated_at=?,initial_payload=NULL WHERE mapping=? AND event_id=?",
      )
      .bind(Date.now(), link.mapping, link.event_id)
      .run();
  }
  /** Persist each side's accepted normalized snapshot; never collapse the two baselines into one. */
  private async save(link: Link, g: Event, t: Task) {
    await this.db
      .prepare(
        "UPDATE links SET task_id=?,google_snapshot=?,todoist_snapshot=?,updated_at=?,google_payload=?,ical_uid=COALESCE(?,ical_uid),task_due_rule=?,completed=?,state='active',reason=NULL WHERE mapping=? AND event_id=?",
      )
      .bind(
        t.id,
        snapshot(eventValue(g, !!link.series_id)),
        snapshot(
          link.kind === "rolling"
            ? this.plainTask(t)
            : taskValue(t, Number(this.env.DEFAULT_DURATION_MINUTES)),
        ),
        Date.now(),
        JSON.stringify(g),
        g.iCalUID || null,
        t.due?.is_recurring ? t.due.string || null : null,
        t.checked || t.is_completed || t.completed_at ? 1 : 0,
        link.mapping,
        link.event_id,
      )
      .run();
  }
  /** Reserve stable identity before an external create so retries reuse the same operation. */
  private async reserve(
    eventId: string,
    taskId: string | null,
    payload: Event | Task,
  ): Promise<Link> {
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO links(mapping,event_id,task_id,request_id,updated_at,initial_payload,series_id,kind) VALUES(?,?,?,?,?,?,?,?)",
      )
      .bind(
        this.mapping.id,
        eventId,
        taskId,
        crypto.randomUUID(),
        Date.now(),
        JSON.stringify(payload),
        "recurringEventId" in payload ? payload.recurringEventId || null : null,
        "recurringEventId" in payload && payload.recurringEventId
          ? "occurrence"
          : "normal",
      )
      .run();
    return (await this.db
      .prepare("SELECT * FROM links WHERE mapping=? AND event_id=?")
      .bind(this.mapping.id, eventId)
      .first<Link>())!;
  }
  /** Handle a live Google change, resuming pending operations before import/reconciliation. */
  async event(e: Event, projected = false): Promise<void> {
    if (this.mapping.complexRecurrence) {
      const pending = await this.db
        .prepare(
          "SELECT task_id,completion_key FROM rolling_advances WHERE mapping=? AND to_event_id=? AND state='pending'",
        )
        .bind(this.mapping.id, e.id)
        .first<{ task_id: string; completion_key: string }>();
      if (pending) {
        await this.task(pending.task_id, false, pending.completion_key);
        return;
      }
      const split = await this.db
        .prepare(
          "SELECT payload FROM operations WHERE mapping=? AND state='pending' AND kind='split' AND (event_id=? OR json_extract(payload,'$.toId')=?)",
        )
        .bind(this.mapping.id, e.id, e.id)
        .first<{ payload: string }>();
      if (split) {
        const plan = JSON.parse(split.payload);
        await this.task(plan.task.id);
        return;
      }
    }
    if (e.recurringEventId && !projected && this.mapping.complexRecurrence) {
      await this.prepareProjection(e.recurringEventId);
      const series = await this.db
        .prepare(
          "SELECT state,lower_bound FROM series WHERE mapping=? AND event_id=?",
        )
        .bind(this.mapping.id, e.recurringEventId)
        .first<{ state: string; lower_bound: string | null }>();
      if (series?.state === "ready") {
        const existing = await this.db
          .prepare("SELECT event_id FROM links WHERE mapping=? AND event_id=?")
          .bind(this.mapping.id, e.id)
          .first();
        const original =
          e.originalStartTime?.dateTime ||
          e.originalStartTime?.date ||
          e.start?.dateTime ||
          e.start?.date;
        if (
          existing ||
          !series.lower_bound ||
          (original && Date.parse(original) >= Date.parse(series.lower_bound))
        )
          await this.event(e, true);
      }
      return;
    }
    if (e.recurringEventId && !projected) {
      const master = await this.db
        .prepare("SELECT * FROM links WHERE mapping=? AND event_id=?")
        .bind(this.mapping.id, e.recurringEventId)
        .first<Link>();
      if (master && ["deleted", "deleting"].includes(master.state)) return;
      await this.issue(
        "google",
        e.recurringEventId,
        "recurring_instance_exception",
      );
      if (master) await this.hold(master, "recurring_instance_exception");
      return;
    }
    const link = await this.db
      .prepare("SELECT * FROM links WHERE mapping=? AND event_id=?")
      .bind(this.mapping.id, e.id)
      .first<Link>();
    if (!link && this.mapping.mappedMoves && e.status !== "cancelled") {
      const previous = await this.db
        .prepare(
          "SELECT * FROM links WHERE (event_id=? OR (ical_uid=? AND series_id IS NULL)) AND mapping!=? AND (task_id IS NOT NULL OR kind='series') AND state NOT IN ('deleted','moved','history')",
        )
        .bind(e.id, e.iCalUID || null, this.mapping.id)
        .first<Link>();
      const source =
        previous &&
        mappings(this.env).find(
          (m) =>
            m.id === previous.mapping && m.enabled !== false && m.mappedMoves,
        );
      if (
        previous &&
        source &&
        (await moveFromGoogle(
          { ...this.actions, mapping: source },
          previous,
          this.mapping,
          e,
        ))
      )
        return;
    }
    if (!link && (await findCopySource(this.actions, e))) return;
    if (
      this.mapping.complexRecurrence &&
      (link?.kind === "series" ||
        (e.recurrence?.length && !eventValue(e, projected)))
    ) {
      await this.prepareProjection(e.id, e);
      return;
    }
    if (link && ["deleted", "moved", "history"].includes(link.state)) return;
    if (link?.state === "deleting") {
      await this.deleteAfterGoogleCancellation(link);
      return;
    }
    if (link?.state === "held") {
      if (
        link.reason === "calendar_deleted" &&
        this.mapping.deleteTasksOnGoogleDeletion
      )
        await this.deleteAfterGoogleCancellation(link);
      return;
    }
    if (!link && (await this.guarded("google", e.id))) return;
    if (e.status === "cancelled") {
      if (link) await this.deleteAfterGoogleCancellation(link);
      else
        await this.db
          .prepare(
            "DELETE FROM issues WHERE mapping=? AND source='google' AND source_id=?",
          )
          .bind(this.mapping.id, e.id)
          .run();
      return;
    }
    if (!link && e.eventType && e.eventType !== "default") return;
    let importValue = eventValue(e, projected);
    if (!(await this.recurrenceAllowed("google", e.id, importValue))) return;
    if (!link && e.recurrence?.length && !importValue) {
      await this.issue("google", e.id, "unsupported_recurrence");
      return;
    }
    if (
      !link &&
      e.recurrence?.length &&
      (await this.db
        .prepare(
          "SELECT source_id FROM issues WHERE mapping=? AND source='google' AND source_id=? AND reason='recurring_instance_exception'",
        )
        .bind(this.mapping.id, e.id)
        .first())
    )
      return;
    if (!link && importValue?.recurrence) {
      const window = horizon(this.env);
      const query = new URLSearchParams({
        timeMin: window.timeMin,
        timeMax: window.timeMax,
        maxResults: "1",
      });
      const instances = await json<{ items: Event[] }>(
        `${base(this.mapping)}/${e.id}/instances?${query}`,
        this.token,
      );
      const instance = instances.items.find(
        (item) => item.status !== "cancelled",
      );
      if (!instance) return;
      const originalStart =
        instance.originalStartTime?.dateTime ||
        instance.originalStartTime?.date;
      const actualStart = instance.start?.dateTime || instance.start?.date;
      if (
        originalStart &&
        actualStart &&
        Date.parse(originalStart) !== Date.parse(actualStart)
      ) {
        if (this.mapping.complexRecurrence)
          await this.prepareProjection(e.id, e);
        else await this.issue("google", e.id, "recurring_instance_exception");
        return;
      }
      const occurrence = eventValue({
        ...instance,
        recurringEventId: undefined,
        recurrence: undefined,
      });
      if (!occurrence) return;
      if (
        occurrence.title !== importValue.title ||
        occurrence.description !== importValue.description
      ) {
        if (this.mapping.complexRecurrence)
          await this.prepareProjection(e.id, e);
        else await this.issue("google", e.id, "recurring_instance_exception");
        return;
      }
      const candidate = { ...occurrence, recurrence: importValue.recurrence };
      if (scheduleSignature(candidate) !== scheduleSignature(importValue)) {
        if (this.mapping.complexRecurrence)
          await this.prepareProjection(e.id, e);
        else await this.issue("google", e.id, "recurring_instance_exception");
        return;
      }
      importValue = candidate;
    }
    if (!link && (!importValue || !inHorizon(importValue.start, this.env)))
      return;
    if (!eventValue(e, projected)) {
      if (link) await this.hold(link, "unsupported_calendar_change");
      return;
    }
    if (link?.task_id) {
      if (!link.google_snapshot || link.kind === "rolling")
        await this.task(link.task_id);
      else await this.pair(link);
      return;
    }
    const pending =
      link ||
      (await this.reserve(e.id, null, {
        ...e,
        syncValue: importValue,
      } as Event));
    const original: Event & { syncValue?: import("./model").Value } =
      JSON.parse(pending.initial_payload!);
    const v = original.syncValue || eventValue(original, projected)!;
    const t = await createTask(this.env, pending.request_id, {
      project_id: this.mapping.todoistProjectId,
      content: v.title,
      description: v.description,
      due: {
        date: v.start,
        timezone: v.recurrence?.timezone || (v.allDay ? null : "UTC"),
        is_recurring: !!v.recurrence,
        ...(v.recurrence
          ? { string: recurrenceString(v.recurrence, v.start) }
          : {}),
      },
      duration: v.allDay
        ? null
        : {
            amount: Math.max(
              1,
              Math.round((Date.parse(v.end) - Date.parse(v.start)) / 60000),
            ),
            unit: "minute",
          },
    });
    await this.save(pending, original, t);
    await this.pair({
      ...pending,
      task_id: t.id,
      google_snapshot: snapshot(eventValue(original, projected)),
      todoist_snapshot: snapshot(
        taskValue(t, Number(this.env.DEFAULT_DURATION_MINUTES)),
      ),
    });
  }
  /** Handle task changes/deletion/completion hints; route moved identities to their current mapping. */
  async task(
    id: string,
    deleted = false,
    completionKey?: string,
    reopened = false,
  ): Promise<void> {
    const link = await this.db
      .prepare("SELECT * FROM links WHERE task_id=?")
      .bind(id)
      .first<Link>();
    if (link && link.mapping !== this.mapping.id) {
      if (
        mappings(this.env).some(
          (m) => m.id === link.mapping && m.enabled !== false,
        )
      )
        await this.env.JOBS.send({
          kind: "task",
          mapping: link.mapping,
          taskId: id,
          deleted,
          completionKey,
          reopened,
        });
      return;
    }
    if (
      link &&
      !deleted &&
      this.mapping.complexRecurrence &&
      link.kind !== "occurrence"
    ) {
      const pending = await this.db
        .prepare(
          "SELECT state FROM series WHERE mapping=? AND event_id=? AND conversion_task_id=?",
        )
        .bind(this.mapping.id, link.event_id, id)
        .first<{ state: string }>();
      if (pending && ["planning", "converting"].includes(pending.state)) {
        if (await this.convertProjection(link))
          await this.prepareProjection(link.event_id);
        return;
      }
    }
    if (link && !deleted && this.mapping.complexRecurrence) {
      const split = await this.db
        .prepare(
          "SELECT payload FROM operations WHERE mapping=? AND event_id=? AND kind='split' AND state='pending'",
        )
        .bind(this.mapping.id, link.event_id)
        .first<{ payload: string }>();
      if (split) {
        await this.finishSplit(link, JSON.parse(split.payload));
        return;
      }
    }
    if (link?.state === "deleting_google") {
      await deleteAfterTaskDeletion(this.actions, link);
      return;
    }
    if (link && ["deleted", "moved", "history"].includes(link.state)) return;
    if (link?.state === "deleting") {
      await this.deleteAfterGoogleCancellation(link);
      return;
    }
    if (link?.state === "held") {
      if (
        link.reason === "calendar_deleted" &&
        this.mapping.deleteTasksOnGoogleDeletion
      )
        await this.deleteAfterGoogleCancellation(link);
      return;
    }
    if (!link && (await this.guarded("todoist", id))) return;
    if (link && link.mapping !== this.mapping.id) {
      await this.hold(link, "project_move");
      return;
    }
    if (deleted) {
      if (link) await deleteAfterTaskDeletion(this.actions, link, true);
      return;
    }
    let t: Task;
    try {
      t = await json<Task>(
        `${TODO}/tasks/${encodeURIComponent(id)}`,
        this.env.TODOIST_ACCESS_TOKEN,
      );
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 410)) {
        if (link) {
          if (this.mapping.deleteGoogleOnTaskDeletion)
            await deleteAfterTaskDeletion(this.actions, link);
          else await this.hold(link, "task_missing");
        }
        return;
      }
      throw e;
    }
    if (t.project_id !== this.mapping.todoistProjectId) {
      if (link && !(await moveFromTask(this.actions, link, t)))
        await this.hold(link, "project_move");
      return;
    }
    if (
      link &&
      this.mapping.complexRecurrence &&
      t.due?.is_recurring &&
      (reopened || (await this.wasReopened(link, t)))
    ) {
      await this.reopenTask(link, t);
      return;
    }
    if (
      this.mapping.complexRecurrence &&
      t.due?.is_recurring &&
      (link?.kind === "rolling" ||
        (!link && !taskValue(t, Number(this.env.DEFAULT_DURATION_MINUTES))))
    ) {
      await this.rollingTask(t, link || undefined, completionKey);
      return;
    }
    if (link?.google_snapshot && link.todoist_snapshot) {
      await this.pair(link, completionKey);
      return;
    }
    const v = taskValue(t, Number(this.env.DEFAULT_DURATION_MINUTES));
    if (!(await this.recurrenceAllowed("todoist", t.id, v))) return;
    if (!v && t.due?.is_recurring) {
      await this.issue("todoist", t.id, "unsupported_recurrence");
      return;
    }
    if (
      !v ||
      (!link && !inHorizon(v.start, this.env)) ||
      t.checked ||
      t.is_completed ||
      t.completed_at ||
      t.is_deleted
    )
      return;
    // Google IDs use base32hex; hex digest is valid and deterministic across retries.
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${this.mapping.id}:${id}`),
    );
    const eventId =
      "ts" +
      Array.from(new Uint8Array(hash), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
    const pending = await this.reserve(eventId, id, t);
    const original: Task = JSON.parse(pending.initial_payload!);
    const originalValue = taskValue(
      original,
      Number(this.env.DEFAULT_DURATION_MINUTES),
    )!;
    let g: Event;
    try {
      g = await json<Event>(
        `${base(this.mapping)}?sendUpdates=none`,
        this.token,
        {
          method: "POST",
          body: JSON.stringify({
            id: eventId,
            ...eventBody(originalValue),
            ...(originalValue.recurrence
              ? { recurrence: [recurrenceRule(originalValue.recurrence)] }
              : {}),
          }),
        },
      );
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409) throw e;
      g = await json<Event>(`${base(this.mapping)}/${eventId}`, this.token);
    }
    const originalEvent = { ...g, ...eventBody(originalValue) };
    await this.save(pending, originalEvent, original);
    await this.pair({
      ...pending,
      google_snapshot: snapshot(eventValue(originalEvent)),
      todoist_snapshot: snapshot(originalValue),
    });
  }
  /** Read both live counterparts, compare independent snapshots and apply one safe direction. */
  private async pair(link: Link, completionKey?: string): Promise<void> {
    let g: Event, t: Task;
    try {
      g = await json<Event>(
        `${base(this.mapping)}/${link.event_id}`,
        this.token,
      );
      if (g.status === "cancelled") {
        await this.deleteAfterGoogleCancellation(link);
        return;
      }
      t = await json<Task>(
        `${TODO}/tasks/${encodeURIComponent(link.task_id!)}`,
        this.env.TODOIST_ACCESS_TOKEN,
      );
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 410)) {
        if (await findGoogleMove(this.actions, link, true)) return;
        await this.hold(link, "counterpart_missing");
        return;
      }
      throw e;
    }
    if (
      t.project_id !== this.mapping.todoistProjectId &&
      (await moveFromTask(this.actions, link, t))
    )
      return;
    if (
      t.project_id !== this.mapping.todoistProjectId ||
      g.status === "cancelled" ||
      t.is_deleted
    ) {
      await this.hold(link, "deleted_or_moved");
      return;
    }
    if (
      this.mapping.complexRecurrence &&
      t.due?.is_recurring &&
      (await this.wasReopened(link, t))
    ) {
      await this.reopenTask(link, t, g);
      return;
    }
    if (
      this.mapping.complexRecurrence &&
      t.due?.is_recurring &&
      link.kind !== "rolling" &&
      (await this.recurringTaskEdit(link, g, t, completionKey))
    )
      return;
    let gv = eventValue(g, !!link.series_id),
      tv =
        link.kind === "rolling"
          ? this.plainTask(t)
          : taskValue(t, Number(this.env.DEFAULT_DURATION_MINUTES));
    if (!gv || !tv) {
      await this.hold(link, "unsupported_or_undated_change");
      return;
    }
    if (gv.recurrence || tv.recurrence) {
      await this.recurringPair(link, g, t, gv, tv);
      return;
    }
    const completed = !!(t.checked || t.is_completed || t.completed_at);
    const mark = this.env.COMPLETION_MODE === "checkmark";
    // Compare Google with its own last snapshot before adjusting completion decoration.
    const action =
      link.state === "import_google"
        ? snapshot(tv) === link.todoist_snapshot
          ? "google"
          : "conflict"
        : direction(link, gv, tv);
    if (action === "conflict") {
      await this.hold(link, "concurrent_changes");
      return;
    }
    if (action === "none" && !mark) {
      await this.save(link, g, t);
      return;
    }
    if (action === "google") {
      // Completed tasks remain completed; only synced text/date fields are changed.
      const title =
        mark && gv.title.startsWith("✓ ") ? gv.title.slice(2) : gv.title;
      if (link.kind === "rolling" && t.due?.is_recurring) {
        t = await updateRecurringTask(this.env, t.id, {
          date: gv.start,
          timezone: t.due.timezone || "Europe/London",
          is_recurring: true,
          string: t.due.string,
        });
      }
      t = await json<Task>(
        `${TODO}/tasks/${t.id}`,
        this.env.TODOIST_ACCESS_TOKEN,
        {
          method: "POST",
          body: JSON.stringify(
            link.kind === "rolling"
              ? {
                  content: title,
                  description: gv.description,
                  ...(!gv.allDay
                    ? {
                        duration: Math.max(
                          1,
                          Math.round(
                            (Date.parse(gv.end) - Date.parse(gv.start)) / 60000,
                          ),
                        ),
                        duration_unit: "minute",
                      }
                    : {}),
                }
              : taskBody({ ...gv, title }),
          ),
        },
      );
      tv = (
        link.kind === "rolling"
          ? this.plainTask(t)
          : taskValue(t, Number(this.env.DEFAULT_DURATION_MINUTES))
      )!;
    }
    const desired =
      action === "google" ? { ...gv, title: tv.title } : { ...tv };
    if (mark && completed) desired.title = `✓ ${desired.title}`;
    // Date-only Todoist tasks cannot express multi-day duration: keep existing Google span
    // when the due date did not change.
    if (desired.allDay && gv.allDay && desired.start === gv.start)
      desired.end = gv.end;
    // Accounts without Todoist durations return no duration even when we sent one.
    // Preserve the linked event's span on text edits and task reschedules.
    if (action === "todoist" && !desired.allDay && !gv.allDay && !t.duration)
      desired.end = new Date(
        Date.parse(desired.start) + Date.parse(gv.end) - Date.parse(gv.start),
      ).toISOString();
    if (snapshot(desired) !== snapshot(gv)) {
      g = await json<Event>(
        `${base(this.mapping)}/${g.id}?sendUpdates=none`,
        this.token,
        {
          method: "PATCH",
          headers: g.etag ? { "If-Match": g.etag } : {},
          body: JSON.stringify(eventBody(desired)),
        },
      );
      gv = eventValue(g, !!link.series_id)!;
    }
    await this.save(link, g, t);
  }
  /** Reconcile native recurring content/clock changes while preserving historical Google anchors. */
  private async recurringPair(
    link: Link,
    g: Event,
    t: Task,
    gv: import("./model").Value,
    tv: import("./model").Value,
  ): Promise<void> {
    const previousGoogle = link.google_snapshot
      ? JSON.parse(link.google_snapshot)
      : null;
    const previousTask = link.todoist_snapshot
      ? JSON.parse(link.todoist_snapshot)
      : null;
    if (
      !gv.recurrence ||
      !tv.recurrence ||
      !previousGoogle?.recurrence ||
      !previousTask?.recurrence ||
      JSON.stringify(gv.recurrence) !== JSON.stringify(tv.recurrence)
    ) {
      const taskSame =
        previousTask &&
        tv.title === previousTask.title &&
        tv.description === previousTask.description &&
        scheduleSignature(tv) === scheduleSignature(previousTask);
      if (
        this.mapping.complexRecurrence &&
        taskSame &&
        previousGoogle &&
        snapshot(gv) !== link.google_snapshot
      ) {
        await this.prepareProjection(g.id, g);
        return;
      }
      await this.hold(link, "recurrence_changed_or_unsupported");
      return;
    }
    // Due-date advancement belongs to Todoist. Never move Google's series anchor
    // or rewrite its historical occurrences when Todoist completes an instance.
    if (
      gv.start !== previousGoogle.start ||
      gv.end !== previousGoogle.end ||
      scheduleSignature(gv) !== scheduleSignature(previousGoogle) ||
      scheduleSignature(tv) !== scheduleSignature(previousTask)
    ) {
      const retimed = retimedOccurrence(previousGoogle, gv, tv);
      const taskUnchanged =
        scheduleSignature(tv) === scheduleSignature(previousTask) &&
        tv.title === previousTask.title &&
        tv.description === previousTask.description;
      if (retimed && taskUnchanged) {
        t = await updateRecurringTask(this.env, t.id, {
          date: retimed.start,
          timezone: gv.recurrence.timezone,
          is_recurring: true,
          string: recurrenceString(gv.recurrence, retimed.start),
        });
        // Save the accepted schedule separately before syncing any Google text
        // edit; a retry must not mistake our own due update for a user change.
        const scheduleLink = {
          ...link,
          google_snapshot: snapshot({
            ...gv,
            title: previousGoogle.title,
            description: previousGoogle.description,
          }),
          todoist_snapshot: snapshot(
            taskValue(t, Number(this.env.DEFAULT_DURATION_MINUTES)),
          ),
        };
        const normalized = taskValue(
          t,
          Number(this.env.DEFAULT_DURATION_MINUTES),
        );
        if (
          !normalized ||
          normalized.start !== retimed.start ||
          JSON.stringify(normalized.recurrence) !==
            JSON.stringify(gv.recurrence)
        ) {
          await this.hold(link, "recurring_retime_not_accepted");
          return;
        }
        await this.save(
          link,
          {
            ...g,
            summary: previousGoogle.title,
            description: previousGoogle.description,
          },
          t,
        );
        await this.recurringPair(scheduleLink, g, t, gv, normalized);
        return;
      }
      if (
        this.mapping.complexRecurrence &&
        taskUnchanged &&
        snapshot(gv) !== link.google_snapshot
      ) {
        await this.prepareProjection(g.id, g);
        return;
      }
      await this.hold(link, "recurring_schedule_edit");
      return;
    }
    const content = (v: import("./model").Value) =>
      JSON.stringify({ title: v.title, description: v.description });
    const gc = content(gv) !== content(previousGoogle),
      tc = content(tv) !== content(previousTask);
    if (gc && tc && content(gv) !== content(tv)) {
      await this.hold(link, "concurrent_changes");
      return;
    }
    if (gc && !tc)
      t = await json<Task>(
        `${TODO}/tasks/${encodeURIComponent(t.id)}`,
        this.env.TODOIST_ACCESS_TOKEN,
        {
          method: "POST",
          body: JSON.stringify({
            content: gv.title,
            description: gv.description,
          }),
        },
      );
    if (tc && !gc)
      g = await json<Event>(
        `${base(this.mapping)}/${g.id}?sendUpdates=none`,
        this.token,
        {
          method: "PATCH",
          headers: g.etag ? { "If-Match": g.etag } : {},
          body: JSON.stringify({
            summary: tv.title,
            description: tv.description,
          }),
        },
      );
    await this.save(link, g, t);
  }
  /** Process one incremental/discovery page; retain fixed query bounds across continuations. */
  async googlePage(
    job: Extract<Job, { kind: "google" | "window" }>,
  ): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT sync_token FROM cursors WHERE mapping=?")
      .bind(this.mapping.id)
      .first<{ sync_token: string }>();
    const discovery = job.kind === "window";
    const token = !discovery
      ? job.token || (!job.page ? row?.sync_token : undefined)
      : undefined;
    const window = job.window || horizon(this.env);
    const query = new URLSearchParams({
      maxResults: "5",
      showDeleted: "true",
      singleEvents: "false",
    });
    if (token) query.set("syncToken", token);
    else {
      query.set("timeMin", window.timeMin);
      query.set("timeMax", window.timeMax);
    }
    if (job.page) query.set("pageToken", job.page);
    let page: {
      items?: Event[];
      nextPageToken?: string;
      nextSyncToken?: string;
    };
    try {
      page = await json(`${base(this.mapping)}?${query}`, this.token);
    } catch (e) {
      if (!discovery && e instanceof ApiError && e.status === 410) {
        await this.db
          .prepare("DELETE FROM cursors WHERE mapping=?")
          .bind(this.mapping.id)
          .run();
        await this.env.JOBS.send({ kind: "google", mapping: this.mapping.id });
        return false;
      }
      throw e;
    }
    for (const e of page.items || []) {
      // Incremental and linked recovery handle existing pairs. Discovery only
      // imports unlinked sources; never release a held/deleted link.
      if (
        discovery &&
        !e.recurringEventId &&
        (await this.db
          .prepare(
            "SELECT event_id FROM links WHERE mapping=? AND event_id=? AND kind!='series'",
          )
          .bind(this.mapping.id, e.id)
          .first())
      )
        continue;
      await this.event(e);
    }
    if (page.nextPageToken)
      await this.env.JOBS.send({
        ...(discovery
          ? { kind: "window" as const }
          : { kind: "google" as const, token }),
        mapping: this.mapping.id,
        page: page.nextPageToken,
        ...(!token ? { window } : {}),
      });
    else if (!discovery && page.nextSyncToken)
      await this.db
        .prepare(
          "INSERT INTO cursors(mapping,sync_token) VALUES(?,?) ON CONFLICT(mapping) DO UPDATE SET sync_token=excluded.sync_token",
        )
        .bind(this.mapping.id, page.nextSyncToken)
        .run();
    return !page.nextPageToken;
  }
  /** Process a bounded project page and enqueue continuation without marking a partial scan complete. */
  async taskPage(cursor?: string): Promise<boolean> {
    const q = new URLSearchParams({
      project_id: this.mapping.todoistProjectId,
      limit: "5",
    });
    if (cursor) q.set("cursor", cursor);
    const page = await json<{ results: Task[]; next_cursor?: string }>(
      `${TODO}/tasks?${q}`,
      this.env.TODOIST_ACCESS_TOKEN,
    );
    for (const t of page.results) await this.task(t.id);
    if (page.next_cursor)
      await this.env.JOBS.send({
        kind: "tasks",
        mapping: this.mapping.id,
        cursor: page.next_cursor,
      });
    return !page.next_cursor;
  }
  /** Recover linked items and interrupted series operations even after they leave discovery bounds. */
  async linkedPage(after = ""): Promise<boolean> {
    if (!after && this.mapping.complexRecurrence) {
      const pending = await this.db
        .prepare(
          "SELECT series.event_id FROM series LEFT JOIN operations ON series.mapping=operations.mapping AND series.event_id=operations.event_id WHERE series.mapping=? AND (series.state IN ('planning','converting','deleting') OR (operations.kind='move' AND operations.state='pending')) LIMIT 5",
        )
        .bind(this.mapping.id)
        .all<{ event_id: string }>();
      for (const row of pending.results)
        await this.env.JOBS.send({
          kind: "series",
          mapping: this.mapping.id,
          eventId: row.event_id,
        });
    }
    const rows = await this.db
      .prepare(
        "SELECT task_id FROM links WHERE mapping=? AND (state='active' OR state IN ('deleting','deleting_google') OR (?=1 AND state='held' AND reason='calendar_deleted')) AND task_id>? ORDER BY task_id LIMIT 5",
      )
      .bind(
        this.mapping.id,
        this.mapping.deleteTasksOnGoogleDeletion ? 1 : 0,
        after,
      )
      .all<{ task_id: string }>();
    for (const row of rows.results) await this.task(row.task_id);
    if (rows.results.length === 5)
      await this.env.JOBS.send({
        kind: "links",
        mapping: this.mapping.id,
        after: rows.results[4].task_id,
      });
    return rows.results.length < 5;
  }
  private plainTask(t: Task) {
    return taskValue(
      { ...t, due: t.due ? { ...t.due, is_recurring: false } : null },
      Number(this.env.DEFAULT_DURATION_MINUTES),
    );
  }
  private async deterministicId(value: string) {
    return (
      "ts" +
      Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(value),
          ),
        ),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("")
    );
  }
  /** Recognize undo activity before treating an automatic due rewind as a user schedule edit. */
  private async wasReopened(link: Link, t: Task) {
    const previous = link.todoist_snapshot && JSON.parse(link.todoist_snapshot),
      current = this.plainTask(t);
    if (!previous || !current || previous.start === current.start) return false;
    const page = await json<{
      results?: { event_type: string; event_date: string }[];
      events?: { event_type: string; event_date: string }[];
    }>(
      `${TODO}/activities?${new URLSearchParams({ object_type: "item", object_id: t.id, event_type: "uncompleted", limit: "5" })}`,
      this.env.TODOIST_ACCESS_TOKEN,
    );
    return (page.results || page.events || []).some(
      (e) =>
        e.event_type === "uncompleted" &&
        Date.parse(e.event_date) > (link.updated_at || 0),
    );
  }
  /** Reactivate known history or park a future event without writing to Google. */
  private async reopenTask(link: Link, t: Task, g?: Event) {
    const value = this.plainTask(t);
    if (!value) return;
    const previous = link.todoist_snapshot && JSON.parse(link.todoist_snapshot);
    if (link.kind === "rolling" && previous && previous.start !== value.start) {
      const past = await this.db
        .prepare(
          "SELECT * FROM links WHERE mapping=? AND state='history' AND kind='history' AND task_id IS NULL AND json_extract(todoist_snapshot,'$.start')=? AND event_id IN (SELECT from_event_id FROM rolling_advances WHERE mapping=? AND task_id=? UNION SELECT to_event_id FROM rolling_advances WHERE mapping=? AND task_id=?) LIMIT 2",
        )
        .bind(link.mapping, value.start, link.mapping, t.id, link.mapping, t.id)
        .all<Link>();
      if (past.results.length !== 1) {
        await this.hold(link, "reopened_occurrence_unmatched");
        return;
      }
      const old = past.results[0],
        raw = await maybeGet<Event>(
          `${base(this.mapping)}/${encodeURIComponent(old.event_id)}`,
          this.token,
        );
      if (
        !raw ||
        raw.status === "cancelled" ||
        snapshot(eventValue(raw)) !== old.google_snapshot ||
        snapshot(value) !== old.todoist_snapshot
      ) {
        await this.hold(link, "reopened_occurrence_conflict");
        return;
      }
      await this.db.batch([
        this.db
          .prepare(
            "UPDATE links SET task_id=NULL,state='history',kind='parked' WHERE mapping=? AND event_id=? AND task_id=?",
          )
          .bind(link.mapping, link.event_id, t.id),
        this.db
          .prepare(
            "UPDATE links SET task_id=?,state='active',kind='rolling',reason=NULL,todoist_snapshot=?,task_due_rule=?,completion_cursor=?,updated_at=? WHERE mapping=? AND event_id=?",
          )
          .bind(
            t.id,
            snapshot(value),
            t.due?.string || null,
            new Date().toISOString(),
            Date.now(),
            link.mapping,
            old.event_id,
          ),
      ]);
      return;
    }
    const live =
      g ||
      (await json<Event>(
        `${base(this.mapping)}/${encodeURIComponent(link.event_id)}`,
        this.token,
      ));
    if (live.status === "cancelled") {
      await this.hold(link, "reopened_calendar_deleted");
      return;
    }
    if (
      snapshot(eventValue(live, !!link.series_id)) !== link.google_snapshot ||
      (link.kind !== "rolling" &&
        !taskValue(t, Number(this.env.DEFAULT_DURATION_MINUTES)))
    ) {
      await this.hold(link, "concurrent_reopen_change");
      return;
    }
    await this.save(link, live, t);
    if (link.kind === "rolling")
      await this.db
        .prepare(
          "UPDATE links SET completion_cursor=? WHERE mapping=? AND event_id=?",
        )
        .bind(new Date().toISOString(), link.mapping, link.event_id)
        .run();
  }
  private async completionActivities(id: string, after?: string) {
    const q = new URLSearchParams({
      object_type: "item",
      object_id: id,
      limit: "20",
      object_event_types: JSON.stringify(["item:completed"]),
      ...(after ? { date_from: after } : {}),
    });
    type Activity = {
      id?: string;
      event_type: string;
      event_date: string;
      extra_data?: {
        due_date?: string;
        has_time?: boolean;
        content?: string;
        description?: string;
      };
    };
    const page = await json<{
      results?: Activity[];
      events?: Activity[];
      next_cursor?: string;
    }>(`${TODO}/activities?${q}`, this.env.TODOIST_ACCESS_TOKEN);
    if (after && page.next_cursor) throw new Error("completion_backlog_review");
    return (page.results || page.events || [])
      .filter(
        (e) =>
          e.event_type === "completed" &&
          (!after || Date.parse(e.event_date) > Date.parse(after)),
      )
      .sort((a, b) => Date.parse(a.event_date) - Date.parse(b.event_date));
  }
  private async latestCompletion(id: string) {
    return (await this.completionActivities(id)).at(-1);
  }
  private async completedSince(link: Link, id: string): Promise<boolean> {
    const latest = await this.latestCompletion(id);
    return !!latest && Date.parse(latest.event_date) > (link.updated_at || 0);
  }
  private async createGoogleValue(
    id: string,
    value: import("./model").Value,
  ): Promise<Event> {
    try {
      return await json<Event>(
        `${base(this.mapping)}?sendUpdates=none`,
        this.token,
        {
          method: "POST",
          body: JSON.stringify({
            id,
            ...eventBody(value),
            ...(value.recurrence
              ? { recurrence: [recurrenceRule(value.recurrence)] }
              : {}),
          }),
        },
      );
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409)) throw e;
      return json<Event>(`${base(this.mapping)}/${id}`, this.token);
    }
  }
  /** Consume ordered completion identities and journal the next event, retaining every historical occurrence. */
  private async rollingTask(
    t: Task,
    link?: Link,
    completionKey?: string,
  ): Promise<void> {
    const value = this.plainTask(t);
    if (!value || t.is_deleted) return;
    if (!link || !link.google_snapshot) {
      if (
        t.checked ||
        t.is_completed ||
        t.completed_at ||
        !inHorizon(value.start, this.env)
      )
        return;
      const id = await this.deterministicId(
        `${this.mapping.id}:${t.id}:rolling:${value.start}`,
      );
      link = link || (await this.reserve(id, t.id, t));
      await this.db
        .prepare(
          "UPDATE links SET kind='rolling' WHERE mapping=? AND event_id=?",
        )
        .bind(this.mapping.id, id)
        .run();
      link.kind = "rolling";
      const original: Task = JSON.parse(
        link.initial_payload || JSON.stringify(t),
      );
      const g = await this.createGoogleValue(
        link.event_id,
        this.plainTask(original)!,
      );
      await this.save(link, g, original);
      await this.db
        .prepare(
          "UPDATE links SET completion_cursor=? WHERE mapping=? AND event_id=?",
        )
        .bind(
          new Date(link.updated_at || Date.now()).toISOString(),
          this.mapping.id,
          link.event_id,
        )
        .run();
      await this.db
        .prepare(
          "DELETE FROM issues WHERE mapping=? AND source='todoist' AND source_id=? AND reason IN ('unsupported_recurrence','recurrence_rollout_pending')",
        )
        .bind(this.mapping.id, t.id)
        .run();
      await this.env.JOBS.send({
        kind: "task",
        mapping: this.mapping.id,
        taskId: t.id,
      });
      return;
    }
    const previous = link.todoist_snapshot
      ? JSON.parse(link.todoist_snapshot)
      : null;
    // Consume activity records in order, using their native next due dates.
    // Multiple rapid completions must retain the intermediate Google events too.
    const cursor =
      link.completion_cursor || new Date(link.updated_at || 0).toISOString();
    const completions = await this.completionActivities(t.id, cursor);
    const completion = completions[0];
    let nextTask = t,
      nextValue = value;
    if (completion) {
      const extra = completion.extra_data;
      if (extra?.due_date) {
        nextTask = {
          ...t,
          content: extra.content || t.content,
          description: extra.description ?? t.description,
          due: {
            ...t.due!,
            date:
              extra.has_time === false
                ? extra.due_date.slice(0, 10)
                : extra.due_date,
            datetime: undefined,
          },
        };
        nextValue = this.plainTask(nextTask)!;
      } else if (completions.length > 1) {
        await this.hold(link, "completion_history_unavailable");
        return;
      }
      completionKey = `activity:${completion.id || completion.event_date}`;
    } else if (completionKey) {
      if (previous && previous.start !== value.start)
        throw new Error("completion_activity_pending");
      return;
    }
    if (completionKey) {
      let advance = await this.db
        .prepare(
          "SELECT * FROM rolling_advances WHERE mapping=? AND task_id=? AND completion_key=?",
        )
        .bind(this.mapping.id, t.id, completionKey)
        .first<{
          state: string;
          from_event_id: string;
          to_event_id: string;
          payload: string;
        }>();
      if (!advance) {
        let id = await this.deterministicId(
          `${this.mapping.id}:${t.id}:completion:${completionKey}`,
        );
        const parked = await this.db
          .prepare(
            "SELECT * FROM links WHERE mapping=? AND state='history' AND kind='parked' AND task_id IS NULL AND todoist_snapshot=? AND event_id IN (SELECT to_event_id FROM rolling_advances WHERE mapping=? AND task_id=?) LIMIT 1",
          )
          .bind(link.mapping, snapshot(nextValue), link.mapping, t.id)
          .first<Link>();
        if (parked) {
          const raw = await maybeGet<Event>(
            `${base(this.mapping)}/${encodeURIComponent(parked.event_id)}`,
            this.token,
          );
          if (
            raw &&
            raw.status !== "cancelled" &&
            snapshot(eventValue(raw)) === parked.google_snapshot
          )
            id = parked.event_id;
        }

        await this.db
          .prepare(
            "INSERT INTO rolling_advances(mapping,task_id,completion_key,from_event_id,to_event_id,payload,state,updated_at) VALUES(?,?,?,?,?,?,'pending',?)",
          )
          .bind(
            this.mapping.id,
            t.id,
            completionKey,
            link.event_id,
            id,
            JSON.stringify({
              value: nextValue,
              task: nextTask,
              completedAt: completion!.event_date,
            }),
            Date.now(),
          )
          .run();
        advance = {
          state: "pending",
          from_event_id: link.event_id,
          to_event_id: id,
          payload: JSON.stringify({
            value: nextValue,
            task: nextTask,
            completedAt: completion!.event_date,
          }),
        };
      }
      if (advance.state !== "done") {
        const plan = JSON.parse(advance.payload);
        const g = await this.createGoogleValue(advance.to_event_id, plan.value);
        await this.db.batch([
          this.db
            .prepare(
              "UPDATE links SET task_id=NULL,state='history',kind='history',reason=NULL WHERE mapping=? AND event_id=? AND task_id=?",
            )
            .bind(this.mapping.id, advance.from_event_id, t.id),
          this.db
            .prepare(
              "INSERT INTO links(mapping,event_id,task_id,request_id,state,kind,google_snapshot,todoist_snapshot,task_due_rule,completion_cursor,updated_at) VALUES(?,?,?,?,'active','rolling',?,?,?,?,?) ON CONFLICT(mapping,event_id) DO UPDATE SET task_id=excluded.task_id,state='active',kind='rolling',reason=NULL,google_snapshot=excluded.google_snapshot,todoist_snapshot=excluded.todoist_snapshot,task_due_rule=excluded.task_due_rule,completion_cursor=excluded.completion_cursor,updated_at=excluded.updated_at WHERE links.state='history' AND links.kind='parked' AND links.task_id IS NULL",
            )
            .bind(
              this.mapping.id,
              g.id,
              t.id,
              crypto.randomUUID(),
              snapshot(eventValue(g)),
              snapshot(plan.value),
              t.due?.string || null,
              plan.completedAt,
              Date.now(),
            ),
          this.db
            .prepare(
              "UPDATE rolling_advances SET state='done',updated_at=? WHERE mapping=? AND task_id=? AND completion_key=?",
            )
            .bind(Date.now(), this.mapping.id, t.id, completionKey),
        ]);
        await this.env.JOBS.send({
          kind: "task",
          mapping: this.mapping.id,
          taskId: t.id,
        });
        return;
      }
      return;
    }
    await this.pair(link);
  }
  /** Distinguish future rule changes from single-occurrence overrides; preserve past Google instances. */
  private async recurringTaskEdit(
    link: Link,
    g: Event,
    t: Task,
    completionKey?: string,
  ): Promise<boolean> {
    if (!link.google_snapshot || !link.todoist_snapshot) return false;
    const previousGoogle = JSON.parse(link.google_snapshot),
      previousTask = JSON.parse(link.todoist_snapshot);
    if (!previousGoogle?.recurrence || !previousTask?.recurrence) return false;
    const native = taskValue(t, Number(this.env.DEFAULT_DURATION_MINUTES)),
      plain = this.plainTask(t);
    if (!plain) return false;
    const clock = (v: import("./model").Value) =>
      localParts(v.start, previousTask.recurrence.timezone).time;
    const anchored = taskValue(
      {
        ...t,
        due: {
          ...t.due!,
          date: previousTask.start,
          ...(t.due?.datetime ? { datetime: previousTask.start } : {}),
        },
      },
      Number(this.env.DEFAULT_DURATION_MINUTES),
    );
    const generic =
      /^every (?:(?:[0-9]+) )?(?:day|days|week|weeks|month|months|year|years)(?: at .*)?$/i.test(
        t.due?.string || "",
      );
    const currentDate = localParts(
      plain.start,
      previousTask.recurrence.timezone,
    ).date;
    const oldDate = localParts(
      previousTask.start,
      previousTask.recurrence.timezone,
    ).date;
    const ruleChanged =
      (!!link.task_due_rule && link.task_due_rule !== t.due?.string) ||
      (!!native &&
        JSON.stringify(native.recurrence) !==
          JSON.stringify(previousTask.recurrence)) ||
      !anchored ||
      (generic && clock(plain) !== clock(previousTask)) ||
      (generic &&
        (previousTask.recurrence.frequency === "MONTHLY"
          ? currentDate.slice(8) !== oldDate.slice(8)
          : previousTask.recurrence.frequency === "YEARLY" &&
            currentDate.slice(5) !== oldDate.slice(5)));
    const changed =
      ruleChanged ||
      !native ||
      clock(plain) !== clock(previousTask) ||
      Date.parse(plain.end) - Date.parse(plain.start) !==
        Date.parse(previousTask.end) - Date.parse(previousTask.start) ||
      plain.start !== previousTask.start;
    if (!changed) return false;
    if (snapshot(eventValue(g)) !== link.google_snapshot) {
      await this.hold(link, "concurrent_schedule_edits");
      return true;
    }
    if (
      !ruleChanged &&
      native &&
      clock(plain) === clock(previousTask) &&
      plain.start !== previousTask.start &&
      (completionKey || (await this.completedSince(link, t.id)))
    )
      return false;
    if (ruleChanged) {
      const toId = await this.deterministicId(
        `${this.mapping.id}:${t.id}:split:${previousTask.start}:${t.due?.string}:${plain.start}`,
      );
      let cutoff = new Date(
        Date.parse(completionKey ? plain.start : previousTask.start) - 1000,
      )
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z");
      if (g.start?.date) cutoff = cutoff.slice(0, 8);
      const plan = {
        toId,
        task: t,
        value: native || plain,
        old: g,
        cutoff,
        retire:
          Date.parse(previousTask.start) <= Date.parse(previousGoogle.start),
        kind: native ? "normal" : "rolling",
      };
      await this.db
        .prepare(
          "INSERT INTO operations(mapping,event_id,kind,request_id,state,payload,updated_at) VALUES(?,?,'split',?,'pending',?,?) ON CONFLICT(mapping,event_id) DO UPDATE SET kind='split',state='pending',payload=excluded.payload,updated_at=excluded.updated_at",
        )
        .bind(
          this.mapping.id,
          link.event_id,
          crypto.randomUUID(),
          JSON.stringify(plan),
          Date.now(),
        )
        .run();
      await this.finishSplit(link, plan);
      return true;
    }
    // A native due override changes one occurrence. Materialize the series so
    // later occurrences retain their own exception identities in Todoist.
    const q = new URLSearchParams({
      originalStart: previousTask.allDay
        ? previousTask.start + "T00:00:00Z"
        : previousTask.start,
      maxResults: "5",
      showDeleted: "false",
    });
    const page = await json<{ items: Event[] }>(
      `${base(this.mapping)}/${encodeURIComponent(g.id)}/instances?${q}`,
      this.token,
    );
    const instance = page.items[0];
    if (!instance) {
      await this.hold(link, "recurring_override_missing");
      return true;
    }
    const before = eventValue(instance, true),
      expected = {
        ...previousGoogle,
        start: previousTask.start,
        end: new Date(
          Date.parse(previousTask.start) +
            Date.parse(previousGoogle.end) -
            Date.parse(previousGoogle.start),
        ).toISOString(),
        recurrence: undefined,
      };
    if (previousTask.allDay)
      expected.end = new Date(Date.parse(expected.end))
        .toISOString()
        .slice(0, 10);
    const simple = (v: import("./model").Value) =>
      JSON.stringify({
        title: v.title,
        description: v.description,
        start: v.start,
        end: v.end,
        allDay: v.allDay,
      });
    const desired = { ...plain };
    if (!t.duration && !desired.allDay)
      desired.end = new Date(
        Date.parse(desired.start) +
          Date.parse(previousGoogle.end) -
          Date.parse(previousGoogle.start),
      ).toISOString();
    if (
      !before ||
      (simple(before) !== simple(expected) &&
        simple(before) !== simple(desired))
    ) {
      await this.hold(link, "concurrent_schedule_edits");
      return true;
    }
    await json<Event>(
      `${base(this.mapping)}/${encodeURIComponent(instance.id)}?sendUpdates=none`,
      this.token,
      {
        method: "PATCH",
        headers: instance.etag ? { "If-Match": instance.etag } : {},
        body: JSON.stringify(eventBody(desired)),
      },
    );
    await this.prepareProjection(g.id, g, t);
    return true;
  }
  /** Resume a journaled future-rule split, recognizing an already-trimmed or retired old series. */
  private async finishSplit(
    link: Link,
    plan: {
      toId: string;
      task: Task;
      value: import("./model").Value;
      old: Event;
      cutoff: string;
      retire?: boolean;
      kind: string;
    },
  ): Promise<void> {
    const current = await maybeGet<Task>(
      `${TODO}/tasks/${encodeURIComponent(plan.task.id)}`,
      this.env.TODOIST_ACCESS_TOKEN,
    );
    if (!current || current.project_id !== this.mapping.todoistProjectId) {
      await this.hold(link, "split_task_missing_or_moved");
      return;
    }
    const live = await maybeGet<Event>(
      `${base(this.mapping)}/${encodeURIComponent(link.event_id)}`,
      this.token,
    );
    const recurrence = [
      recurrenceRule(JSON.parse(link.google_snapshot!).recurrence) +
        ";UNTIL=" +
        plan.cutoff,
    ];
    if (plan.retire) {
      if (live && live.status !== "cancelled") {
        if (live.etag !== plan.old.etag) {
          await this.hold(link, "concurrent_schedule_edits");
          return;
        }
        await json(
          `${base(this.mapping)}/${encodeURIComponent(link.event_id)}?sendUpdates=none`,
          this.token,
          {
            method: "DELETE",
            headers: live.etag ? { "If-Match": live.etag } : {},
          },
        );
      }
    } else if (!live || live.status === "cancelled") {
      await this.hold(link, "concurrent_delete_rule_edit");
      return;
    } else if (JSON.stringify(live.recurrence) !== JSON.stringify(recurrence)) {
      if (live.etag !== plan.old.etag) {
        await this.hold(link, "concurrent_schedule_edits");
        return;
      }
      await json<Event>(
        `${base(this.mapping)}/${encodeURIComponent(link.event_id)}?sendUpdates=none`,
        this.token,
        {
          method: "PATCH",
          headers: live.etag ? { "If-Match": live.etag } : {},
          body: JSON.stringify({ recurrence }),
        },
      );
    }
    const g = await this.createGoogleValue(plan.toId, plan.value);
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE links SET task_id=NULL,state='history',kind='history',reason=NULL WHERE mapping=? AND event_id=?",
        )
        .bind(this.mapping.id, link.event_id),
      this.db
        .prepare(
          "INSERT INTO links(mapping,event_id,task_id,request_id,state,kind,google_snapshot,todoist_snapshot,task_due_rule,updated_at) VALUES(?,?,?,?,'active',?,?,?,?,?)",
        )
        .bind(
          this.mapping.id,
          g.id,
          current.id,
          crypto.randomUUID(),
          plan.kind,
          snapshot(eventValue(g)),
          snapshot(plan.value),
          current.due?.string || null,
          Date.now(),
        ),
      this.db
        .prepare(
          "UPDATE operations SET state='done',updated_at=? WHERE mapping=? AND event_id=?",
        )
        .bind(Date.now(), this.mapping.id, link.event_id),
    ]);
  }
  /** Stage native-to-occurrence conversion without losing the existing task or completed cursor. */
  private async prepareProjection(
    id: string,
    master?: Event,
    acceptedTask?: Task,
  ): Promise<void> {
    if (!this.mapping.complexRecurrence) return;
    const g =
      master ||
      (await json<Event>(
        `${base(this.mapping)}/${encodeURIComponent(id)}`,
        this.token,
      ));
    if (g.eventType && g.eventType !== "default") return;
    let link = await this.db
      .prepare("SELECT * FROM links WHERE mapping=? AND event_id=?")
      .bind(this.mapping.id, id)
      .first<Link>();
    if (!link && this.mapping.mappedMoves && g.status !== "cancelled") {
      const prior = await this.db
        .prepare(
          "SELECT * FROM links WHERE (event_id=? OR (ical_uid=? AND series_id IS NULL)) AND mapping!=? AND state NOT IN ('deleted','moved','history')",
        )
        .bind(id, g.iCalUID || null, this.mapping.id)
        .first<Link>();
      const source =
        prior &&
        mappings(this.env).find(
          (m) => m.id === prior.mapping && m.enabled !== false && m.mappedMoves,
        );
      if (
        prior &&
        source &&
        (await moveFromGoogle(
          { ...this.actions, mapping: source },
          prior,
          this.mapping,
          g,
        ))
      )
        return;
    }
    if (link && ["deleted", "moved", "history"].includes(link.state)) return;
    if (!link && (await findCopySource(this.actions, g))) return;
    if (!link && (await this.guarded("google", id))) return;
    const pending = await this.db
      .prepare("SELECT state FROM series WHERE mapping=? AND event_id=?")
      .bind(this.mapping.id, id)
      .first<{ state: string }>();
    if (pending?.state === "held") return;

    if (
      link?.state === "held" &&
      ![
        "recurring_instance_exception",
        "recurring_schedule_edit",
        "unsupported_calendar_change",
      ].includes(link.reason || "")
    )
      return;
    if (!link) link = await this.reserve(id, null, g);
    if (g.status !== "cancelled")
      await this.db
        .prepare(
          "UPDATE links SET google_payload=?,ical_uid=COALESCE(?,ical_uid) WHERE mapping=? AND event_id=?",
        )
        .bind(JSON.stringify(g), g.iCalUID || null, this.mapping.id, id)
        .run();
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO series(mapping,event_id,state,conversion_task_id,conversion_original,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        this.mapping.id,
        id,
        link.task_id ? "planning" : "ready",
        link.task_id,
        acceptedTask ? JSON.stringify(acceptedTask) : null,
        Date.now(),
      )
      .run();
    if (g.status === "cancelled") {
      if (await findGoogleMove(this.actions, link, true)) return;
      if (link.task_id) await this.deleteAfterGoogleCancellation(link);
      await this.db
        .prepare(
          "UPDATE series SET state='deleting',updated_at=? WHERE mapping=? AND event_id=?",
        )
        .bind(Date.now(), this.mapping.id, id)
        .run();
    } else if (link.task_id) {
      if (!(await this.convertProjection(link))) return;
    }
    await this.db
      .prepare(
        "UPDATE links SET kind='series',state='series',reason=NULL WHERE mapping=? AND event_id=? AND task_id IS NULL",
      )
      .bind(this.mapping.id, id)
      .run();
    await this.db
      .prepare(
        "DELETE FROM issues WHERE mapping=? AND source='google' AND source_id=?",
      )
      .bind(this.mapping.id, id)
      .run();
    await this.env.JOBS.send({
      kind: "series",
      mapping: this.mapping.id,
      eventId: id,
    });
  }
  private async pauseProjection(link: Link, reason: string) {
    await this.hold(link, reason);
    await this.db
      .prepare(
        "UPDATE series SET state='held',updated_at=? WHERE mapping=? AND event_id=?",
      )
      .bind(Date.now(), link.mapping, link.event_id)
      .run();
  }
  /** Resume a durable conversion across due-object updates and D1 link reassignment. */
  private async convertProjection(link: Link): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT * FROM series WHERE mapping=? AND event_id=?")
      .bind(this.mapping.id, link.event_id)
      .first<{
        state: string;
        conversion_original: string | null;
        conversion_event: string | null;
        lower_bound: string | null;
      }>();
    if (!row) return false;
    let t = await maybeGet<Task>(
      `${TODO}/tasks/${encodeURIComponent(link.task_id!)}`,
      this.env.TODOIST_ACCESS_TOKEN,
    );
    if (!t) {
      await this.pauseProjection(link, "series_task_missing");
      return false;
    }
    if (t.project_id !== this.mapping.todoistProjectId) {
      await this.pauseProjection(link, "project_move");
      return false;
    }
    const plain = (task: Task) =>
      taskValue(
        {
          ...task,
          due: task.due ? { ...task.due, is_recurring: false } : null,
        },
        Number(this.env.DEFAULT_DURATION_MINUTES),
      );
    let target: Event | null;
    if (row.state === "planning") {
      const current = plain(t),
        previous = row.conversion_original
          ? plain(JSON.parse(row.conversion_original))
          : link.todoist_snapshot
            ? JSON.parse(link.todoist_snapshot)
            : null;
      if (
        !current ||
        !previous ||
        current.title !== previous.title ||
        current.description !== previous.description
      ) {
        await this.pauseProjection(link, "projection_conversion_conflict");
        return false;
      }
      const anchor =
        row.conversion_original && link.todoist_snapshot
          ? JSON.parse(link.todoist_snapshot)
          : current;
      const exact = new URLSearchParams({
        originalStart: anchor.allDay
          ? anchor.start + "T00:00:00Z"
          : anchor.start,
        maxResults: "5",
        showDeleted: "false",
      });
      let page = await json<{ items?: Event[]; nextPageToken?: string }>(
        `${base(this.mapping)}/${encodeURIComponent(link.event_id)}/instances?${exact}`,
        this.token,
      );
      target = page.items?.find((e) => e.status !== "cancelled") || null;
      if (!target) {
        const query = new URLSearchParams({
          timeMin: current.allDay
            ? current.start + "T00:00:00Z"
            : current.start,
          maxResults: "5",
          showDeleted: "false",
        });
        page = await json(
          `${base(this.mapping)}/${encodeURIComponent(link.event_id)}/instances?${query}`,
          this.token,
        );
        target = page.items?.find((e) => e.status !== "cancelled") || null;
        if (!target && page.nextPageToken) {
          await this.pauseProjection(link, "projection_candidate_needs_review");
          return false;
        }
      }
      const lower =
        target?.originalStartTime?.dateTime ||
        target?.originalStartTime?.date ||
        target?.start?.dateTime ||
        target?.start?.date ||
        current.start;
      await this.db
        .prepare(
          "UPDATE series SET state='converting',conversion_original=?,conversion_event=?,lower_bound=?,updated_at=? WHERE mapping=? AND event_id=?",
        )
        .bind(
          JSON.stringify(t),
          JSON.stringify(target),
          lower,
          Date.now(),
          this.mapping.id,
          link.event_id,
        )
        .run();
    } else target = JSON.parse(row.conversion_event || "null");
    const original: Task = JSON.parse(
      row.conversion_original || JSON.stringify(t),
    );
    if (target) {
      const desired = eventValue(target, true);
      if (!desired) {
        await this.pauseProjection(link, "unsupported_instance");
        return false;
      }
      const current = plain(t),
        initial = plain(original);
      const fields = (v: import("./model").Value | null) =>
        v &&
        JSON.stringify({
          title: v.title,
          description: v.description,
          start: v.start,
          allDay: v.allDay,
        });
      if (
        fields(current) !== fields(initial) &&
        fields(current) !== fields(desired)
      ) {
        await this.pauseProjection(link, "projection_conversion_conflict");
        return false;
      }
      if (t.due?.is_recurring)
        t = await updateRecurringTask(this.env, t.id, {
          date: desired.start,
          timezone: target.start?.timeZone || "Europe/London",
          is_recurring: false,
          string: desired.start,
        });
      t = await json<Task>(
        `${TODO}/tasks/${encodeURIComponent(t.id)}`,
        this.env.TODOIST_ACCESS_TOKEN,
        { method: "POST", body: JSON.stringify(taskBody(desired)) },
      );
      if (
        t.due?.is_recurring ||
        !plain(t) ||
        plain(t)!.start !== desired.start
      ) {
        await this.pauseProjection(link, "projection_conversion_not_accepted");
        return false;
      }
      await this.db.batch([
        this.db
          .prepare(
            "UPDATE links SET task_id=NULL,kind='series',state='series',reason=NULL,initial_payload=NULL WHERE mapping=? AND event_id=?",
          )
          .bind(this.mapping.id, link.event_id),
        this.db
          .prepare(
            "INSERT INTO links(mapping,event_id,task_id,request_id,state,google_snapshot,todoist_snapshot,series_id,kind,completed,updated_at) VALUES(?,?,?,?,'active',?,?,?,'occurrence',?,?)",
          )
          .bind(
            this.mapping.id,
            target.id,
            t.id,
            crypto.randomUUID(),
            snapshot(desired),
            snapshot(plain(t)),
            link.event_id,
            t.checked || t.completed_at ? 1 : 0,
            Date.now(),
          ),
        this.db
          .prepare(
            "UPDATE series SET state='ready',conversion_task_id=NULL,conversion_original=NULL,conversion_event=NULL,updated_at=? WHERE mapping=? AND event_id=?",
          )
          .bind(Date.now(), this.mapping.id, link.event_id),
      ]);
    } else {
      await deleteTask(this.env, t.id);
      await this.db.batch([
        this.db
          .prepare(
            "UPDATE links SET task_id=NULL,kind='series',state='series',reason=NULL,initial_payload=NULL WHERE mapping=? AND event_id=?",
          )
          .bind(this.mapping.id, link.event_id),
        this.db
          .prepare(
            "INSERT INTO links(mapping,event_id,task_id,request_id,state,reason,kind,updated_at) VALUES(?,?,?,?,'deleted','series_ended','normal',?)",
          )
          .bind(
            this.mapping.id,
            "retired:" + link.event_id,
            t.id,
            crypto.randomUUID(),
            Date.now(),
          ),
        this.db
          .prepare(
            "UPDATE series SET state='ready',conversion_task_id=NULL,conversion_original=NULL,conversion_event=NULL,updated_at=? WHERE mapping=? AND event_id=?",
          )
          .bind(Date.now(), this.mapping.id, link.event_id),
      ]);
    }
    return true;
  }
  /** Expand or retire one bounded occurrence page using Google's own recurrence/exception identities. */
  async seriesPage(job: Extract<Job, { kind: "series" }>): Promise<boolean> {
    const master = await json<Event>(
      `${base(this.mapping)}/${encodeURIComponent(job.eventId)}`,
      this.token,
    );
    const row = await this.db
      .prepare(
        "SELECT state,lower_bound FROM series WHERE mapping=? AND event_id=?",
      )
      .bind(this.mapping.id, job.eventId)
      .first<{ state: string; lower_bound: string | null }>();
    if (!row || row.state === "held") return true;
    if (["planning", "converting"].includes(row.state)) {
      await this.prepareProjection(job.eventId, master);
      return false;
    }
    if (master.status === "cancelled") {
      const link = await this.db
        .prepare("SELECT * FROM links WHERE mapping=? AND event_id=?")
        .bind(this.mapping.id, master.id)
        .first<Link>();
      if (link && (await findGoogleMove(this.actions, link, true))) return true;
    }
    if (master.status === "cancelled") {
      const links = await this.db
        .prepare(
          "SELECT * FROM links WHERE mapping=? AND series_id=? AND state NOT IN ('deleted','moved','history') AND event_id>? ORDER BY event_id LIMIT 5",
        )
        .bind(this.mapping.id, job.eventId, job.after || "")
        .all<Link>();
      for (const child of links.results)
        await this.deleteAfterGoogleCancellation(child, master);
      if (links.results.length === 5) {
        await this.env.JOBS.send({ ...job, after: links.results[4].event_id });
        return false;
      }
      await this.db.batch([
        this.db
          .prepare(
            "UPDATE links SET state='deleted',reason='series_deleted',updated_at=? WHERE mapping=? AND event_id=?",
          )
          .bind(Date.now(), this.mapping.id, job.eventId),
        this.db
          .prepare(
            "UPDATE series SET state='deleted',updated_at=? WHERE mapping=? AND event_id=?",
          )
          .bind(Date.now(), this.mapping.id, job.eventId),
      ]);
      return true;
    }
    const window = job.window || horizon(this.env);
    const query = new URLSearchParams({
      timeMin: window.timeMin,
      timeMax: window.timeMax,
      showDeleted: "true",
      maxResults: "5",
    });
    if (job.page) query.set("pageToken", job.page);
    const page = await json<{ items?: Event[]; nextPageToken?: string }>(
      `${base(this.mapping)}/${encodeURIComponent(job.eventId)}/instances?${query}`,
      this.token,
    );
    for (const item of page.items || []) {
      const existing = await this.db
        .prepare("SELECT event_id FROM links WHERE mapping=? AND event_id=?")
        .bind(this.mapping.id, item.id)
        .first();
      const original =
        item.originalStartTime?.dateTime ||
        item.originalStartTime?.date ||
        item.start?.dateTime ||
        item.start?.date;
      if (
        !existing &&
        row.lower_bound &&
        original &&
        Date.parse(original) < Date.parse(row.lower_bound)
      )
        continue;
      if (!existing) {
        const budget = await this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM links WHERE mapping=? AND kind='occurrence' AND state='active' AND completed=0",
          )
          .bind(this.mapping.id)
          .first<{ count: number }>();
        if ((budget?.count || 0) >= 200) {
          await this.issue("google", job.eventId, "occurrence_budget");
          return true;
        }
      }
      await this.event(item, true);
    }
    if (page.nextPageToken) {
      const count = (job.count || 0) + (page.items?.length || 0);
      if (count >= 200) {
        await this.issue("google", job.eventId, "occurrence_budget");
        return true;
      }
      await this.env.JOBS.send({
        ...job,
        page: page.nextPageToken,
        window,
        count,
      });
      return false;
    }
    await this.db
      .prepare(
        "DELETE FROM issues WHERE mapping=? AND source='google' AND source_id=? AND reason='occurrence_budget'",
      )
      .bind(this.mapping.id, job.eventId)
      .run();
    return true;
  }
  /** Renew a Google push channel before expiry; persist channel identity before watch creation can notify. */
  async renew(): Promise<void> {
    const active = await this.db
      .prepare("SELECT id FROM channels WHERE mapping=? AND expires>?")
      .bind(this.mapping.id, Date.now() + 86400000)
      .first();
    if (active) return;
    const id = crypto.randomUUID();
    // Persist before watch: Google's initial sync notification may beat the watch response.
    await this.db
      .prepare("INSERT INTO channels(id,mapping,expires) VALUES(?,?,?)")
      .bind(id, this.mapping.id, Date.now() + 300000)
      .run();
    const result = await json<{ resourceId: string; expiration: string }>(
      `${base(this.mapping)}/watch`,
      this.token,
      {
        method: "POST",
        body: JSON.stringify({
          id,
          type: "web_hook",
          address: `${this.env.PUBLIC_URL}/webhooks/google`,
          token: this.env.GOOGLE_CHANNEL_SECRET,
          params: { ttl: "604800" },
        }),
      },
    );
    await this.db
      .prepare("UPDATE channels SET resource_id=?,expires=? WHERE id=?")
      .bind(result.resourceId, Number(result.expiration), id)
      .run();
  }
}
/** Resolve credentials and dispatch bounded queued work; return true only when the logical scan is complete. */
export async function processJob(
  env: Env,
  m: Mapping,
  job: Job,
): Promise<boolean> {
  if (job.kind === "notify") {
    await notify(env, job.test, job.testId);
    return true;
  }
  const fingerprint = async (value: string) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
      ),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  if (job.kind === "verify-token") {
    const readback = JSON.parse(await env.TODOIST_TOKENS.get());
    if ((await fingerprint(readback.access_token)) !== job.fingerprint)
      throw new Error("token_store_propagation_pending");
    console.info(JSON.stringify({ code: "todoist_token_readback_verified" }));
    return true;
  }
  if (job.kind === "refresh-token") {
    const fresh = await todoistToken(env, true);
    // A second get() in this invocation may return its first value. Verify in a
    // separate invocation; the queued digest cannot be used as a credential.
    await env.JOBS.send({
      kind: "verify-token",
      mapping: m.id,
      fingerprint: await fingerprint(fresh),
    });
    console.info(JSON.stringify({ code: "todoist_token_rotated" }));
    return true;
  }
  const runtimeEnv = { ...env, TODOIST_ACCESS_TOKEN: await todoistToken(env) };
  const calendarToken = await googleToken(env);
  const sync = new Sync(runtimeEnv, m, calendarToken);
  if (job.kind === "series") return sync.seriesPage(job);
  if (job.kind === "migration") await sync.prepareMigration(job.plan);
  if (job.kind === "google" || job.kind === "window")
    return sync.googlePage(job);
  if (job.kind === "task")
    await sync.task(job.taskId, job.deleted, job.completionKey, job.reopened);
  if (job.kind === "tasks") return sync.taskPage(job.cursor);
  if (job.kind === "links") return sync.linkedPage(job.after);
  if (job.kind === "event")
    await sync.event(
      await json<Event>(
        `${base(m)}/${encodeURIComponent(job.eventId)}`,
        calendarToken,
      ),
    );
  if (job.kind === "renew") await sync.renew();
  return true;
}
