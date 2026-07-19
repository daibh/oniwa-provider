---
phase: 6
title: Metrics Queries
status: completed
priority: P2
effort: 6h
dependencies:
  - 5
---

# Phase 6: Metrics Queries

## Overview

Implement usage metrics aggregation endpoints that query CloudWatch Logs Insights and combine results with pricing data to produce cost-annotated reports by day, week, month, quarter, and year.

## Requirements

- Per-user usage metrics: `GET /v1/admin/users/:id/usage?period=month`
- Global metrics: `GET /v1/admin/metrics?period=month`
- Supported periods: `day`, `week`, `month`, `quarter`, `year`
- Also support custom `from`/`to` ISO date parameters
- Each response includes totals and per-model breakdown
- Cost calculated by multiplying token counts against `pricing.json` rates

## Architecture

```
/metrics endpoint
  → parse period/from/to → compute time range
  → build CloudWatch Logs Insights query string
  → StartQuery (async) → Poll GetQueryResults
  → parse results into structured metrics
  → load pricing from S3
  → calculate cost per model
  → return JSON response
```

## Related Code Files

- Create: `src/metrics.ts` — query builder, result parser, cost calculator
- Modify: `src/admin.ts` — add usage/metrics routes
- Modify: `src/types.ts` — add MetricsResponse, PeriodQuery types
- Modify: `package.json` — add `@aws-sdk/client-cloudwatch-logs`
- Modify: `src/config.ts` — add CW_LOG_GROUP env var

## Implementation Steps

1. **Add CloudWatch Logs SDK**
   - `npm install @aws-sdk/client-cloudwatch-logs`

2. **Add config**
   - `logsGroupName: string` from `CW_LOG_GROUP` env var
   - Default: `/aws/lambda/oniwa-provider`

3. **Add types**
   - `PeriodQuery`: `{ period: 'day' | 'week' | 'month' | 'quarter' | 'year', from?: string, to?: string }`
   - `ModelMetrics`: `{ inputTokens, outputTokens, cachedInputTokens, requests, cost }`
   - `MetricsResponse`: `{ period, start, end, totalRequests, totalInputTokens, totalOutputTokens, totalCachedInputTokens, byModel: Record<string, ModelMetrics>, totalCost }`

4. **Create `src/metrics.ts`**

   - **`computeTimeRange(period, from?, to?): { start: Date, end: Date }`**
     - `day`: today 00:00:00 → now
     - `week`: Monday 00:00:00 → now
     - `month`: 1st of month 00:00:00 → now
     - `quarter`: 1st of quarter 00:00:00 → now
     - `year`: Jan 1 00:00:00 → now
     - `from`/`to` override the range entirely when provided
     - All in UTC

   - **`buildQuery(userId: string | null, start: Date, end: Date): string`**
     - CloudWatch Logs Insights query:
     ```
     filter type = "usage" {userId filter} and @timestamp >= {start} and @timestamp < {end}
     | stats sum(inputTokens) as inputTokens, sum(outputTokens) as outputTokens,
              sum(cachedInputTokens) as cachedInputTokens, count(*) as requests
              by model, bin({interval})
     ```
     - If userId is provided: `and userId = "{userId}"`
     - Interval: `1h` for day, `1d` for week/month, `7d` for quarter/year
     - Limit to reasonable time range (max 1 year)

   - **`runQuery(cwClient, logGroup, query, start, end): Promise<QueryResult[]>`**
     - `StartQueryCommand` with logGroupName, queryString, startTime (epoch seconds), endTime
     - Poll `GetQueryResultsCommand` every 1s until status is `Complete` or `Failed`
     - Timeout after 30s
     - Parse results array into structured objects

   - **`aggregateMetrics(results, pricing): MetricsResponse`**
     - Sum per-model stats
     - Calculate cost per model: `(inputTokens * pricing[model].input + outputTokens * pricing[model].output + cachedInputTokens * pricing[model].cachedInput) / 1000000`
     - Build response shape with totals

5. **Add routes to `src/admin.ts`**

   - **`GET /users/:id/usage`**
     - Query params: `period` (default: `month`), `from`, `to`
     - Validate userId exists (read profile)
     - Call `runQuery` with userId filter
     - Load pricing, call `aggregateMetrics`
     - Return MetricsResponse

   - **`GET /metrics`** (global)
     - Same as above but no userId filter
     - Returns metrics across all users

6. **Error handling**
   - CloudWatch Logs Insights can fail due to:
     - Query timeout (1min max) → retry with smaller time window
     - No data → return empty metrics (all zeros)
     - Invalid query syntax → return 400 with error message
   - Cache pricing config to avoid S3 read per query (in-memory, 5min TTL)

## Success Criteria

- [ ] Per-user metrics return correct token totals for a known test period
- [ ] Global metrics aggregate across all users
- [ ] Day/week/month/quarter/year periods compute correct time ranges
- [ ] Custom `from`/`to` overrides work
- [ ] Cost calculation matches manual verification (tokens × rate / 1M)
- [ ] Empty periods return zeroed response (no crash)
- [ ] CloudWatch query failure returns graceful error, not 500 crash
- [ ] `npm run build` compiles without errors
