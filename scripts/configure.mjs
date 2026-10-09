import { randomBytes, pbkdf2Sync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const root = resolve(import.meta.dirname, "..");
if (existsSync(resolve(root, ".env"))) {
  console.log("已有 .env，未覆盖。");
  process.exit(0);
}
const password = randomBytes(18).toString("base64url");
const salt = randomBytes(16);
const key = pbkdf2Sync(password, salt, 600000, 32, "sha256");
const hash = `pbkdf2-sha256$600000$${salt.toString("base64url")}$${key.toString("base64url")}`;
mkdirSync(resolve(root, "var"), { recursive: true, mode: 0o700 });
writeFileSync(resolve(root, "var/bootstrap-password.txt"), password + "\n", {
  mode: 0o600,
  flag: "wx",
});
writeFileSync(
  resolve(root, ".env"),
  [
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
  ].join("\n"),
  { mode: 0o600, flag: "wx" },
);
console.log(
  "已生成 .env。初始管理员密码保存在 var/bootstrap-password.txt（仅当前用户可读）。",
);
console.log(
  "家庭局域网访问请设置 REFBOX_LISTEN；HTTPS 反向代理请启用 REFBOX_SECURE_COOKIE=true。",
);
