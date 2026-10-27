// Versioned list-price table, USD per 1M tokens, sourced from the providers'
// official pricing pages on PRICING_VERSION. Savings are always computed at
// these list prices for the model the caller asked for.
//
// Sources: developers.openai.com/api/docs/pricing, ai.google.dev/gemini-api/docs/pricing,
// platform.claude.com pricing (via the Anthropic model table of the same date).
export const PRICING_VERSION = '2026-10-27';
export const PRICING_MAX_AGE_DAYS = 45;

/**
 * Known upcoming provider price changes. Each one must be re-verified and the
 * table re-dated on or after `on`; the test suite fails once a date passes
 * without PRICING_VERSION moving past it.
 */
export const PRICING_REVIEWS: { on: string; note: string }[] = [
  { on: '2026-11-22', note: 'GPT-5.6 Sol promotional pricing ($4/$20) is guaranteed only through 2026-11-21 (developers.openai.com pricing page)' },
  { on: '2026-12-01', note: 'Gemini 4 Argon input/output/cache prices double (ai.google.dev pricing page)' },
  { on: '2026-12-31', note: 'Some Gemini 3.x Flash / Flash-Lite prices double; check each model' },
  { on: '2027-01-01', note: 'Gemini 3.8 Flash and remaining 3.x Flash prices double' },
  { on: '2027-01-14', note: 'gpt-4o, gpt-4o-mini, gpt-4.1, gpt-4.1-mini shut down; drop the rows or keep them as retired' },
];

export function pricingFreshness(nowMs = Date.now()) {
  const ageDays = Math.floor((nowMs - Date.parse(PRICING_VERSION + 'T00:00:00Z')) / 86_400_000);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const overdue = PRICING_REVIEWS.filter(r => r.on <= today && r.on > PRICING_VERSION);
  return { version: PRICING_VERSION, age_days: ageDays, max_age_days: PRICING_MAX_AGE_DAYS, stale: ageDays > PRICING_MAX_AGE_DAYS || overdue.length > 0, overdue_reviews: overdue, upcoming_reviews: PRICING_REVIEWS.filter(r => r.on > today) };
}

export type Provider = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'xai' | 'deepseek';

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
  /** OpenAI Fast mode multiplier when it is not the usual 2x (gpt-5.5 is 2.5x; GPT-4.x and o-series 1.67-1.82x) */
  fastFactor?: number;
  /** OpenAI Ultrafast (6x) is only sold for these models */
  ultrafast?: boolean;
  /** long-context tier: applies when input tokens exceed `longCtxAt` */
  longCtxAt?: number;
  longCtx?: { input: number; output: number; cachedInput?: number; cacheWrite?: number };
  tier: 'frontier' | 'mid' | 'fast';
}

const P = (provider: Provider, tier: Price['tier'], input: number, output: number, cachedInput?: number, cacheWrite?: number, extra: Partial<Price> = {}): Price =>
  ({ provider, tier, input, output, cachedInput, cacheWrite, ...extra });

export const PRICES: Record<string, Price> = {
  // ---- OpenAI (standard tier, ≤272K; cache write = 30m TTL rate) ----
  'gpt-6-astra': P('openai', 'frontier', 10, 50, 1, 12.5, { ultrafast: true, longCtxAt: 272_000, longCtx: { input: 20, output: 75, cachedInput: 2, cacheWrite: 25 }, minCacheTokens: 1024 }),
  'gpt-6.1-sol': P('openai', 'mid', 2, 10, 0.1, 2.5, { ultrafast: true, longCtxAt: 272_000, longCtx: { input: 4, output: 15, cachedInput: 0.2, cacheWrite: 5 }, minCacheTokens: 1024 }),
  'gpt-6.1-terra': P('openai', 'mid', 1, 5, 0.05, 1.25, { longCtxAt: 272_000, longCtx: { input: 2, output: 7.5, cachedInput: 0.1, cacheWrite: 2.5 }, minCacheTokens: 1024 }),
  'gpt-6-sol': P('openai', 'mid', 2, 10, 0.2, 2.5, { longCtxAt: 272_000, longCtx: { input: 4, output: 15, cachedInput: 0.4, cacheWrite: 5 }, minCacheTokens: 1024 }),
  'gpt-6-luna': P('openai', 'fast', 0.1, 0.5, 0.01, 0.125, { longCtxAt: 272_000, longCtx: { input: 0.2, output: 0.75, cachedInput: 0.02, cacheWrite: 0.25 }, minCacheTokens: 1024 }),
  'gpt-5.6-sol': P('openai', 'frontier', 4, 20, 0.4, 5, { longCtxAt: 272_000, longCtx: { input: 8, output: 30, cachedInput: 0.8, cacheWrite: 10 }, minCacheTokens: 1024 }),
  'gpt-5.6-terra': P('openai', 'mid', 2, 12, 0.2, 2.5, { longCtxAt: 272_000, longCtx: { input: 4, output: 18, cachedInput: 0.4, cacheWrite: 5 }, minCacheTokens: 1024 }),
  'gpt-5.6-luna': P('openai', 'fast', 0.2, 1.2, 0.02, 0.25, { longCtxAt: 272_000, longCtx: { input: 0.4, output: 1.8, cachedInput: 0.04, cacheWrite: 0.5 }, minCacheTokens: 1024 }),
  // Daybreak cyber model: access needs OpenAI approval; 400K window
  'gpt-5.6-cyber': P('openai', 'frontier', 12.5, 75, 1.25, 15.625, { longCtxAt: 272_000, longCtx: { input: 25, output: 112.5, cachedInput: 2.5, cacheWrite: 31.25 }, minCacheTokens: 1024 }),
  'gpt-5.3-codex': P('openai', 'mid', 1.75, 14, 0.175, undefined, { minCacheTokens: 1024 }),
  'gpt-5.5': P('openai', 'frontier', 5, 30, 0.5, undefined, { fastFactor: 2.5, longCtxAt: 272_000, longCtx: { input: 10, output: 45, cachedInput: 1 }, minCacheTokens: 1024 }),
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
  'gpt-4.1': P('openai', 'mid', 2, 8, 0.5, undefined, { fastFactor: 1.75, minCacheTokens: 1024 }),
  'gpt-4.1-mini': P('openai', 'fast', 0.4, 1.6, 0.1, undefined, { minCacheTokens: 1024 }),
  'gpt-4.1-nano': P('openai', 'fast', 0.1, 0.4, 0.025, undefined, { minCacheTokens: 1024 }),
  'gpt-4o': P('openai', 'mid', 2.5, 10, 1.25, undefined, { fastFactor: 1.7, minCacheTokens: 1024 }),
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
  'claude-sonnet-5-5': P('anthropic', 'mid', 2, 10, 0.1, 2.5, { minCacheTokens: 512 }), // cache hits 0.05x base on Opus 5.5 and Sonnet 5.5
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

  // ---- xAI (docs.x.ai/docs/models; prompts over 200K tokens bill the whole request at 2x) ----
  'grok-4.7': P('xai', 'frontier', 2, 6, 0.5, undefined, { longCtxAt: 200_000, longCtx: { input: 4, output: 12, cachedInput: 1 } }),
  'grok-4.6': P('xai', 'frontier', 2, 6, 0.5, undefined, { longCtxAt: 200_000, longCtx: { input: 4, output: 12, cachedInput: 1 } }),
  'grok-4.5': P('xai', 'frontier', 2, 6, 0.3, undefined, { longCtxAt: 200_000, longCtx: { input: 4, output: 12, cachedInput: 0.6 } }),
  'grok-4.3': P('xai', 'mid', 1.25, 2.5, 0.2, undefined, { longCtxAt: 200_000, longCtx: { input: 2.5, output: 5, cachedInput: 0.4 } }),
  'grok-4.20': P('xai', 'mid', 1.25, 2.5, 0.2, undefined, { longCtxAt: 200_000, longCtx: { input: 2.5, output: 5, cachedInput: 0.4 } }),
  'grok-build-0.1': P('xai', 'fast', 1, 2, 0.2, undefined, { longCtxAt: 200_000, longCtx: { input: 2, output: 4, cachedInput: 0.4 } }),

  // ---- DeepSeek (api-docs.deepseek.com; PEAK rates listed, off-peak is half: see priceModifier) ----
  'deepseek-v4-pro': P('deepseek', 'mid', 1.32, 3.96, 0.044),
  'deepseek-flash': P('deepseek', 'fast', 0.3, 1.2, 0.006),
};
/** Retired ids the provider still accepts and bills as the model that replaced them. */
const MODEL_ALIASES: Record<string, string> = { 'deepseek-v4-flash': 'deepseek-flash', 'deepseek-v4-flash-vision-exp': 'deepseek-flash' };

/** Cheaper sibling for the opt-in cascade router and arbitrage math. */
export const CASCADE_TARGET: Record<string, string> = {
  'gpt-6-astra': 'gpt-6.1-sol',
  'gpt-6.1-sol': 'gpt-6.1-terra',
  'gpt-6.1-terra': 'gpt-6-luna',
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
  'grok-4.7': 'grok-4.3',
  'grok-4.6': 'grok-4.3',
  'grok-4.5': 'grok-4.3',
  'deepseek-v4-pro': 'deepseek-flash',
  'gemini-2.5-pro': 'gemini-2.5-flash',
  'gemini-2.5-flash': 'gemini-2.5-flash-lite',
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
  // Router and cloud prefixes (OpenRouter, LiteLLM, Bedrock): "x-ai/grok-4.7", "us.anthropic.claude-opus-5-5-20260301-v1:0".
  m = m.replace(/^(openai|anthropic|google|models|vertex_ai|x-ai|xai|deepseek|bedrock|openrouter)\//, '');
  m = m.replace(/^(us|eu|apac|global)\./, '').replace(/^(anthropic|amazon|meta|mistral)\./, '');
  m = m.replace(/-v\d+(?::\d+)?$/, '');
  if (MODEL_ALIASES[m]) m = MODEL_ALIASES[m];
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

// ---- processing tiers ----------------------------------------------------------
// Providers sell the same tokens at different rates by speed. A receipt must price
// what the customer actually bought, and the baseline must use the same tier, so a
// tier never shows up as a saving (or a loss) TokenZero did not cause.
//   OpenAI  service_tier: flex 0.5x (Batch rates), fast 2x (named "priority" before
//           2026-07-30; both spellings accepted), ultrafast 6x. The response echoes the
//           tier that served the request, which wins over the request when present.
//   Anthropic speed: "fast" 2x (Opus 5.5: $8/$40; Opus 5 and 4.8: $10/$50).
//   Batch APIs are separate endpoints (pass-through, not metered).
export interface PriceModifier { tier: string | null; factor: number }
/** Anthropic `inference_geo: "us"` is 1.1x on every token category for Claude 4.6+ (older models reject the parameter). */
const US_GEO_FACTOR = 1.1;
const usGeoEligible = (key: string) => /^claude-(fable|mythos|opus-5|opus-4-[6-9]|sonnet-5|sonnet-4-[6-9]|haiku-5)/.test(key);
export function priceModifier(provider: Provider, body: any, response?: any, at: Date = new Date()): PriceModifier {
  if (provider === 'openai' || provider === 'openrouter') {
    const t = String(response?.service_tier ?? response?.response?.service_tier ?? body?.service_tier ?? '').toLowerCase();
    const p = priceFor(body?.model);
    if (t === 'flex') return { tier: 'flex', factor: 0.5 };
    if (t === 'fast' || t === 'priority') return { tier: 'fast', factor: p?.fastFactor ?? 2 };
    if (t === 'ultrafast') return { tier: 'ultrafast', factor: p && !p.ultrafast ? (p.fastFactor ?? 2) : 6 };
    return { tier: null, factor: 1 };
  }
  if (provider === 'anthropic') {
    const k = normalizeModel(body?.model) ?? '';
    const geo = String(response?.usage?.inference_geo ?? body?.inference_geo ?? '').toLowerCase() === 'us' && usGeoEligible(k) ? US_GEO_FACTOR : 1;
    if (String(body?.speed ?? '').toLowerCase() === 'fast' && /^claude-opus-(5-5|5|4-8)$/.test(k)) return { tier: geo > 1 ? 'fast+us' : 'fast', factor: 2 * geo };
    if (geo > 1) return { tier: 'us', factor: geo };
  }
  // DeepSeek bills by time of day: peak is Mon-Fri 01:00-04:00 and 06:00-10:00 UTC, off-peak is half price.
  if (provider === 'deepseek' && !deepseekPeak(at)) return { tier: 'off-peak', factor: 0.5 };
  return { tier: null, factor: 1 };
}
export function deepseekPeak(at: Date = new Date()): boolean {
  const day = at.getUTCDay(), h = at.getUTCHours() + at.getUTCMinutes() / 60;
  if (day === 0 || day === 6) return false;
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
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

/** Baseline: the same request with no caching and no routing, at the requested model and tier. */
export function baselineCost(model: unknown, u: Usage, factor = 1): number | null {
  return costOf(model, { input: u.input, output: u.output }, factor);
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


// ---- model lifecycle ----------------------------------------------------------
// Provider deprecation calendars (developers.openai.com/api/docs/deprecations,
// platform.claude.com model-deprecations), keyed by pricing key. A retired model
// still has a row so historical receipts and audits price correctly; the auditor,
// the gateway warning header and /models tell callers to move.
export interface Sunset { retires: string; replacement: string; announced: string }
export const MODEL_SUNSET: Record<string, Sunset> = {
  'gpt-4o': { retires: '2027-01-14', replacement: 'gpt-6-luna', announced: '2026-10-14' },
  'gpt-4o-mini': { retires: '2027-01-14', replacement: 'gpt-6-luna', announced: '2026-10-14' },
  'gpt-4.1': { retires: '2027-01-14', replacement: 'gpt-6-luna', announced: '2026-10-14' },
  'gpt-4.1-mini': { retires: '2027-01-14', replacement: 'gpt-6-luna', announced: '2026-10-14' },
  'gpt-4.1-nano': { retires: '2026-10-23', replacement: 'gpt-5.6-luna', announced: '2026-04-22' },
  'gpt-5': { retires: '2026-12-11', replacement: 'gpt-5.6-sol', announced: '2026-06-11' },
  'gpt-5-mini': { retires: '2026-12-11', replacement: 'gpt-5.6-terra', announced: '2026-06-11' },
  'gpt-5-nano': { retires: '2026-12-11', replacement: 'gpt-5.6-luna', announced: '2026-06-11' },
  'gpt-5-pro': { retires: '2026-12-11', replacement: 'gpt-5.6-sol', announced: '2026-06-11' },
  'gpt-5.1': { retires: '2027-04-01', replacement: 'gpt-6-sol', announced: '2026-10-01' },
  'gpt-5.3-codex': { retires: '2027-04-01', replacement: 'gpt-6-sol', announced: '2026-10-01' },
  'gpt-5.4-nano': { retires: '2027-04-01', replacement: 'gpt-6-luna', announced: '2026-10-01' },
  'o1': { retires: '2026-10-23', replacement: 'gpt-5.6-sol', announced: '2026-04-22' },
  'o3': { retires: '2026-12-11', replacement: 'gpt-5.6-sol', announced: '2026-06-11' },
  'o3-pro': { retires: '2026-12-11', replacement: 'gpt-5.6-sol', announced: '2026-06-11' },
  'o3-mini': { retires: '2026-10-23', replacement: 'gpt-5.6-sol', announced: '2026-04-22' },
  'o4-mini': { retires: '2026-10-23', replacement: 'gpt-5.6-terra', announced: '2026-04-22' },
  'claude-sonnet-4-5': { retires: '2026-11-30', replacement: 'claude-sonnet-5-5', announced: '2026-09-30' },
};
export interface SunsetStatus extends Sunset { key: string; retired: boolean; days_left: number }
/** Lifecycle of a model id as of `at`: null when the provider has not announced a retirement. */
export function modelSunset(model: unknown, at: Date = new Date()): SunsetStatus | null {
  const key = normalizeModel(model); if (!key) return null;
  const s = MODEL_SUNSET[key]; if (!s) return null;
  const days = Math.ceil((Date.parse(s.retires + 'T00:00:00Z') - at.getTime()) / 86_400_000);
  return { key, ...s, retired: days <= 0, days_left: Math.max(0, days) };
}
