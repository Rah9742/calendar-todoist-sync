/** Bounded historical hold summaries. Explicit field projection prevents raw payload or credential disclosure. */
import { Buffer } from "node:buffer";
import { mappings } from "./model";

type Cursor = [string, string];
/** Decode a bounded, validated pagination position; reject malformed offsets before database access. */
export function reviewCursor(value: string | null): Cursor {
  if (value === null) return ["", ""];
  if (!value || value.length > 2048) throw new Error("invalid_cursor");
  const decoded: unknown = JSON.parse(
    Buffer.from(value, "base64url").toString("utf8"),
  );
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    !decoded.every(
      (s) => typeof s === "string" && s.length > 0 && s.length <= 512,
    )
  )
    throw new Error("invalid_cursor");
  return [decoded[0], decoded[1]];
}
const encodeCursor = (mapping: string, eventId: string) =>
  Buffer.from(JSON.stringify([mapping, eventId])).toString("base64url");

function savedValue(raw: string | null) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const text = (key: string, limit: number) =>
      typeof value[key] === "string" ? value[key].slice(0, limit) : null;
    // Explicit projection: never return descriptions, initial payloads, attendees,
    // credentials or arbitrary fields from a saved provider response.
    return {
      title: text("title", 1024),
      start: text("start", 64),
      end: text("end", 64),
      allDay: value.allDay === true,
    };
  } catch {
    return null;
  }
}
/** Return a bounded projection of historical held snapshots, never full provider payloads. */
export async function reviewList(env: Env, after: Cursor) {
  const configured = mappings(env).map((m) => m.id);
  if (!configured.length) return { items: [], nextCursor: null };
  const page = await env.DB.prepare(
    `SELECT mapping,event_id,task_id,reason,updated_at,google_snapshot,todoist_snapshot
    FROM links WHERE state='held' AND mapping IN (${configured.map(() => "?").join(",")})
    AND (mapping>? OR (mapping=? AND event_id>?)) ORDER BY mapping,event_id LIMIT 26`,
  )
    .bind(...configured, after[0], after[0], after[1])
    .all<{
      mapping: string;
      event_id: string;
      task_id: string | null;
      reason: string | null;
      updated_at: number;
      google_snapshot: string | null;
      todoist_snapshot: string | null;
    }>();
  const rows = page.results.slice(0, 25);
  const last = rows.at(-1);
  return {
    generatedAt: new Date().toISOString(),
    notice:
      "Last saved sync snapshots, not current provider values. Verify both providers before resolving a hold. This endpoint never changes or releases a pair.",
    items: rows.map((r) => ({
      ref: encodeCursor(r.mapping, r.event_id),
      mapping: r.mapping,
      reason: r.reason,
      heldSince: new Date(r.updated_at).toISOString(),
      hasLinkedTask: r.task_id !== null,
      lastSaved: {
        google: savedValue(r.google_snapshot),
        todoist: savedValue(r.todoist_snapshot),
      },
    })),
    nextCursor:
      page.results.length > 25 && last
        ? encodeCursor(last.mapping, last.event_id)
        : null,
  };
}
