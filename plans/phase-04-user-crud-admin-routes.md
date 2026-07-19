---
phase: 4
title: User CRUD & Admin Routes
status: completed
priority: P1
effort: 8h
dependencies:
  - 3
---

# Phase 4: User CRUD & Admin Routes

## Overview

Create all admin API endpoints for managing users, tokens, and pricing config. Users can be created, listed, viewed, and soft-deleted. Tokens can be generated and revoked. Pricing config is readable and updatable.

## Requirements

- Full CRUD for users (create, list, get, soft-delete)
- Token generation and revocation per user
- Pricing config management
- All under `/v1/admin/*` prefix with ADMIN_API_KEY auth
- Return token value only on creation (one-time display)

## Architecture

```
POST /v1/admin/users                    → createUser(storage)
GET  /v1/admin/users                    → listUsers(storage)
GET  /v1/admin/users/:id                → getUser(storage, id)
DELETE /v1/admin/users/:id              → deactivateUser(storage, id)
POST /v1/admin/users/:id/tokens         → generateToken(storage, id)
DELETE /v1/admin/users/:id/tokens/:tid  → revokeToken(storage, id, tid)
GET  /v1/admin/pricing                  → getPricing(storage)
PUT  /v1/admin/pricing                  → updatePricing(storage, body)
```

## Related Code Files

- Create: `src/admin.ts`
- Modify: `src/index.ts` — mount admin router at `/v1/admin`
- Modify: `src/auth.ts` — export `requireAdmin` middleware

## Implementation Steps

1. **Add admin middleware to `src/auth.ts`**
   - `requireAdmin(config, storage)`: Express middleware
     - Extract token from request
     - Compare against `config.adminApiKey` (timing-safe)
     - If invalid, return 401 JSON error
     - If valid, call `next()`

2. **Create `src/admin.ts` — admin router**
   - All routes behind `requireAdmin` middleware
   - Routes and logic:

   - **POST `/users`** — Create user
     - Body: `{ name?: string }` (optional display name)
     - Generate userId: `usr_${randomBytes(16).toString('hex')}`
     - Generate token: `sk-${randomBytes(32).toString('hex')}` (64 hex chars)
     - Hash token with SHA-256
     - Create UserProfile with initial token
     - Write `users/{userId}/profile.json`
     - Write `keys/{hash}.json` → `{ userId, tokenId }`
     - Update `users/index.json` (append new user entry)
     - Return: `{ id, name, token: "sk-...", tokenPrefix: "sk-{first 8 chars}..." }` (full token shown once!)

   - **GET `/users`** — List all users
     - Read `users/index.json`
     - Return array of `{ id, name, createdAt, tokenCount, active }`
     - No token exposure

   - **GET `/users/:id`** — Get user details
     - Read `users/{id}/profile.json`
     - Return profile with token list (prefixes only, no full hashes)
     - `{ id, name, active, createdAt, tokens: [{ id, prefix, createdAt, revoked }] }`
     - 404 if not found

   - **DELETE `/users/:id`** — Soft-deactivate user
     - Read profile, set `active: false`
     - Write back to `users/{id}/profile.json`
     - Update `users/index.json` status
     - Return `{ id, active: false }`

   - **POST `/users/:id/tokens`** — Generate new token
     - Read profile, verify user exists and is active
     - Generate token, hash, create token entry
     - Add to profile.tokens array
     - Write `keys/{hash}.json`
     - Write updated profile
     - Return `{ id, token: "sk-...", prefix }`

   - **DELETE `/users/:id/tokens/:tokenId`** — Revoke token
     - Read profile, find token with matching id
     - Read existing `keys/{hash}.json` to get the hash
     - Delete `keys/{hash}.json` from S3
     - Set `revoked: true` on the token in profile
     - Write updated profile
     - Return `{ id, tokenId, revoked: true }`

   - **GET `/pricing`** → Read `pricing.json` from S3, return parsed JSON
   - **PUT `/pricing`** → Validate body shape, write to S3, clear pricing cache

3. **Mount admin router in `src/index.ts`**
   - `app.use('/v1/admin', requireAdmin, adminRouter)`
   - Admin middleware runs before any route logic
   - Add express JSON body parser for admin routes (already global: `50mb` limit)

4. **User index management**
   - `users/index.json` format: `{ [userId]: { name, createdAt, active } }`
   - Update on create, soft-delete
   - Don't update on token add/revoke (too frequent, only user-level changes)
   - Read on `/v1/admin/users` list

## Success Criteria

- [ ] Create user returns a valid token
- [ ] Created user's token works for `/v1/messages` auth
- [ ] List users returns all non-deleted users
- [ ] Get user returns profile with token prefixes
- [ ] Soft-deleted user's token is rejected on proxy requests
- [ ] New token for existing user works immediately
- [ ] Revoked token is rejected on proxy requests
- [ ] Delete/re-create cycle works cleanly
- [ ] Pricing read/write works
- [ ] All admin endpoints return 401 without ADMIN_API_KEY
