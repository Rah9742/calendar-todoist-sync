/** Provider shapes, canonical synchronized values and snapshot decisions. Unsupported values return null instead of guessed schedules. */
import {
  googleRecurrence,
  localParts,
  todoistRecurrence,
  zonedInstant,
  type Recurrence,
} from "./recurrence";
/** An explicit calendar/project pair; propagation flags are opt-in and labels are stable internal identities. */
export interface Mapping {
  enabled?: boolean;
  extendedRecurrence?: boolean;
  deleteTasksOnGoogleDeletion?: boolean;
  deleteGoogleOnTaskDeletion?: boolean;
  mappedMoves?: boolean;
  complexRecurrence?: boolean;
  id: string;
  googleCalendarId: string;
  todoistProjectId: string;
}
export interface Event {
  id: string;
  iCalUID?: string;
  created?: string;
  updated?: string;
  summary?: string;
  description?: string;
  status?: string;
  etag?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: { date?: string; dateTime?: string; timeZone?: string };
  eventType?: string;
  location?: string;
  attendees?: {
    email?: string;
    optional?: boolean;
    self?: boolean;
    responseStatus?: string;
  }[];
}
export interface Task {
  id: string;
  project_id: string;
  content: string;
  description?: string;
  checked?: boolean;
  is_completed?: boolean;
  completed_at?: string | null;
  is_deleted?: boolean;
  due?: {
    date: string;
    datetime?: string;
    timezone?: string | null;
    is_recurring?: boolean;
    string?: string;
  } | null;
  duration?: { amount: number; unit: string } | null;
}
/** Canonical synchronized fields only; provider metadata outside this surface is preserved separately. */
export interface Value {
  title: string;
  description: string;
  start: string;
  end: string;
  allDay: boolean;
  recurrence?: Recurrence;
}
/** Durable counterpart identity, independent baselines and recovery state; raw payloads are private data. */
export interface Link {
  mapping: string;
  event_id: string;
  task_id: string | null;
  request_id: string;
  initial_payload: string | null;
  google_snapshot: string | null;
  todoist_snapshot: string | null;
  state: string;
  reason?: string | null;
  ical_uid?: string | null;
  google_payload?: string | null;
  completion_cursor?: string | null;
  series_id?: string | null;
  kind?: string;
  task_due_rule?: string | null;
  updated_at?: number;
}
/** Bounded serialized work. Carry identifiers/cursors here, never OAuth tokens. */
export type Job =
  | { kind: "event"; mapping: string; eventId: string }
  | {
      kind: "series";
      mapping: string;
      eventId: string;
      page?: string;
      after?: string;
      count?: number;
      window?: CalendarWindow;
    }
  | { kind: "notify"; mapping: string; test?: boolean; testId?: string }
  | { kind: "migration"; mapping: string; plan: MigrationPlan }
  | {
      kind: "google";
      mapping: string;
      page?: string;
      token?: string;
      window?: CalendarWindow;
    }
  | { kind: "window"; mapping: string; page?: string; window?: CalendarWindow }
  | {
      kind: "task";
      mapping: string;
      taskId: string;
      completionKey?: string;
      reopened?: boolean;
      deleted?: boolean;
    }
  | { kind: "tasks"; mapping: string; cursor?: string }
  | { kind: "links"; mapping: string; after?: string }
  | { kind: "renew"; mapping: string }
  | { kind: "refresh-token"; mapping: string }
  | { kind: "verify-token"; mapping: string; fingerprint: string };
export interface MigrationPlan {
  pairs: { eventId: string; taskId: string; authority?: "google" }[];
  guards: { source: "google" | "todoist"; id: string }[];
}
/** Validate explicit one-to-one mappings; reject duplicate endpoints or malformed policy flags. */
export function mappings(env: Env): Mapping[] {
  const values: Mapping[] = JSON.parse(env.MAPPINGS_JSON);
  const calendars = new Set<string>(),
    projects = new Set<string>(),
    ids = new Set<string>();
  for (const m of values) {
    if (
      !m.id ||
      !m.googleCalendarId ||
      !m.todoistProjectId ||
      (m.enabled !== undefined && typeof m.enabled !== "boolean") ||
      (m.extendedRecurrence !== undefined &&
        typeof m.extendedRecurrence !== "boolean") ||
      (m.deleteTasksOnGoogleDeletion !== undefined &&
        typeof m.deleteTasksOnGoogleDeletion !== "boolean") ||
      [m.deleteGoogleOnTaskDeletion, m.mappedMoves, m.complexRecurrence].some(
        (v) => v !== undefined && typeof v !== "boolean",
      ) ||
      ids.has(m.id) ||
      calendars.has(m.googleCalendarId) ||
      projects.has(m.todoistProjectId)
    )
      throw new Error("invalid_mappings");
    ids.add(m.id);
    calendars.add(m.googleCalendarId);
    projects.add(m.todoistProjectId);
  }
  return values;
}
/** Normalize the synchronized Google surface. Instances require the explicit occurrence path; unsupported input returns null. */
export function eventValue(e: Event, occurrence = false): Value | null {
  if (
    e.status === "cancelled" ||
    (e.recurrence?.length && !googleRecurrence(e)) ||
    (e.recurringEventId && !occurrence) ||
    (e.eventType && e.eventType !== "default") ||
    e.attendees?.some((a) => a.self && a.responseStatus === "declined")
  )
    return null;
  const start = e.start?.date || e.start?.dateTime,
    end = e.end?.date || e.end?.dateTime;
  if (!start || !end) return null;
  return {
    title: e.summary || "(Untitled)",
    description: e.description || "",
    start: e.start?.date ? start : new Date(start).toISOString(),
    end: e.end?.date ? end : new Date(end).toISOString(),
    allDay: !!e.start?.date,
    ...(e.recurrence?.length ? { recurrence: googleRecurrence(e)! } : {}),
  };
}
/** Normalize a scheduled task and its duration/timezone; unsupported or undated input returns null. */
export function taskValue(t: Task, minutes: number): Value | null {
  if (!t.due || (t.due.is_recurring && !todoistRecurrence(t))) return null;
  const recurrence = t.due.is_recurring ? todoistRecurrence(t)! : undefined;
  const start = zonedInstant(
    t.due.datetime || t.due.date,
    t.due.timezone || "Europe/London",
  );
  if (!start) return null;
  const allDay = !start.includes("T");
  const duration = t.duration
    ? t.duration.amount * (t.duration.unit === "day" ? 1440 : 1)
    : minutes;
  return {
    title: t.content,
    description: t.description || "",
    start: allDay ? start : new Date(start).toISOString(),
    end: allDay
      ? new Date(Date.parse(start) + 86400000).toISOString().slice(0, 10)
      : new Date(Date.parse(start) + duration * 60000).toISOString(),
    allDay,
    ...(recurrence ? { recurrence } : {}),
  };
}
/** Encode ordinary Todoist update fields; native recurring due objects use their dedicated path. */
export function taskBody(v: Value) {
  return {
    content: v.title,
    description: v.description,
    due_date: v.allDay ? v.start : undefined,
    due_datetime: v.allDay ? undefined : v.start,
    duration: v.allDay
      ? null
      : Math.max(
          1,
          Math.round((Date.parse(v.end) - Date.parse(v.start)) / 60000),
        ),
    duration_unit: v.allDay ? null : "minute",
  };
}
/** Encode only the synchronized Google fields, preserving unrelated provider metadata on PATCH. */
export function eventBody(v: Value) {
  return {
    summary: v.title,
    description: v.description,
    start: v.allDay
      ? { date: v.start }
      : {
          dateTime: v.start,
          ...(v.recurrence ? { timeZone: v.recurrence.timezone } : {}),
        },
    end: v.allDay
      ? { date: v.end }
      : {
          dateTime: v.end,
          ...(v.recurrence ? { timeZone: v.recurrence.timezone } : {}),
        },
  };
}
export const snapshot = (v: Value | null) => JSON.stringify(v);
/** Compare each provider with its own baseline; conflicting edits require review rather than choosing a winner. */
export function direction(
  link: Link,
  g: Value,
  t: Value,
): "google" | "todoist" | "conflict" | "none" {
  const gc = snapshot(g) !== link.google_snapshot,
    tc = snapshot(t) !== link.todoist_snapshot;
  if (gc && tc) return snapshot(g) === snapshot(t) ? "none" : "conflict";
  return gc ? "google" : tc ? "todoist" : "none";
}

export interface CalendarWindow {
  start: string;
  end: string;
  timeMin: string;
  timeMax: string;
}
const londonDate = (instant: number | string) =>
  localParts(new Date(instant).toISOString(), "Europe/London").date;
/** Compute exclusive discovery bounds by London calendar dates; this is not a limit on existing links. */
export function horizon(env: Env, now = Date.now()): CalendarWindow {
  if (!env.HORIZON_DAYS)
    return {
      start: env.IMPORT_START,
      end: env.IMPORT_END,
      timeMin: `${env.IMPORT_START}T00:00:00Z`,
      timeMax: `${env.IMPORT_END}T00:00:00Z`,
    };
  const start = londonDate(now);
  // Calendar-day arithmetic, followed by conversion of each London midnight,
  // keeps the window correct across both DST transitions.
  const end = new Date(Date.parse(start) + Number(env.HORIZON_DAYS) * 86400000)
    .toISOString()
    .slice(0, 10);
  return {
    start,
    end,
    timeMin: zonedInstant(`${start}T00:00:00`, "Europe/London")!,
    timeMax: zonedInstant(`${end}T00:00:00`, "Europe/London")!,
  };
}
/** Check eligibility for new imports without changing an existing link or its completion cursor. */
export function inHorizon(start: string, env: Env): boolean {
  const window = horizon(env);
  const date =
    env.HORIZON_DAYS && start.includes("T") ? londonDate(start) : start;
  return date >= window.start && date < window.end;
}

/** Fail closed before writes when required runtime settings are invalid. */
export function assertReady(env: Env): void {
  if (
    env.HORIZON_DAYS &&
    (!/^\d+$/.test(env.HORIZON_DAYS) ||
      Number(env.HORIZON_DAYS) < 1 ||
      Number(env.HORIZON_DAYS) > 366)
  )
    throw new Error("configure_rolling_horizon");
  const validDate = (v: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    !Number.isNaN(Date.parse(v)) &&
    new Date(v).toISOString().slice(0, 10) === v;
  if (
    !validDate(env.IMPORT_START) ||
    !validDate(env.IMPORT_END) ||
    env.IMPORT_START >= env.IMPORT_END
  )
    throw new Error("configure_import_horizon");
  const url = new URL(env.PUBLIC_URL);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("configure_public_url");
  if (!mappings(env).length) throw new Error("configure_mappings");
  if (!["retain", "checkmark"].includes(env.COMPLETION_MODE))
    throw new Error("configure_completion");
  if (
    !Number.isInteger(Number(env.DEFAULT_DURATION_MINUTES)) ||
    Number(env.DEFAULT_DURATION_MINUTES) <= 0
  )
    throw new Error("configure_duration");
}
