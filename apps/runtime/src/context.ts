import { open, realpath, readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { HttpError } from "./state.js";

const hiddenContext = (path: string) =>
  path
    .split(/[\\/]/)
    .some(
      (part) =>
        [
          ".git",
          "node_modules",
          "var",
          ".ssh",
          ".aws",
          ".cloudflared",
        ].includes(part) ||
        /^\.env(?:\.|$)/.test(part) ||
        /^(?:credentials|bootstrap-password)(?:\.|$)/.test(part),
    );

// This capability reads only the selected goal workspace or the administrator's
// fixed Wiki root. It never creates an execution environment or runs a command.
export async function readContext(root: string, path: string, limit = 48000) {
  if (
    typeof path !== "string" ||
    !path ||
    isAbsolute(path) ||
    path.includes("\0") ||
    path.split(/[\\/]/).includes("..") ||
    hiddenContext(path)
  )
    throw new HttpError(
      403,
      "上下文路径必须位于授权目录内，不能读取凭据或运行数据",
    );
  const directory = await realpath(root);
  const target = await realpath(resolve(directory, path));
  const location = relative(directory, target);
  if (
    location === ".." ||
    location.startsWith(".." + sep) ||
    isAbsolute(location)
  )
    throw new HttpError(403, "上下文路径不能越过授权目录或通过链接离开目录");
  const info = await stat(target);
  if (info.isDirectory()) {
    const entries = (await readdir(target, { withFileTypes: true }))
      .filter((entry) => !hiddenContext(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      path,
      kind: "directory",
      entries: entries
        .slice(0, 200)
        .map((entry) => ({
          name: entry.name,
          directory: entry.isDirectory(),
          symlink: entry.isSymbolicLink(),
        })),
      truncated: entries.length > 200,
    };
  }
  if (!info.isFile()) throw new HttpError(403, "只能读取普通文件或目录");
  const handle = await open(target, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return {
      path,
      kind: "file",
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      truncated: info.size > bytesRead,
    };
  } finally {
    await handle.close();
  }
}

export async function wikiOverview(root: string) {
  return Promise.all(
    ["hot.md", "index.md"].map(async (path) => {
      try {
        return await readContext(root, path, 24000);
      } catch {
        return { path, unavailable: true };
      }
    }),
  );
}
