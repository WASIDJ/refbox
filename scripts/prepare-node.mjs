import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("当前常驻安装器针对 Apple Silicon macOS");
const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "var");
mkdirSync(output, { recursive: true, mode: 0o700 });
const sums = resolve(output, "node-checksums.txt");
execFileSync("/usr/bin/curl", [
  "-fsSL",
  "--max-time",
  "45",
  "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt",
  "-o",
  sums,
]);
const line = readFileSync(sums, "utf8")
  .split("\n")
  .find((x) => /node-v24\.\d+\.\d+-darwin-arm64\.tar\.gz$/.test(x));
if (!line) throw new Error("官方校验清单中缺少 macOS arm64 Node 24");
const [expected, filename] = line.trim().split(/\s+/);
const archive = resolve(output, filename);
if (!existsSync(archive))
  execFileSync("/usr/bin/curl", [
    "-fsSL",
    "--max-time",
    "180",
    "https://nodejs.org/dist/latest-v24.x/" + filename,
    "-o",
    archive,
  ]);
const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
if (actual !== expected) throw new Error("Node 运行时 SHA-256 校验失败");
const runtime = resolve(output, "daemon-node");
const expectedVersion = filename.match(/^node-(v24\.\d+\.\d+)-/)[1];
if (existsSync(runtime)) {
  const cachedVersion = execFileSync(
    resolve(runtime, "bin/node"),
    ["--version"],
    { encoding: "utf8" },
  ).trim();
  if (cachedVersion !== expectedVersion)
    rmSync(runtime, { recursive: true, force: true });
}
if (!existsSync(runtime)) {
  execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", output]);
  renameSync(resolve(output, filename.replace(".tar.gz", "")), runtime);
}
const version = execFileSync(resolve(runtime, "bin/node"), ["--version"], {
  encoding: "utf8",
}).trim();
writeFileSync(
  resolve(output, "daemon-node.json"),
  JSON.stringify({ version, filename, sha256: actual }, null, 2) + "\n",
);
console.log("独立 Node 运行时已准备并通过官方 SHA-256 校验：" + version);
