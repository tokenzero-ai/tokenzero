// Static token-waste analyzer (pure: no I/O, no database, no network), shared
// by the server and the CLI so a local audit and a hosted one agree.
//
// Reads source files (a repo tree, a PR diff or a
// pasted snippet), finds LLM call sites and scores the patterns that cost
// money: uncached static prompts, frontier models on extraction tasks, tool
// schemas re-sent per call, no determinism on repeat-heavy calls, and hot loops.
// Everything is heuristic and says so; the gateway's ledger is where numbers
// become verified.
import crypto from 'node:crypto';
import { priceFor, normalizeModel, CASCADE_TARGET, costOf, PRICES } from './pricing.ts';
import { countTokens } from './tokens.ts';

export interface SourceFile { path: string; content: string; }
export interface Finding {
  severity: 'high' | 'medium' | 'low' | 'info';
  file: string;
  line: number;
  title: string;
  detail: string;
  fix: string;
  est_savings_pct: number;
}
export interface CallSite { file: string; line: number; model: string | null; sdk: string; }
export type RepoKind = 'app' | 'library' | 'unknown';
export interface AuditReport {
  id: string;
  repo: string | null;
  /** always "static heuristics": estimates, never measurements */
  method: 'static heuristics';
  repo_kind: RepoKind;
  notes: string[];
  scanned_files: number;
  call_sites: CallSite[];
  models: Record<string, number>;
  findings: Finding[];
  estimated_waste_pct: number;
  cost_per_10k_runs: { before_usd: number; after_usd: number; model: string; assumed_prompt_tokens: number } | null;
  badge_url: string | null;
  generated_at: string;
}

const MODEL_RE = /["'`](?:openai\/|anthropic\/|google\/|models\/)?((?:gpt-[\w.-]+|o[134](?:-mini|-pro)?(?:-[\w-]+)?|claude-[\w.-]+|gemini-[\w.-]+))["'`]/g;
const CALL_RE: [RegExp, string][] = [
  [/\.chat\.completions\.(create|parse)\s*\(/, 'openai-chat'],
  [/\.responses\.(create|parse|stream)\s*\(/, 'openai-responses'],
  [/\.messages\.(create|stream|parse)\s*\(/, 'anthropic-messages'],
  [/\b(generateText|streamText|generateObject|streamObject)\s*\(/, 'vercel-ai'],
  [/\b(ChatOpenAI|AzureChatOpenAI)\s*\(/, 'langchain-openai'],
  [/\bChatAnthropic\s*\(/, 'langchain-anthropic'],
  [/\bChatGoogleGenerativeAI\s*\(/, 'langchain-gemini'],
  [/\binit_chat_model\s*\(/, 'langchain'],
  [/\.generate_content\s*\(|\.generateContent\s*\(/, 'gemini-sdk'],
  [/\blitellm\.(a?completion)\s*\(/, 'litellm'],
];
export const SOURCE_EXT = /\.(py|ts|tsx|js|jsx|mjs|cjs|rb|go|java|kt|rs|cs|php)$/i;
export const SKIP_PATH = /(^|\/)(node_modules|dist|build|\.next|vendor|venv|\.venv|__pycache__|target|coverage|\.git)(\/|$)|\.min\.js$|\.lock$|\.d\.ts$|(^|\/)(test|tests|__tests__|spec)(\/|$)|[._-](test|spec)\.[a-z]+$|(^|\/)(public|static|assets)\/.*\.m?js$|(^|\/)(workbox|sw|service-worker)[\w.-]*\.js$|[.-][a-f0-9]{8,}\.m?js$|\.bundle\.m?js$/i;
/** Illustrative code: real usage patterns, but not production traffic. */
const EXAMPLE_PATH = /(^|\/)(examples?|docs?|cookbooks?|samples?|demos?|notebooks?|benchmarks?|scripts)(\/|$)/i;
export const MANIFEST_FILES = ['package.json', 'pyproject.toml', 'setup.py', 'setup.cfg'];

// ---- lexer --------------------------------------------------------------------
interface Literal { text: string; line: number; }
interface Lexed { masked: string[]; literals: Literal[]; }

const TRIPLE_DQ = '"'.repeat(3), TRIPLE_SQ = "'".repeat(3);

/**
 * Blank out comments and string-literal contents (same length, newlines kept) so
 * call detection sees only code, and collect the string literals with their
 * starting line. Language-aware enough for Python and the C family; single- and
 * double-quoted strings stop at end of line so one stray quote can't invert the
 * rest of the file.
 */
export function lex(src: string, path: string): Lexed {
  const py = /\.py$/i.test(path), hashComments = py || /\.(rb|php)$/i.test(path);
  const backtick = /\.(js|jsx|ts|tsx|mjs|cjs|go)$/i.test(path);
  const out = src.split('');
  const literals: Literal[] = [];
  let i = 0, line = 1;
  const blank = (a: number, b: number) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  const advance = (a: number, b: number) => { for (let k = a; k < b; k++) if (src[k] === '\n') line++; };
  while (i < src.length) {
    const c = src[i], two = src.slice(i, i + 2), three = src.slice(i, i + 3);
    if ((hashComments && c === '#') || (!py && two === '//')) { let j = src.indexOf('\n', i); if (j < 0) j = src.length; blank(i, j); i = j; continue; }
    if (!py && two === '/*') { let j = src.indexOf('*/', i + 2); j = j < 0 ? src.length : j + 2; blank(i, j); advance(i, j); i = j; continue; }
    if (py && (three === TRIPLE_DQ || three === TRIPLE_SQ)) {
      let j = src.indexOf(three, i + 3); j = j < 0 ? src.length : j + 3;
      literals.push({ text: src.slice(i + 3, Math.max(i + 3, j - 3)), line });
      blank(i + 3, Math.max(i + 3, j - 3)); advance(i, j); i = j; continue;
    }
    if (c === '"' || c === "'" || (backtick && c === '`')) {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; else if (src[j] === '\n' && c !== '`') break; j++; }
      const end = Math.min(j, src.length);
      literals.push({ text: src.slice(i + 1, end), line });
      blank(i + 1, end); advance(i, end + 1); i = end + 1; continue;
    }
    if (c === '\n') line++;
    i++;
  }
  return { masked: out.join('').split('\n'), literals };
}

/** Does a literal read like natural-language prompt text (not HTML, CSS, SQL or code)? */
function promptLike(t: string): boolean {
  if (t.length < 200) return false;
  const tags = (t.match(/<\/?[a-z][\w-]*[^>]*>/gi) ?? []).length;
  const cssRules = (t.match(/[{;]\s*[a-z-]+\s*:\s*[^;{}]+;/gi) ?? []).length;
  const codeChars = (t.match(/[{}();=<>]/g) ?? []).length;
  const words = (t.match(/[A-Za-z]{2,}/g) ?? []).length;
  return tags < 4 && cssRules < 3 && codeChars / t.length < 0.03 && words / (t.length / 6) > 0.5;
}

/** Instruction phrasing that marks an extraction/classification-shaped task. Read only from prompt text. */
const SIMPLE_TASK = /\b(classify|classification|categori[sz]e|sentiment|extract (the|all|every|any)|return (only |just )?(valid |a )?json|respond (only )?(with|in) (valid )?json|output (only )?(valid )?json|translate (this|the following|into)|summari[sz]e (this|the following|in \d+)|label (this|the|each)|is (this|it) spam|yes or no|true or false)\b/i;

// ---- repo classification ------------------------------------------------------
// Exact package names of LLM SDKs and frameworks (plus their own sub-packages).
// Deliberately not generic words: an app's package called "agent" or "ai-app" is an app.
const LLM_LIB_EXACT = new Set(['openai', 'anthropic', '@anthropic-ai/sdk', 'ai', 'litellm', 'openai-agents', '@openai/agents', 'instructor', 'dspy', 'dspy-ai', 'guidance', 'semantic-kernel', 'haystack-ai', 'autogen', 'pyautogen', 'autogen-agentchat', 'crewai', 'google-genai', '@google/genai', 'mistralai', '@mistralai/mistralai', 'cohere', 'cohere-ai', 'llama-index', 'llama_index', 'llamaindex', 'langchain', 'langgraph', '@langchain/core', 'groq-sdk', 'together-ai', 'ollama']);
const LLM_LIB_FAMILY = /^(@langchain\/[\w-]+|langchain[-_][\w-]+|langgraph[-_][\w-]+|llama[-_]index[-_][\w-]+|@ai-sdk\/[\w-]+|openai[-_]agents[-_][\w-]+)$/i;
const isLlmLib = (name: string) => LLM_LIB_EXACT.has(name.toLowerCase()) || LLM_LIB_FAMILY.test(name);
const APP_DEPS = ['next', 'react-dom', 'express', 'fastify', 'hono', '@remix-run/react', 'nuxt', 'svelte', '@sveltejs/kit', 'electron'];

export function detectRepoKind(manifests: SourceFile[], files: SourceFile[]): { kind: RepoKind; reason: string } {
  const get = (n: string) => manifests.find(m => m.path === n)?.content ?? '';
  const pkgRaw = get('package.json');
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      if (pkg.name && isLlmLib(pkg.name)) return { kind: 'library', reason: `package "${pkg.name}" is an LLM SDK/framework` };
      const deps = { ...pkg.dependencies };
      const appDep = APP_DEPS.some(d => d in deps);
      const publishable = !pkg.private && (pkg.exports || pkg.main || pkg.module || pkg.types) && (pkg.files || pkg.publishConfig);
      if (publishable && !appDep) return { kind: 'library', reason: 'publishable npm package layout (exports/main + files, not private)' };
      if (pkg.private || appDep) return { kind: 'app', reason: 'private package or app framework dependency' };
    } catch { /* malformed: ignore */ }
  }
  const pyproject = get('pyproject.toml'), setup = get('setup.py') + get('setup.cfg');
  const pyName = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1] ?? /name\s*=\s*["']([^"']+)["']/.exec(setup)?.[1];
  if (pyName && isLlmLib(pyName)) return { kind: 'library', reason: `Python package "${pyName}" is an LLM SDK/framework` };
  const webApp = files.some(f => /(^|\/)app\/(layout|page)\.[jt]sx?$|(^|\/)pages\/(_app|index)\.[jt]sx?$|(^|\/)src\/routes\/\+page\.svelte$/.test(f.path));
  const hasAppEntry = files.some(f => /^(app|main|server|manage|streamlit_app|bot)\.py$/i.test(f.path) || (/^(app|api|server)\//i.test(f.path) && /\b(FastAPI|Flask|Django|streamlit|gradio)\b/.test(f.content)));
  const installable = (pyproject.includes('[build-system]') && /^\s*\[project\]/m.test(pyproject)) || /\bsetup\(/.test(setup);
  if (webApp) return { kind: 'app', reason: 'web app routes found (Next.js / SvelteKit)' };
  if (installable && files.some(f => /^src\/[\w-]+\//.test(f.path)) && !hasAppEntry) return { kind: 'library', reason: 'installable Python package with src/ layout and no app entry point' };
  if (hasAppEntry) return { kind: 'app', reason: 'app entry point found' };
  return { kind: 'unknown', reason: 'no manifest signal' };
}

const DOWN: Record<Finding['severity'], Finding['severity']> = { high: 'medium', medium: 'low', low: 'info', info: 'info' };

// ---- analysis -----------------------------------------------------------------
export function analyzeFiles(files: SourceFile[], repo: string | null = null, manifests: SourceFile[] = []): AuditReport {
  const findings: Finding[] = [];
  const callSites: CallSite[] = [];
  const siteFindings: Finding[][] = [];
  const models: Record<string, number> = {};
  const unknownModels = new Set<string>();
  const notes: string[] = [];
  const sources = files.filter(f => SOURCE_EXT.test(f.path) && !SKIP_PATH.test(f.path) && f.content.length <= 400_000);
  const { kind, reason } = detectRepoKind(manifests, sources);
  if (kind === 'library') notes.push(`Library/SDK layout detected (${reason}): call sites are most likely pass-through wrappers where the caller chooses the model and prompt, so findings are downgraded one level and the estimate is discounted.`);

  const promptLibrary: { file: string; line: number; tokens: number }[] = [];
  const repoCaches = sources.some(f => /cache_control|cacheControl|prompt_cache_key|promptCacheKey|cachedContent|cached_content/.test(f.content));
  const PROMPT_FILE = /(^|\/)[^/]*(prompt|instruction|template|persona)s?[^/]*\.[a-z]+$|(^|\/)prompts?\//i;
  const PROMPT_NAME = /\b[\w.]*(prompt|system|instruction|template|persona)\w*\s*(:\s*[\w[\]|. ]+)?\s*[:=]\s*(f|r|rf|fr|b)?$/i;

  for (const f of sources) {
    const src = f.content, lines = src.split('\n');
    const { masked, literals } = lex(src, f.path);
    for (const l of literals) {
      if (!promptLike(l.text)) continue;
      const tokens = countTokens(l.text);
      if (tokens < 300) continue;
      const lead = (masked[l.line - 1] ?? '').slice(0, Math.max(0, (masked[l.line - 1] ?? '').search(/["'`]|$/))).trimEnd();
      if (PROMPT_FILE.test(f.path) || PROMPT_NAME.test(lead) || PROMPT_NAME.test((masked[l.line - 2] ?? '').trimEnd())) promptLibrary.push({ file: f.path, line: l.line, tokens });
    }
    const hasCacheControl = /cache_control|cacheControl|prompt_cache_key|promptCacheKey|cachedContent|cached_content/.test(src);
    const illustrative = EXAMPLE_PATH.test(f.path);
    let repeatFlagged = false;

    masked.forEach((code, i) => {
      const sdk = CALL_RE.find(([re]) => re.test(code))?.[1];
      if (!sdk) return;
      const local: Finding[] = [];
      const push = (fd: Finding) => {
        let sev = fd.severity;
        if (kind === 'library') sev = DOWN[sev];
        if (illustrative) sev = DOWN[sev];
        local.push({ ...fd, severity: sev });
      };
      const window = lines.slice(i, Math.min(lines.length, i + 30)).join('\n');
      const model = [...window.matchAll(MODEL_RE)].map(m => m[1])[0] ?? null;
      callSites.push({ file: f.path, line: i + 1, model, sdk });
      if (model) models[model] = (models[model] ?? 0) + 1;
      const key = normalizeModel(model);
      const price = key ? priceFor(key) : null;
      const near = literals.filter(l => l.line >= i + 1 - 40 && l.line <= i + 1 + 40);
      const prompts = near.filter(l => promptLike(l.text));
      const codeCtx = masked.slice(Math.max(0, i - 25), i + 25).join('\n');
      const simpleTask = near.some(l => SIMPLE_TASK.test(l.text));
      const isAnthropic = sdk.includes('anthropic') || (model?.startsWith('claude') ?? false);

      // 1. Large static prompt with no caching directive.
      const bigTok = prompts.reduce((a, l) => a + countTokens(l.text), 0);
      if (bigTok >= 300 && !hasCacheControl) {
        const readRate = price?.cachedInput != null && price.input ? Math.round((1 - price.cachedInput / price.input) * 100) : 90;
        const min = price?.minCacheTokens ?? 1024;
        const cacheable = bigTok >= min || (isAnthropic && bigTok >= 512);
        push({
          severity: isAnthropic ? (bigTok >= 1500 ? 'high' : cacheable ? 'medium' : 'low') : (cacheable ? 'medium' : 'low'), file: f.path, line: prompts[0].line,
          title: `~${bigTok.toLocaleString()} static prompt tokens re-billed at full price on every call`,
          detail: isAnthropic
            ? `This call sends a large fixed prompt but never marks a cache breakpoint, so Anthropic bills all ${bigTok} tokens at the full input rate each time instead of the cache-read rate (${readRate}% cheaper).`
            : `A fixed prefix of ~${bigTok} tokens is sent on every call. Prefix caching applies only to stable prefixes of at least ${min} tokens on this model; keep the static part first and nothing volatile (timestamps, ids) interpolated into it.`,
          fix: isAnthropic
            ? 'Route through TokenZero (breakpoints are injected automatically) or add `cache_control: {type: "ephemeral"}` to the last system block and the last tool.'
            : 'Route through TokenZero to get a stable `prompt_cache_key`, or move dynamic content below the static prefix and set `prompt_cache_key` yourself.',
          // OpenAI/Gemini already cache stable prefixes automatically; the recoverable part
          // is prefix hygiene and cache routing, not the whole cache discount.
          est_savings_pct: !cacheable ? 0 : isAnthropic ? Math.min(85, Math.round((bigTok / (bigTok + 400)) * readRate)) : 15,
        });
      }

      // 2. Frontier model on a task whose prompt reads like extraction/classification.
      if (key && price?.tier === 'frontier' && CASCADE_TARGET[key] && simpleTask) {
        const to = CASCADE_TARGET[key];
        const a = costOf(key, { input: 1500, output: 200 })!, b = costOf(to, { input: 1500, output: 200 })!;
        push({
          severity: 'high', file: f.path, line: i + 1,
          title: `${key} used for a task whose prompt reads like extraction/classification`,
          detail: `Frontier pricing ($${price.input}/M in, $${price.output}/M out) on a constrained task. ${to} costs ~${Math.round((1 - b / a) * 100)}% less per call at this shape.`,
          fix: `Opt into TokenZero cascade routing (\`X-TokenZero-Cascade: auto\`) so this call is routed to ${to} only when the classifier is confident, with parity reported in the ledger, or switch the model here behind an eval.`,
          est_savings_pct: Math.round((1 - b / a) * 100),
        });
      }

      // 3. Call inside a loop (code only; strings and comments ignored).
      const above = masked.slice(Math.max(0, i - 6), i).join('\n');
      if (/^\s*(for|while)\b|\.map\(|\.forEach\(|asyncio\.gather|Promise\.all/m.test(above) && !/batch/i.test(codeCtx)) {
        push({
          severity: 'medium', file: f.path, line: i + 1,
          title: 'LLM call inside a loop',
          detail: 'Per-item calls repeat the full prompt prefix for every element. If items are independent and latency-tolerant, the provider Batch API is 50% cheaper; if the prefix is shared, caching pays off immediately.',
          fix: 'Batch where possible; otherwise keep the shared prefix cache-formatted (TokenZero does this automatically).',
          est_savings_pct: 25,
        });
      }

      // 4. Repeat-prone task with no cache opt-in (once per file, informational).
      // Current reasoning models reject non-default temperature and Anthropic's
      // current API rejects sampling parameters, so temperature is never the advice.
      if (simpleTask && !repeatFlagged && !/seed\s*[:=]|temperature\s*[:=]\s*0\b/.test(codeCtx)) {
        repeatFlagged = true;
        push({
          severity: 'info', file: f.path, line: i + 1,
          title: 'Repeat-prone task with no response-cache opt-in',
          detail: 'Classification and extraction calls often see identical inputs. Without a determinism signal no proxy can safely serve repeats from cache.',
          fix: 'If identical inputs should get identical answers, send `X-TokenZero-Cache: always` on these calls (or `temperature: 0` / a `seed` on models that still accept them). Repeats are then served in <10 ms at $0.',
          est_savings_pct: 10,
        });
      }

      // 5. Anthropic tools without a breakpoint.
      if (isAnthropic && /\btools\s*[:=]/.test(masked.slice(i, i + 30).join('\n')) && !hasCacheControl) {
        push({
          severity: 'low', file: f.path, line: i + 1,
          title: 'Tool definitions sent without a cache breakpoint',
          detail: 'Tool schemas render before the system prompt in the cached prefix. Without a breakpoint on the last tool they are billed in full on every call.',
          fix: 'TokenZero marks the last tool automatically; manually, add `cache_control` to the last tool definition.',
          est_savings_pct: 8,
        });
      }

      // 6. Unpriced or retired model ids: once per id per report.
      if (model && !key && !unknownModels.has(model)) {
        unknownModels.add(model);
        push({ severity: 'info', file: f.path, line: i + 1, title: `Unrecognised model id "${model}"`, detail: 'Not in the current pricing table: it may be retired or renamed. Retired models return errors or are silently remapped by some providers.', fix: 'Check the provider model list; TokenZero flags unpriced models in `X-TokenZero-Warning`.', est_savings_pct: 0 });
      }

      findings.push(...local);
      siteFindings.push(local);
    });
  }

  // Repo-level: large prompt templates defined away from the call sites, with no caching
  // directive anywhere. Systemic, so it applies to every call site in the estimate.
  const libTokens = promptLibrary.reduce((a, p) => a + p.tokens, 0);
  if (callSites.length && !repoCaches && libTokens >= 1024 && !findings.some(f => /static prompt tokens/.test(f.title))) {
    const anth = callSites.filter(c => c.sdk.includes('anthropic') || c.model?.startsWith('claude')).length;
    const anthropicHeavy = anth * 2 >= callSites.length;
    const top = promptLibrary.slice().sort((a, b) => b.tokens - a.tokens)[0];
    const sev: Finding['severity'] = anthropicHeavy ? (libTokens >= 3000 ? 'high' : 'medium') : 'medium';
    const fd: Finding = {
      severity: kind === 'library' ? DOWN[sev] : sev, file: top.file, line: top.line,
      title: `${promptLibrary.length} static prompt template(s), ~${libTokens.toLocaleString()} tokens, and no caching directive anywhere in the repo`,
      detail: anthropicHeavy
        ? 'Most call sites use Anthropic, which only discounts cached input when the request marks a cache breakpoint. None of these prompts can be served from cache as written, so every call pays the full input rate for them.'
        : 'Most call sites use providers with automatic prefix caching, which only pays off when these templates are sent as a byte-identical prefix: static template first, nothing volatile (dates, ids, user data) interpolated into it.',
      fix: anthropicHeavy
        ? 'Route through TokenZero (breakpoints are injected on tools and system automatically) or add `cache_control: {type: "ephemeral"}` after each static template.'
        : 'Keep templates first and static; TokenZero adds a stable `prompt_cache_key` so related requests land on the same cache.',
      est_savings_pct: anthropicHeavy ? Math.min(70, Math.round((libTokens / (libTokens + 2000)) * 85)) : 12,
    };
    findings.push(fd);
    for (const site of siteFindings) site.push(fd);
  }

  // Estimate: compound each call site's own findings, average over ALL call sites
  // (clean sites count as 0), discount libraries, cap at a believable ceiling.
  const weight = { high: 1, medium: 0.6, low: 0.3, info: 0 } as const;
  const perSite = siteFindings.map(fs => 1 - fs.reduce((rem, f) => rem * (1 - (f.est_savings_pct / 100) * weight[f.severity]), 1));
  let waste = perSite.length ? perSite.reduce((a, b) => a + b, 0) / perSite.length : 0;
  if (kind === 'library') waste *= 0.3;
  const wastePct = Math.round(Math.min(0.7, waste) * 100);
  if (!callSites.length) notes.push('No recognised LLM call sites (OpenAI, Anthropic, Gemini, Vercel AI SDK, LangChain, LiteLLM). Calls behind custom wrappers are not detected.');

  const topModel = Object.entries(models).sort((a, b) => b[1] - a[1]).map(([m]) => normalizeModel(m)).find(Boolean) ?? null;
  let cost: AuditReport['cost_per_10k_runs'] = null;
  if (topModel && PRICES[topModel]) {
    const assumed = 2000;
    const before = costOf(topModel, { input: assumed, output: 300 })! * 10_000;
    cost = { model: topModel, assumed_prompt_tokens: assumed, before_usd: Math.round(before * 100) / 100, after_usd: Math.round(before * (1 - wastePct / 100) * 100) / 100 };
  }
  const order = { high: 0, medium: 1, low: 2, info: 3 } as const;
  findings.sort((a, b) => order[a.severity] - order[b.severity] || b.est_savings_pct - a.est_savings_pct);
  const id = 'aud_' + crypto.randomBytes(16).toString('base64url');
  return { id, repo, method: 'static heuristics', repo_kind: kind, notes, scanned_files: sources.length, call_sites: callSites, models, findings, estimated_waste_pct: wastePct, cost_per_10k_runs: cost, badge_url: null, generated_at: new Date().toISOString() };
}

/** Turn a unified diff into per-file "added lines" sources so the analyzer only sees what the PR introduces. */
export function filesFromDiff(diff: string): SourceFile[] {
  const files: SourceFile[] = [];
  let cur: SourceFile | null = null;
  for (const line of diff.split('\n')) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m) { cur = { path: m[1], content: '' }; files.push(cur); continue; }
    if (!cur) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) cur.content += line.slice(1) + '\n';
    else if (line.startsWith(' ')) cur.content += line.slice(1) + '\n';   // context lines keep surrounding structure
    else if (line.startsWith('@@')) cur.content += '\n';
  }
  return files;
}

export const PR_COMMENT_MARKER = '<!-- tokenzero-cost-check -->';
const PUBLIC_REPO = 'https://github.com/tokenzero-ai/tokenzero';

/**
 * Make repo-controlled text inert in markdown. Only file paths (rendered as code spans
 * via `code`) and manifest-derived notes come from the audited repo; our own titles,
 * details and fixes interpolate nothing but model ids matched by [\w.-]+.
 */
const inert = (t: string) => t.replace(/[\\`*_[\]<>|]/g, c => '\\' + c).replace(/\r?\n/g, ' ');
const pipeSafe = (t: string) => t.replace(/\|/g, '\\|');
// GFM splits table cells on '|' even inside code spans, so it must be escaped there too.
const code = (t: string) => '`' + t.replace(/`/g, "'").replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 200) + '`';

/**
 * Markdown for a PR comment. `gatewayUrl` (a gateway we run) adds the one-line fix and,
 * with `hostedReport`, a link to the stored report; without it the comment links only to
 * the public tools repo, never to a host we have not verified.
 */
export function prComment(report: AuditReport, opts: { gatewayUrl?: string | null; hostedReport?: boolean } = {}): string {
  const c = report.cost_per_10k_runs;
  const head = c
    ? `**TokenZero cost check:** estimated cost per 10k runs ${code('$' + c.before_usd)} → ${code('$' + c.after_usd)} (${report.estimated_waste_pct}% recoverable) on ${code(c.model)}`
    : `**TokenZero cost check:** ${report.findings.length} finding(s), ${report.call_sites.length} LLM call site(s)`;
  const rows = report.findings.slice(0, 8).map(f => `| ${f.severity} | ${code(`${f.file}:${f.line}`)} | ${pipeSafe(f.title)} | ${f.est_savings_pct}% |`).join('\n');
  const g = opts.gatewayUrl?.replace(/\/+$/, '');
  const fix = g
    ? `One-line fix for everything above: point your SDK at ${code(g + '/v1')} (BYOK; your keys pass straight through).${opts.hostedReport ? ` [Full report](${g}/audit/${report.id})` : ''}`
    : `How to fix: route calls through the TokenZero gateway, or apply the fixes above by hand. [TokenZero tools](${PUBLIC_REPO})`;
  return [
    PR_COMMENT_MARKER,
    head, '',
    report.findings.length ? '| severity | where | finding | est. savings |\n|---|---|---|---|\n' + rows : '_No token-waste patterns found in the changed lines._',
    '', report.findings.slice(0, 3).map(f => `<details><summary>${f.title}</summary>\n\n${f.detail}\n\n**Fix:** ${f.fix}\n</details>`).join('\n'),
    '', fix,
    ...report.notes.map(n => `> ${inert(n)}`),
    '', '<sub>Static heuristics at list prices, not measurements. Verified numbers come from the signed ledger once traffic flows.</sub>',
  ].join('\n');
}

