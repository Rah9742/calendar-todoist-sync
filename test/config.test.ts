import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  loadMappings,
  parseConfig,
  validateDeployment,
} from "../scripts/config.mjs";
const dirs: string[] = [];
const file = (content: string) => {
  const dir = mkdtempSync(join(tmpdir(), "sync-config-"));
  dirs.push(dir);
  const path = join(dir, "config.jsonc");
  writeFileSync(path, content);
  return path;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
describe("private configuration", () => {
  it("supports comments/trailing commas without corrupting commas inside strings", () => {
    expect(parseConfig('{/* note */ "value":"literal,}",}')).toEqual({
      value: "literal,}",
    });
  });
  it("fails closed for malformed JSONC without reflecting sensitive content", () => {
    expect(() => parseConfig('{"private":"DO_NOT_ECHO", broken')).toThrow(
      "Invalid configuration JSONC.",
    );
  });
  it("requires a local deployment file rather than falling back to the public template", () => {
    expect(() => loadConfig("does-not-exist.local.jsonc")).toThrow(
      "Configure wrangler.local.jsonc first",
    );
  });
  it("accepts multiple explicit pairs and boolean opt-ins", () => {
    expect(
      loadMappings(
        file(
          JSON.stringify({
            mappings: [
              {
                id: "work",
                googleCalendarId: "calendar-A",
                todoistProjectId: "project-A",
                mappedMoves: true,
              },
              {
                id: "home",
                googleCalendarId: "calendar-B",
                todoistProjectId: "project-B",
              },
            ],
          }),
        ),
      ),
    ).toHaveLength(2);
  });
  it.each([
    [],
    [
      { id: "a", googleCalendarId: "c", todoistProjectId: "p" },
      { id: "b", googleCalendarId: "c", todoistProjectId: "q" },
    ],
    [
      {
        id: "a",
        googleCalendarId: "c",
        todoistProjectId: "p",
        mappedMoves: "true",
      },
    ],
  ])("rejects empty, duplicate or malformed pairs", (pairs) => {
    expect(() =>
      loadMappings(file(JSON.stringify({ mappings: pairs }))),
    ).toThrow();
  });
});

it("rejects the public template for real deployment", () => {
  expect(() =>
    validateDeployment(loadConfig("wrangler.jsonc"), [
      {
        id: "work",
        googleCalendarId: "calendar-A",
        todoistProjectId: "project-A",
      },
    ]),
  ).toThrow("Fill in the private Cloudflare");
});
it("validates filled private resources without exposing their values", () => {
  const c = {
    vars: {
      CF_ACCOUNT_ID: "a".repeat(32),
      TOKEN_STORE_ID: "b".repeat(32),
      TODOIST_TOKEN_SECRET_ID: "c".repeat(32),
      PUBLIC_URL: "https://sync.example.com",
    },
    d1_databases: [{ database_id: "11111111-1111-1111-1111-111111111111" }],
  };
  expect(() =>
    validateDeployment(c, [
      {
        id: "work",
        googleCalendarId: "calendar-A",
        todoistProjectId: "project-A",
      },
    ]),
  ).not.toThrow();
  expect(() =>
    validateDeployment(c, [
      {
        id: "work",
        googleCalendarId: "REPLACE_WITH_CALENDAR",
        todoistProjectId: "project-A",
      },
    ]),
  ).toThrow("Replace example");
});
