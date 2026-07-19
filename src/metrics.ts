import { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { calculateCost, setPricingCache } from "./pricing";
import { getCachedPricing } from "./pricing";
import { readJSON, pricingPath } from "./storage";
import type { UsageQuery, MetricsResponse, ModelMetrics, PricingConfig } from "./types";

function computeTimeRange(query: UsageQuery): { start: number; end: number; period: string } {
  const now = Date.now();
  const end = query.to ? new Date(query.to).getTime() : now;
  let start: number;
  let period: string;

  if (query.from) {
    start = new Date(query.from).getTime();
    period = "custom";
  } else {
    const p = query.period || "month";
    period = p;
    const d = new Date(now);
    switch (p) {
      case "day": start = now - 86400000; break;
      case "week": start = now - 604800000; break;
      case "month": d.setMonth(d.getMonth() - 1); start = d.getTime(); break;
      case "quarter": d.setMonth(d.getMonth() - 3); start = d.getTime(); break;
      case "year": d.setFullYear(d.getFullYear() - 1); start = d.getTime(); break;
      default: start = now - 2592000000; period = "month";
    }
  }

  return { start: Math.floor(start / 1000), end: Math.floor(end / 1000), period };
}

function buildQueryString(userId?: string): string {
  const filter = userId
    ? `filter userId = "${userId}"`
    : "filter type = \"usage\"";
  return `fields @timestamp, userId, model, provider, inputTokens, outputTokens, cachedInputTokens, streaming
    | ${filter}
    | stats sum(inputTokens) as totalInput, sum(outputTokens) as totalOutput, sum(cachedInputTokens) as totalCached, count() as requests by model
    | sort @timestamp desc`;
}

export async function queryMetrics(
  logGroupName: string,
  awsRegion: string,
  query: UsageQuery,
  userId?: string
): Promise<MetricsResponse> {
  const logsClient = new CloudWatchLogsClient({ region: awsRegion });
  const { start, end, period } = computeTimeRange(query);
  const queryString = buildQueryString(userId);

  const startCmd = new StartQueryCommand({
    logGroupName,
    startTime: start,
    endTime: end,
    queryString,
    limit: 1000,
  });

  const startRes = await logsClient.send(startCmd);
  const queryId = startRes.queryId;
  if (!queryId) {
    return emptyMetrics(period, start, end);
  }

  let results: any[] | undefined;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    const res = await logsClient.send(new GetQueryResultsCommand({ queryId }));
    if (res.status === "Complete") {
      results = res.results;
      break;
    }
    if (res.status === "Failed") break;
  }

  if (!results) {
    return emptyMetrics(period, start, end);
  }

  let pricing = getCachedPricing();
  if (!pricing) {
    try {
      const p = await readJSON<PricingConfig>(pricingPath());
      if (p) {
        setPricingCache(p);
        pricing = p;
      }
    } catch { /* use null pricing */ }
  }

  const byModel: Record<string, ModelMetrics> = {};
  for (const row of results) {
    const map = rowToMap(row);
    const model = map.model || "unknown";
    const input = parseInt(map.totalInput || "0", 10);
    const output = parseInt(map.totalOutput || "0", 10);
    const cached = parseInt(map.totalCached || "0", 10);
    const requests = parseInt(map.requests || "0", 10);
    const cost = pricing ? calculateCost(input, output, cached, model, pricing) : 0;

    byModel[model] = {
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: cached,
      requests,
      cost: round2(cost),
    };
  }

  const totals = Object.values(byModel).reduce(
    (acc, m) => {
      acc.totalInputTokens += m.inputTokens;
      acc.totalOutputTokens += m.outputTokens;
      acc.totalCachedInputTokens += m.cachedInputTokens;
      acc.totalRequests += m.requests;
      acc.totalCost += m.cost;
      return acc;
    },
    { totalInputTokens: 0, totalOutputTokens: 0, totalCachedInputTokens: 0, totalRequests: 0, totalCost: 0 }
  );

  return {
    period,
    start: new Date(start * 1000).toISOString(),
    end: new Date(end * 1000).toISOString(),
    totalRequests: totals.totalRequests,
    totalInputTokens: totals.totalInputTokens,
    totalOutputTokens: totals.totalOutputTokens,
    totalCachedInputTokens: totals.totalCachedInputTokens,
    byModel,
    totalCost: round2(totals.totalCost),
  };
}

function rowToMap(row: any[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const field of row) {
    if (field.field && field.value !== undefined) {
      map[field.field] = field.value;
    }
  }
  return map;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function emptyMetrics(period: string, start: number, end: number): MetricsResponse {
  return {
    period,
    start: new Date(start * 1000).toISOString(),
    end: new Date(end * 1000).toISOString(),
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedInputTokens: 0,
    byModel: {},
    totalCost: 0,
  };
}
