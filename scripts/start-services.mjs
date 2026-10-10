import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Parse configuration as data. Never source it as shell code or print credentials.
const source = await readFile(resolve(root, ".env"), "utf8").catch(() => "");
for (const line of source.split(/\r?\n/)) {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (!match || process.env[match[1]] !== undefined) continue;
  const value = match[2].trim();
  process.env[match[1]] = /^".*"$/.test(value)
    ? JSON.parse(value)
    : /^'.*'$/.test(value)
      ? value.slice(1, -1)
      : value;
}
for (const key of [
  "REFBOX_PLATFORM_TOKEN",
  "REFBOX_MONITOR_TOKEN",
  "REFBOX_VERIFIER_TOKEN",
  "REFBOX_SCRATCHPAD_TOKEN",
])
  if ((process.env[key] ?? "").length < 32)
    throw new Error(
      `${key} must be configured with a distinct random service token`,
    );
if (
  new Set(
    [
      "REFBOX_PLATFORM_TOKEN",
      "REFBOX_MONITOR_TOKEN",
      "REFBOX_VERIFIER_TOKEN",
      "REFBOX_SCRATCHPAD_TOKEN",
    ].map((key) => process.env[key]),
  ).size !== 4
)
  throw new Error("Service credentials must be distinct");
const children = ["monitor", "prover", "scratchpad"].map((name) =>
  spawn(process.execPath, [resolve(root, `apps/services/${name}.mjs`)], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  }),
);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
let failed = false;
await Promise.all(
  children.map(
    (child) =>
      new Promise((resolveExit) => {
        child.once("error", () => {
          failed = true;
          stop();
          resolveExit();
        });
        child.once("exit", (code) => {
          if (code && !stopping) {
            failed = true;
            stop();
          }
          resolveExit();
        });
      }),
  ),
);
process.exitCode = failed ? 1 : 0;
