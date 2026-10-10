import { HttpError } from "./state.js";

export type PlatformOptions = { url: string; token: string };
type PluginTool = {
  id: string;
  name?: string;
  description?: string;
  mutates: boolean;
};
type Plugin = {
  id: string;
  enabled?: boolean;
  online?: boolean;
  tools?: PluginTool[];
  resources?: { id: string }[];
  manifest?: { tools?: PluginTool[]; resources?: { id: string }[] };
};
type Resource = {
  id: string;
  pluginId: string;
  version?: string;
  environmentId?: string;
};

/** Uses the platform registry as authority. Models never select a destination URL. */
export class PlatformClient {
  private readonly base: URL;
  constructor(private readonly options: PlatformOptions) {
    this.base = new URL(options.url);
    if (
      this.base.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(this.base.hostname) ||
      this.base.username ||
      this.base.password ||
      options.token.length < 32
    )
      throw new Error("平台接口必须使用本机 HTTP 地址和独立的内部凭据");
  }

  async request(path: string, input?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.base), {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + this.options.token,
        "Content-Type": "application/json",
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!response.ok)
      throw new HttpError(response.status, "平台接口暂不可用或操作未授权");
    return response.json();
  }

  async resources(): Promise<Resource[]> {
    const value = await this.request("/internal/resources");
    return (
      Array.isArray(value)
        ? value
        : ((value as { resources?: Resource[] }).resources ?? [])
    ) as Resource[];
  }

  async plugins(): Promise<Plugin[]> {
    const value = await this.request("/internal/plugins");
    return (
      Array.isArray(value)
        ? value
        : ((value as { plugins?: Plugin[] }).plugins ?? [])
    ) as Plugin[];
  }

  async observe(resourceId?: string): Promise<unknown> {
    if (resourceId)
      return this.request(
        "/internal/observations?resourceId=" + encodeURIComponent(resourceId),
      );
    return { resources: await this.resources(), plugins: await this.plugins() };
  }

  async catalog(resourceId?: string, readOnly = false) {
    const plugins = await this.plugins();
    const resource = resourceId
      ? (await this.resources()).find((r) => r.id === resourceId)
      : undefined;
    if (resourceId && !resource) throw new HttpError(404, "诊断资源不存在");
    return plugins
      .filter(
        (p) => p.enabled !== false && (!resource || p.id === resource.pluginId),
      )
      .map((p) => ({
        id: p.id,
        tools: (p.manifest?.tools ?? p.tools ?? []).filter(
          (t) => !readOnly || t.mutates === false,
        ),
      }));
  }

  async call(
    pluginId: string,
    toolId: string,
    input: Record<string, unknown>,
    resourceId?: string,
    readOnly = false,
    idempotencyKey?: string,
  ) {
    if (![pluginId, toolId].every((id) => /^[a-zA-Z0-9_-]+$/.test(id)))
      throw new HttpError(400, "插件和工具标识无效");
    const plugin = (await this.catalog(resourceId, readOnly)).find(
      (p) => p.id === pluginId,
    );
    if (!plugin?.tools.some((t) => t.id === toolId))
      throw new HttpError(403, "工具未声明、插件未启用或不属于本次诊断资源");
    return this.request(
      `/internal/plugins/${encodeURIComponent(pluginId)}/tools/${encodeURIComponent(toolId)}`,
      {
        input: { ...input, ...(resourceId ? { resourceId } : {}) },
        readOnly,
        ...(resourceId ? { resourceId } : {}),
        ...(idempotencyKey ? { _idempotencyKey: idempotencyKey } : {}),
      },
    );
  }
}
