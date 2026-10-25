// Versioned list-price table, USD per 1M tokens, sourced from the providers'
// official pricing pages on PRICING_VERSION. Savings are always computed at
// these list prices for the model the caller asked for.
//
// Sources: developers.openai.com/api/docs/pricing, ai.google.dev/gemini-api/docs/pricing,
// platform.claude.com pricing (via the Anthropic model table of the same date).
export const PRICING_VERSION = '2026-10-25';
export const PRICING_MAX_AGE_DAYS = 45;

/**
 * Known upcoming provider price changes. Each one must be re-verified and the
 * table re-dated on or after `on`; the test suite fails once a date passes
 * without PRICING_VERSION moving past it.
 */
export const PRICING_REVIEWS: { on: string; note: string }[] = [
  { on: '2026-12-01', note: 'Gemini 4 Argon input/output/cache prices double (ai.google.dev pricing page)' },
  { on: '2026-12-31', note: 'Some Gemini 3.x Flash / Flash-Lite prices double; check each model' },
  { on: '2027-01-01', note: 'Gemini 3.8 Flash and remaining 3.x Flash prices double' },
];

export function pricingFreshness(nowMs = Date.now()) {
  const ageDays = Math.floor((nowMs - Date.parse(PRICING_VERSION + 'T00:00:00Z')) / 86_400_000);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const overdue = PRICING_REVIEWS.filter(r => r.on <= today && r.on > PRICING_VERSION);
  return { version: PRICING_VERSION, age_days: ageDays, max_age_days: PRICING_MAX_AGE_DAYS, stale: ageDays > PRICING_MAX_AGE_DAYS || overdue.length > 0, overdue_reviews: overdue, upcoming_reviews: PRICING_REVIEWS.filter(r => r.on > today) };
}

export type Provider = 'openai' | 'anthropic' | 'gemini' | 'xai' | 'deepseek' | 'openrouter';

export interface Price {
  provider: Provider;
  input: number;
  output: number;
  /** cache read price; undefined = provider has no caching discount for this model */
  cachedInput?: number;
  /** cache write price (per token written); undefined = no surcharge */
  cacheWrite?: number;
  /** minimum cacheable prefix in tokens, when the provider needs explicit markers */
  minCacheTokens?: number;
  /** long-context tier: applies when input tokens exceed `longCtxAt` */
  longCtxAt?: number;
  longCtx?: { input: number; output: number; cachedInput?: number; cacheWrite?: number };
  tier: 'frontier' | 'mid' | 'fast';
}

const P = (provider: Provider, tier: Price['tier'], input: number, output: number, cachedInput?: number, cacheWrite?: number, extra: Partial<Price> = {}): Price =>
  ({ provider, tier, input, output, cachedInput, cacheWrite, ...extra });

export const PRICES: Record<string, Price> = {
  // ---- OpenAI (standard tier, ≤272K; cache write = 30m TTL rate) ----
  'gpt-6-astra': P('openai', 'frontier', 10, 50, 1, 12.5, { longCtxAt: 272_000, longCtx: { input: 20, output: 75, cachedInput: 2, cacheWrite: 25 }, minCacheTokens: 1024 }),
  'gpt-6.1-sol': P('openai', 'mid', 2, 10, 0.1, 2.5, { longCtxAt: 272_000, longCtx: { input: 4, output: 15, cachedInput: 0.2, cacheWrite: 5 }, minCacheTokens: 1024 }),
  'gpt-6-sol': P('openai', 'mid', 2, 10, 0.2, 2.5, { longCtxAt: 272_000, longCtx: { input: 4, output: 15, cachedInput: 0.4, cacheWrite: 5 }, minCacheTokens: 1024 }),
  'gpt-6-luna': P('openai', 'fast', 0.1, 0.5, 0.01, 0.125, { longCtxAt: 272_000, longCtx: { input: 0.2, output: 0.75, cachedInput: 0.02, cacheWrite: 0.25 }, minCacheTokens: 1024 }),
  'gpt-5.6-sol': P('openai', 'frontier', 4, 20, 0.4, 5, { longCtxAt: 272_000, longCtx: { input: 8, output: 30, cachedInput: 0.8, cacheWrite: 10 }, minCacheTokens: 1024 }),
  'gpt-5.6-terra': P('openai', 'mid', 2, 12, 0.2, 2.5, { longCtxAt: 272_000, longCtx: { input: 4, output: 18, cachedInput: 0.4, cacheWrite: 5 }, minCacheTokens: 1024 }),
  'gpt-5.6-luna': P('openai', 'fast', 0.2, 1.2, 0.02, 0.25, { longCtxAt: 272_000, longCtx: { input: 0.4, output: 1.8, cachedInput: 0.04, cacheWrite: 0.5 }, minCacheTokens: 1024 }),
  'gpt-5.5': P('openai', 'frontier', 5, 30, 0.5, undefined, { longCtxAt: 272_000, longCtx: { input: 10, output: 45, cachedInput: 1 }, minCacheTokens: 1024 }),
  'gpt-5.5-pro': P('openai', 'frontier', 30, 180),
  'gpt-5.4': P('openai', 'frontier', 2.5, 15, 0.25, undefined, { longCtxAt: 272_000, longCtx: { input: 5, output: 22.5, cachedInput: 0.5 }, minCacheTokens: 1024 }),
  'gpt-5.4-pro': P('openai', 'frontier', 30, 180),
  'gpt-5.4-mini': P('openai', 'fast', 0.75, 4.5, 0.075, undefined, { minCacheTokens: 1024 }),
  'gpt-5.4-nano': P('openai', 'fast', 0.2, 1.25, 0.02, undefined, { minCacheTokens: 1024 }),
  'gpt-5.2': P('openai', 'frontier', 1.75, 14, 0.175, undefined, { minCacheTokens: 1024 }),
  'gpt-5.2-pro': P('openai', 'frontier', 21, 168),
  'gpt-5.1': P('openai', 'mid', 1.25, 10, 0.125, undefined, { minCacheTokens: 1024 }),
  'gpt-5': P('openai', 'mid', 1.25, 10, 0.125, undefined, { minCacheTokens: 1024 }),
  'gpt-5-mini': P('openai', 'fast', 0.25, 2, 0.025, undefined, { minCacheTokens: 1024 }),
  'gpt-5-nano': P('openai', 'fast', 0.05, 0.4, 0.005, undefined, { minCacheTokens: 1024 }),
  'gpt-5-pro': P('openai', 'frontier', 15, 120),
  'o3': P('openai', 'mid', 2, 8, 0.5, undefined, { minCacheTokens: 1024 }),
  'o3-pro': P('openai', 'frontier', 20, 80),
  'o3-mini': P('openai', 'fast', 1.1, 4.4, 0.55, undefined, { minCacheTokens: 1024 }),
  'o4-mini': P('openai', 'fast', 1.1, 4.4, 0.275, undefined, { minCacheTokens: 1024 }),
  'o1': P('openai', 'frontier', 15, 60, 7.5),
  'gpt-4.1': P('openai', 'mid', 2, 8, 0.5, undefined, { minCacheTokens: 1024 }),
  'gpt-4.1-mini': P('openai', 'fast', 0.4, 1.6, 0.1, undefined, { minCacheTokens: 1024 }),
  'gpt-4.1-nano': P('openai', 'fast', 0.1, 0.4, 0.025, undefined, { minCacheTokens: 1024 }),
  'gpt-4o': P('openai', 'mid', 2.5, 10, 1.25, undefined, { minCacheTokens: 1024 }),
  'gpt-4o-mini': P('openai', 'fast', 0.15, 0.6, 0.075, undefined, { minCacheTokens: 1024 }),

  // ---- Anthropic (cache write = 5-minute TTL, 1.25x; 1h TTL is 2x) ----
  'claude-fable-5-1': P('anthropic', 'frontier', 10, 50, 0.25, 12.5, { minCacheTokens: 512 }),
  'claude-fable-5': P('anthropic', 'frontier', 10, 50, 1, 12.5, { minCacheTokens: 512 }),
  'claude-opus-5-5': P('anthropic', 'frontier', 4, 20, 0.2, 5, { minCacheTokens: 512 }),
  'claude-opus-5': P('anthropic', 'frontier', 5, 25, 0.5, 6.25, { minCacheTokens: 512 }),
  'claude-opus-4-8': P('anthropic', 'frontier', 5, 25, 0.5, 6.25, { minCacheTokens: 1024 }),
  'claude-opus-4-7': P('anthropic', 'frontier', 5, 25, 0.5, 6.25, { minCacheTokens: 2048 }),
  'claude-opus-4-6': P('anthropic', 'frontier', 5, 25, 0.5, 6.25, { minCacheTokens: 4096 }),
  'claude-opus-4-5': P('anthropic', 'frontier', 5, 25, 0.5, 6.25, { minCacheTokens: 4096 }),
  'claude-sonnet-5-5': P('anthropic', 'mid', 2, 10, 0.2, 2.5, { minCacheTokens: 512 }),
  'claude-sonnet-5': P('anthropic', 'mid', 2, 10, 0.2, 2.5, { minCacheTokens: 1024 }),
  'claude-sonnet-4-6': P('anthropic', 'mid', 3, 15, 0.3, 3.75, { minCacheTokens: 1024 }),
  'claude-sonnet-4-5': P('anthropic', 'mid', 3, 15, 0.3, 3.75, { minCacheTokens: 1024 }),
  'claude-haiku-5-5': P('anthropic', 'fast', 0.1, 0.5, 0.01, 0.125, { minCacheTokens: 512, longCtxAt: 100_000, longCtx: { input: 0.5, output: 2.5, cachedInput: 0.05, cacheWrite: 0.625 } }),
  'claude-haiku-4-5': P('anthropic', 'fast', 1, 5, 0.1, 1.25, { minCacheTokens: 4096 }),

  // ---- Google Gemini (paid tier; prices scheduled to rise Dec 2026/Jan 2027 — re-verify) ----
  'gemini-4-argon': P('gemini', 'frontier', 2, 10, 0.1),
  'gemini-3.8-flash': P('gemini', 'fast', 0.75, 3.75, 0.075),
  'gemini-3.6-flash': P('gemini', 'fast', 0.75, 3.75, 0.075),
  'gemini-3.5-flash-lite': P('gemini', 'fast', 0.3, 2.5, 0.03),
  'gemini-3.1-pro': P('gemini', 'frontier', 2, 12, 0.2, undefined, { longCtxAt: 200_000, longCtx: { input: 4, output: 18, cachedInput: 0.4 } }),
  'gemini-3.1-flash-lite': P('gemini', 'fast', 0.25, 1.5, 0.025),
  'gemini-3-flash': P('gemini', 'fast', 0.5, 3, 0.05),
  'gemini-2.5-pro': P('gemini', 'frontier', 1.25, 10, 0.125, undefined, { longCtxAt: 200_000, longCtx: { input: 2.5, output: 15, cachedInput: 0.25 } }),
  'gemini-2.5-flash': P('gemini', 'fast', 0.3, 2.5, 0.03),
  'gemini-2.5-flash-lite': P('gemini', 'fast', 0.1, 0.4, 0.01),

  // ---- xAI Grok ----
  'grok-4': P('xai', 'frontier', 3, 15, 0.75),
  'grok-4-fast': P('xai', 'fast', 0.2, 0.8, 0.05),
  'grok-4-mini': P('xai', 'fast', 0.2, 0.8, 0.05),
  'grok-3': P('xai', 'mid', 3, 15, 0.75),
  'grok-3-mini': P('xai', 'fast', 0.3, 0.5, 0.075),

  // ---- DeepSeek ----
  'deepseek-v3': P('deepseek', 'fast', 0.27, 1.1, 0.07),
  'deepseek-chat': P('deepseek', 'fast', 0.27, 1.1, 0.07),
  'deepseek-r1': P('deepseek', 'mid', 0.55, 2.19, 0.14),
  'deepseek-reasoner': P('deepseek', 'mid', 0.55, 2.19, 0.14),
};

/** Cheaper sibling for the opt-in cascade router and arbitrage math. */
export const CASCADE_TARGET: Record<string, string> = {
  'gpt-6-astra': 'gpt-6.1-sol',
  'gpt-6.1-sol': 'gpt-6-luna',
  'gpt-6-sol': 'gpt-6-luna',
  'gpt-5.6-sol': 'gpt-5.6-terra',
  'gpt-5.6-terra': 'gpt-5.6-luna',
  'gpt-5.5': 'gpt-5.4-mini',
  'gpt-5.4': 'gpt-5.4-mini',
  'gpt-5.2': 'gpt-5-mini',
  'gpt-5.1': 'gpt-5-mini',
  'gpt-5': 'gpt-5-mini',
  'gpt-4.1': 'gpt-4.1-mini',
  'gpt-4o': 'gpt-4o-mini',
  'o3': 'o4-mini',
  'claude-fable-5-1': 'claude-opus-5-5',
  'claude-fable-5': 'claude-opus-5-5',
  'claude-opus-5-5': 'claude-sonnet-5-5',
  'claude-opus-5': 'claude-sonnet-5-5',
  'claude-opus-4-8': 'claude-sonnet-5-5',
  'claude-opus-4-7': 'claude-sonnet-5-5',
  'claude-opus-4-6': 'claude-sonnet-4-6',
  'claude-sonnet-5-5': 'claude-haiku-5-5',
  'claude-sonnet-5': 'claude-haiku-5-5',
  'claude-sonnet-4-6': 'claude-haiku-4-5',
  'claude-sonnet-4-5': 'claude-haiku-4-5',
  'gemini-4-argon': 'gemini-3.8-flash',
  'gemini-3.1-pro': 'gemini-3.8-flash',
  'gemini-3.8-flash': 'gemini-3.5-flash-lite',
  'gemini-2.5-pro': 'gemini-2.5-flash',
  'gemini-2.5-flash': 'gemini-2.5-flash-lite',
  'grok-4': 'grok-4-fast',
  'grok-3': 'grok-3-mini',
  'deepseek-r1': 'deepseek-v3',
  'deepseek-reasoner': 'deepseek-chat',
};

const KEYS_BY_LENGTH = Object.keys(PRICES).sort((a, b) => b.length - a.length);

/**
 * Map a provider model id onto a pricing key. Handles vendor prefixes
 * ("openai/gpt-6-luna", "models/gemini-4-argon"), date/snapshot suffixes
 * ("claude-haiku-4-5-20251001", "gpt-4o-2024-08-06"), Vertex "@" versions and
 * "-preview"/"-latest" tags.
 */
export function normalizeModel(model: unknown): string | null {
  if (typeof model !== 'string' || !model) return null;
  let m = model.toLowerCase().trim();
  m = m.replace(/^(openai|anthropic|google|gemini|x-ai|xai|deepseek|bedrock|models|vertex_ai)\//, '');
  m = m.replace(/^(?:us\.|eu\.|apac\.)?anthropic\./, '');
  m = m.replace(/-v\d+:\d+$/, '');
  m = m.replace(/@\d{8}$/, '');
  m = m.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  m = m.replace(/-(latest|preview|customtools|thinking)$/, '');
  if (PRICES[m]) return m;
  for (const k of KEYS_BY_LENGTH) if (m.startsWith(k + '-') || m === k) return k;
  return null;
}

export function priceFor(model: unknown): (Price & { key: string }) | null {
  const key = normalizeModel(model);
  return key ? { key, ...PRICES[key] } : null;
}

export interface Usage {
  input: number;          // total input tokens incl. cached + cache-written
  output: number;
  cachedInput?: number;   // tokens read from provider cache
  cacheWrite?: number;    // tokens written to provider cache (surcharge)
}

/** Actual cost in USD for a usage breakdown at list price. Null when the model is unpriced. */
export function costOf(model: unknown, u: Usage, factor = 1): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const tier = p.longCtx && p.longCtxAt && u.input > p.longCtxAt ? { ...p, ...p.longCtx } : p;
  const cached = u.cachedInput ?? 0;
  const written = u.cacheWrite ?? 0;
  const fresh = Math.max(0, u.input - cached - written);
  const M = 1e6;
  return factor * (
    fresh * tier.input / M +
    cached * (tier.cachedInput ?? tier.input) / M +
    written * (tier.cacheWrite ?? tier.input) / M +
    u.output * tier.output / M
  );
}

/** Baseline: the same request with no caching and no routing, at the requested model. */
export function baselineCost(model: unknown, u: Usage): number | null {
  return costOf(model, { input: u.input, output: u.output });
}

/** Provider inferred from a model id (used when the API key gives no signal). */
export function providerOfModel(model: unknown): Provider {
  const m = typeof model === 'string' ? model.toLowerCase() : '';
  if (/^(openai|anthropic|google|meta|mistral|deepseek|x-ai|qwen)\//.test(m)) return 'openrouter';
  if (m.startsWith('claude')) return 'anthropic';
  if (m.startsWith('gemini') || m.startsWith('models/gemini')) return 'gemini';
  if (m.startsWith('grok')) return 'xai';
  if (m.startsWith('deepseek')) return 'deepseek';
  return 'openai';
}

/** Provider inferred from the shape of the BYOK key. Beats the model heuristic when both apply. */
export function providerOfKey(key: string | undefined): Provider | null {
  if (!key) return null;
  if (key.startsWith('sk-ant-')) return 'anthropic';
  if (key.startsWith('sk-or-')) return 'openrouter';
  if (key.startsWith('AIza')) return 'gemini';
  if (key.startsWith('xai-')) return 'xai';
  if (key.startsWith('sk-')) return 'openai';
  return null;
}
