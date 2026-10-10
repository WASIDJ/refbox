import { now } from "./http.mjs";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";

const idPattern = /^[a-zA-Z0-9_-]+$/;
export function validCheck(check) {
  if (!check || !idPattern.test(check.id ?? "")) return false;
  let url;
  try {
    url = new URL(check.url);
  } catch {
    return false;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    return false;
  if (
    check.credentialEnv &&
    !/^[A-Z][A-Z0-9_]{0,127}$/.test(check.credentialEnv)
  )
    return false;
  if (
    check.browser &&
    (check.contains || check.json || check.metric || check.credentialEnv)
  )
    return false;
  return (
    (typeof check.contains === "string" && check.contains.length > 0) ||
    (check.json &&
      typeof check.json.path === "string" &&
      "equals" in check.json) ||
    (check.metric &&
      /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(check.metric.name) &&
      Number.isFinite(check.metric.min)) ||
    (check.browser &&
      typeof check.browser.selector === "string" &&
      check.browser.selector.length > 0)
  );
}
async function limitedBody(response) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 1024 * 1024)
        throw new Error("Response exceeds 1 MiB evidence limit");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Keep evidence bounded without losing the identity of the full response.
function boundedText(value) {
  const bytes = Buffer.from(value);
  // UTF-8 replacement characters can exceed the original byte length at a
  // cut boundary. Remove any trailing incomplete character before decoding.
  let end = Math.min(bytes.length, 4096);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}
function boundedValue(value) {
  if (value === undefined) return { present: false };
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) <= 4096) return { present: true, value };
  return {
    present: true,
    truncated: true,
    jsonExcerpt: boundedText(encoded),
    jsonBytes: Buffer.byteLength(encoded),
    jsonSha256: digest(encoded),
  };
}
function atPath(value, path) {
  for (const key of path.split(".").filter(Boolean)) value = value?.[key];
  return value;
}
export async function httpProbe(
  check,
  { env = process.env, fetchImpl = fetch, timeoutMs = 5000 } = {},
) {
  const result = {
    id: check?.id ?? "invalid",
    url: check?.url ?? "",
    passed: false,
    sampledAt: now(),
    method: check?.metric
      ? "http_metric"
      : check?.json
        ? "http_json"
        : "http_body",
  };
  if (!validCheck(check) || check.browser)
    return {
      ...result,
      unavailable: true,
      detail:
        "A fixed deterministic business criterion is required; HTTP 200 alone is insufficient.",
    };
  const headers = {};
  if (check.credentialEnv) {
    const token = env[check.credentialEnv];
    if (!token)
      return {
        ...result,
        unavailable: true,
        detail: `Probe credential ${check.credentialEnv} is not configured.`,
      };
    headers.Authorization = "Bearer " + token;
  }
  try {
    const response = await fetchImpl(check.url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    result.witness = {
      status: response.status,
      finalUrl: response.url || check.url,
    };
    // Authentication is unknown capability even if its response body cannot
    // be collected. Never promote a failed credential into a repair signal.
    if (response.status === 401 || response.status === 403)
      result.unavailable = true;
    const bytes = await limitedBody(response);
    const text = bytes.toString("utf8");
    Object.assign(result.witness, {
      bodyBytes: bytes.length,
      bodySha256: digest(bytes),
      bodyExcerpt: boundedText(text),
      bodyTruncated: bytes.length > 4096,
      assertions: [],
    });
    if (!response.ok)
      return {
        ...result,
        completedAt: now(),
        unavailable: response.status === 401 || response.status === 403,
        detail: `HTTP ${response.status}`,
      };
    const outcomes = [];
    if (check.contains) {
      const matchIndex = text.indexOf(check.contains);
      outcomes.push(matchIndex >= 0);
      result.witness.assertions.push({
        kind: "contains",
        matchIndex,
        passed: matchIndex >= 0,
      });
    }
    if (check.json) {
      const observed = atPath(JSON.parse(text), check.json.path);
      const passed = isDeepStrictEqual(observed, check.json.equals);
      outcomes.push(passed);
      result.witness.assertions.push({
        kind: "json",
        path: check.json.path,
        observed: boundedValue(observed),
        passed,
      });
    }
    if (check.metric) {
      const name = check.metric.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(
        "^" + name + "(?:\\{[^\\n]*\\})?\\s+([-+0-9.eE]+)(?:\\s|$)",
        "gm",
      );
      const values = [...text.matchAll(pattern)]
        .map((m) => Number(m[1]))
        .filter(Number.isFinite);
      const sum = values.reduce((total, n) => total + n, 0);
      const passed = values.length > 0 && sum >= check.metric.min;
      outcomes.push(passed);
      result.witness.assertions.push({
        kind: "metric",
        name: check.metric.name,
        values: values.slice(0, 64),
        valueCount: values.length,
        valuesTruncated: values.length > 64,
        sum,
        minimum: check.metric.min,
        passed,
      });
    }
    const passed = outcomes.length > 0 && outcomes.every(Boolean);
    return {
      ...result,
      completedAt: now(),
      passed,
      detail: passed
        ? "Registered business assertion passed."
        : "HTTP succeeded but registered business assertion failed.",
    };
  } catch (err) {
    return {
      ...result,
      completedAt: now(),
      detail:
        err.name === "TimeoutError"
          ? "Probe timed out."
          : "Probe failed: " + err.message.slice(0, 300),
    };
  }
}

export async function browserProbe(
  check,
  { env = process.env, timeoutMs = 10000 } = {},
) {
  const result = {
    id: check.id,
    url: check.url,
    passed: false,
    sampledAt: now(),
    method: "browser_ui",
  };
  if (!validCheck(check) || !check.browser)
    return {
      ...result,
      unavailable: true,
      detail: "No fixed browser acceptance criterion.",
    };
  let browser;
  try {
    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch({ headless: true, channel: "chromium" });
    const context = await browser.newContext();
    if (check.browser.passwordEnv) {
      if (
        !/^[A-Z][A-Z0-9_]{0,127}$/.test(check.browser.passwordEnv) ||
        !env[check.browser.passwordEnv]
      )
        return {
          ...result,
          unavailable: true,
          detail:
            "Dedicated verifier application login credential is unavailable.",
        };
      const origin = new URL(check.url).origin;
      const response = await context.request.post(origin + "/api/login", {
        data: { password: env[check.browser.passwordEnv] },
        headers: { Origin: origin, "X-Refbox-Request": "1" },
        timeout: timeoutMs,
      });
      if (!response.ok())
        return {
          ...result,
          unavailable: true,
          detail: "Dedicated verifier application login failed.",
        };
    }
    const page = await context.newPage();
    const navigation = await page.goto(check.url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    result.witness = {
      finalUrl: page.url(),
      selector: check.browser.selector,
      navigationStatus: navigation?.status() ?? null,
      visible: false,
    };
    const locator = page.locator(check.browser.selector).first();
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    const visibleText = await locator.innerText();
    Object.assign(result.witness, {
      visible: true,
      visibleText: boundedText(visibleText),
      visibleTextBytes: Buffer.byteLength(visibleText),
      visibleTextSha256: digest(visibleText),
      visibleTextTruncated: Buffer.byteLength(visibleText) > 4096,
    });
    if (check.browser.text && !visibleText.includes(check.browser.text))
      return {
        ...result,
        completedAt: now(),
        detail:
          "Rendered business UI text does not match registered criterion.",
      };
    return {
      ...result,
      completedAt: now(),
      passed: true,
      detail:
        "Real browser rendered the registered business UI at the deployed user URL.",
    };
  } catch (err) {
    const unavailable =
      /Cannot find|Executable doesn't exist|browserType\.launch|Host system is missing dependencies|EPERM|Operation not permitted|Permission denied|sandbox/i.test(
        err.message,
      );
    return {
      ...result,
      completedAt: now(),
      unavailable,
      detail: unavailable
        ? "Independent browser worker is unavailable."
        : "Rendered UI assertion failed: " + err.message.slice(0, 300),
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}
