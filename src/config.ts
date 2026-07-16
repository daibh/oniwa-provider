import { Config } from "./types";

const parseArray = (key: string): string[] => {
  const val = process.env[key];
  if (!val) return [];
  try {
    return JSON.parse(val);
  } catch {
    return val.split(",").map((s) => s.trim()).filter(Boolean);
  }
};

const parseModelMapping = (): Record<string, string> => {
  const val = process.env.MODEL_MAPPING;
  if (!val) return {};
  try {
    return JSON.parse(val);
  } catch {
    const mapping: Record<string, string> = {};
    val.split(",").forEach((pair) => {
      const [k, v] = pair.split("=").map((s) => s.trim());
      if (k && v) mapping[k] = v;
    });
    return mapping;
  }
};

export function loadConfig(): Config {
  const allowedApiKeys = parseArray("ALLOWED_API_KEYS");
  if (allowedApiKeys.length === 0 && process.env.ANTHROPIC_AUTH_TOKEN) {
    allowedApiKeys.push(process.env.ANTHROPIC_AUTH_TOKEN);
  }

  return {
    port: parseInt(process.env.PORT || "8080", 10),
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    modelMapping: parseModelMapping(),
    defaultModel: process.env.DEFAULT_MODEL || "gpt-4o",
    maxOutputTokens: parseInt(process.env.MAX_OUTPUT_TOKENS || "16384", 10),
    allowedApiKeys,
  };
}
