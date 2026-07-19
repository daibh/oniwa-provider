---
title: User Management & Usage Metrics
description: >-
  Add multi-provider routing, per-user auth, usage tracking, cost metrics, and
  Lambda deployment to oNiwaProvider
status: completed
priority: P1
branch: feature/user-management
tags:
  - auth
  - usage-tracking
  - s3
  - cloudwatch
  - lambda
  - multi-provider
blockedBy: []
blocks: []
created: '2026-07-19T12:16:48.159Z'
createdBy: 'ck:plan'
source: skill
---

# User Management & Usage Metrics

## Overview

Three major upgrades to oNiwaProvider:

1. **Multi-provider routing** — route each model to the correct provider (OpenAI, DeepSeek, Anthropic, etc.) instead of a single hardcoded endpoint
2. **User management** — per-user API tokens replace the single global auth, admin CRUD endpoints
3. **Usage & cost metrics** — track token usage per request, calculate costs, aggregate by time period, stored in CloudWatch Logs + S3

Brainstorm design doc: `docs/user-management-usage-metrics-brainstorm.md`

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Multi-Provider Routing](./phase-01-multi-provider-routing.md) | Completed |
| 2 | [Storage Layer](./phase-02-storage-layer.md) | Completed |
| 3 | [Auth Overhaul](./phase-03-auth-overhaul.md) | Completed |
| 4 | [User CRUD & Admin Routes](./phase-04-user-crud-admin-routes.md) | Completed |
| 5 | [Usage Capture](./phase-05-usage-capture.md) | Completed |
| 6 | [Metrics Queries](./phase-06-metrics-queries.md) | Completed |
| 7 | [Lambda Deployment](./phase-07-lambda-deployment.md) | Completed |

## Dependencies

- Phase 1 is prerequisite for all others (fundamental request flow change)
- Phases 2-4 are sequential (storage → auth → admin)
- Phase 5 depends on 3 (user identity) + 1 (provider routing)
- Phase 6 depends on 5 (usage records exist)
- Phase 7 depends on all previous (full system deployed)

## Key Decisions

| Decision | Choice |
|----------|--------|
| Provider routing | Env-var based provider config + model→provider mapping |
| Translation formats | `openai` (anthropic→openai), `anthropic` (passthrough) |
| User profiles | S3 (`users/{id}/profile.json`, `keys/{hash}.json`) |
| Usage records | CloudWatch Logs via `console.log`, queried via Insights SDK |
| Pricing config | S3 `pricing.json`, manually maintained |
| Admin auth | Separate `ADMIN_API_KEY` env var |
| Migration | Unknown tokens auto-create user (zero-config) |
| Usage write timing | Fire-and-forget (after response sent) |
| Streaming usage | `stream_options: { include_usage: true }` + parse final chunk |
