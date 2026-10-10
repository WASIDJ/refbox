// Keep the same receipt when the server outcome was not observable. Successful
// requests clear the receipt so a later identical instruction is a new action.
const unresolvedRequests = new Map<string, string>();

export async function api<T>(path: string, payload?: unknown): Promise<T> {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const intent = body === undefined ? undefined : `${path}:${body}`;
  let requestKey: string | undefined;
  if (intent !== undefined) {
    requestKey = unresolvedRequests.get(intent) ?? crypto.randomUUID();
    unresolvedRequests.set(intent, requestKey);
  }
  const response = await fetch("/api" + path, {
    method: payload === undefined ? "GET" : "POST",
    headers:
      payload === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "X-Refbox-Request": "1",
            "Idempotency-Key": requestKey!,
          },
    ...(body === undefined ? {} : { body }),
  });
  if (response.status === 401 && path !== "/login")
    window.dispatchEvent(new Event("refbox:unauthorized"));
  const text = await response.text();
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      response.ok
        ? "服务返回了无法读取的数据"
        : `请求失败（${response.status}），请稍后重试`,
    );
  }
  if (intent !== undefined && response.status < 500)
    unresolvedRequests.delete(intent);
  if (!response.ok)
    throw new Error(
      value !== null && typeof value === "object" && "error" in value
        ? String(value.error)
        : `请求失败（${response.status}）`,
    );
  return value as T;
}
export const timestamp = (value?: string) => {
  if (!value || Number.isNaN(Date.parse(value))) return "尚未采样";
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};
export const relativeTime = (value?: string) => {
  if (!value || Number.isNaN(Date.parse(value))) return "尚无样本";
  const seconds = Math.max(
    0,
    Math.round((Date.now() - Date.parse(value)) / 1000),
  );
  return seconds < 60
    ? `${seconds} 秒前`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} 分钟前`
      : `${Math.floor(seconds / 3600)} 小时前`;
};
