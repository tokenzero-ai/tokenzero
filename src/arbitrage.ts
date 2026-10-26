// Price a workload across models at list prices: the requested model, its cheaper
// sibling and any extra candidates, with and without prompt caching. Pure.
import { priceFor, costOf, normalizeModel, CASCADE_TARGET, PRICES, PRICING_VERSION } from './pricing.ts';

export interface ArbitrageArgs { model: string; input_tokens: number; output_tokens: number; requests_per_month?: number; static_tokens?: number; compare_to?: string[]; }

export function modelArbitrage(args: ArbitrageArgs) {
  const key = normalizeModel(args.model);
  if (!key) throw new Error(`unknown model ${args.model}; known: ${Object.keys(PRICES).join(', ')}`);
  const n = args.requests_per_month ?? 10_000, inp = args.input_tokens, out = args.output_tokens, st = Math.min(inp, args.static_tokens ?? 0);
  const rowFor = (m: string) => {
    const p = priceFor(m)!;
    const base = costOf(m, { input: inp, output: out })!;
    const cached = p.cachedInput != null && st >= (p.minCacheTokens ?? 1024) ? costOf(m, { input: inp, output: out, cachedInput: st })! : base;
    return { model: m, tier: p.tier, per_request_usd: base, per_request_cached_usd: cached, monthly_usd: base * n, monthly_cached_usd: cached * n };
  };
  const models = [key, ...(CASCADE_TARGET[key] ? [CASCADE_TARGET[key]] : []), ...((args.compare_to ?? []).map(normalizeModel).filter(Boolean) as string[])];
  const rows = [...new Set(models)].map(rowFor);
  return {
    pricing_version: PRICING_VERSION, requested: rows[0],
    alternatives: rows.slice(1).map(r => ({ ...r, savings_pct_vs_requested: Math.round((1 - r.per_request_usd / rows[0].per_request_usd) * 1000) / 10 })),
    caveat: 'List prices. Cheaper models need an eval before swapping; TokenZero cascade routing is opt-in and advisory by default; an opt-in shadow parity monitor is coming.',
  };
}
