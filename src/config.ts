import { Config, ProviderConfig, ProviderFormat } from "./types";

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

function parseProviders(): Record<string, ProviderConfig> {
  const raw = process.env.PROVIDERS;
  if (!raw) {
    console.warn("WARNING: No providers configured. Set PROVIDERS env var.");
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    const providers: Record<string, ProviderConfig> = {};
    for (const [id, cfg] of Object.entries(parsed)) {
      const c = cfg as any;
      if (!c.baseUrl || !c.apiKey || !c.format) {
        throw new Error(`Provider '${id}' missing baseUrl, apiKey, or format`);
      }
      if (c.format !== "openai" && c.format !== "anthropic") {
        throw new Error(`Provider '${id}' has invalid format '${c.format}'. Must be 'openai' or 'anthropic'`);
      }
      providers[id] = { baseUrl: c.baseUrl, apiKey: c.apiKey, format: c.format as ProviderFormat };
    }
    return providers;
  } catch (e) {
    console.error(`[config] Failed to parse PROVIDERS:`, e);
    process.exit(1);
  }
}

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  const providers = parseProviders();
  const modelRouting = parseRecord("MODEL_ROUTING");

  const result = {
    port: parseInt(process.env.PORT || "8080", 10),
    modelMapping: parseRecord("MODEL_MAPPING"),
    modelApiKeys: parseRecord("MODEL_API_KEYS"),
    modelContextLimits: parseRecordNum("MODEL_CONTEXT_LIMITS"),
    maxOutputTokens: parseInt(process.env.MAX_OUTPUT_TOKENS || "16384", 10),
    maxImageSize: parseInt(process.env.MAX_IMAGE_SIZE || "5242880", 10),
    providers,
    modelRouting,
    adminApiKey: process.env.ADMIN_API_KEY || "",
    s3Bucket: process.env.S3_BUCKET || "",
    awsRegion: process.env.AWS_REGION || "us-east-1",
    logsGroupName: process.env.CW_LOG_GROUP || "/aws/lambda/oniwa-provider",
  };

  _config = result;
  return result;
}
