import "dotenv/config";
import express from "express";
import { loadConfig } from "./config";
import { anthropicToOpenAI, openaiToAnthropic, openaiChunkToAnthropicEvents, createStreamState } from "./translate";
import type { OpenAIResponse } from "./types";

const app = express();
const config = loadConfig();

app.use(express.json({ limit: "50mb" }));

function getAuthToken(req: express.Request): string | null {
  const xApiKey = req.headers["x-api-key"];
  if (xApiKey) {
    return typeof xApiKey === "string" ? xApiKey : xApiKey[0];
  }

  const auth = req.headers["authorization"];
  if (auth) {
    const authStr = typeof auth === "string" ? auth : auth[0];
    const parts = authStr.split(" ");
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
      return parts[1];
    }
  }
  return null;
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const MODELS = [
  { id: "claude-sonnet-4-6-20250514", object: "model", created: 1747000000, owned_by: "oniwa" },
  { id: "claude-haiku-4-5-20251001", object: "model", created: 1747000000, owned_by: "oniwa" },
  { id: "claude-opus-4-5-20250514", object: "model", created: 1747000000, owned_by: "oniwa" },
];

app.get("/v1/models", (_req, res) => {
  res.json({ data: MODELS });
});

app.post("/v1/messages/count_tokens", (req, res) => {
  const text = JSON.stringify(req.body);
  const charCount = text.length;
  res.json({
    input_tokens: Math.ceil(charCount / 4),
    output_tokens: 0,
  });
});

app.post("/v1/messages", async (req, res) => {
  const token = getAuthToken(req);
  if (config.allowedApiKeys.length > 0) {
    if (!token || !config.allowedApiKeys.includes(token)) {
      res.status(401).json({
        type: "error",
        error: { type: "authentication_error", message: "Invalid API key" },
      });
      return;
    }
  }

  try {
    const anthropicReq = req.body;
    const openaiReq = anthropicToOpenAI(anthropicReq, config.modelMapping, config.defaultModel, config.maxOutputTokens);

    const resolvedModel = openaiReq.model;
    const modelKey = config.modelApiKeys[resolvedModel] || config.openaiApiKey;
    if (!modelKey) {
      res.status(500).json({
        type: "error",
        error: {
          type: "api_error",
          message: `No API key configured for model '${resolvedModel}'. Set OPENAI_API_KEY or add it to MODEL_API_KEYS.`,
        },
      });
      return;
    }

    const oaiHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${modelKey}`,
    };

    if (anthropicReq.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const oaiRes = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: oaiHeaders,
        body: JSON.stringify(openaiReq),
      });

      if (!oaiRes.ok) {
        const errText = await oaiRes.text();
        res.write(`data: ${JSON.stringify({
          type: "error",
          error: { type: "api_error", message: errText },
        })}\n\n`);
        res.end();
        return;
      }

      const reader = oaiRes.body?.getReader();
      if (!reader) { res.end(); return; }

      const state = createStreamState();
      const decoder = new TextDecoder();
      let buffer = "";

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
              const events = openaiChunkToAnthropicEvents(chunk, anthropicReq.model, state);
              for (const event of events) {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
              }
            } catch {
              // skip
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (!state.messageStarted) {
        res.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      const oaiRes = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: oaiHeaders,
        body: JSON.stringify(openaiReq),
      });

      if (!oaiRes.ok) {
        const errText = await oaiRes.text();
        let errBody: { error?: { message?: string }; message?: string };
        try { errBody = JSON.parse(errText); } catch { errBody = { message: errText }; }
        res.status(oaiRes.status).json({
          type: "error",
          error: {
            type: "api_error",
            message: errBody.error?.message || errBody.message || "OpenAI API error",
          },
        });
        return;
      }

      const oaiData = (await oaiRes.json()) as OpenAIResponse;
      const anthropicRes = openaiToAnthropic(oaiData, anthropicReq.model);
      res.json(anthropicRes);
    }
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({
      type: "error",
      error: {
        type: "server_error",
        message: err instanceof Error ? err.message : "Unknown error",
      },
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({
    type: "error",
    error: { type: "not_found", message: "Not found" },
  });
});

app.listen(config.port, () => {
  console.log(`oNiwa Provider running on port ${config.port}`);
  console.log(`Default OpenAI model: ${config.defaultModel}`);
  console.log(`OpenAI API URL: ${config.openaiBaseUrl}`);
  console.log(`Model mapping: ${JSON.stringify(config.modelMapping)}`);
  console.log(`Allowed API keys: ${config.allowedApiKeys.length > 0 ? config.allowedApiKeys.length + " configured" : "any key accepted"}`);
});
