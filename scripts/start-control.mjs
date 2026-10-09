import { spawn } from "node:child_process";
import { resolve } from "node:path";
process.chdir(resolve(import.meta.dirname, ".."));
process.loadEnvFile(".env");
const child = spawn(resolve("bin/refbox"), [], {
  env: process.env,
  stdio: "inherit",
});
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("exit", (code) => process.exit(code ?? 1));
