---
phase: 3
title: Auth Overhaul
status: completed
priority: P1
effort: 6h
dependencies:
  - 2
---

# Phase 3: Auth Overhaul

## Overview

Replace the single global `ANTHROPIC_AUTH_TOKEN` with per-user token auth. Each request's `x-api-key` is hashed and looked up in S3 to identify the user. Unknown tokens auto-create a user (zero-config migration). Admin endpoints are protected by a separate `ADMIN_API_KEY`.

## Requirements

- SHA-256 token hashing for secure S3 key lookup
- Token→user resolution from S3 (`keys/{hash}.json`)
- Auto-create user on first request with unknown token
- Admin auth via `ADMIN_API_KEY` env var
- Remove old `allowedApiKeys` / `ANTHROPIC_AUTH_TOKEN` auth flow completely

## Architecture

```
Request → getAuthToken(req)
  → HASHED = sha256(token)
  → Lookup keys/{HASHED}.json on S3
  → Found? → attach { userId, tokenId } to req → pass to proxy
  → Not found? → auto-create user with this token → attach → pass to proxy
```

Admin endpoints check `ADMIN_API_KEY` match — no user lookup needed.

## Related Code Files

- Create: `src/auth.ts`
- Modify: `src/index.ts` — replace getAuthToken usage, add admin auth middleware
- Modify: `src/config.ts` — add ADMIN_API_KEY

## Implementation Steps

1. **Create `src/auth.ts`**
   - `hashToken(token: string): string` — SHA-256 via `crypto.createHash('sha256').update(token).digest('hex')`
   - `resolveUser(token: string, storage): Promise<{ userId, tokenId } | null>`
     - Hash token, call `storage.readJSON(storage.tokenLookupPath(hash))`
     - Return null if not found
   - `autoCreateUser(token: string, storage): Promise<{ userId, tokenId }>`
     - Generate userId: `usr_${randomBytes(16).toString('hex')}`
     - Create UserProfile with this single token
     - Write two S3 objects: `users/{userId}/profile.json` and `keys/{hash}.json`
     - Use S3 conditional write (If-None-Match: "*") on the key file to handle race conditions
     - If conditional write fails (file exists), another Lambda created it first — read and return
   - `resolveOrCreateUser(token: string, storage): Promise<{ userId, tokenId }>`
     - resolveUser → if found, return
     - autoCreateUser → return
   - `isAdminRequest(token: string, adminKey: string): boolean`
     - Constant-time comparison to prevent timing attacks: `crypto.timingSafeEqual(Buffer.from(token), Buffer.from(adminKey))`
     - Only if `adminKey` is non-empty

2. **Update `src/config.ts`**
   - Replace `allowedApiKeys: string[]` with `adminApiKey: string` (from `ADMIN_API_KEY`)
   - Remove the `ANTHROPIC_AUTH_TOKEN` → `allowedApiKeys` fallback entirely

3. **Update `src/index.ts` — auth middleware**
   - Replace the existing `getAuthToken` + `allowedApiKeys` check block with:
     - Extract token from headers (same logic: `x-api-key` first, then `Authorization: Bearer`)
     - For `/v1/admin/*` routes: check against `ADMIN_API_KEY`
     - For all other routes: call `resolveOrCreateUser(token, storage)`
     - If token is null/empty, return 401
     - Store resolved `userId` on `req` for downstream usage capture
   - Import storage from storage.ts, auth from auth.ts
   - Initialize storage client at startup

4. **Remove old code**
   - Delete `switchTokenParam` function (unused after previous refactor)
   - Remove `ANTHROPIC_AUTH_TOKEN` from env var parsing in config.ts

## Auto-Migration Detail

When an unknown token arrives:
1. Check if `ANTHROPIC_AUTH_TOKEN` env var is set AND token matches it
2. If yes → create user named `migrated-{prefix}` (special flag, token already distributed)
3. If no → create user named `auto-{prefix}` (normal auto-creation)
4. Either way → user is active, token works immediately
5. Admin can later rename/deactivate via admin API

## Success Criteria

- [ ] `npm run build` compiles without errors
- [ ] Known token resolves to the correct userId
- [ ] Unknown token auto-creates user on first request
- [ ] Second request with same token returns the same user (no duplicate creation)
- [ ] Admin endpoints reject non-admin tokens with 401
- [ ] Non-admin endpoints reject null/empty tokens with 401
- [ ] Timing-safe admin key comparison
