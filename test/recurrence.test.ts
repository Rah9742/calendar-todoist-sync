import { expect, it } from "vitest";
import {
  googleRecurrence,
  localParts,
  todoistRecurrence,
  zonedInstant,
  recurrenceRule,
  recurrenceString,
  scheduleSignature,
  retimedOccurrence,
} from "../src/recurrence";
import { eventValue, taskValue } from "../src/model";
it("translates a simple native weekly rule in both directions", () => {
  const e = {
    id: "g",
    start: { dateTime: "2026-11-03T10:00:00Z", timeZone: "Europe/London" },
    end: { dateTime: "2026-11-03T11:00:00Z", timeZone: "Europe/London" },
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
  };
  const t = {
    id: "t",
    project_id: "p",
    content: "Weekly",
    due: {
      date: "2026-11-03T10:00:00Z",
      timezone: "Europe/London",
      string: "every week",
      is_recurring: true,
    },
  };
  expect(googleRecurrence(e)).toEqual(todoistRecurrence(t));
  expect(recurrenceRule(googleRecurrence(e)!)).toBe(
    "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU",
  );
});
it("does not approximate finite, compound, ordinal-weekday or completion-relative rules", () => {
  for (const rule of [
    "RRULE:FREQ=WEEKLY;COUNT=5",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
    "RRULE:FREQ=MONTHLY;BYDAY=1MO",
  ])
    expect(
      googleRecurrence({
        id: "g",
        start: { date: "2026-11-03" },
        recurrence: [rule],
      }),
    ).toBeNull();
  expect(
    todoistRecurrence({
      id: "t",
      project_id: "p",
      content: "x",
      due: { date: "2026-11-03", string: "every! week", is_recurring: true },
    }),
  ).toBeNull();
});
it.each([
  ["2026-11-04", "RRULE:FREQ=MONTHLY;BYMONTHDAY=4", "every 4th"],
  ["2026-11-15", "RRULE:FREQ=MONTHLY;INTERVAL=3", "every 3 months"],
  [
    "2026-12-01T19:00:00Z",
    "RRULE:FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=1",
    "every 1st Dec at 19:00",
  ],
  ["2027-05-16T10:00:00+01:00", "RRULE:FREQ=YEARLY", "every 16 May 10:00 am"],
  ["2026-12-31", "RRULE:FREQ=YEARLY;INTERVAL=2", "every 2 years"],
])("round trips equivalent calendar rules for %s", (date, rrule, text) => {
  const g = googleRecurrence({
    id: "g",
    start: date.includes("T")
      ? { dateTime: date, timeZone: "Europe/London" }
      : { date },
    recurrence: [rrule],
  });
  const t = todoistRecurrence({
    id: "t",
    project_id: "p",
    content: "x",
    due: { date, timezone: "Europe/London", string: text, is_recurring: true },
  });
  expect(g).not.toBeNull();
  expect(t).toEqual(g);
  expect(
    googleRecurrence({
      id: "g",
      start: date.includes("T")
        ? { dateTime: date, timeZone: "Europe/London" }
        : { date },
      recurrence: [recurrenceRule(g!)],
    }),
  ).toEqual(g);
  expect(
    todoistRecurrence({
      id: "t",
      project_id: "p",
      content: "x",
      due: {
        date,
        timezone: "Europe/London",
        string: recurrenceString(g!, date),
        is_recurring: true,
      },
    }),
  ).toEqual(g);
});
it("rejects month-end, leap-day, mismatched named dates and unsupported rule fields", () => {
  for (const [date, rule] of [
    ["2026-01-31", "RRULE:FREQ=MONTHLY"],
    ["2028-02-29", "RRULE:FREQ=YEARLY"],
    ["2026-11-04", "RRULE:FREQ=YEARLY;BYMONTH=12"],
    ["2026-11-04", "RRULE:FREQ=MONTHLY;BYMONTHDAY=4,15"],
  ])
    expect(
      googleRecurrence({ id: "g", start: { date }, recurrence: [rule] }),
    ).toBeNull();
  for (const [date, text] of [
    ["2026-11-30", "every month"],
    ["2028-02-29", "every year"],
    ["2026-11-05", "every 4th"],
    ["2026-12-01", "every 1st November"],
    ["2026-11-04", "every! month"],
    ["2026-11-04", "every 4st"],
  ])
    expect(
      todoistRecurrence({
        id: "t",
        project_id: "p",
        content: "x",
        due: { date, string: text, is_recurring: true },
      }),
    ).toBeNull();
});
it("keeps local wall time across London DST without moving a native anchor", () => {
  const t = {
    id: "t",
    project_id: "p",
    content: "Weekly",
    due: {
      date: "2026-10-20T10:00:00+01:00",
      timezone: "Europe/London",
      string: "every week",
      is_recurring: true,
    },
  };
  const before = taskValue(t, 30)!;
  const after = taskValue(
    { ...t, due: { ...t.due, date: "2026-10-27T10:00:00Z" } },
    30,
  )!;
  expect(before.start).not.toBe(after.start);
  expect(scheduleSignature(before)).toBe(scheduleSignature(after));
});
it("resolves unambiguous zoned times and refuses DST gaps and folds", () => {
  expect(zonedInstant("2026-07-01T10:00:00", "Europe/London")).toBe(
    "2026-07-01T09:00:00.000Z",
  );
  expect(zonedInstant("2026-03-29T01:30:00", "Europe/London")).toBeNull();
  expect(zonedInstant("2026-10-25T01:30:00", "Europe/London")).toBeNull();
});
it("normalizes a recurring Google series without expanding instances into tasks", () => {
  expect(
    eventValue({
      id: "g",
      start: { date: "2026-11-03" },
      end: { date: "2026-11-04" },
      recurrence: ["RRULE:FREQ=DAILY"],
    })?.recurrence?.frequency,
  ).toBe("DAILY");
});
it("keeps the next occurrence's London local date across DST and refuses nonexistent new times", () => {
  const make = (start: string, end: string) =>
    eventValue({
      id: "g",
      start: { dateTime: start, timeZone: "Europe/London" },
      end: { dateTime: end, timeZone: "Europe/London" },
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=SU"],
    })!;
  const previous = make("2026-03-22T10:00:00Z", "2026-03-22T10:30:00Z");
  const current = make("2026-03-22T15:00:00Z", "2026-03-22T15:30:00Z");
  const next = make("2026-03-29T09:00:00Z", "2026-03-29T09:30:00Z");
  expect(retimedOccurrence(previous, current, next)?.start).toBe(
    "2026-03-29T14:00:00.000Z",
  );
  const gap = make("2026-03-22T01:30:00Z", "2026-03-22T02:00:00Z");
  expect(retimedOccurrence(previous, gap, next)).toBeNull();
});

it("keeps reused formatters isolated by timezone across winter and summer", () => {
  for (let round = 0; round < 3; round++) {
    for (const [zone, winter, summer] of [
      ["Europe/London", "12:00:00", "13:00:00"],
      ["America/New_York", "07:00:00", "08:00:00"],
      ["Asia/Kolkata", "17:30:00", "17:30:00"],
      ["Australia/Sydney", "23:00:00", "22:00:00"],
    ]) {
      expect(localParts("2026-11-08T12:00:00Z", zone).time).toBe(winter);
      expect(localParts("2027-07-01T12:00:00Z", zone).time).toBe(summer);
    }
  }
  expect(zonedInstant("2027-03-28T01:30:00", "Europe/London")).toBeNull();
  expect(zonedInstant("2027-10-31T01:30:00", "Europe/London")).toBeNull();
  expect(() => localParts("2027-07-01T12:00:00Z", "Not/A_Timezone")).toThrow(
    RangeError,
  );
});
