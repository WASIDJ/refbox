import { randomBytes, pbkdf2Sync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const root = resolve(import.meta.dirname, "..");
const envFile = resolve(root, ".env");
mkdirSync(resolve(root, "var"), { recursive: true, mode: 0o700 });
let source = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
let password = "";
if (!source) {
  password = randomBytes(18).toString("base64url");
  const salt = randomBytes(16);
  const key = pbkdf2Sync(password, salt, 600000, 32, "sha256");
  const hash = `pbkdf2-sha256$600000$${salt.toString("base64url")}$${key.toString("base64url")}`;
  writeFileSync(resolve(root, "var/bootstrap-password.txt"), password + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  source = [
    `REFBOX_ENGINE_TOKEN=${randomBytes(32).toString("hex")}`,
    `REFBOX_PASSWORD_HASH='${hash}'`,
    `PI_PROFILE_DIR='${resolve(homedir(), ".pi/agent")}'`,
    `REFBOX_DATABASE='${resolve(root, "var/refbox.sqlite")}'`,
    `REFBOX_WEB_DIR='${resolve(root, "apps/web/dist")}'`,
    "REFBOX_MODEL=kimi-k3",
    "REFBOX_ENGINE_PORT=18801",
    "REFBOX_ENGINE_URL=http://127.0.0.1:18801",
    "REFBOX_LISTEN=127.0.0.1:8080",
    "REFBOX_SECURE_COOKIE=false",
    "",
  ].join("\n");
  writeFileSync(envFile, source, { mode: 0o600, flag: "wx" });
  console.log("已生成管理员凭据，密码保存在 var/bootstrap-password.txt。");
} else {
  try {
    password = readFileSync(
      resolve(root, "var/bootstrap-password.txt"),
      "utf8",
    ).trim();
  } catch {}
}
const values = {
  REFBOX_PLATFORM_TOKEN: randomBytes(32).toString("hex"),
  REFBOX_BROKER_TOKEN: randomBytes(32).toString("hex"),
  REFBOX_MONITOR_TOKEN: randomBytes(32).toString("hex"),
  REFBOX_VERIFIER_TOKEN: randomBytes(32).toString("hex"),
  REFBOX_SCRATCHPAD_TOKEN: randomBytes(32).toString("hex"),
  REFBOX_PLATFORM_DATABASE: resolve(root, "var/platform.sqlite"),
  REFBOX_MONITOR_DATABASE: resolve(root, "var/monitor.sqlite"),
  REFBOX_VERIFIER_DATABASE: resolve(root, "var/verifier.sqlite"),
  REFBOX_SCRATCHPAD_DATABASE: resolve(root, "var/scratchpad.sqlite"),
  REFBOX_BROKER_DATABASE: resolve(root, "var/broker.sqlite"),
  REFBOX_PLATFORM_URL: "http://127.0.0.1:8080",
  REFBOX_VERIFIER_URL: "http://127.0.0.1:18812",
  REFBOX_BROKER_URL: "http://127.0.0.1:18814",
  REFBOX_BROKER_LISTEN: "127.0.0.1:18814",
  REFBOX_TUNNEL_METRICS_URL: "http://127.0.0.1:18803",
  REFBOX_MONITOR_PORT: "18811",
  REFBOX_VERIFIER_PORT: "18812",
  REFBOX_SCRATCHPAD_PORT: "18813",
  REFBOX_AUTO_REPAIR: "true",
  REFBOX_ALLOW_TUNNEL_RESTART: "false",
  REFBOX_ENVIRONMENT_ID: "macmini-local",
  REFBOX_PUBLIC_URL: "",
  REFBOX_VERIFY_PASSWORD: password,
  REFBOX_PLUGIN_MANIFESTS: JSON.stringify([
    {
      manifestUrl: "http://127.0.0.1:18811/manifest",
      credentialEnv: "REFBOX_MONITOR_TOKEN",
    },
    {
      manifestUrl: "http://127.0.0.1:18813/manifest",
      credentialEnv: "REFBOX_SCRATCHPAD_TOKEN",
    },
  ]),
};
let added = 0;
for (const [key, value] of Object.entries(values)) {
  if (new RegExp("^" + key + "=", "m").test(source)) continue;
  appendFileSync(envFile, `\n${key}='${value}'`);
  added++;
}
console.log(
  `已补齐 ${added} 项平台配置；已有密码、令牌与数据库地址保留。请设置 REFBOX_PUBLIC_URL 为实际 Cloudflare 地址后验收。`,
);
