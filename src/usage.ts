import { randomBytes } from "crypto";
import type { UsageRecord } from "./types";

export function buildUsageRecord(
  userId: string,
  model: string,
  provider: string,
  tokens: { input: number; output: number; cachedInput: number },
  streaming: boolean
): UsageRecord {
  return {
    type: "usage",
    requestId: `req_${randomBytes(8).toString("hex")}`,
    userId,
    model,
    provider,
    timestamp: new Date().toISOString(),
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cachedInputTokens: tokens.cachedInput,
    streaming,
  };
}

export function logUsage(record: UsageRecord): void {
  try {
    console.log(JSON.stringify(record));
  } catch {
    console.error("[usage] Failed to serialize usage record");
  }
}
