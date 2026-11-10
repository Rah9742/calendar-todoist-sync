/** Constrained CalDAV copy identity. This is move correlation for recent copies, not title-based migration matching. */
import { localParts } from "./recurrence";
import { eventValue, type Event, type Link } from "./model";
// CalDAV clients can replace both Google's id and iCalUID when moving an event.
// Correlate only an exact calendar copy created during the deletion grace period;
// titles alone are never sufficient and pre-existing events are never adopted.
/** Canonicalize relevant copy fields while excluding organizer/event IDs that can change on a calendar move. */
export function calendarCopyKey(g: Event): string | null {
  const v = eventValue({
    ...g,
    recurringEventId: undefined,
    recurrence: undefined,
  });
  if (!v) return null;
  const rule = (g.recurrence || [])
    .map((r) => {
      if (!r.startsWith("RRULE:")) return r;
      const parts = r
        .slice(6)
        .split(";")
        .filter((p) => p !== "INTERVAL=1" && p !== "WKST=MO");
      if (
        parts.includes("FREQ=WEEKLY") &&
        !parts.some((p) => p.startsWith("BYDAY="))
      ) {
        const day = new Date(
          Date.parse(localParts(v.start, g.start?.timeZone || "UTC").date),
        ).getUTCDay();
        parts.push("BYDAY=" + ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][day]);
      }
      return "RRULE:" + parts.sort().join(";");
    })
    .sort();
  return JSON.stringify({
    ...v,
    description: v.description.replace(/\r\n/g, "\n").trim(),
    recurrence: rule,
    location: g.location || "",
    attendees: (g.attendees || [])
      .map((a) => ({
        email: (a.email || "").toLowerCase(),
        optional: !!a.optional,
      }))
      .sort((a, b) => a.email.localeCompare(b.email)),
    timezone: g.recurrence?.length ? g.start?.timeZone || "UTC" : undefined,
  });
}
/** Read retained Google recovery metadata, returning null rather than trusting malformed or task-shaped payloads. */
export function savedCalendar(link: Link): Event | null {
  try {
    const raw = JSON.parse(
      link.google_payload || link.initial_payload || "null",
    );
    return raw?.start ? raw : null;
  } catch {
    return null;
  }
}
