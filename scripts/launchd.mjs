import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { userInfo } from "node:os";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
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
const node = process.execPath;
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
      "--env-file=" + resolve(root, ".env"),
      resolve(root, "apps/runtime/dist/main.js"),
    ],
  },
  {
    name: "ai.refbox.control",
    user: owner,
    args: [node, resolve(root, "scripts/start-control.mjs")],
  },
];
if (install) {
  for (const file of [
    ".env",
    "bin/refbox",
    "apps/runtime/dist/main.js",
    "apps/web/dist/index.html",
  ])
    if (!existsSync(resolve(root, file)))
      throw new Error("请先配置并构建 refbox");
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
<key>WorkingDirectory</key>${string(root)}<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key>${string(dirname(node) + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")}</dict>
<key>StandardOutPath</key>${string(resolve(root, "var", d.name + ".log"))}
<key>StandardErrorPath</key>${string(resolve(root, "var", d.name + ".error.log"))}
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
