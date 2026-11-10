/** Equivalent native recurrence translation and timezone handling. Unsupported patterns and ambiguous wall times are rejected. */
import type { Event, Task, Value } from "./model";
export interface Recurrence {
  frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  weekday?: string;
  monthDay?: number;
  month?: number;
  timezone: string;
}
const days = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const names = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
const months = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
function calendarRule(
  frequency: Recurrence["frequency"],
  interval: number,
  start: string,
  timezone: string,
): Recurrence | null {
  const date = localParts(start, timezone).date;
  const month = Number(date.slice(5, 7)),
    monthDay = Number(date.slice(8, 10));
  if (frequency === "MONTHLY" && monthDay > 28) return null;
  if (frequency === "YEARLY" && month === 2 && monthDay === 29) return null;
  return {
    frequency,
    interval,
    ...(frequency === "WEEKLY"
      ? { weekday: localParts(start, timezone).weekday }
      : {}),
    ...(["MONTHLY", "YEARLY"].includes(frequency) ? { monthDay } : {}),
    ...(frequency === "YEARLY" ? { month } : {}),
    timezone,
  };
}
// Intl formatters are immutable computation helpers, with no request data or I/O.
// Bound the cache because provider-supplied timezone names can vary.
const localFormatters = new Map<string, Intl.DateTimeFormat>();
function localFormatter(zone: string): Intl.DateTimeFormat {
  const cached = localFormatters.get(zone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  if (localFormatters.size >= 16)
    localFormatters.delete(localFormatters.keys().next().value!);
  localFormatters.set(zone, formatter);
  return formatter;
}
/** Resolve an instant into a timezone using a bounded formatter cache. */
export function localParts(
  start: string,
  zone: string,
): { date: string; time: string; weekday: string } {
  if (!start.includes("T"))
    return {
      date: start,
      time: "",
      weekday: days[new Date(start + "T12:00:00Z").getUTCDay()],
    };
  const parts = localFormatter(zone).formatToParts(new Date(start));
  const part = (name: string) => parts.find((p) => p.type === name)!.value;
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}:${part("second")}`,
    weekday: part("weekday").slice(0, 2).toUpperCase(),
  };
}
/** Resolve a supplied wall time only when it maps unambiguously; reject DST gaps and repeated hours. */
export function zonedInstant(value: string, zone: string): string | null {
  if (!value.includes("T") || /(Z|[+-]\d\d:\d\d)$/.test(value)) return value;
  const raw = Date.parse(value + "Z");
  if (!Number.isFinite(raw)) return null;
  const offsets = new Set<number>();
  for (const delta of [-36, 0, 36]) {
    const sample = raw + delta * 3600000,
      p = localParts(new Date(sample).toISOString(), zone);
    offsets.add(Date.parse(`${p.date}T${p.time}Z`) - sample);
  }
  const expected = value.length === 16 ? value + ":00" : value.slice(0, 19),
    matches = [...offsets]
      .map((offset) => new Date(raw - offset).toISOString())
      .filter((candidate) => {
        const p = localParts(candidate, zone);
        return `${p.date}T${p.time}` === expected;
      });
  return matches.length === 1 ? matches[0] : null;
}
/** Translate only native Google rules with an exactly supported shape; return null for exceptions/complexity. */
export function googleRecurrence(e: Event): Recurrence | null {
  if (
    !e.recurrence?.length ||
    e.recurrence.length !== 1 ||
    !e.recurrence[0].startsWith("RRULE:")
  )
    return null;
  const fields = e.recurrence[0]
    .slice(6)
    .split(";")
    .map((p) => p.split("="));
  if (
    fields.some(
      ([k, v]) =>
        !v ||
        ![
          "FREQ",
          "INTERVAL",
          "BYDAY",
          "WKST",
          "BYMONTHDAY",
          "BYMONTH",
        ].includes(k),
    ) ||
    new Set(fields.map(([k]) => k)).size !== fields.length
  )
    return null;
  const rule = Object.fromEntries(fields),
    frequency = rule.FREQ;
  if (
    !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(frequency) ||
    (rule.WKST && rule.WKST !== "MO")
  )
    return null;
  const interval = Number(rule.INTERVAL || "1");
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) return null;
  const timezone = e.start?.timeZone || (e.start?.date ? "Europe/London" : "");
  if (!timezone) return null;
  const start = e.start?.dateTime || e.start?.date;
  if (!start) return null;
  const normalized = calendarRule(
    frequency as Recurrence["frequency"],
    interval,
    start,
    timezone,
  );
  if (!normalized) return null;
  if (frequency === "MONTHLY" || frequency === "YEARLY") {
    if (
      rule.BYDAY ||
      (rule.BYMONTH && frequency !== "YEARLY") ||
      (rule.BYMONTHDAY &&
        (!/^\d+$/.test(rule.BYMONTHDAY) ||
          Number(rule.BYMONTHDAY) !== normalized.monthDay)) ||
      (rule.BYMONTH &&
        (!/^\d+$/.test(rule.BYMONTH) ||
          Number(rule.BYMONTH) !== normalized.month))
    )
      return null;
    return normalized;
  }
  if (rule.BYMONTHDAY || rule.BYMONTH) return null;
  const weekday = rule.BYDAY || localParts(start, timezone).weekday;
  if (!days.includes(weekday) || (frequency === "DAILY" && rule.BYDAY))
    return null;
  return {
    frequency: frequency as Recurrence["frequency"],
    interval,
    ...(frequency === "WEEKLY" ? { weekday } : {}),
    timezone,
  };
}
/** Parse equivalent supported Todoist rules without approximating finite or completion-relative schedules. */
export function todoistRecurrence(t: Task): Recurrence | null {
  if (!t.due?.is_recurring || !t.due.string) return null;
  let text = t.due.string.trim().toLowerCase().replace(/^ev /, "every ");
  const clock =
    text.match(/ at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/) ||
    text.match(/ (\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (clock) text = text.slice(0, clock.index);
  // Deliberately exclude completion-relative, finite and compound schedules.
  const pattern = text.match(
    /^every (?:(\d+) )?(day|days|week|weeks|month|months|year|years)$/,
  );
  const named = text.match(
    /^every (sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/,
  );
  const monthly = text.match(/^every (\d{1,2})(st|nd|rd|th)$/);
  const yearly = pattern
    ? null
    : text.match(/^every (\d{1,2})(st|nd|rd|th)? ([a-z]+)$/);
  if (!pattern && !named && !monthly && !yearly) return null;
  const interval = Number(pattern?.[1] || "1");
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) return null;
  const timezone = t.due.timezone || "Europe/London";
  const start = zonedInstant(t.due.datetime || t.due.date, timezone);
  if (!start) return null;
  const dueDate = localParts(start, timezone).date;
  const monthDay = Number(dueDate.slice(8, 10)),
    month = Number(dueDate.slice(5, 7));
  const suffix = (day: number) =>
    day >= 11 && day <= 13
      ? "th"
      : day % 10 === 1
        ? "st"
        : day % 10 === 2
          ? "nd"
          : day % 10 === 3
            ? "rd"
            : "th";
  if (
    monthly &&
    (Number(monthly[1]) !== monthDay || monthly[2] !== suffix(monthDay))
  )
    return null;
  if (
    yearly &&
    (Number(yearly[1]) !== monthDay ||
      (yearly[2] && yearly[2] !== suffix(monthDay)) ||
      ![months[month - 1], months[month - 1].slice(0, 3)].includes(yearly[3]))
  )
    return null;
  if (clock) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] || "0");
    if (clock[3]) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (clock[3] === "pm" ? 12 : 0);
    }
    if (
      hour > 23 ||
      minute > 59 ||
      localParts(start, timezone).time.slice(0, 5) !==
        `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
    )
      return null;
  }
  const frequency: Recurrence["frequency"] =
    monthly || pattern?.[2].startsWith("month")
      ? "MONTHLY"
      : yearly || pattern?.[2].startsWith("year")
        ? "YEARLY"
        : pattern?.[2].startsWith("day")
          ? "DAILY"
          : "WEEKLY";
  if (frequency === "MONTHLY" || frequency === "YEARLY")
    return calendarRule(frequency, interval, start, timezone);
  const weekday = named
    ? days[names.indexOf(named[1])]
    : localParts(start, timezone).weekday;
  if (named && weekday !== localParts(start, timezone).weekday) return null;
  return {
    frequency,
    interval,
    ...(frequency === "WEEKLY" ? { weekday } : {}),
    timezone,
  };
}
/** Encode a supported native Todoist rule at the supplied occurrence wall clock. */
export function recurrenceString(rule: Recurrence, start?: string): string {
  const time = start?.includes("T")
    ? ` at ${localParts(start, rule.timezone).time.slice(0, 5)}`
    : "";
  const unit = {
    DAILY: "day",
    WEEKLY: "week",
    MONTHLY: "month",
    YEARLY: "year",
  }[rule.frequency];
  return `every ${rule.interval === 1 ? unit : rule.interval + " " + unit + "s"}${time}`;
}
/** Encode an equivalent supported Google RRULE, including explicit interval and weekday/date fields. */
export function recurrenceRule(rule: Recurrence): string {
  return `RRULE:FREQ=${rule.frequency};INTERVAL=${rule.interval}${rule.frequency === "WEEKLY" ? `;BYDAY=${rule.weekday}` : ""}${rule.monthDay ? `;BYMONTHDAY=${rule.monthDay}` : ""}${rule.month ? `;BYMONTH=${rule.month}` : ""}`;
}
/** Compare recurrence, wall clock and duration while deliberately ignoring Todoist due-date advancement. */
export function scheduleSignature(v: Value): string {
  const r = v.recurrence!;
  return JSON.stringify({
    recurrence: r,
    allDay: v.allDay,
    time: localParts(v.start, r.timezone).time,
    duration: Date.parse(v.end) - Date.parse(v.start),
  });
}
// Carry only a wall-clock shift onto Todoist's current uncompleted occurrence.
// Google's anchor date/rule and duration must be unchanged. In particular, never
// rewind an advanced Todoist task to the first occurrence of its Google series.
/** Apply a same-anchor Google clock shift to the next pending Todoist occurrence without rewinding completion. */
export function retimedOccurrence(
  previous: Value,
  current: Value,
  task: Value,
): Value | null {
  if (
    !current.recurrence ||
    previous.allDay ||
    current.allDay ||
    task.allDay ||
    JSON.stringify(previous.recurrence) !==
      JSON.stringify(current.recurrence) ||
    JSON.stringify(task.recurrence) !== JSON.stringify(current.recurrence) ||
    Date.parse(previous.end) - Date.parse(previous.start) !==
      Date.parse(current.end) - Date.parse(current.start)
  )
    return null;
  const zone = current.recurrence.timezone;
  const before = localParts(previous.start, zone),
    after = localParts(current.start, zone);
  if (
    before.date !== after.date ||
    before.time === after.time ||
    !after.time.endsWith(":00")
  )
    return null;
  const date = localParts(task.start, zone).date;
  const start = zonedInstant(`${date}T${after.time}`, zone);
  if (!start) return null;
  return {
    ...task,
    start,
    end: new Date(
      Date.parse(start) + Date.parse(current.end) - Date.parse(current.start),
    ).toISOString(),
  };
}
