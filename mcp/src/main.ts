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
import { PRICING_VERSION } from '../../src/pricing.ts';
import { MCP_LEGACY_VERSIONS, RPC, isModern, requestedVersion, versionSupported, unsupportedVersionError, modernResult, discoverResult } from '../../src/mcp-protocol.ts';
import { walk, manifests } from '../../cli/src/scan.ts';

const VERSION = '0.2.0';
declare const __TOKENZERO_BAKED__: string | undefined;
// Set at build time by scripts/bake-default-url.sh (only after the URL is proven to be our
// gateway); otherwise a placeholder the gateway replaces when it serves the bundle.
const BAKED_URL = typeof __TOKENZERO_BAKED__ === 'string' ? __TOKENZERO_BAKED__ : '__TOKENZERO_DEFAULT_URL__';
const SUPPORTED = [...MCP_LEGACY_VERSIONS];
const SERVER = { name: 'tokenzero', version: VERSION };
const CAPABILITIES = { tools: { listChanged: false } };
const INSTRUCTIONS = 'Use provision_workspace to create a TokenZero workspace and key with no form; audit_repo_token_waste to find LLM cost waste in the current project (local, nothing uploaded), calculate_model_arbitrage to price model alternatives, optimize_prompt_payload to make a request body cache-friendly.';
const serviceUrl = () => (process.env.TOKENZERO_URL || (BAKED_URL.startsWith('http') ? BAKED_URL : '')).replace(/\/+$/, '');

const TOOLS = [
  {
    name: 'audit_repo_token_waste',
    description: 'Static audit for LLM token waste: uncached static prompts and prompt templates, frontier models on extraction/classification prompts, calls in loops, unpriced models. Give `path` for a local directory (scanned on this machine, nothing uploaded; defaults to the working directory), `repo` (owner/name) for a public GitHub repo, or `diff` for a unified diff. Results are static heuristics, not measurements.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'local directory; defaults to the current working directory' }, repo: { type: 'string', description: 'public GitHub owner/name' }, diff: { type: 'string', description: 'unified diff text, e.g. from git diff' } }, additionalProperties: false },
  },
  {
    name: 'calculate_model_arbitrage',
    description: `Price a workload at list prices (table ${PRICING_VERSION}) for the requested model, its cheaper sibling and any extra models, with and without prompt caching. Runs locally.`,
    inputSchema: { type: 'object', properties: { model: { type: 'string' }, input_tokens: { type: 'number' }, output_tokens: { type: 'number' }, requests_per_month: { type: 'number' }, static_tokens: { type: 'number', description: 'portion of input_tokens that is a fixed prefix (system + tools)' }, compare_to: { type: 'array', items: { type: 'string' } } }, required: ['model', 'input_tokens', 'output_tokens'], additionalProperties: false },
  },
  {
    name: 'optimize_prompt_payload',
    description: 'Rewrite an OpenAI Chat/Responses or Anthropic Messages request body so its static prefix is provider-cacheable, and project the saving. Sends the body you pass to the TokenZero service (set TOKENZERO_URL); do not pass secrets in it.',
    inputSchema: { type: 'object', properties: { body: { type: 'object' }, endpoint: { type: 'string', enum: ['/v1/chat/completions', '/v1/responses', '/v1/messages'] }, strategy: { type: 'string', enum: ['static', 'conversation'] } }, required: ['body'], additionalProperties: false },
  },
  {
    name: 'provision_workspace',
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
