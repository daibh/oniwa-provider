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

const parseRecord = (key: string): Record<string, string> => {
  const val = process.env[key];
  if (!val) return {};
  try {
    return JSON.parse(val);
  } catch {
    const result: Record<string, string> = {};
    val.split(",").forEach((pair) => {
      const [k, v] = pair.split("=").map((s) => s.trim());
      if (k && v) result[k] = v;
    });
    return result;
  }
};

const parseRecordNum = (key: string): Record<string, number> => {
  const val = process.env[key];
  if (!val) return {};
  try {
    return JSON.parse(val);
  } catch {
    const result: Record<string, number> = {};
    val.split(",").forEach((pair) => {
      const [k, v] = pair.split("=").map((s) => s.trim());
      if (k && v) result[k] = parseInt(v, 10);
    });
    return result;
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
    modelMapping: parseRecord("MODEL_MAPPING"),
    modelApiKeys: parseRecord("MODEL_API_KEYS"),
    modelContextLimits: parseRecordNum("MODEL_CONTEXT_LIMITS"),
    defaultModel: process.env.DEFAULT_MODEL || "gpt-4o",
    maxOutputTokens: parseInt(process.env.MAX_OUTPUT_TOKENS || "16384", 10),
    maxImageSize: parseInt(process.env.MAX_IMAGE_SIZE || "5242880", 10),
    allowedApiKeys,
  };
}
