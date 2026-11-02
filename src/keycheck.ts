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

export interface KeyCheck { provider: CheckProvider; provider_name: string; ok: boolean; status: number | null; verdict: 'valid' | 'invalid' | 'no_access' | 'rate_limited' | 'unreachable' | 'unknown'; message: string; fix?: string; keyless_sandbox?: string }

/** Ask the provider whether `key` is accepted. Never throws; `fetchImpl`/`base` exist for tests. */
export async function checkProviderKey(key: string, opts: { provider?: CheckProvider | null; base?: string; sandboxUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<KeyCheck> {
  const provider = opts.provider ?? providerOfKeyPrefix(key) ?? 'openai';
  const name = NAME[provider];
  const sandbox = opts.sandboxUrl ? `curl ${opts.sandboxUrl} -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"hi"}]}'` : undefined;
  const { url, headers } = request(provider, key.trim(), opts.base ?? DEFAULT_BASE[provider]);
  let status: number | null = null;
  try {
    const r = await (opts.fetchImpl ?? fetch)(url, { headers: { ...headers, 'user-agent': 'tokenzero-keycheck/1' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 8_000), redirect: 'manual' });
    status = r.status;
    let body = ''; try { body = (await r.text()).slice(0, 2000); } catch { /* none */ }
    const geminiBad = provider === 'gemini' && r.status === 400 && /API_KEY_INVALID|API key not valid/i.test(body);
    if (r.ok) return { provider, provider_name: name, ok: true, status, verdict: 'valid', message: `${name} accepted this key.` };
    if (r.status === 401 || geminiBad) return { provider, provider_name: name, ok: false, status, verdict: 'invalid', message: `${name} rejected this key (HTTP ${r.status}): it is not a valid ${name} key (revoked, mistyped, or for another provider).`, fix: `Create or copy a key at the ${name} console and set ${KEY_ENV[provider][0]}.`, keyless_sandbox: sandbox };
    if (r.status === 403) return { provider, provider_name: name, ok: false, status, verdict: 'no_access', message: `${name} recognised the key but refused access (HTTP 403): check its permissions, project or billing.`, keyless_sandbox: sandbox };
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
