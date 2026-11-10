/** Run Wrangler without putting personal resources or mapping secrets in tracked files. */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, loadMappings, validateDeployment } from "./config.mjs";
const [mode, ...provided] = process.argv.slice(2);
const bootstrap = provided.includes("--bootstrap");
const extra = provided.filter((arg) => arg !== "--bootstrap");
const cli = "node_modules/wrangler/bin/wrangler.js";
let temporary;
let devFile;
let bootstrapFile;
try {
  let args;
  if (mode === "build" || mode === "types") {
    args =
      mode === "build"
        ? [
            "deploy",
            "--config",
            "wrangler.jsonc",
            "--dry-run",
            "--outdir",
            "dist",
            ...extra,
          ]
        : [
            "types",
            "--config",
            "wrangler.jsonc",
            "--strict-vars=false",
            ...extra,
          ];
  } else {
    const config = loadConfig();
    if (mode === "deploy") {
      const pairs = loadMappings();
      validateDeployment(config, pairs);
      if ("MAPPINGS_JSON" in (config.vars || {}))
        throw new Error(
          "Remove MAPPINGS_JSON from local Wrangler vars; mappings are uploaded as a secret.",
        );
      mkdirSync(".wrangler", { recursive: true });
      temporary = mkdtempSync(join(".wrangler", "deploy-"));
      const secrets = join(temporary, "secrets.json");
      writeFileSync(
        secrets,
        JSON.stringify({ MAPPINGS_JSON: JSON.stringify(pairs) }),
        { mode: 0o600 },
      );
      let deploymentFile = "wrangler.local.jsonc";
      if (bootstrap) {
        bootstrapFile = "wrangler.bootstrap.local.jsonc";
        config.vars.SYNC_ENABLED = "false";
        config.secrets = { required: ["MAPPINGS_JSON"] };
        writeFileSync(bootstrapFile, JSON.stringify(config), { mode: 0o600 });
        deploymentFile = bootstrapFile;
      }
      args = [
        "deploy",
        "--config",
        deploymentFile,
        "--secrets-file",
        secrets,
        ...extra,
      ];
    } else if (mode === "dev") {
      devFile = "wrangler.dev.local.jsonc";
      config.vars = {
        ...config.vars,
        MAPPINGS_JSON: JSON.stringify(loadMappings()),
      };
      config.secrets = {
        required: (config.secrets?.required || []).filter(
          (key) => key !== "MAPPINGS_JSON",
        ),
      };
      writeFileSync(devFile, JSON.stringify(config), { mode: 0o600 });
      args = ["dev", "--config", devFile, ...extra];
    } else if (mode === "cf") {
      args = [...extra, "--config", "wrangler.local.jsonc"];
    } else throw new Error("Unknown Wrangler operation.");
  }
  const child = spawn(process.execPath, [cli, ...args], { stdio: "inherit" });
  const forward = () => child.kill("SIGINT");
  process.once("SIGINT", forward);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.removeListener("SIGINT", forward);
  process.exitCode = code;
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Wrangler command failed.",
  );
  process.exitCode = 1;
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  if (devFile) rmSync(devFile, { force: true });
  if (bootstrapFile) rmSync(bootstrapFile, { force: true });
}
