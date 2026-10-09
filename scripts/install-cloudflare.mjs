import { copyFileSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

if (process.getuid?.() !== 0) throw new Error("安装常驻 Tunnel 需要 sudo");
const arg = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error("缺少 " + name);
  return process.argv[index + 1];
};
const hostname = arg("--hostname");
const tunnel = arg("--tunnel");
const credentials = arg("--credentials");
if (
  !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(hostname) ||
  !/^[0-9a-f-]{36}$/.test(tunnel)
)
  throw new Error("主机名或 Tunnel UUID 无效");
const owner = process.env.SUDO_USER ?? process.env.REFBOX_CONTROL_USER;
if (!owner || owner === "root") throw new Error("需要普通控制用户");
const root =
  process.env.REFBOX_INSTALL_DIR ?? "/Library/Application Support/refbox";
const dir = resolve(root, "cloudflare");
mkdirSync(dir, { recursive: true, mode: 0o750 });
execFileSync("/usr/sbin/chown", [owner + ":staff", dir]);
const binary = resolve(root, "bin/cloudflared");
copyFileSync(realpathSync("/opt/homebrew/bin/cloudflared"), binary);
const cred = resolve(dir, "credentials.json");
copyFileSync(credentials, cred);
execFileSync("/bin/chmod", ["600", cred]);
execFileSync("/usr/sbin/chown", [owner + ":staff", cred]);
const config = resolve(dir, "config.json");
writeFileSync(
  config,
  JSON.stringify(
    {
      tunnel,
      "credentials-file": cred,
      protocol: "http2",
      metrics: "127.0.0.1:18803",
      ingress: [
        { hostname, service: "http://127.0.0.1:8080" },
        { service: "http_status:404" },
      ],
    },
    null,
    2,
  ) + "\n",
  { mode: 0o640 },
);
execFileSync("/usr/sbin/chown", [owner + ":staff", config]);
execFileSync(binary, ["tunnel", "--config", config, "ingress", "validate"], {
  stdio: "inherit",
});
const xml = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const str = (s) => "<string>" + xml(s) + "</string>";
const label = "ai.refbox.tunnel";
const plist = "/Library/LaunchDaemons/" + label + ".plist";
writeFileSync(
  plist,
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key>${str(label)}<key>UserName</key>${str(owner)}<key>WorkingDirectory</key>${str(root)}
<key>ProgramArguments</key><array>${[binary, "tunnel", "--config", config, "--no-autoupdate", "run", tunnel].map(str).join("")}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key>${str("/Library/Logs/refbox/tunnel.log")}<key>StandardErrorPath</key>${str("/Library/Logs/refbox/tunnel.error.log")}
</dict></plist>\n`,
  { mode: 0o644 },
);
execFileSync("/usr/sbin/chown", ["root:wheel", plist]);
execFileSync("/usr/bin/plutil", ["-lint", plist], { stdio: "inherit" });
try {
  execFileSync("/bin/launchctl", ["bootout", "system/" + label], {
    stdio: "ignore",
  });
} catch {}
execFileSync("/bin/launchctl", ["bootstrap", "system", plist]);
console.log("Cloudflare Tunnel 常驻服务已安装：https://" + hostname);
