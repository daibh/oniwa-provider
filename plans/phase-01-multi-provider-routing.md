---
phase: 1
title: Multi-Provider Routing
status: completed
priority: P1
effort: 8h
dependencies: []
---

# Phase 1: Multi-Provider Routing

## Overview

Replace the single hardcoded `config.openaiBaseUrl` with a provider routing layer. Each resolved model maps to a provider (OpenAI, DeepSeek, Anthropic, etc.), which defines the API endpoint, API key, and request/response format. This allows Claude Code to use any model from any provider through the same proxy.

## Requirements

- Provider config per provider: base URL, API key, format type
- Model → provider routing table
- Format dispatch: `openai` format (anthropic→openai translation, existing code), `anthropic` format (passthrough)
- Per-provider API keys (env var or MODEL_API_KEYS-based)
- Backward compatible: existing `OPENAI_API_KEY` + `OPENAI_BASE_URL` work as default provider
- Provider field in usage records for cost tracking

## Architecture

```
Claude Code request (Anthropic format)
  → model: "claude-sonnet-4-6-20250514"
  → MODEL_MAPPING → resolved model: "gpt-4o"
  → MODEL_ROUTING → provider: "openai"
  → Provider config: { baseUrl, apiKey, format: "openai" }
  → format === "openai" → anthropicToOpenAI() → fetch(provider.baseUrl/chat/completions)
  → format === "anthropic" → passthrough → fetch(provider.baseUrl/v1/messages)
```

### Provider Config (env vars)

```env
# Default provider (backward compatible)
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1

# Explicit providers
PROVIDERS={"openai":{"baseUrl":"https://api.openai.com/v1","apiKey":"sk-...","format":"openai"},
            "deepseek":{"baseUrl":"https://api.deepseek.com/v1","apiKey":"sk-...","format":"openai"},
            "anthropic":{"baseUrl":"https://api.anthropic.com/v1","apiKey":"sk-ant-...","format":"anthropic"}}

# Model → provider routing (resolved model name → provider id)
MODEL_ROUTING={"gpt-4o":"openai","gpt-4o-mini":"openai","deepseek-chat":"deepseek","claude-sonnet-4-6-20250514":"anthropic"}
```

## Related Code Files

- Modify: `src/types.ts` — add ProviderConfig, ProviderFormat types
- Modify: `src/config.ts` — add provider parsing, model routing
- Modify: `src/index.ts` — provider selection, format dispatch, multiple fetch paths
- Modify: `src/translate.ts` — pass provider context for format decisions
- Modify: `.env.example` — document provider config

## Implementation Steps

1. **Add types to `src/types.ts`**

   ```ts
   export type ProviderFormat = "openai" | "anthropic";

   export interface ProviderConfig {
     baseUrl: string;
     apiKey: string;
     format: ProviderFormat;
   }

   export interface ModelRoute {
     model: string;       // resolved model name (e.g., "gpt-4o")
     provider: string;    // provider id (e.g., "openai")
   }
   ```

2. **Update `src/config.ts` — provider parsing**

   - Add `providers: Record<string, ProviderConfig>` from `PROVIDERS` env var (JSON)
   - Add `modelRouting: Record<string, string>` from `MODEL_ROUTING` env var (JSON)
   - Backward compatibility: if `PROVIDERS` is not set but `OPENAI_API_KEY` is:
     - Auto-create a provider `"default"` with `{ baseUrl: OPENAI_BASE_URL, apiKey: OPENAI_API_KEY, format: "openai" }`
     - All models route to `"default"`
   - Validation: each provider must have `baseUrl`, `apiKey`, `format`
   - Validation: `format` must be `"openai"` or `"anthropic"`
   - Validation: every model in `MODEL_ROUTING` must have a matching provider

3. **Add routing logic to `src/index.ts`**

   - Create `resolveProvider(resolvedModel: string, config): { provider: ProviderConfig, format: ProviderFormat }`
     - Look up `config.modelRouting[resolvedModel]` → providerId
     - If not found, use `"default"` provider
     - Look up `config.providers[providerId]`
     - Return provider config + format
   - Refactor the request-sending block:
     - After model resolution, call `resolveProvider`
     - Based on `format`:

     **Format: `openai`**
     - Use existing `anthropicToOpenAI()` translation
     - Send to `provider.baseUrl/chat/completions`
     - Use `provider.apiKey` as Bearer token
     - Use existing response handling (`openaiToAnthropic`, streaming)

     **Format: `anthropic`**
     - Passthrough: forward the original Anthropic request body as-is
     - Send to `provider.baseUrl/v1/messages`
     - Use `provider.apiKey` as `x-api-key` header
     - Return the response as-is (no translation needed)
     - Streaming: forward SSE events directly

4. **Streaming handling for anthropic format**

   - If `format === "anthropic"`:
     - Forward the `stream: true` flag as-is
     - Stream the response chunks directly to the client
     - No translation needed — client speaks Anthropic format natively
   - This means the proxy acts as a simple auth + routing layer for Anthropic

5. **Usage extraction per format**

   - **openai format**: existing logic (response.usage)
   - **anthropic format**: response includes `usage.input_tokens`, `usage.output_tokens` at the top level in non-streaming, and in `message_delta` for streaming
   - Both produce the same UsageRecord shape for downstream logging

6. **Update `.env.example`**
   - Replace `OPENAI_API_KEY` with provider config documentation
   - Add `PROVIDERS` JSON example
   - Add `MODEL_ROUTING` JSON example
   - Keep `OPENAI_API_KEY` as backward-compatible fallback

7. **Remove obsolete config**
   - `config.openaiBaseUrl` → replaced by provider.baseUrl
   - `config.openaiApiKey` → replaced by provider.apiKey
   - `config.modelApiKeys` → replaced by per-provider apiKey in PROVIDERS
   - Keep backward compatibility: if old env vars are set and PROVIDERS is not, create default provider

## Success Criteria

- [ ] Existing single-provider setup (`OPENAI_API_KEY`) still works (backward compatible)
- [ ] Multi-provider routing works: model → correct provider endpoint
- [ ] OpenAI-format providers translate request/response correctly
- [ ] Anthropic-format providers pass through correctly
- [ ] Missing provider for a model falls back gracefully (error message, not crash)
- [ ] Provider config validation catches missing fields at startup
- [ ] `npm run build` compiles without errors
- [ ] Streaming works for both formats
