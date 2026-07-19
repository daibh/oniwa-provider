---
phase: 5
title: Usage Capture
status: completed
priority: P1
effort: 8h
dependencies:
  - 1
  - 3
---

# Phase 5: Usage Capture

## Overview

Extract token usage from every API request and log it as a structured JSON record. Usage extraction depends on the **provider format** (from Phase 1):

- **`openai` format**: usage in `response.usage` (non-streaming) or final SSE chunk with `stream_options: { include_usage: true }` (streaming)
- **`anthropic` format**: usage in `response.usage.input_tokens`/`output_tokens` (non-streaming) or `message_delta` event usage (streaming)

Log fire-and-forget (no latency added to response). Include `provider` and `providerFormat` in each usage record.

## Requirements

- Capture `prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens` from OpenAI
- Streaming: add `stream_options.include_usage`, parse final chunk
- Non-streaming: read usage from OpenAIResponse
- Log to CloudWatch via `console.log(JSON.stringify(usageRecord))`
- Fire-and-forget — don't await the write, don't block the response
- Handle missing usage data gracefully (no crash if absent)

## Architecture

### Non-Streaming Flow
```
OpenAI response → JSON parse → extract usage.usage
  → build UsageRecord → console.log(JSON.stringify(record))  ← fire-and-forget
  → forward OpenAI response to client
```

### Streaming Flow
```
OpenAI streaming response → iterate chunks
  → forward each chunk to client immediately
  → on final chunk (before [DONE]): check for chunk.usage
  → build UsageRecord → console.log(JSON.stringify(record))  ← after stream ends
```

## Related Code Files

- Modify: `src/translate.ts` — add stream_options, update OpenAIStreamChunk type usage
- Modify: `src/types.ts` — update OpenAIStreamChunk to include `usage?`
- Modify: `src/index.ts` — capture usage in both streaming and non-streaming paths, call usage logger
- Create: `src/usage.ts` — usage record builder and logger
- Modify: `package.json` — add `@aws-sdk/client-cloudwatch-logs` (for metrics queries; writing is just console.log)

## Implementation Steps

1. **Update `src/types.ts`**
   - Update `OpenAIStreamChunk` to include optional `usage`:
     ```ts
     export interface OpenAIStreamChunk {
       id: string;
       object: string;
       model: string;
       choices: { index: number; delta: Partial<OpenAIMessage>; finish_reason: string | null }[];
       usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number;
                 prompt_tokens_details?: { cached_tokens?: number } };
     }
     ```
   - Update `OpenAIResponse.usage` to include `prompt_tokens_details`:
     ```ts
     usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number;
              prompt_tokens_details?: { cached_tokens?: number } };
     ```

2. **Update `src/translate.ts` — streaming request**
   - In `anthropicToOpenAI`, when `tokenParam === "max_completion_tokens"` AND `req.stream === true`:
     - Add `stream_options: { include_usage: true }` to the OpenAIRequest
   - Note: `stream_options` is only needed when using `max_completion_tokens` (Chat Completions API with reasoning models). For legacy `max_tokens` streaming, usage may or may not be included. Handle both cases.

3. **Create `src/usage.ts`**
   - `buildUsageRecord(userId: string, model: string, usage: { prompt_tokens, completion_tokens, cached_tokens? }, streaming: boolean): UsageRecord`
     - Generate unique `requestId` (uuid or random hex)
     - Format timestamp as ISO string
     - Return structured UsageRecord object
   - `logUsage(record: UsageRecord): void`
     - `console.log(JSON.stringify({ type: "usage", ...record }))`
     - Pure fire-and-forget — synchronous, no return, never throws
   - `extractStreamUsage(chunk: OpenAIStreamChunk): { prompt_tokens, completion_tokens, cached_tokens? } | null`
     - Read chunk.usage if present
     - Extract `prompt_tokens_details?.cached_tokens` as cachedInputTokens
     - Return null if no usage field

4. **Update `src/index.ts` — non-streaming path**
   - After `const oaiData = JSON.parse(await oaiRes.text())`:
     - Extract usage from oaiData.usage
     - Build UsageRecord with userId from req (set by auth middleware)
     - Call `logUsage(record)` — no await, fire-and-forget
   - Same logic applies in both success and retry paths

5. **Update `src/index.ts` — streaming path**
   - After the streaming loop completes (after `reader.releaseLock()`):
     - Check the last chunk for usage data
     - If stream_options was set, the final chunk's `usage` field has the totals
     - Build UsageRecord and fire-and-forget
   - Edge case: if the stream errored partway through, don't log usage (incomplete)

6. **Handle usage absence**
   - Some providers may not send usage in streaming even with stream_options
   - If usage data is null/missing, skip logging (don't write a zeroed record)
   - Log a warning via `console.warn` when expected but absent

## Usage Record Schema

```json
{
  "type": "usage",
  "requestId": "req_abc123",
  "userId": "usr_abc",
  "model": "gpt-4o",
  "timestamp": "2026-07-19T12:34:56.789Z",
  "inputTokens": 150,
  "outputTokens": 320,
  "cachedInputTokens": 50,
  "streaming": true
}
```

## Success Criteria

- [ ] Non-streaming request logs correct usage record to stdout
- [ ] Streaming request with `include_usage` logs correct usage after stream ends
- [ ] Streaming without `include_usage` gracefully skips logging (no crash)
- [ ] Logged records are valid JSON parseable by CloudWatch Logs Insights
- [ ] `cachedInputTokens` is correctly extracted from `prompt_tokens_details.cached_tokens`
- [ ] Usage logging doesn't add detectable latency to response (fire-and-forget)
- [ ] `npm run build` compiles without errors
