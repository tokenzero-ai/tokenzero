// Provider-key preflight (#2668 P1). One cheap, read-only call to the provider itself (a models/key listing, never a
// generation, so it costs nothing) tells a new user "this key is invalid for <provider>" before their first proxied
// request fails. Self-contained so the CLI and the stdio MCP bundle can run it locally: from those, the key goes only
// to the provider, never to TokenZero. Nothing here logs or stores a key.

export type CheckProvider = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'xai' | 'deepseek' | 'groq' | 'mistral' | 'cerebras' | 'github';
export const KEY_ENV: Record<CheckProvider, string[]> = {
  openai: ['OPENAI_API_KEY'], anthropic: ['ANTHROPIC_API_KEY'], gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], openrouter: ['OPENROUTER_API_KEY'],
  xai: ['XAI_API_KEY'], deepseek: ['DEEPSEEK_API_KEY'], groq: ['GROQ_API_KEY'], mistral: ['MISTRAL_API_KEY'], cerebras: ['CEREBRAS_API_KEY'], github: ['GITHUB_TOKEN'],
};
const NAME: Record<CheckProvider, string> = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Google Gemini', openrouter: 'OpenRouter', xai: 'xAI', deepseek: 'DeepSeek', groq: 'Groq', mistral: 'Mistral', cerebras: 'Cerebras', github: 'GitHub Models' };
const DEFAULT_BASE: Record<CheckProvider, string> = {
  openai: 'https://api.openai.com', anthropic: 'https://api.anthropic.com', gemini: 'https://generativelanguage.googleapis.com', openrouter: 'https://openrouter.ai',
  xai: 'https://api.x.ai', deepseek: 'https://api.deepseek.com', groq: 'https://api.groq.com', mistral: 'https://api.mistral.ai', cerebras: 'https://api.cerebras.ai', github: 'https://models.github.ai',
};

/** Which provider a key belongs to, by its prefix (null when the prefix says nothing, e.g. Mistral keys). */
export function providerOfKeyPrefix(key: string): CheckProvider | null {
  const k = key.trim();
  if (k.startsWith('sk-ant-')) return 'anthropic';
  if (k.startsWith('sk-or-')) return 'openrouter';
  if (k.startsWith('AIza')) return 'gemini';
  if (k.startsWith('xai-')) return 'xai';
  if (k.startsWith('gsk_')) return 'groq';
  if (k.startsWith('csk-')) return 'cerebras';
  if (k.startsWith('ghp_') || k.startsWith('github_pat_')) return 'github';
  if (k.startsWith('sk-')) return 'openai'; // also DeepSeek's shape; pass the provider explicitly for DeepSeek
  return null;
}

function request(p: CheckProvider, key: string, base: string): { url: string; headers: Record<string, string> } {
  const b = base.replace(/\/+$/, '');
  switch (p) {
    case 'anthropic': return { url: `${b}/v1/models?limit=1`, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } };
    case 'gemini': return { url: `${b}/v1beta/models?pageSize=1`, headers: { 'x-goog-api-key': key } };
    case 'openrouter': return { url: `${b}/api/v1/key`, headers: { authorization: `Bearer ${key}` } };
    case 'deepseek': return { url: `${b}/models`, headers: { authorization: `Bearer ${key}` } };
    case 'groq': return { url: `${b}/openai/v1/models`, headers: { authorization: `Bearer ${key}` } };
    case 'github': return { url: `${b}/catalog/models`, headers: { authorization: `Bearer ${key}`, accept: 'application/vnd.github+json' } };
    default: return { url: `${b}/v1/models`, headers: { authorization: `Bearer ${key}` } };
  }
}

export interface KeyCheck { provider: CheckProvider; provider_name: string; ok: boolean; status: number | null; verdict: 'valid' | 'invalid' | 'wrong_provider' | 'no_access' | 'no_model_access' | 'rate_limited' | 'unreachable' | 'unknown'; message: string; fix?: string; link?: string; keyless_sandbox?: string }

/** Ask the provider whether `key` is accepted. Never throws; `fetchImpl`/`base` exist for tests. */
export async function checkProviderKey(key: string, opts: { provider?: CheckProvider | null; base?: string; sandboxUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number; model?: string | null } = {}): Promise<KeyCheck> {
  const provider = opts.provider ?? providerOfKeyPrefix(key) ?? 'openai';
  const name = NAME[provider];
  const sandbox = opts.sandboxUrl ? `curl ${opts.sandboxUrl} -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"hi"}]}'` : undefined;
  const { url, headers } = request(provider, key.trim(), opts.base ?? DEFAULT_BASE[provider]);
  let status: number | null = null;
  try {
    const r = await (opts.fetchImpl ?? fetch)(url, { headers: { ...headers, 'user-agent': 'tokenzero-keycheck/1' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000), redirect: 'manual' });
    status = r.status;
    let body = ''; try { body = (await r.text()).slice(0, 400_000); } catch { /* none */ }
    const geminiBad = provider === 'gemini' && r.status === 400 && /API_KEY_INVALID|API key not valid/i.test(body);
    if (r.ok) {
      // With a model: the listing must name it (ids compared without a vendor/ prefix and case-insensitively).
      const want = (opts.model ?? '').toLowerCase().replace(/^[\w-]+\//, '');
      if (want && provider !== 'openrouter' && !body.toLowerCase().includes(want)) {
        return { provider, provider_name: name, ok: false, status, verdict: 'no_model_access', message: `${name} accepted this key, but its model list does not include "${opts.model}".`, fix: 'Use a model this key lists, or request access to this one.', link: CONSOLE[provider].keys };
      }
      return { provider, provider_name: name, ok: true, status, verdict: 'valid', message: `${name} accepted this key.`, link: CONSOLE[provider].keys };
    }
    const rem = classifyProviderError(provider, r.status, body, { key, model: opts.model });
    if (rem?.cause === 'wrong_provider') return { provider, provider_name: name, ok: false, status, verdict: 'wrong_provider', message: rem.message, fix: rem.fix, link: rem.link, keyless_sandbox: sandbox };
    if (r.status === 401 || geminiBad) return { provider, provider_name: name, ok: false, status, verdict: 'invalid', message: `${name} rejected this key (HTTP ${r.status}): it is not a valid ${name} key (revoked, mistyped, or for another provider).`, fix: `Create or copy a key at the ${name} console and set ${KEY_ENV[provider][0]}.`, link: CONSOLE[provider].keys, keyless_sandbox: sandbox };
    if (r.status === 403) return { provider, provider_name: name, ok: false, status, verdict: 'no_access', message: `${name} recognised the key but refused access (HTTP 403): check its permissions, project or billing.`, link: CONSOLE[provider].keys, keyless_sandbox: sandbox };
    if (r.status === 429) return { provider, provider_name: name, ok: true, status, verdict: 'rate_limited', message: `${name} rate-limited the check (HTTP 429); the key itself was accepted.` };
    return { provider, provider_name: name, ok: false, status, verdict: 'unknown', message: `${name} answered HTTP ${r.status}; the key could not be confirmed.` };
  } catch (e: any) {
    return { provider, provider_name: name, ok: false, status, verdict: 'unreachable', message: `Could not reach ${name} to check the key (${e?.name === 'TimeoutError' ? 'timeout' : e?.message ?? e}).` };
  }
}

/** Provider keys present in an environment map (values never returned, only where they are). */
export function keysInEnv(env: Record<string, string | undefined>): { provider: CheckProvider; variable: string; key: string }[] {
  const out: { provider: CheckProvider; variable: string; key: string }[] = [];
  for (const [p, vars] of Object.entries(KEY_ENV) as [CheckProvider, string[]][]) {
    const v = vars.find(n => typeof env[n] === 'string' && env[n]!.trim().length >= 8);
    if (v) out.push({ provider: p, variable: v, key: env[v]!.trim() });
  }
  return out;
}

// ---- #2725: one map from a provider's error to the specific cause, fix and console page --------------------------
export type FailureCause = 'invalid_key' | 'wrong_provider' | 'no_model_access' | 'billing' | 'permission' | 'rate_limited' | 'context_length' | 'bad_request' | 'not_found' | 'payload_too_large' | 'timeout' | 'upstream_error' | 'unreachable' | 'unknown';
/** Provider status pages, for failures on the provider's side (5xx, timeouts, unreachable). */
export const STATUS_PAGE: Partial<Record<CheckProvider, string>> = { openai: 'https://status.openai.com', anthropic: 'https://status.anthropic.com', gemini: 'https://aistudio.google.com/status', openrouter: 'https://status.openrouter.ai', xai: 'https://status.x.ai', deepseek: 'https://status.deepseek.com', github: 'https://www.githubstatus.com' };
export const CONSOLE: Record<CheckProvider, { keys: string; billing?: string }> = {
  openai: { keys: 'https://platform.openai.com/api-keys', billing: 'https://platform.openai.com/settings/organization/billing/overview' },
  anthropic: { keys: 'https://console.anthropic.com/settings/keys', billing: 'https://console.anthropic.com/settings/billing' },
  gemini: { keys: 'https://aistudio.google.com/apikey', billing: 'https://console.cloud.google.com/billing' },
  openrouter: { keys: 'https://openrouter.ai/settings/keys', billing: 'https://openrouter.ai/settings/credits' },
  xai: { keys: 'https://console.x.ai', billing: 'https://console.x.ai' },
  deepseek: { keys: 'https://platform.deepseek.com/api_keys', billing: 'https://platform.deepseek.com/top_up' },
  groq: { keys: 'https://console.groq.com/keys' },
  mistral: { keys: 'https://console.mistral.ai/api-keys', billing: 'https://console.mistral.ai/billing' },
  cerebras: { keys: 'https://cloud.cerebras.ai' },
  github: { keys: 'https://github.com/settings/tokens' },
};
export interface Remediation { cause: FailureCause; message: string; fix: string; link: string }

/** Turn a provider's HTTP status + error body into the specific cause and the one thing to do about it. */
export function classifyProviderError(provider: CheckProvider, status: number, body: string, opts: { key?: string; model?: string | null } = {}): Remediation | null {
  const name = NAME[provider], c = CONSOLE[provider], b = body.toLowerCase();
  const keyProvider = opts.key ? providerOfKeyPrefix(opts.key) : null;
  const env = KEY_ENV[provider][0];
  if (status === 401 || (provider === 'gemini' && status === 400 && /api_key_invalid|api key not valid/.test(b)) || (provider === 'openrouter' && /user not found|no auth credentials/.test(b))) {
    if (keyProvider && keyProvider !== provider && !(keyProvider === 'openai' && provider === 'deepseek'))
      return { cause: 'wrong_provider', message: `This looks like a ${NAME[keyProvider]} key, but the request went to ${name}.`, fix: `Use a model from ${NAME[keyProvider]} with this key, or send X-TokenZero-Provider: ${keyProvider}.`, link: CONSOLE[keyProvider].keys };
    const maybeDeepseek = provider === 'openai' && keyProvider === 'openai' ? ' If this is a DeepSeek key (DeepSeek keys also start with sk-), send X-TokenZero-Provider: deepseek.' : '';
    return { cause: 'invalid_key', message: `${name} rejected the API key (HTTP ${status}): it is not a valid ${name} key (revoked, mistyped, or for another provider).`, fix: `Copy a working key from the ${name} console and send it as ${provider === 'anthropic' ? 'x-api-key or ' : ''}Authorization: Bearer <key> (env ${env}).${maybeDeepseek}`, link: c.keys };
  }
  if (status === 402 || /insufficient_quota|exceeded your current quota|credit balance is too low|insufficient credits|billing|payment required/.test(b))
    return { cause: 'billing', message: `${name} accepted the key but refused to bill it (${status === 402 ? 'HTTP 402' : 'no credit or quota'}).`, fix: `Add credit or enable billing for this ${name} account, then retry.`, link: c.billing ?? c.keys };
  if (status === 404 && /model/.test(b) || /does not have access to model|model_not_found|not have access to|is not available for your|you do not have access/.test(b))
    return { cause: 'no_model_access', message: `${name} accepted the key, but it has no access to ${opts.model ? `model "${opts.model}"` : 'the requested model'}.`, fix: `Pick a model this key can use (GET the provider's models list) or request access for this model.`, link: c.keys };
  if (status === 403) return { cause: 'permission', message: `${name} recognised the key but refused this request (HTTP 403): check the key's permissions, project or region.`, fix: `Open the key's settings and allow this API/model, or create a key with full access.`, link: c.keys };
  if (status === 429) return { cause: 'rate_limited', message: `${name} rate-limited this request (HTTP 429); the key works.`, fix: 'Retry after a pause, or send X-TokenZero-Fallback: auto to fail over automatically.', link: c.keys };
  // Everything else a provider can answer: one specific cause per class, never a raw error (#2789).
  const sp = STATUS_PAGE[provider] ?? c.keys;
  if (status === 413 || /request entity too large|payload too large|request too large/.test(b))
    return { cause: 'payload_too_large', message: `${name} refused the request as too large (HTTP ${status}).`, fix: 'Send fewer or smaller messages/attachments, or split the request.', link: c.keys };
  if (status === 400 && /context length|context_length|maximum context|context window|too many tokens|prompt is too long|input is too long|max_tokens.*exceed|exceeds the maximum/.test(b))
    return { cause: 'context_length', message: `${name} rejected the request: the prompt plus max_tokens is longer than ${opts.model ? `"${opts.model}"` : 'the model'} accepts.`, fix: 'Trim the conversation history or lower max_tokens, or use a model with a longer context window.', link: c.keys };
  if (status === 404) return { cause: 'not_found', message: `${name} has no such endpoint or model here (HTTP 404)${opts.model ? ` for "${opts.model}"` : ''}.`, fix: `Check the model id against the ${name} models list and that the SDK base URL ends in /v1.`, link: c.keys };
  if (status === 408 || status === 504 || status === 524) return { cause: 'timeout', message: `${name} timed out answering (HTTP ${status}); nothing is wrong with the key.`, fix: 'Retry, lower max_tokens, or send X-TokenZero-Fallback: auto to retry and fail over automatically.', link: sp };
  if (status >= 500) return { cause: 'upstream_error', message: `${name} had an error on its side (HTTP ${status}${status === 529 ? ', overloaded' : ''}); nothing is wrong with the key or the request.`, fix: 'Retry in a moment, or send X-TokenZero-Fallback: auto to retry with jitter and fail over automatically.', link: sp };
  if (status === 0) return { cause: 'unreachable', message: `${name} could not be reached from TokenZero.`, fix: 'Retry in a moment, or send X-TokenZero-Fallback: auto to fail over automatically.', link: sp };
  if (status >= 400) return { cause: 'bad_request', message: `${name} rejected the request itself (HTTP ${status}), not the key.`, fix: 'Fix the parameter the provider names below (model id, message format or an unsupported field), then retry.', link: c.keys };
  return null;
}
