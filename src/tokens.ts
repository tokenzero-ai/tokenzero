// Token counting. Provider-reported usage is always the source of truth for
// billing; this module exists for pre-flight estimates (simulator, audits,
// cache-eligibility checks). o200k_base is OpenAI's tokenizer for GPT-4o/5;
// Anthropic and Google tokenizers differ by roughly ±15%, which we fold into
// the per-provider factor below rather than pretend to byte-exact counts.
import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type { Provider } from './pricing.ts';

let enc: Tiktoken | null = null;
function encoder(): Tiktoken {
  if (!enc) enc = getEncoding('o200k_base');
  return enc;
}

const PROVIDER_FACTOR: Record<Provider, number> = { openai: 1, anthropic: 1.12, gemini: 1.05, xai: 1.02, deepseek: 1.04, openrouter: 1.05 };

// System prompts and tool schemas repeat on nearly every request, and BPE encoding
// dominated the gateway's CPU profile. Memoize raw counts for longer texts (LRU).
const MEMO_MIN_CHARS = 256, MEMO_MAX = 4096;
const memo = new Map<string, number>();
function rawCount(text: string): number {
  if (text.length < MEMO_MIN_CHARS) return encoder().encode(text, 'all').length;
  const hit = memo.get(text);
  if (hit !== undefined) { memo.delete(text); memo.set(text, hit); return hit; }
  const n = encoder().encode(text, 'all').length;
  memo.set(text, n);
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!);
  return n;
}

export function countTokens(text: string, provider: Provider = 'openai'): number {
  if (!text) return 0;
  return Math.ceil(rawCount(text) * PROVIDER_FACTOR[provider]);
}

/** Flatten any OpenAI/Anthropic content value (string | block[]) to text for counting. */
export function contentToText(c: unknown): string {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((b: any) => {
      if (!b || typeof b !== 'object') return String(b ?? '');
      if (typeof b.text === 'string') return b.text;
      if (b.type === 'image' || b.type === 'image_url' || b.type === 'input_image') return '\u0000'.repeat(1600); // ~1.6k tokens/image budget
      if (b.type === 'tool_use' || b.type === 'function_call') return JSON.stringify(b.input ?? b.arguments ?? '');
      if (b.type === 'tool_result' || b.type === 'function_call_output') return contentToText(b.content ?? b.output);
      if (b.type === 'document') return '\u0000'.repeat(4000);
      return JSON.stringify(b);
    }).join('\n');
  }
  if (typeof c === 'object') return JSON.stringify(c);
  return String(c);
}

export interface PromptProfile {
  provider: Provider;
  total: number;
  /** tokens in system/developer instructions */
  system: number;
  /** tokens in tool/function definitions */
  tools: number;
  /** tokens in conversation history before the final user turn */
  history: number;
  /** tokens in the final user turn */
  lastUser: number;
  turns: number;
}

/** Profile an OpenAI Chat, OpenAI Responses or Anthropic Messages request body. */
export function profilePrompt(body: any, provider: Provider): PromptProfile {
  let system = 0, tools = 0, history = 0, lastUser = 0, turns = 0;
  const c = (t: unknown) => countTokens(contentToText(t), provider);

  if (body.system) system += c(body.system);
  if (typeof body.instructions === 'string') system += c(body.instructions);
  if (body.tools) tools += c(JSON.stringify(body.tools));
  if (body.functions) tools += c(JSON.stringify(body.functions));

  const msgs: any[] = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : [];
  turns = msgs.length;
  const lastUserIdx = msgs.map(m => m?.role).lastIndexOf('user');
  msgs.forEach((m, i) => {
    const n = 4 + c(m?.content ?? m?.output ?? m?.arguments ?? m);
    if (m?.role === 'system' || m?.role === 'developer') system += n;
    else if (i === lastUserIdx) lastUser += n;
    else history += n;
  });
  return { provider, system, tools, history, lastUser, turns, total: system + tools + history + lastUser };
}
