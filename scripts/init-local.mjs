/** Create owner-only private templates without overwriting an existing installation. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
for (const [source, target] of [
  ["wrangler.jsonc", "wrangler.local.jsonc"],
  ["config/mappings.example.json", "config/mappings.local.json"],
  [".dev.vars.example", ".dev.vars"],
]) {
  if (existsSync(target)) {
    console.log(`Kept existing ${target}`);
    continue;
  }
  let content = readFileSync(source, "utf8");
  if (target === ".dev.vars")
    content = content
      .replace(
        /^ADMIN_TOKEN=$/m,
        `ADMIN_TOKEN=${randomBytes(32).toString("hex")}`,
      )
      .replace(
        /^GOOGLE_CHANNEL_SECRET=$/m,
        `GOOGLE_CHANNEL_SECRET=${randomBytes(32).toString("hex")}`,
      );
  writeFileSync(target, content, { mode: 0o600, flag: "wx" });
  console.log(`Created ${target}`);
}
console.log(
  "Fill in the private templates before deployment. Secret values were not printed.",
);
