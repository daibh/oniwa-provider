---
phase: 2
title: Storage Layer
status: completed
priority: P1
effort: 4h
dependencies:
  - 1
---

# Phase 2: Storage Layer

## Overview

Create the S3 abstraction layer and path conventions for reading/writing user profiles, token hashes, and pricing config. This is the foundation all other phases build on.

## Requirements

- S3 read/write helpers typed to JSON
- Path builders consistent across all data types
- Error handling for missing keys, network errors, throttling
- Pricing config loader with caching

## Architecture

```
src/storage.ts    → S3 client init, readJSON, writeJSON, listObjects, path builders
src/pricing.ts    → loadPricing(), calculateCost(tokens, model, pricing)
src/types.ts      → UserProfile, UserToken, PricingConfig, UsageRecord types
```

## Related Code Files

- Create: `src/storage.ts`
- Create: `src/pricing.ts`
- Modify: `src/types.ts` — add UserProfile, UserToken, PricingConfig, UsageRecord interfaces
- Modify: `src/config.ts` — add S3_BUCKET, AWS_REGION env vars
- Modify: `package.json` — add @aws-sdk/client-s3
- Modify: `.env.example` — document new env vars

## Implementation Steps

1. **Add AWS SDK dependency**
   ```
   npm install @aws-sdk/client-s3
   ```

2. **Update `src/types.ts`**
   - Add `UserProfile`: `{ id, name, active, tokens: UserToken[], createdAt }`
   - Add `UserToken`: `{ id, prefix, hashedToken, createdAt, revoked? }`
   - Add `PricingConfig`: `Record<string, { input: number, output: number, cachedInput: number }>`
   - Add `UsageRecord`: `{ requestId, userId, model, timestamp, inputTokens, outputTokens, cachedInputTokens, streaming }`

3. **Create `src/storage.ts`**
   - Initialize S3 client (singleton, reuse across warm Lambda invocations)
   - `bucketName` from env (`S3_BUCKET`)
   - `readJSON<T>(key: string): Promise<T | null>` — S3 GetObject → parse, return null if NoSuchKey
   - `writeJSON<T>(key: string, data: T, opts?: { ifNoneMatch?: boolean }): Promise<void>` — PutObject with JSON
   - `deleteObject(key: string): Promise<void>`
   - `listObjects(prefix: string): Promise<string[]>` — ContinuationToken pagination, return keys
   - Path builders:
     - `userProfilePath(userId)` → `users/{userId}/profile.json`
     - `tokenLookupPath(tokenHash)` → `keys/{tokenHash}.json`
     - `pricingPath()` → `pricing.json`
     - `usersIndexPath()` → `users/index.json`
   - All S3 calls wrapped in try/catch, log errors with `console.error`

4. **Update `src/config.ts`**
   - Add `s3Bucket: string` (from `S3_BUCKET` env var, required)
   - Add `awsRegion: string` (from `AWS_REGION` env var, default `us-east-1`)
   - Export updated Config type

5. **Create `src/pricing.ts`**
   - `loadPricing(storage, bucket): Promise<PricingConfig>` — read `pricing.json` from S3, return defaults if missing
   - `getModelCost(tokens: { input, output, cachedInput }, model: string, pricing: PricingConfig): number`
     - Cost = (input * pricing[model].input + output * pricing[model].output + cachedInput * pricing[model].cachedInput) / 1000000
     - If model not in pricing, return 0 (unknown)
   - Simple in-memory cache (Map<string, PricingConfig> with TTL or manual refresh)

6. **Update `.env.example`**
   - Add `S3_BUCKET=my-usage-bucket`
   - Add `AWS_REGION=us-east-1`

## Success Criteria

- [ ] `npm run build` compiles without errors
- [ ] `storage.ts` can read a known S3 key and return parsed JSON
- [ ] `storage.ts` returns null for nonexistent keys
- [ ] `storage.ts` path builders produce correct S3 key strings
- [ ] `pricing.ts` calculates cost correctly (verified with known values)
