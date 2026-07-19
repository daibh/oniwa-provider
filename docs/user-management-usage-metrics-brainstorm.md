# User Management + Usage Metrics — Brainstorm Summary

## Problem

oNiwaProvider needs per-user auth, usage tracking, and cost metrics. Currently:
- Single global `ANTHROPIC_AUTH_TOKEN` — no user identity
- No persistence layer
- No usage/cost tracking

## Requirements

| Item | Detail |
|------|--------|
| User management | CRUD users, each with dedicated API tokens |
| Token auth | User token replaces ANTHROPIC_AUTH_TOKEN. Identifies user per request |
| Usage tracking | inputTokens, outputTokens, cachedInputTokens per request |
| Cost calculation | Model pricing config → cost per request, aggregated by time |
| Metrics periods | day, week, month, quarter, year — per user + global |
| Admin auth | Separate `ADMIN_API_KEY` env var for management endpoints |
| Streaming | Capture usage from final SSE chunk (`stream_options: { include_usage: true }`) |
| Migration | Unknown tokens auto-create user (zero-config upgrade) |
| Write timing | Fire-and-forget — usage logged after response sent |
| Deployment | AWS Lambda + S3 + CloudWatch Logs |

## Architecture

### Data Split

| Data | Location | Access Pattern |
|------|----------|---------------|
| User profiles + tokens | S3 `users/{id}/profile.json` | Random read/write |
| Token→user lookup | S3 `keys/{sha256(token)}.json` | Fast hash lookup |
| Pricing config | S3 `pricing.json` | Read on metrics query, write on admin update |
| Usage records | CloudWatch Logs (via `console.log`) | Append-only write; query via Insights |
| Metrics API | CloudWatch Logs Insights queries | `StartQuery` + `GetQueryResults` SDK |

### S3 Bucket Layout

```
s3://{BUCKET}/
  users/
    index.json                              # { userId: {name, created, active} } — admin listing
    {userId}/
      profile.json                          # { id, name, active, tokens: [{id, prefix, hashedToken, created}], createdAt }
  keys/
    {sha256(token)}.json                    # { userId, tokenId }
  pricing.json                              # { model: { input, output, cachedInput } }
```

### CloudWatch Logs Usage Record (logged as JSON line)

```
{ "type":"usage", "requestId":"...", "userId":"usr_...", "model":"gpt-4o",
  "inputTokens":150, "outputTokens":320, "cachedInputTokens":50,
  "timestamp":"2026-07-19T12:34:56.789Z", "streaming":true }
```

CloudWatch Logs Insights query for metrics:

```sql
fields @timestamp, userId, model, inputTokens, outputTokens, cachedInputTokens
| filter type = "usage" and userId = "usr_abc" and @timestamp >= fromIso8601("2026-07-01")
| stats sum(inputTokens) as inT, sum(outputTokens) as outT, sum(cachedInputTokens) as cacheT,
         count(*) as requests by bin(1d)
```

### Auth Flow

```
Request → Headers: { x-api-key: token }
  → Hash token with SHA-256
  → S3: read keys/{hash}.json
  → Found → attach userId to req → route to proxy
  → Not found → auto-create user with this token → attach new userId → route to proxy
```

### Auto-Migration

If `ANTHROPIC_AUTH_TOKEN` env var is set and a request comes in with that token:
- No matching user found → create user "migrated-{prefix}" with that token
- Token now works as a user token
- `ANTHROPIC_AUTH_TOKEN` env var can be removed after migration

## New Endpoints

### Admin (`x-api-key: ADMIN_API_KEY`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/admin/users` | Create user → returns full token |
| GET | `/v1/admin/users` | List all users |
| GET | `/v1/admin/users/:id` | User details + token prefixes |
| DELETE | `/v1/admin/users/:id` | Soft-deactivate user |
| POST | `/v1/admin/users/:id/tokens` | Generate new token |
| DELETE | `/v1/admin/users/:id/tokens/:tokenId` | Revoke token |
| GET | `/v1/admin/users/:id/usage?period=month` | Per-user metrics |
| GET | `/v1/admin/metrics?period=month` | Global metrics |
| GET | `/v1/admin/pricing` | Get pricing config |
| PUT | `/v1/admin/pricing` | Update pricing config |

### Proxy (any valid user token)

| Method | Path | Status |
|--------|------|--------|
| POST | `/v1/messages` | Auth changed (user token lookup) |
| POST | `/v1/messages/count_tokens` | Auth changed |
| GET | `/v1/models` | Auth changed |

## Implementation Phases

### Phase 1: Storage Layer

- Add `@aws-sdk/client-s3` dependency
- `src/storage.ts`: S3 helpers (readJSON, writeJSON, listObjects), path builders
- `src/usage.ts`: Usage record builder, CloudWatch log format

### Phase 2: Auth Overhaul

- `src/auth.ts`: SHA-256 hashing, token→user lookup, auto-migration, admin key check
- Update `src/index.ts`: Replace global `allowedApiKeys` check with user token auth

### Phase 3: User CRUD + Admin Routes

- `src/admin.ts`: All `/v1/admin/*` routes
- User profile read/write to S3
- Token generation (crypto.randomBytes → hex), hashing, storage

### Phase 4: Usage Capture

- Add `stream_options: { include_usage: true }` to OpenAI streaming requests
- Update `OpenAIStreamChunk` type to include `usage` field
- In both streaming and non-streaming paths: extract usage, log to CloudWatch (fire-and-forget)
- Auto-migration: on first request from unknown token, create user + log

### Phase 5: Metrics Queries

- `@aws-sdk/client-cloudwatch-logs` dependency
- CloudWatch Logs Insights query builder + result parser
- `GET /v1/admin/users/:id/usage`, `GET /v1/admin/metrics`
- Cost calculation: multiply token counts by `pricing.json` rates

### Phase 6: Lambda Deployment

- `src/lambda.ts`: Handler wrapping Express app for API Gateway + Lambda
- Handle warm starts, S3 client reuse, environment validation

## Files to Create / Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/storage.ts` | Create | S3 read/write/list helpers |
| `src/auth.ts` | Create | Token hashing, user lookup, admin auth |
| `src/usage.ts` | Create | Usage record extraction, CW Logs logging |
| `src/pricing.ts` | Create | Pricing config read, cost calculation |
| `src/admin.ts` | Create | Admin route handlers (user CRUD, pricing, metrics) |
| `src/lambda.ts` | Create | Lambda handler wrapper |
| `src/types.ts` | Modify | Add usage/pricing/admin types, update stream chunk |
| `src/index.ts` | Modify | Integrate new auth, admin routes, usage capture |
| `src/config.ts` | Modify | Add S3_BUCKET, ADMIN_API_KEY, AWS region |
| `package.json` | Modify | Add @aws-sdk/client-s3, @aws-sdk/client-cloudwatch-logs |
| `.env.example` | Modify | Document new env vars |

## Open Questions / Risks

- **CW Insights query timeout**: 1 min max, but we're querying per-user data which should stay under.
- **Auto-migration race**: Two concurrent requests with unmigrated token could both try to create user. Use S3 conditional write (If-None-Match) on `keys/{hash}.json`.
- **Pricing for non-OpenAI providers**: DeepSeek, Anthropic etc. all use different rate cards. `pricing.json` must be manually maintained.
- **Streaming usage in final chunk**: Not all OpenAI-compatible providers send usage in the final streaming chunk. Need to handle gracefully (skip usage tracking if absent).
- **Cost precision**: Token counts from OpenAI are round numbers; cost calculation at query time using per-1M rates may have rounding differences from provider invoices.
