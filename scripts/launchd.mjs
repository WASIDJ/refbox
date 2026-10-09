import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
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
if (uninstall) console.log("已停止服务；plist、数据库与配置均保留。");
else if (!install)
  console.log("已生成并校验安装清单：var/launchd/（尚未安装）。");
