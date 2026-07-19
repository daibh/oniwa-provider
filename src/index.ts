import "dotenv/config";
import express from "express";
import { loadConfig } from "./config";
import { anthropicToOpenAI, openaiToAnthropic, openaiChunkToAnthropicEvents, createStreamState } from "./translate";
import { initStorage } from "./storage";
import { resolveOrCreateUser, isAdminRequest, hashToken } from "./auth";
import { createAdminRouter } from "./admin";
import { readJSON, userProfilePath } from "./storage";
import { logUsage, buildUsageRecord } from "./usage";
import type { OpenAIResponse, ProviderConfig, UserProfile, OpenAIStreamChunk } from "./types";

const app = express();
const config = loadConfig();

if (config.s3Bucket) {
  initStorage(config.s3Bucket, config.awsRegion);
}

app.use(express.json({ limit: "50mb" }));

app.use("/v1", authMiddleware);
app.use("/v1/admin", createAdminRouter(config));

const tokenParamCache = new Map<string, "max_completion_tokens" | "max_tokens">();

function getTokenParam(model: string) {
  return tokenParamCache.get(model) || "max_completion_tokens";
}

function getAuthToken(req: express.Request): string | null {
  const xApiKey = req.headers["x-api-key"];
  if (xApiKey) return typeof xApiKey === "string" ? xApiKey : xApiKey[0];
  const auth = req.headers["authorization"];
  if (auth) {
    const parts = (typeof auth === "string" ? auth : auth[0]).split(" ");
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer") return parts[1];
  }
  return null;
}

async function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = getAuthToken(req);
  if (!token) {
    res.status(401).json({ type: "error", error: { type: "authentication_error", message: "Missing API key" } });
    return;
  }

  if (req.originalUrl.startsWith("/v1/admin")) {
    if (isAdminRequest(token, config.adminApiKey)) {
      return next();
    }
    res.status(401).json({ type: "error", error: { type: "authentication_error", message: "Invalid admin API key" } });
    return;
  }

  if (!config.s3Bucket) {
    return next();
  }

  try {
    const user = await resolveOrCreateUser(token);
    const profile = await readJSON<UserProfile>(userProfilePath(user.userId));
    if (!profile || !profile.active) {
      res.status(403).json({ type: "error", error: { type: "forbidden", message: "User deactivated" } });
      return;
    }
    const tokenH = hashToken(token);
    const tokenEntry = profile.tokens.find((t) => t.hashedToken === tokenH);
    if (tokenEntry?.revoked) {
      res.status(403).json({ type: "error", error: { type: "forbidden", message: "Token revoked" } });
      return;
    }
    (req as any).userId = user.userId;
    (req as any).tokenHashed = tokenH;
    next();
  } catch (e) {
    console.error("[auth] resolveOrCreateUser error:", e);
    res.status(500).json({ type: "error", error: { type: "server_error", message: "Authentication failed" } });
  }
}

function isUnsupportedParamError(status: number, body: string, paramName: string): boolean {
  return status === 400 && body.includes(paramName) && body.includes("not supported");
}

function resolveProvider(model: string): { provider: ProviderConfig; resolvedModel: string } {
  const resolvedModel = config.modelMapping[model] || model;
  const providerId = config.modelRouting[resolvedModel] || "default";
  const provider = config.providers[providerId];
  if (!provider) {
    throw new Error(`No provider found for model '${model}' (resolved: '${resolvedModel}', provider: '${providerId}'). Check PROVIDERS and MODEL_ROUTING env vars.`);
  }
  return { provider, resolvedModel };
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));

const MODELS = [
  { id: "claude-sonnet-4-6-20250514", object: "model", created: 1747000000, owned_by: "oniwa" },
  { id: "claude-haiku-4-5-20251001", object: "model", created: 1747000000, owned_by: "oniwa" },
  { id: "claude-opus-4-5-20250514", object: "model", created: 1747000000, owned_by: "oniwa" },
];

app.get("/v1/models", (_req, res) => res.json({ data: MODELS }));

app.post("/v1/messages/count_tokens", (req, res) => {
  const text = JSON.stringify(req.body);
  res.json({ input_tokens: Math.ceil(text.length / 4), output_tokens: 0 });
});

app.post("/v1/messages", async (req, res) => {
  try {
    const anthropicReq = req.body;
    const { provider, resolvedModel } = resolveProvider(anthropicReq.model);

    if (provider.format === "anthropic") {
      await handleAnthropicPassthrough(res, anthropicReq, provider, (req as any).userId || "unknown");
    } else {
      await handleOpenAIFormat(res, anthropicReq, provider, resolvedModel, (req as any).userId || "unknown");
    }
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({
      type: "error",
      error: { type: "server_error", message: err instanceof Error ? err.message : "Unknown error" },
    });
  }
});

async function handleAnthropicPassthrough(
  res: express.Response,
  anthropicReq: any,
  provider: ProviderConfig,
  userId: string
) {
  const body = { ...anthropicReq, model: anthropicReq.model };

  if (anthropicReq.stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const oaiRes = await fetch(`${provider.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!oaiRes.ok) {
      const errText = await oaiRes.text();
      res.write(`data: ${JSON.stringify({ type: "error", error: { type: "api_error", message: errText } })}\n\n`);
      res.end();
      return;
    }

    const reader = oaiRes.body?.getReader();
    if (!reader) { res.end(); return; }

    const decoder = new TextDecoder();
    let buffer = "";
    let anthropicInputTokens = 0;
    let anthropicOutputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith("data: ")) {
            try {
              const event = JSON.parse(trimmed.slice(6));
              if (event.type === "message_start" && event.message?.usage?.input_tokens) {
                anthropicInputTokens = event.message.usage.input_tokens;
              }
              if (event.type === "message_delta" && event.usage?.output_tokens) {
                anthropicOutputTokens = event.usage.output_tokens;
              }
            } catch { /* skip parse */ }
          }
          res.write(trimmed + "\n\n");
        }
      }
    } finally { reader.releaseLock(); }

    if (anthropicInputTokens > 0 || anthropicOutputTokens > 0) {
      logUsage(buildUsageRecord(userId, anthropicReq.model, provider.format, {
        input: anthropicInputTokens,
        output: anthropicOutputTokens,
        cachedInput: 0,
      }, true));
    }

    res.end();
  } else {
    const oaiRes = await fetch(`${provider.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!oaiRes.ok) {
      const errText = await oaiRes.text();
      let errBody: any;
      try { errBody = JSON.parse(errText); } catch { errBody = { message: errText }; }
      res.status(oaiRes.status).json({
        type: "error",
        error: { type: "api_error", message: errBody.error?.message || errBody.message || errText },
      });
      return;
    }

    const data = JSON.parse(await oaiRes.text());
    if (data.usage) {
      logUsage(buildUsageRecord(userId, anthropicReq.model, provider.format, {
        input: data.usage.input_tokens || 0,
        output: data.usage.output_tokens || 0,
        cachedInput: 0,
      }, false));
    }
    res.json(data);
  }
}

async function handleOpenAIFormat(
  res: express.Response,
  anthropicReq: any,
  provider: ProviderConfig,
  resolvedModel: string,
  userId: string
) {
  let tokenParam = getTokenParam(resolvedModel);

    let openaiReq = anthropicToOpenAI(
      { ...anthropicReq, model: resolvedModel },
      config.modelMapping,
      config.maxOutputTokens,
      config.modelContextLimits,
      config.maxImageSize,
      tokenParam
    );

    openaiReq.model = resolvedModel;

    const modelKey = config.modelApiKeys[openaiReq.model] || provider.apiKey;
  if (!modelKey) {
    res.status(500).json({
      type: "error",
      error: { type: "api_error", message: `No API key for model '${openaiReq.model}'` },
    });
    return;
  }

  const oaiHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${modelKey}`,
  };

  const url = `${provider.baseUrl}/chat/completions`;
  const body = JSON.stringify(openaiReq);

  if (anthropicReq.stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let oaiRes = await fetch(url, { method: "POST", headers: oaiHeaders, body });

    if (!oaiRes.ok) {
      const errText = await oaiRes.text();
      const altParam = tokenParam === "max_completion_tokens" ? "max_tokens" : "max_completion_tokens";
      if (isUnsupportedParamError(oaiRes.status, errText, tokenParam)) {
        tokenParamCache.set(resolvedModel, altParam);
        tokenParam = altParam;
        openaiReq = anthropicToOpenAI(
          { ...anthropicReq, model: resolvedModel },
          config.modelMapping,
          config.maxOutputTokens, config.modelContextLimits,
          config.maxImageSize, tokenParam
        );
        oaiRes = await fetch(url, {
          method: "POST",
          headers: oaiHeaders,
          body: JSON.stringify(openaiReq),
        });
        if (!oaiRes.ok) {
          const retryErr = await oaiRes.text();
          res.write(`data: ${JSON.stringify({ type: "error", error: { type: "api_error", message: retryErr } })}\n\n`);
          res.end();
          return;
        }
      } else {
        res.write(`data: ${JSON.stringify({ type: "error", error: { type: "api_error", message: errText } })}\n\n`);
        res.end();
        return;
      }
    }

    const reader = oaiRes.body?.getReader();
    if (!reader) { res.end(); return; }

    const state = createStreamState();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastUsage: OpenAIStreamChunk["usage"];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            res.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
            res.write("data: [DONE]\n\n");
            continue;
          }
          try {
            const chunk = JSON.parse(data);
            if (chunk.usage) lastUsage = chunk.usage;
            const events = openaiChunkToAnthropicEvents(chunk, anthropicReq.model, state);
            for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
          } catch { /* skip */ }
        }
      }
    } finally { reader.releaseLock(); }

    if (lastUsage) {
      const usageRecord = buildUsageRecord(
        userId,
        openaiReq.model,
        provider.format,
        {
          input: lastUsage.prompt_tokens || 0,
          output: lastUsage.completion_tokens || 0,
          cachedInput: lastUsage.prompt_tokens_details?.cached_tokens || 0,
        },
        true
      );
      logUsage(usageRecord);
    }

    if (!state.messageStarted) res.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  } else {
    let oaiRes = await fetch(url, { method: "POST", headers: oaiHeaders, body });

    if (!oaiRes.ok) {
      const errText = await oaiRes.text();
      const altParam = tokenParam === "max_completion_tokens" ? "max_tokens" : "max_completion_tokens";
      if (isUnsupportedParamError(oaiRes.status, errText, tokenParam)) {
        tokenParamCache.set(resolvedModel, altParam);
        tokenParam = altParam;
        openaiReq = anthropicToOpenAI(
          { ...anthropicReq, model: resolvedModel },
          config.modelMapping,
          config.maxOutputTokens, config.modelContextLimits,
          config.maxImageSize, tokenParam
        );
        oaiRes = await fetch(url, {
          method: "POST",
          headers: oaiHeaders,
          body: JSON.stringify(openaiReq),
        });
        if (!oaiRes.ok) {
          const retryErr = await oaiRes.text();
          let errBody: any;
          try { errBody = JSON.parse(retryErr); } catch { errBody = { message: retryErr }; }
          res.status(oaiRes.status).json({
            type: "error",
            error: { type: "api_error", message: errBody.error?.message || errBody.message || retryErr },
          });
          return;
        }
      } else {
        let errBody: any;
        try { errBody = JSON.parse(errText); } catch { errBody = { message: errText }; }
        res.status(oaiRes.status).json({
          type: "error",
          error: { type: "api_error", message: errBody.error?.message || errBody.message || errText },
        });
        return;
      }
    }

    const oaiData: OpenAIResponse = JSON.parse(await oaiRes.text());
    const anthropicRes = openaiToAnthropic(oaiData, anthropicReq.model);
    const usageRecord = buildUsageRecord(
      userId,
      openaiReq.model,
      provider.format,
      {
        input: oaiData.usage?.prompt_tokens || 0,
        output: oaiData.usage?.completion_tokens || 0,
        cachedInput: oaiData.usage?.prompt_tokens_details?.cached_tokens || 0,
      },
      false
    );
    logUsage(usageRecord);
    res.json(anthropicRes);
  }
}

app.use((_req, res) => {
  res.status(404).json({ type: "error", error: { type: "not_found", message: "Not found" } });
});

if (!process.env.AWS_EXECUTION_ENV) {
  app.listen(config.port, () => {
    console.log(`oNiwa Provider running on port ${config.port}`);
    console.log(`Providers: ${Object.keys(config.providers).join(", ")}`);
    console.log(`Model routing: ${JSON.stringify(config.modelRouting)}`);
    console.log(`Model mapping: ${JSON.stringify(config.modelMapping)}`);
    console.log(`Context limits: ${JSON.stringify(config.modelContextLimits)}`);
    console.log(`Max output tokens: ${config.maxOutputTokens}`);
    console.log(`Admin API key: ${config.adminApiKey ? "configured" : "not set (admin endpoints disabled)"}`);
    console.log(`User auth: token-based (auto-create on first request)`);
    console.log(`S3 bucket: ${config.s3Bucket || "not configured (user management disabled)"}`);
  });
}

export { app, config };
