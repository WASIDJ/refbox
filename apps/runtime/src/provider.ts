import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  createModels,
  createProvider,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export async function engyModels() {
  const profile = process.env.PI_PROFILE_DIR ?? join(homedir(), ".pi/agent");
  const config = JSON.parse(
    await readFile(join(profile, "models.json"), "utf8"),
  ).providers?.engy;
  if (
    !config ||
    config.api !== "openai-completions" ||
    !Array.isArray(config.models)
  )
    throw new Error("PI_PROFILE_DIR 中需要 engy / openai-completions 配置");
  const key =
    process.env.ENGY_API_KEY ??
    JSON.parse(await readFile(join(profile, "auth.json"), "utf8")).engy?.key;
  if (typeof key !== "string" || !key || key.startsWith("!"))
    throw new Error(
      "请配置 ENGY_API_KEY 或 Pi engy 的直接 API Key；不执行凭据中的命令",
    );
  const resolvedKey = process.env[key] ?? key;
  const models = createModels();
  models.setProvider(
    createProvider({
      id: "engy",
      name: "Engy",
      baseUrl: config.baseUrl,
      auth: {
        apiKey: {
          name: "Engy",
          resolve: async () => ({ auth: { apiKey: resolvedKey } }),
        },
      },
      models: config.models.map((m: Partial<Model<"openai-completions">>) => ({
        ...m,
        provider: "engy",
        api: "openai-completions",
        baseUrl: config.baseUrl,
        name: m.name ?? m.id,
        input: m.input ?? ["text"],
        reasoning: m.reasoning ?? false,
        cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.contextWindow ?? 128000,
        maxTokens: m.maxTokens ?? 16384,
      })) as Model<"openai-completions">[],
      api: openAICompletionsApi(),
    }),
  );
  return models;
}
