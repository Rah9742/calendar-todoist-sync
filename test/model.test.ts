import { describe, it, expect, vi } from "vitest";
import {
  eventValue,
  horizon,
  inHorizon,
  assertReady,
  taskValue,
  eventBody,
  taskBody,
  direction,
  snapshot,
  mappings,
  type Link,
} from "../src/model";
const timed = {
  title: "Test",
  description: "",
  start: "2026-10-25T00:30:00.000Z",
  end: "2026-10-25T02:30:00.000Z",
  allDay: false,
};
describe("normalization", () => {
  it("preserves instants across the London DST fallback", () => {
    expect(
      eventValue({
        id: "e",
        start: { dateTime: "2026-10-25T01:30:00+01:00" },
        end: { dateTime: "2026-10-25T02:30:00+00:00" },
        summary: "Test",
      }),
    ).toEqual(timed);
    expect(taskBody(timed).duration).toBe(120);
  });
  it("keeps all-day exclusive end dates", () => {
    const v = eventValue({
      id: "e",
      start: { date: "2026-11-01" },
      end: { date: "2026-11-04" },
    })!;
    expect(eventBody(v).end).toEqual({ date: "2026-11-04" });
    expect(taskBody(v).due_date).toBe("2026-11-01");
  });
  it("skips unsupported series, instances, declined invitations and special event types", () => {
    const e = {
      id: "e",
      start: { date: "2026-11-01" },
      end: { date: "2026-11-02" },
    };
    for (const extra of [
      { recurrence: ["RRULE:FREQ=MONTHLY;BYDAY=1MO"] },
      { recurringEventId: "master" },
      { attendees: [{ self: true, responseStatus: "declined" }] },
      { eventType: "outOfOffice" },
    ])
      expect(eventValue({ ...e, ...extra })).toBeNull();
  });
  it("skips undated, recurring and ambiguous floating task times", () => {
    const t = { id: "t", project_id: "p", content: "Test" };
    expect(taskValue(t, 30)).toBeNull();
    expect(
      taskValue({ ...t, due: { date: "2026-11-01", is_recurring: true } }, 30),
    ).toBeNull();
    expect(
      taskValue({ ...t, due: { date: "2026-10-25T01:30:00" } }, 30),
    ).toBeNull();
  });
  it("rejects duplicate calendar/project mappings", () => {
    const m = { id: "one", googleCalendarId: "g", todoistProjectId: "p" };
    expect(() =>
      mappings({
        MAPPINGS_JSON: JSON.stringify([m, { ...m, id: "two" }]),
      } as Env),
    ).toThrow("invalid_mappings");
  });
  it("detects conflicting edits but recognizes equal converged edits", () => {
    const link = {
      google_snapshot: snapshot(timed),
      todoist_snapshot: snapshot(timed),
    } as Link;
    expect(
      direction(link, { ...timed, title: "A" }, { ...timed, title: "B" }),
    ).toBe("conflict");
    expect(
      direction(link, { ...timed, title: "A" }, { ...timed, title: "A" }),
    ).toBe("none");
  });
});
it("converts ordinary Todoist floating times using London daylight-saving rules", () => {
  const t = {
    id: "t",
    project_id: "p",
    content: "Summer",
    due: { date: "2026-07-01T10:00:00" },
  };
  expect(taskValue(t, 30)?.start).toBe("2026-07-01T09:00:00.000Z");
  expect(
    taskValue({ ...t, due: { date: "2026-03-29T01:30:00" } }, 30),
  ).toBeNull();
});

describe("rolling horizon", () => {
  const env = {
    HORIZON_DAYS: "90",
    IMPORT_START: "2026-11-01",
    IMPORT_END: "2027-01-30",
  } as Env;
  it("advances the exclusive end daily across year boundaries", () => {
    expect(horizon(env, Date.parse("2026-11-08T12:00:00Z"))).toEqual({
      start: "2026-11-08",
      end: "2027-02-06",
      timeMin: "2026-11-08T00:00:00.000Z",
      timeMax: "2027-02-06T00:00:00.000Z",
    });
    expect(horizon(env, Date.parse("2026-11-09T12:00:00Z")).end).toBe(
      "2027-02-07",
    );
  });
  it("uses London midnight and calendar days across both DST transitions", () => {
    const spring = horizon(env, Date.parse("2027-03-27T12:00:00Z"));
    expect(spring.timeMin).toBe("2027-03-27T00:00:00.000Z");
    expect(spring.timeMax).toBe("2027-06-24T23:00:00.000Z");
    const autumn = horizon(env, Date.parse("2026-10-24T23:30:00Z"));
    expect(autumn.start).toBe("2026-10-25");
    expect(autumn.timeMin).toBe("2026-10-24T23:00:00.000Z");
    expect(autumn.timeMax).toBe("2027-01-23T00:00:00.000Z");
  });
  it("keeps fixed bounds available when rolling mode is absent", () => {
    expect(horizon({ ...env, HORIZON_DAYS: "" }).end).toBe("2027-01-30");
    expect(inHorizon("2027-01-30", { ...env, HORIZON_DAYS: "" })).toBe(false);
  });
  it("rejects malformed or excessive rolling lengths", () => {
    for (const HORIZON_DAYS of ["-1", "0", "1.5", "367", "NaN"])
      expect(() => assertReady({ ...env, HORIZON_DAYS })).toThrow(
        "configure_rolling_horizon",
      );
  });
});

it("filters timed starts using London dates with an exclusive upper boundary", () => {
  const now = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse("2027-06-01T12:00:00Z"));
  const env = { HORIZON_DAYS: "90" } as Env;
  try {
    expect(inHorizon("2027-05-31T23:00:00Z", env)).toBe(true);
    expect(inHorizon("2027-05-31T22:59:59Z", env)).toBe(false);
    expect(inHorizon("2027-08-29T22:59:59Z", env)).toBe(true);
    expect(inHorizon("2027-08-29T23:00:00Z", env)).toBe(false);
    expect(inHorizon("2027-08-30", env)).toBe(false);
  } finally {
    now.mockRestore();
  }
});
