import { spawn } from "node:child_process";
import { resolve } from "node:path";
process.chdir(resolve(import.meta.dirname, ".."));
process.loadEnvFile(".env");
const child = spawn(resolve("bin/refbox-broker"), [], {
  env: process.env,
  stdio: "inherit",
});
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("error", () => {
  console.error("动作代理未能启动");
  process.exitCode = 1;
});
child.on("exit", (code) => process.exit(code ?? 1));
