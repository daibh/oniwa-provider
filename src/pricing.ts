import type { PricingConfig } from "./types";

let cachedPricing: PricingConfig | null = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

export function setPricingCache(pricing: PricingConfig) {
  cachedPricing = pricing;
  cacheTime = Date.now();
}

export function getCachedPricing(): PricingConfig | null {
  if (cachedPricing && Date.now() - cacheTime < CACHE_TTL) {
    return cachedPricing;
  }
  return null;
}

export function invalidatePricingCache() {
  cachedPricing = null;
  cacheTime = 0;
}

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  model: string,
  pricing: PricingConfig
): number {
  const rates = pricing[model];
  if (!rates) return 0;
  const inputCost = (inputTokens * rates.input) / 1_000_000;
  const outputCost = (outputTokens * rates.output) / 1_000_000;
  const cachedCost = (cachedInputTokens * rates.cachedInput) / 1_000_000;
  return inputCost + outputCost + cachedCost;
}
