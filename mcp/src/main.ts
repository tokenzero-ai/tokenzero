// @tokenzero/mcp: a stdio MCP server for coding agents (Claude Code, Cursor,
// Windsurf, Cline). Newline-delimited JSON-RPC 2.0 on stdin/stdout; logs go to
// stderr only.
//
//   audit_repo_token_waste     local: scans a directory on this machine (nothing
//                              uploaded) or a public GitHub repo (read-only fetch)
//   calculate_model_arbitrage  local: versioned list-price table
//   optimize_prompt_payload    hosted: sends the request body you pass to the
//                              TokenZero service, which owns the cache formatter
import path from 'node:path';
import readline from 'node:readline';
import { analyzeFiles, filesFromDiff } from '../../src/audit-core.ts';
import { fetchRepoFiles } from '../../src/github-fetch.ts';
import { modelArbitrage } from '../../src/arbitrage.ts';
import { MCP_LEGACY_VERSIONS, RPC, isModern, requestedVersion, versionSupported, unsupportedVersionError, modernResult, discoverResult } from '../../src/mcp-protocol.ts';
import { walk, manifests } from '../../cli/src/scan.ts';

const VERSION = '0.2.11';
declare const __TOKENZERO_BAKED__: string | undefined;
// Set at build time by scripts/bake-default-url.sh (only after the URL is proven to be our
// gateway); otherwise a placeholder the gateway replaces when it serves the bundle.
const BAKED_URL = typeof __TOKENZERO_BAKED__ === 'string' ? __TOKENZERO_BAKED__ : '__TOKENZERO_DEFAULT_URL__';
const SUPPORTED = [...MCP_LEGACY_VERSIONS];
const SERVER = { name: 'tokenzero', version: VERSION };
const CAPABILITIES = { tools: { listChanged: false }, prompts: { listChanged: false } };
// Slash-command entry points (same names as the hosted server); the local audit scans this machine, nothing uploaded.
const PROMPTS = [
  { name: 'cut-my-llm-bill', title: 'Cut my LLM bill', description: 'Find token waste in this project (scanned locally, nothing uploaded) and show the top fixes with estimated savings. No API key needed.', arguments: [{ name: 'repo', description: 'owner/name of a public GitHub repo instead of the local project', required: false }] },
  { name: 'price-my-workload', title: 'Price my LLM workload', description: 'Price a workload across models at list prices, with the cheaper sibling and the effect of prompt caching. No API key needed.', arguments: [{ name: 'model', description: 'model id, e.g. gpt-6.1-sol or claude-sonnet-5-5', required: true }, { name: 'requests_per_month', description: 'monthly request volume (default 10000)', required: false }] },
  { name: 'try-tokenzero', title: 'Try TokenZero on one call', description: 'Run one priced call through TokenZero with no key or setup and show the saving and its signed receipt.', arguments: [] },
];
function promptMessages(name: string, args: any = {}) {
  const p = PROMPTS.find(x => x.name === name);
  if (!p) throw new Error(`unknown prompt ${name}; available: ${PROMPTS.map(x => x.name).join(', ')}`);
  const say = (text: string) => ({ description: p.description, messages: [{ role: 'user', content: { type: 'text', text } }] });
  const repo = typeof args?.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(args.repo.trim()) ? args.repo.trim() : '';
  if (name === 'cut-my-llm-bill') return say(`Use the TokenZero MCP tools to find where this project wastes LLM tokens. Call audit_repo_token_waste with ${repo ? `repo "${repo}"` : 'path "." (it scans this machine; nothing is uploaded)'}. Then list the top 3 findings with file:line, the estimated saving and the fix, and finish with the one-line change that applies the fixes automatically (base_url ${serviceUrl() || "https://api.tokenzero.sh"}/v1, my provider key stays mine). If nothing calls an LLM here, call try_tokenzero instead and show what it measured.`);
  if (name === 'price-my-workload') { const model = typeof args?.model === 'string' && args.model.trim() ? args.model.trim().slice(0, 80) : 'gpt-6.1-sol'; const n = Number(args?.requests_per_month) > 0 ? Math.min(1e9, Math.round(Number(args.requests_per_month))) : 10000; return say(`Call the TokenZero tool calculate_model_arbitrage with {"model": "${model}", "requests_per_month": ${n}}. Show the monthly cost on ${model}, on its cheaper sibling, and with prompt caching, as a short table, then one sentence on which change saves the most.`); }
  return say('Call the TokenZero tool try_tokenzero with no arguments. Show what happened, the saving it measured, and the signed receipt id, then the keyless curl it returns so I can try a real call.');
}
const INSTRUCTIONS = 'Start with try_tokenzero (no key, no setup). Use provision_workspace to create a TokenZero workspace and key with no form; audit_repo_token_waste to find LLM cost waste in the current project (local, nothing uploaded), calculate_model_arbitrage to price model alternatives, optimize_prompt_payload to make a request body cache-friendly.';
const serviceUrl = () => (process.env.TOKENZERO_URL || (BAKED_URL.startsWith('http') ? BAKED_URL : '')).replace(/\/+$/, '');

const TOOLS = [
  {
    name: 'try_tokenzero',
    title: 'Try TokenZero (no key needed)',
    annotations: { title: 'Try TokenZero (no key needed)', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: 'Call this first: no API key, no signup, no setup. Shows what TokenZero would do to one of your LLM calls: it runs the four savings engines (prompt-cache formatting, edge cache, cascade advice, signed receipt) on a sample or your own prompt and model, and returns the list-price saving, the signed receipt and a copy-paste keyless curl that makes a real call on a free model. Pass {} for the default, or {"model": "gpt-6.1-sol", "system": "...", "prompt": "..."}. Runs in the TokenZero service; send no secrets in the prompt.',
    inputSchema: { type: 'object', properties: { model: { type: 'string', description: 'a priced model id; default gpt-6.1-sol' }, system: { type: 'string', description: 'your system prompt (optional)' }, prompt: { type: 'string', description: 'your user message (optional)' } }, additionalProperties: false },
  },
  {
    name: 'audit_repo_token_waste',
    title: 'Audit a repo or directory for LLM token waste',
    annotations: { title: 'Audit a repo or directory for LLM token waste', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'No API key needed. Static audit for LLM token waste: uncached static prompts and prompt templates, frontier models on extraction/classification prompts, calls in loops, unpriced models, and prompt-caching mis-integration (caching gated on model names, volatile values in the system prompt, random ids in history, wrong-provider cache markers, misplaced breakpoints, cost math that ignores cached tokens). Give `path` for a local directory (scanned on this machine, nothing uploaded; defaults to the working directory), `repo` (owner/name) for a public GitHub repo, or `diff` for a unified diff. Results are static heuristics, not measurements.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'local directory; defaults to the current working directory' }, repo: { type: 'string', description: 'public GitHub owner/name' }, diff: { type: 'string', description: 'unified diff text, e.g. from git diff' } }, additionalProperties: false },
  },
  {
    name: 'calculate_model_arbitrage',
    title: 'Price a workload across models',
    annotations: { title: 'Price a workload across models', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: `No API key needed; only \`model\` is required (defaults 2,000 tokens in and 400 out). Price a workload at list prices for the requested model, its cheaper sibling and any extra models, with and without prompt caching. Runs locally.`,
    inputSchema: { type: 'object', properties: { model: { type: 'string', description: 'model id, e.g. gpt-6.1-sol or claude-sonnet-5-5' }, input_tokens: { type: 'number', description: 'per request; default 2000' }, output_tokens: { type: 'number', description: 'per request; default 400' }, requests_per_month: { type: 'number' }, static_tokens: { type: 'number', description: 'portion of input_tokens that is a fixed prefix (system + tools)' }, compare_to: { type: 'array', items: { type: 'string' } } }, required: ['model'], additionalProperties: false },
  },
  {
    name: 'optimize_prompt_payload',
    title: 'Make a request body cache-friendly',
    annotations: { title: 'Make a request body cache-friendly', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Rewrite an OpenAI Chat/Responses or Anthropic Messages request body so its static prefix is provider-cacheable, and project the saving. Sends the body you pass to the TokenZero service (set TOKENZERO_URL); do not pass secrets in it.',
    inputSchema: { type: 'object', properties: { body: { type: 'object' }, endpoint: { type: 'string', enum: ['/v1/chat/completions', '/v1/responses', '/v1/messages'] }, strategy: { type: 'string', enum: ['static', 'conversation'] } }, required: ['body'], additionalProperties: false },
  },
  {
    name: 'workspace_metrics',
    title: 'Read a workspace savings scorecard',
    annotations: { title: 'Read a workspace savings scorecard', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Live value scorecard for a TokenZero workspace (GET /v1/workspaces/me/metrics): hard savings and net ROI per window, per-engine contribution, speed, parity, availability, privacy posture, per-model breakdown and one-click recommendations. Uses TOKENZERO_KEY unless a key is given; demo: true returns a labelled sample.',
    inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'workspace key (tz_live_…); defaults to TOKENZERO_KEY' }, window: { type: 'string', enum: ['24h', '7d', '30d', 'all'] }, demo: { type: 'boolean' } } },
  },
  {
    name: 'provision_workspace',
    title: 'Create a free TokenZero workspace',
    annotations: { title: 'Create a free TokenZero workspace', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Create a TokenZero workspace and key with no form (POST /v1/workspaces on the TokenZero service). Returns the key once, the base URLs that route through it, the one-click dashboard link (key in the URL fragment, never sent to the server) and the badge URL. Free up to the monthly free tier; nothing is billed.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'workspace name (defaults to "mcp-agent")' } }, additionalProperties: false },
  },
];

async function callTool(name: string, args: any): Promise<unknown> {
  switch (name) {
    case 'audit_repo_token_waste': {
      if (args?.diff) return analyzeFiles(filesFromDiff(String(args.diff)), null);
      if (args?.repo) {
        const repo = String(args.repo).replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
        const { files, manifests: m } = await fetchRepoFiles(repo, { token: process.env.GITHUB_TOKEN });
        return analyzeFiles(files, repo, m);
      }
      const root = path.resolve(args?.path ?? process.cwd());
      return analyzeFiles(walk(root), null, manifests(root));
    }
    case 'calculate_model_arbitrage': return modelArbitrage(args);
    case 'try_tokenzero':
    case 'optimize_prompt_payload': {
      const base = serviceUrl();
      if (!base) throw new Error('set TOKENZERO_URL to use this tool (the cache formatter runs in the TokenZero service)');
      const r = await fetch(base + '/mcp', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { 'content-type': 'application/json', 'user-agent': `tokenzero-mcp/${VERSION}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
        .catch((e: any) => { throw new Error(`could not reach the TokenZero service at ${base} (${e?.cause?.code ?? e?.message ?? e}); set TOKENZERO_URL to use a different one`); });
      if (r.status >= 300 && r.status < 400) throw new Error(`${base} is not publicly reachable yet (redirected)`);
      const j: any = await r.json();
      if (j.error) throw new Error(j.error.message);
      if (j.result?.isError) throw new Error(j.result.content?.[0]?.text ?? 'remote tool error');
      return j.result?.structuredContent ?? j.result;
    }
    case 'workspace_metrics': {
      const base = serviceUrl();
      if (!base) throw new Error('set TOKENZERO_URL to use this tool');
      const key = typeof args?.key === 'string' && args.key.trim() ? args.key.trim() : (process.env.TOKENZERO_KEY ?? '');
      const demo = args?.demo === true || !key;
      const w = ['24h', '7d', '30d', 'all'].includes(args?.window) ? args.window : '30d';
      const r = await fetch(`${base}/v1/workspaces/me/metrics?${demo ? 'demo=1' : `window=${w}`}`, { redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { 'user-agent': `tokenzero-mcp/${VERSION}`, ...(demo ? {} : { 'x-tokenzero-key': key }) } })
        .catch((e: any) => { throw new Error(`could not reach the TokenZero service at ${base} (${e?.cause?.code ?? e?.message ?? e})`); });
      const j: any = await r.json();
      if (r.status !== 200) throw new Error(j?.error?.message ?? `HTTP ${r.status}`);
      return demo && !args?.demo ? { ...j, note: (j.note ? j.note + ' ' : '') + 'No key was given and TOKENZERO_KEY is unset, so this is the sample scorecard.' } : j;
    }
    case 'provision_workspace': {
      const base = serviceUrl();
      if (!base) throw new Error('set TOKENZERO_URL to use this tool (workspaces live in the TokenZero service)');
      const wsName = typeof args?.name === 'string' && args.name.trim() ? args.name.trim().slice(0, 64) : 'mcp-agent';
      const r = await fetch(base + '/v1/workspaces', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json', 'user-agent': `tokenzero-mcp/${VERSION}` }, body: JSON.stringify({ name: wsName }) })
        .catch((e: any) => { throw new Error(`could not reach the TokenZero service at ${base} (${e?.cause?.code ?? e?.message ?? e}); set TOKENZERO_URL to use a different one`); });
      if (r.status >= 300 && r.status < 400) throw new Error(`${base} is not publicly reachable yet (redirected)`);
      const j: any = await r.json();
      if (r.status !== 201) throw new Error(j?.error?.message ?? `HTTP ${r.status}`);
      const id: string = j.workspace.id, key: string = j.key;
      return { workspace_id: id, name: wsName, api_key: key, url: base, openai_base_url: `${base}/w/${key}/v1`, anthropic_base_url: `${base}/w/${key}`, gemini_native_base_url: `${base}/w/${key}`,
        dashboard_url: `${base}/dashboard?workspace=${id}`, one_click_dashboard_url: `${base}/dashboard?workspace=${id}#key=${key}`, mcp_url: `${base}/mcp`, badge_svg_url: `${base}/v1/badge/${id}.svg`,
        note: 'Store the key where secrets live (env or a secrets manager), never in the repository. Free up to the monthly free tier; nothing is billed.' };
    }
    default: throw new Error(`unknown tool ${name}`);
  }
}

const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(m: any) {
  const isRequest = m && m.id !== undefined && m.id !== null && typeof m.method === 'string';
  const reply = (result: unknown) => isRequest && send({ jsonrpc: '2.0', id: m.id, result });
  const fail = (code: number, message: string) => isRequest && send({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  const failData = (code: number, message: string, data: unknown) => isRequest && send({ jsonrpc: '2.0', id: m.id, error: { code, message, data } });
  const call = async () => {
    try { const r = await callTool(m.params?.name, m.params?.arguments ?? {}); return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], structuredContent: r, isError: false }; }
    catch (e: any) { return { content: [{ type: 'text', text: `error: ${e?.message ?? e}` }], isError: true }; }
  };
  try {
    if (isModern(m)) {
      // ---- 2026-07-28: no handshake; version and identity travel on every request ----
      const v = requestedVersion(m)!;
      if (!versionSupported(v)) { const e = unsupportedVersionError(v); return failData(e.code, e.message, e.data); }
      switch (m.method) {
        case 'server/discover': return reply(discoverResult(SERVER, CAPABILITIES, INSTRUCTIONS));
        case 'tools/list': return reply(modernResult({ tools: TOOLS }, SERVER, true));
        case 'prompts/list': return reply(modernResult({ prompts: PROMPTS }, SERVER, true));
        case 'prompts/get': return reply(modernResult(promptMessages(String(m.params?.name ?? ''), m.params?.arguments), SERVER));
        case 'tools/call': return reply(modernResult(await call(), SERVER));
        default:
          if (typeof m.method === 'string' && m.method.startsWith('notifications/')) return;
          return fail(RPC.methodNotFound, `method not found: ${m.method}`);
      }
    }
    switch (m?.method) {
      case 'initialize': {
        const want = m.params?.protocolVersion;
        return reply({ protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[0], capabilities: CAPABILITIES, serverInfo: SERVER, instructions: INSTRUCTIONS });
      }
      case 'ping': return reply({});
      // The stdio backward-compatibility probe: a dual-era client sends this first.
      case 'server/discover': return reply(discoverResult(SERVER, CAPABILITIES, INSTRUCTIONS));
      case 'tools/list': return reply({ tools: TOOLS });
      case 'prompts/list': return reply({ prompts: PROMPTS });
      case 'prompts/get': return reply(promptMessages(String(m.params?.name ?? ''), m.params?.arguments));
      case 'tools/call': return reply(await call());
      default:
        if (typeof m?.method === 'string' && m.method.startsWith('notifications/')) return;
        return fail(RPC.methodNotFound, `method not found: ${m?.method}`);
    }
  } catch (e: any) { fail(RPC.internal, e?.message ?? 'internal error'); }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', line => {
  const t = line.trim();
  if (!t) return;
  let msg: any;
  try { msg = JSON.parse(t); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
  for (const m of Array.isArray(msg) ? msg : [msg]) void handle(m);
});
process.stderr.write(`tokenzero-mcp ${VERSION} ready (stdio)\n`);
