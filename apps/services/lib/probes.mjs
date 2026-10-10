import { now } from "./http.mjs";
import { isDeepStrictEqual } from "node:util";

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
async function limitedText(response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
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
    return Buffer.concat(chunks).toString();
  } finally {
    await reader.cancel().catch(() => {});
  }
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
    if (!response.ok) return { ...result, detail: `HTTP ${response.status}` };
    const text = await limitedText(response);
    const outcomes = [];
    if (check.contains) outcomes.push(text.includes(check.contains));
    if (check.json)
      outcomes.push(
        isDeepStrictEqual(
          atPath(JSON.parse(text), check.json.path),
          check.json.equals,
        ),
      );
    if (check.metric) {
      const name = check.metric.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(
        "^" + name + "(?:\\{[^\\n]*\\})?\\s+([-+0-9.eE]+)(?:\\s|$)",
        "gm",
      );
      const values = [...text.matchAll(pattern)]
        .map((m) => Number(m[1]))
        .filter(Number.isFinite);
      outcomes.push(
        values.length > 0 &&
          values.reduce((sum, n) => sum + n, 0) >= check.metric.min,
      );
    }
    const passed = outcomes.length > 0 && outcomes.every(Boolean);
    return {
      ...result,
      passed,
      detail: passed
        ? "Registered business assertion passed."
        : "HTTP succeeded but registered business assertion failed.",
    };
  } catch (err) {
    return {
      ...result,
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
    browser = await chromium.launch({ headless: true });
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
    await page.goto(check.url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    const locator = page.locator(check.browser.selector).first();
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
    if (
      check.browser.text &&
      !(await locator.innerText()).includes(check.browser.text)
    )
      return {
        ...result,
        detail:
          "Rendered business UI text does not match registered criterion.",
      };
    return {
      ...result,
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
      unavailable,
      detail: unavailable
        ? "Independent browser worker is unavailable."
        : "Rendered UI assertion failed: " + err.message.slice(0, 300),
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}
