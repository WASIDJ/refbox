import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  unlinkSync,
  copyFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { userInfo } from "node:os";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const serviceRoot =
  process.env.REFBOX_INSTALL_DIR ?? "/Library/Application Support/refbox";
const install = process.argv.includes("--install");
const uninstall = process.argv.includes("--uninstall");
if ((install || uninstall) && process.getuid?.() !== 0)
  throw new Error(
    "安装系统服务需要管理员权限；请使用 sudo node scripts/launchd.mjs --install",
  );
const owner =
  process.env.SUDO_USER ??
  process.env.REFBOX_CONTROL_USER ??
  userInfo().username;
if (owner === "root")
  throw new Error("需要指定普通控制用户：REFBOX_CONTROL_USER");
const node = resolve(serviceRoot, "runtime/bin/node");
const xml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const string = (value) => `<string>${xml(value)}</string>`;
const definitions = [
  {
    name: "ai.refbox.engine",
    user: "root",
    args: [
      node,
      "--env-file=" + resolve(serviceRoot, ".env"),
      resolve(serviceRoot, "apps/runtime/dist/main.js"),
    ],
  },
  {
    name: "ai.refbox.control",
    user: owner,
    args: [node, resolve(serviceRoot, "scripts/start-control.mjs")],
  },
  {
    name: "ai.refbox.broker",
    user: "root",
    args: [node, resolve(serviceRoot, "scripts/start-broker.mjs")],
  },
  ...[
    ["monitor", "monitor"],
    ["verifier", "prover"],
    ["scratchpad", "scratchpad"],
  ].map(([label, file]) => ({
    name: "ai.refbox." + label,
    user: owner,
    args: [
      node,
      "--env-file=" + resolve(serviceRoot, ".env"),
      resolve(serviceRoot, "apps/services/" + file + ".mjs"),
    ],
  })),
];
if (install) {
  for (const file of [
    ".env",
    "bin/refbox",
    "bin/refbox-broker",
    "apps/services/monitor.mjs",
    "apps/services/prover.mjs",
    "apps/services/scratchpad.mjs",
    "apps/runtime/dist/main.js",
    "apps/web/dist/index.html",
    "var/daemon-node/bin/node",
  ])
    if (!existsSync(resolve(root, file)))
      throw new Error("请先配置、构建 refbox 并运行 npm run prepare:daemon");
  process.loadEnvFile(resolve(root, ".env"));
  // Stop only this checkout's processes so development listeners cannot block
  // the root runtime. Other applications using the same port are not touched.
  for (const d of definitions) {
    try {
      execFileSync("/bin/launchctl", ["bootout", "system/" + d.name], {
        stdio: "ignore",
      });
    } catch {}
  }
  const candidates = [];
  const lock =
    (process.env.REFBOX_DATABASE ?? resolve(root, "var/refbox.sqlite")) +
    ".lock";
  if (existsSync(lock))
    candidates.push({
      pid: Number(readFileSync(lock, "utf8")),
      match: "apps/runtime/dist/main.js",
    });
  const port = (process.env.REFBOX_LISTEN ?? "127.0.0.1:8080")
    .split(":")
    .at(-1);
  try {
    const pids = execFileSync(
      "/usr/sbin/lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    for (const pid of pids.trim().split(/\s+/))
      if (pid)
        candidates.push({
          pid: Number(pid),
          match: resolve(root, "bin/refbox"),
        });
  } catch {}
  for (const { pid, match } of candidates) {
    if (!Number.isInteger(pid) || pid <= 1) continue;
    let ours = false;
    try {
      const cmd = execFileSync(
        "/bin/ps",
        ["-p", String(pid), "-o", "command="],
        { encoding: "utf8" },
      );
      const cwd = execFileSync(
        "/usr/sbin/lsof",
        ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
        { encoding: "utf8" },
      );
      ours = cmd.includes(match) && cwd.split("\n").includes("n" + root);
    } catch {}
    if (!ours) continue;
    process.kill(pid, "SIGTERM");
    for (let n = 0; n < 120; n++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  // Keep published files and the privileged runtime on the internal disk.
  // macOS protects removable-volume access independently of Unix root privileges.
  mkdirSync(serviceRoot, { recursive: true, mode: 0o755 });
  for (const relative of [
    "apps",
    "node_modules",
    "scripts",
    "bin",
    "package.json",
  ])
    execFileSync("/usr/bin/ditto", [
      "--noextattr",
      "--norsrc",
      resolve(root, relative),
      resolve(serviceRoot, relative),
    ]);
  execFileSync("/usr/bin/ditto", [
    "--noextattr",
    "--norsrc",
    resolve(root, "var/daemon-node"),
    resolve(serviceRoot, "runtime"),
  ]);
  const data = resolve(serviceRoot, "var");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  execFileSync("/usr/sbin/chown", [owner + ":staff", data]);
  const database = resolve(data, "refbox.sqlite");
  const sourceDatabase =
    process.env.REFBOX_DATABASE ?? resolve(root, "var/refbox.sqlite");
  if (!existsSync(database) && existsSync(sourceDatabase)) {
    for (const suffix of ["", "-wal", "-shm"])
      if (existsSync(sourceDatabase + suffix))
        copyFileSync(sourceDatabase + suffix, database + suffix);
  }
  mkdirSync(resolve(data, "workspaces"), { recursive: true, mode: 0o755 });
  let env = readFileSync(resolve(root, ".env"), "utf8");
  // Preserve production credentials and preferences. Add only missing platform keys.
  if (existsSync(resolve(serviceRoot, ".env"))) {
    let existing = readFileSync(resolve(serviceRoot, ".env"), "utf8");
    for (const line of env.split(/\r?\n/)) {
      const name = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
      if (name && !new RegExp("^" + name + "=", "m").test(existing))
        existing += "\n" + line;
    }
    env = existing;
  }
  for (const [key, value] of Object.entries({
    REFBOX_DATABASE: database,
    REFBOX_WEB_DIR: resolve(serviceRoot, "apps/web/dist"),
    REFBOX_PLATFORM_DATABASE: resolve(data, "platform.sqlite"),
    REFBOX_MONITOR_DATABASE: resolve(data, "monitor.sqlite"),
    REFBOX_VERIFIER_DATABASE: resolve(data, "verifier.sqlite"),
    REFBOX_SCRATCHPAD_DATABASE: resolve(data, "scratchpad.sqlite"),
    REFBOX_BROKER_DATABASE: resolve(data, "broker.sqlite"),
  }))
    env = new RegExp("^" + key + "=", "m").test(env)
      ? env.replace(
          new RegExp("^" + key + "=.*$", "m"),
          key + "='" + value + "'",
        )
      : env + "\n" + key + "='" + value + "'";
  writeFileSync(resolve(serviceRoot, ".env"), env, { mode: 0o600 });
  execFileSync("/usr/sbin/chown", [
    owner + ":staff",
    resolve(serviceRoot, ".env"),
  ]);
}
const logRoot = install ? "/Library/Logs/refbox" : resolve(root, "var");
if (install) {
  mkdirSync(logRoot, { recursive: true, mode: 0o750 });
  execFileSync("/usr/sbin/chown", [owner + ":staff", logRoot]);
}
const output =
  install || uninstall
    ? "/Library/LaunchDaemons"
    : resolve(root, "var/launchd");
mkdirSync(output, { recursive: true });
for (const d of definitions) {
  const path = resolve(output, d.name + ".plist");
  if (uninstall) {
    try {
      execFileSync("/bin/launchctl", ["bootout", "system/" + d.name]);
    } catch {}
    if (existsSync(path)) unlinkSync(path);
    continue;
  }
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key>${string(d.name)}<key>UserName</key>${string(d.user)}
<key>ProgramArguments</key><array>${d.args.map(string).join("")}</array>
<key>WorkingDirectory</key>${string(serviceRoot)}<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key>${string(dirname(node) + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")}</dict>
<key>StandardOutPath</key>${string(resolve(logRoot, d.name + ".log"))}
<key>StandardErrorPath</key>${string(resolve(logRoot, d.name + ".error.log"))}
</dict></plist>\n`;
  writeFileSync(path, plist, { mode: 0o644 });
  execFileSync("/usr/bin/plutil", ["-lint", path], { stdio: "inherit" });
  if (install) {
    if (
      !existsSync(resolve(root, ".env")) ||
      !existsSync(resolve(root, "bin/refbox")) ||
      !existsSync(resolve(root, "apps/runtime/dist/main.js"))
    )
      throw new Error("请先配置并构建 refbox");
    execFileSync("/usr/sbin/chown", ["root:wheel", path]);
    try {
      execFileSync("/bin/launchctl", ["bootout", "system/" + d.name], {
        stdio: "ignore",
      });
    } catch {}
    execFileSync("/bin/launchctl", ["bootstrap", "system", path]);
    console.log("已安装 " + d.name + "，运行用户 " + d.user);
  }
}
if (uninstall) console.log("已移除常驻服务；数据库与配置均保留。");
else if (!install)
  console.log("已生成并校验安装清单：var/launchd/（尚未安装）。");
