// TokenZero CLI.
//
//   tokenzero init     connect this project to the gateway (env vars only, no code changes)
//   tokenzero audit    local static token-waste audit; source never leaves the machine
//   tokenzero usage    this month's routed spend and savings for your workspace
//   tokenzero verify   check a savings receipt's Ed25519 signature offline
//
// Single file, no dependencies, Node >= 18.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { analyzeFiles, filesFromDiff, prComment, type AuditReport } from '../../src/audit-core.ts';
import { walk, manifests } from './scan.ts';
import { canonical } from '../../src/canonical.ts';

const VERSION = '0.2.0';
// Replaced when the bundle is served or published; unreplaced means "ask for --url".
declare const __TOKENZERO_BAKED__: string | undefined;
// Set at build time by scripts/bake-default-url.sh (only after the URL is proven to be our
// gateway); otherwise a placeholder the gateway replaces when it serves the bundle.
const BAKED_URL = typeof __TOKENZERO_BAKED__ === 'string' ? __TOKENZERO_BAKED__ : '__TOKENZERO_DEFAULT_URL__';

// ---- tiny arg parser --------------------------------------------------------
interface Args { _: string[]; flags: Record<string, string | boolean>; }
function parseArgs(argv: string[]): Args {
  const a: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--') { a._.push(...argv.slice(i + 1)); break; }
    if (t.startsWith('--')) {
      const [k, v] = t.slice(2).split('=', 2);
      if (v !== undefined) a.flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-') && VALUE_FLAGS.has(k)) a.flags[k] = argv[++i];
      else a.flags[k] = true;
    } else if (t === '-y') a.flags.yes = true;
    else a._.push(t);
  }
  return a;
}
const VALUE_FLAGS = new Set(['url', 'name', 'key', 'format', 'diff', 'fail-over', 'env-file', 'limit']);

// ---- output -----------------------------------------------------------------
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c('1'), dim = c('2'), green = c('32'), yellow = c('33'), red = c('31'), cyan = c('36');
const out = (s = '') => process.stdout.write(s + '\n');
const err = (s: string) => process.stderr.write(s + '\n');

function baseUrl(a: Args): string | null {
  const u = (a.flags.url as string) || process.env.TOKENZERO_URL || (BAKED_URL.startsWith('http') ? BAKED_URL : '');
  return u ? u.replace(/\/+$/, '') : null;
}

async function confirm(q: string, a: Args): Promise<boolean> {
  if (a.flags.yes) return true;
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`${q} ${dim('[y/N]')} `)).trim().toLowerCase();
  rl.close();
  return ans === 'y' || ans === 'yes';
}

async function api(base: string, p: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  let r: Response;
  try { r = await fetch(base + p, { ...init, redirect: 'manual', headers: { 'content-type': 'application/json', 'user-agent': `tokenzero-cli/${VERSION}`, ...(init.headers ?? {}) } }); }
  catch (e: any) { throw new Error(`cannot reach ${base}: ${e?.cause?.code ?? e?.message ?? e}`); }
  if (r.status >= 300 && r.status < 400) throw new Error(`${base} redirected (${r.status}) instead of answering; the gateway is not publicly reachable yet`);
  const text = await r.text();
  let body: any = text; try { body = JSON.parse(text); } catch { /* keep text */ }
  return { status: r.status, body };
}

interface Stack { lang: 'python' | 'node' | 'unknown'; sdks: string[]; }
function detectStack(root: string): Stack {
  const sdks = new Set<string>();
  let lang: Stack['lang'] = 'unknown';
  const read = (f: string) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };
  const pkg = read('package.json');
  if (pkg) {
    lang = 'node';
    try {
      const j = JSON.parse(pkg); const deps = { ...j.dependencies, ...j.devDependencies };
      if (deps.openai) sdks.add('openai');
      if (deps['@anthropic-ai/sdk']) sdks.add('anthropic');
      if (deps.ai || Object.keys(deps).some(d => d.startsWith('@ai-sdk/'))) sdks.add('vercel-ai');
      if (Object.keys(deps).some(d => d.startsWith('@langchain/') || d === 'langchain')) sdks.add('langchain');
      if (deps['@google/genai']) sdks.add('gemini');
    } catch { /* malformed package.json */ }
  }
  const py = read('requirements.txt') + read('pyproject.toml') + read('Pipfile') + read('setup.py');
  if (py) {
    if (lang === 'unknown') lang = 'python';
    if (/^\s*["']?openai\b/im.test(py)) sdks.add('openai');
    if (/^\s*["']?anthropic\b/im.test(py)) sdks.add('anthropic');
    if (/langchain/i.test(py)) sdks.add('langchain');
    if (/litellm/i.test(py)) sdks.add('litellm');
    if (/google-genai|google-generativeai/i.test(py)) sdks.add('gemini');
  }
  return { lang, sdks: [...sdks] };
}

// ---- .env handling ----------------------------------------------------------
const ENV_KEYS = ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'TOKENZERO_URL', 'TOKENZERO_KEY'] as const;

function planEnv(file: string, wanted: Record<string, string>) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const current: Record<string, string> = {};
  for (const line of existing.split('\n')) { const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line); if (m) current[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  const add: string[] = [], conflicts: string[] = [];
  for (const [k, v] of Object.entries(wanted)) {
    if (!(k in current)) add.push(`${k}=${v}`);
    else if (current[k] !== v) conflicts.push(k);
  }
  return { existing, add, conflicts, exists: !!existing };
}

function gitignored(root: string, name: string): boolean {
  try { return fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n').some(l => { const t = l.trim(); return t === name || t === '/' + name || t === name + '*' || t === '.env*' || t === '*.env'; }); } catch { return false; }
}

// ---- commands ---------------------------------------------------------------
function summarize(r: AuditReport, limit = 5) {
  out(`${bold('Audit')} ${dim('(static heuristics, local only: no source left this machine)')}`);
  out(`  ${r.scanned_files} files · ${r.call_sites.length} LLM call site(s) · ${r.findings.length} finding(s) · repo looks like: ${r.repo_kind}`);
  for (const n of r.notes) out(dim(`  note: ${n}`));
  if (r.cost_per_10k_runs) out(`  est. cost per 10k runs on ${r.cost_per_10k_runs.model}: $${r.cost_per_10k_runs.before_usd} → ${green('$' + r.cost_per_10k_runs.after_usd)} (~${r.estimated_waste_pct}% recoverable)`);
  for (const f of r.findings.slice(0, limit)) {
    const sev = f.severity === 'high' ? red(f.severity) : f.severity === 'medium' ? yellow(f.severity) : dim(f.severity);
    out(`  ${sev.padEnd(tty ? 15 : 6)} ${cyan(f.file + ':' + f.line)}  ${f.title}`);
  }
  if (r.findings.length > limit) out(dim(`  … ${r.findings.length - limit} more (run the audit command for the full list)`));
}

function snippet(sdk: string, lang: Stack['lang']): string | null {
  const py = lang === 'python';
  switch (sdk) {
    case 'openai': return py ? 'OpenAI()            # reads OPENAI_BASE_URL; no code change' : 'new OpenAI()        // reads OPENAI_BASE_URL; no code change';
    case 'anthropic': return py ? 'Anthropic()         # reads ANTHROPIC_BASE_URL; no code change' : 'new Anthropic()     // reads ANTHROPIC_BASE_URL; no code change';
    case 'vercel-ai': return 'createOpenAI({ baseURL: process.env.OPENAI_BASE_URL }) / createAnthropic({ baseURL: process.env.ANTHROPIC_BASE_URL + "/v1" })';
    case 'langchain': return py ? 'ChatOpenAI(base_url=os.environ["OPENAI_BASE_URL"]) / ChatAnthropic(base_url=os.environ["ANTHROPIC_BASE_URL"])' : 'new ChatOpenAI({ configuration: { baseURL: process.env.OPENAI_BASE_URL } })';
    case 'litellm': return 'litellm reads OPENAI_BASE_URL / ANTHROPIC_BASE_URL (api_base) per provider';
    case 'gemini': return 'use the OpenAI SDK against OPENAI_BASE_URL with your Gemini key (AIza…)';
    default: return null;
  }
}

async function cmdInit(a: Args) {
  const root = path.resolve((a._[1] as string) ?? '.');
  const base = baseUrl(a);
  out(`${bold('TokenZero')} init ${dim('v' + VERSION)} in ${root}\n`);

  const stack = detectStack(root);
  out(`${bold('Project')}  ${stack.lang}${stack.sdks.length ? ' · ' + stack.sdks.join(', ') : dim(' · no LLM SDK found in manifests')}`);
  const report = analyzeFiles(walk(root), null, manifests(root));
  out(); summarize(report, 5); out();

  if (!base) { err(red('No gateway URL. Pass --url https://… or set TOKENZERO_URL.')); process.exitCode = 2; return; }

  // Workspace: created server-side; the key is shown once and written only where you agree.
  let key = (a.flags.key as string) || process.env.TOKENZERO_KEY || '';
  let wsId = '';
  if (!key) {
    try {
      const r = await api(base, '/v1/workspaces', { method: 'POST', body: JSON.stringify({ name: (a.flags.name as string) ?? path.basename(root) }) });
      if (r.status !== 201) throw new Error(`workspace creation failed (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
      key = r.body.key; wsId = r.body.workspace.id;
      out(`${bold('Workspace')} ${wsId} ${dim('created')}`);
      saveCreds({ workspace_id: wsId, api_key: key, url: base });
    } catch (e: any) {
      err(yellow(`! ${e.message}`));
      err(dim('  Continuing without a workspace key: requests will be grouped by an anonymous workspace derived from your provider key.'));
    }
  }

  const prefix = key ? `${base}/w/${key}` : base;
  const wanted: Record<string, string> = { OPENAI_BASE_URL: `${prefix}/v1`, ANTHROPIC_BASE_URL: prefix, TOKENZERO_URL: base };
  if (key) wanted.TOKENZERO_KEY = key;

  const envFile = path.join(root, (a.flags['env-file'] as string) ?? '.env');
  const plan = planEnv(envFile, wanted);
  out(`\n${bold('Environment')} ${dim('(your provider keys stay where they are; they pass through untouched)')}`);
  for (const k of ENV_KEYS) if (wanted[k]) out(`  ${k}=${k === 'TOKENZERO_KEY' || k.endsWith('BASE_URL') && key ? redactKey(wanted[k], key) : wanted[k]}`);
  if (plan.conflicts.length) out(yellow(`  ! ${path.basename(envFile)} already sets ${plan.conflicts.join(', ')} to other values; left unchanged`));

  if (a.flags['no-env']) out(dim(`  --no-env: add the lines above to your environment yourself.`));
  else if (plan.add.length && await confirm(`\nAppend ${plan.add.length} line(s) to ${path.relative(root, envFile) || '.env'}?`, a)) {
    const sep = plan.existing && !plan.existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(envFile, `${sep}\n# TokenZero (BYOK gateway): ${base}\n${plan.add.join('\n')}\n`, { mode: 0o600 });
    out(green(`  ✓ wrote ${path.relative(root, envFile) || '.env'}`));
    if (fs.existsSync(path.join(root, '.git')) && !gitignored(root, path.basename(envFile))) out(yellow(`  ! ${path.basename(envFile)} is not in .gitignore; it now holds your TokenZero key`));
  } else if (plan.add.length) out(dim('  not written; run with --yes to write, or copy the lines above.'));

  if (stack.sdks.length) {
    out(`\n${bold('Your code')}`);
    for (const s of stack.sdks) { const sn = snippet(s, stack.lang); if (sn) out(`  ${s.padEnd(10)} ${sn}`); }
  }

  if (a.flags.mcp) await setupMcp(root, base, a);
  if (a.flags['agent-rules']) await setupAgentRules(root, base, a);
  if (!a.flags['no-github-action'] && (a.flags['github-action'] || fs.existsSync(path.join(root, '.git')))) await setupGithubAction(root, a);

  out(`\n${bold('Next')}`);
  if (wsId) out(`  dashboard   ${base}/dashboard?workspace=${wsId}   ${dim('(one-click unlock link: ' + selfCmd(base) + ' dashboard)')}`);
  out(`  usage       ${selfCmd(base)} usage`);
  if (wsId) out(`  badge       turn on public stats in the dashboard, then: [![LLM spend verified by TokenZero](${base}/v1/badge/${wsId}.svg)](${base}/dashboard?workspace=${wsId})`);
  if (!a.flags.mcp) out(`  coding agents: ${selfCmd(base)} init --mcp`);
  if (!a.flags['agent-rules']) out(`  agent rules:   ${selfCmd(base)} init --agent-rules   ${dim('(AGENTS.md block for Claude Code / Cursor / Codex)')}`);
}

// Saved credentials (0600, outside the project): what `tokenzero dashboard` and `usage` fall back to
// when TOKENZERO_KEY is not set. Written by init and signup.
const credsPath = () => path.join(process.env.TOKENZERO_CONFIG_DIR || path.join(os.homedir(), '.config', 'tokenzero'), 'credentials.json');
function saveCreds(c: { workspace_id: string; api_key: string; url: string }) {
  try { const p = credsPath(); fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 }); fs.writeFileSync(p, JSON.stringify({ ...c, updated_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 }); }
  catch { /* read-only home: the key was printed or written to .env already */ }
}
function loadCreds(): { workspace_id?: string; api_key?: string; url?: string } | null {
  try { return JSON.parse(fs.readFileSync(credsPath(), 'utf8')); } catch { return null; }
}

/** One command, no form: create a workspace and print everything an agent or a human needs to use it. */
async function cmdSignup(a: Args) {
  const base = baseUrl(a);
  if (!base) { err(red('No gateway URL. Pass --url https://… or set TOKENZERO_URL.')); process.exitCode = 2; return; }
  const name = (a.flags.name as string) || path.basename(process.cwd()) || 'cli';
  const r = await api(base, '/v1/workspaces', { method: 'POST', body: JSON.stringify({ name }) });
  if (r.status !== 201) { err(red(`signup failed (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`)); process.exitCode = 1; return; }
  const wsId: string = r.body.workspace.id, key: string = r.body.key;
  saveCreds({ workspace_id: wsId, api_key: key, url: base });
  const payload = {
    workspace_id: wsId, api_key: key, url: base,
    dashboard_url: `${base}/dashboard?workspace=${wsId}`,
    one_click_dashboard_url: `${base}/dashboard?workspace=${wsId}#key=${key}`,
    openai_base_url: `${base}/w/${key}/v1`, anthropic_base_url: `${base}/w/${key}`, gemini_native_base_url: `${base}/w/${key}`,
    mcp_url: `${base}/mcp`, badge_svg_url: `${base}/v1/badge/${wsId}.svg`,
    credentials_file: credsPath(),
  };
  if (a.flags.json) { out(JSON.stringify(payload, null, 2)); return; }
  out(`${bold('Workspace')} ${wsId} ${dim('created · key shown once')}`);
  out(`  TOKENZERO_KEY        ${key}`);
  out(`  OPENAI_BASE_URL      ${payload.openai_base_url}`);
  out(`  ANTHROPIC_BASE_URL   ${payload.anthropic_base_url}`);
  out(`  dashboard            ${payload.one_click_dashboard_url}   ${dim('(the #key= part never leaves your browser)')}`);
  out(dim(`  saved to ${credsPath()} (0600); \`${selfCmd(base)} init\` writes the .env lines for a project`));
}

/** Print the one-click dashboard link for the saved (or given) key. The key rides in the URL fragment, which browsers never send. */
async function cmdDashboard(a: Args) {
  const saved = loadCreds();
  const base = baseUrl(a) || saved?.url || '';
  const key = (a.flags.key as string) || process.env.TOKENZERO_KEY || saved?.api_key || '';
  if (!base || !key) { err(red('No workspace key: run `' + selfCmd(base) + ' signup` or `init` first, or pass --url and --key.')); process.exitCode = 2; return; }
  let wsId = saved?.api_key === key ? saved?.workspace_id ?? '' : '';
  if (!wsId) { const r = await api(base, '/v1/workspaces/me', { headers: { 'x-tokenzero-key': key } }); if (r.status === 200) wsId = r.body.id; }
  if (!wsId) { err(red('That key does not unlock a workspace at ' + base)); process.exitCode = 1; return; }
  const url = `${base}/dashboard?workspace=${wsId}#key=${key}`;
  if (a.flags.json) { out(JSON.stringify({ workspace_id: wsId, dashboard_url: url }, null, 2)); return; }
  out(url);
}

const AGENT_RULES_MARKER = '<!-- tokenzero-agent-rules -->';
/** A short, accurate block for AGENTS.md so coding agents route through the gateway and audit before PRs. Never duplicated. */
async function setupAgentRules(root: string, base: string, a: Args) {
  out(`\n${bold('Agent rules')} ${dim('(AGENTS.md: read by Claude Code, Cursor, Codex, Windsurf)')}`);
  const file = path.join(root, 'AGENTS.md');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (existing.includes(AGENT_RULES_MARKER)) { out(dim('  AGENTS.md already has the TokenZero section')); return; }
  const block = [AGENT_RULES_MARKER, '## LLM cost (TokenZero)',
    `- LLM calls go through the TokenZero gateway: \`OPENAI_BASE_URL=${base}/w/<key>/v1\`, \`ANTHROPIC_BASE_URL=${base}/w/<key>\` (or send \`X-TokenZero-Key\`). Provider keys pass through untouched; never commit them.`,
    `- Before opening a PR that adds or changes an LLM call, run \`npx -y @tokenzero/cli audit\` (local, nothing uploaded) and fix medium/high findings: cache the static prefix, use the cheaper sibling for extraction/classification, batch calls in loops.`,
    `- Model choices: prefer ids the audit prices; retiring ids are flagged with their replacement. Price alternatives with the MCP tool \`calculate_model_arbitrage\` (\`npx -y @tokenzero/mcp\` or ${base}/mcp).`,
    `- Savings are verified: every routed request has a signed receipt (\`npx -y @tokenzero/cli verify <request_id>\`).`,
  ].join('\n') + '\n';
  if (!await confirm('  Add the TokenZero section to AGENTS.md?', a)) return;
  fs.writeFileSync(file, existing + (existing && !existing.endsWith('\n') ? '\n\n' : existing ? '\n' : '') + block);
  out(green(`  ✓ wrote ${path.relative(root, file)}`));
}

// How to re-invoke this CLI. The unscoped npm package name is owned by an
// unrelated publisher, so hints must never point at the bare name; the scoped
// package is the published one (the gateway-served tarball still works offline).
const selfCmd = (_base: string) => 'npx -y @tokenzero/cli';

const WORKFLOW = `name: TokenZero cost check
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  cost-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: tokenzero-ai/tokenzero/action@v0
        # with:
        #   fail-over: 30          # fail the check above 30% estimated recoverable waste
        #   comment-on-clean: true # also comment when the changes have no findings
`;
/** Offer the PR cost-check workflow to git repositories (or on --github-action); never overwrite. */
async function setupGithubAction(root: string, a: Args) {
  const file = path.join(root, '.github', 'workflows', 'tokenzero.yml');
  const rel = path.relative(root, file);
  out(`\n${bold('GitHub Action')} ${dim('(audits each PR on your runner; one comment kept up to date; no account, nothing uploaded)')}`);
  if (fs.existsSync(file)) { out(dim(`  ${rel} already exists; left unchanged`)); return; }
  if (!await confirm(`  Write ${rel}?`, a)) { out(dim('  skipped (--github-action to add later, --no-github-action to stop asking)')); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, WORKFLOW);
  out(green(`  ✓ wrote ${rel}`));
}

const redactKey = (s: string, key: string) => (key ? s.replace(key, key.slice(0, 12) + '…' + key.slice(-4)) : s);

async function setupMcp(root: string, base: string, a: Args) {
  out(`\n${bold('MCP')} ${dim('(audit_repo_token_waste, optimize_prompt_payload, calculate_model_arbitrage)')}`);
  out(`  Claude Code (hosted):  claude mcp add --transport http tokenzero ${base}/mcp`);
  out(`  Claude Code (local):   claude mcp add tokenzero -- npx -y @tokenzero/mcp`);
  // Project-level configs: .mcp.json at the root (Claude Code, shared with the team via git)
  // and .cursor/mcp.json (Cursor). Both point at the hosted HTTP server; existing entries are kept.
  for (const [label, file] of [['Claude Code', path.join(root, '.mcp.json')], ['Cursor', path.join(root, '.cursor', 'mcp.json')]] as const) {
    let cfg: any = {};
    if (fs.existsSync(file)) { try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { out(yellow(`  ! ${path.relative(root, file)} is not valid JSON; not touching it`)); continue; } }
    if (cfg?.mcpServers?.tokenzero?.url === `${base}/mcp`) { out(dim(`  ${label}: already configured`)); continue; }
    if (!await confirm(`  Add TokenZero to ${path.relative(root, file)} for ${label}?`, a)) continue;
    cfg.mcpServers = { ...(cfg.mcpServers ?? {}), tokenzero: label === 'Claude Code' ? { type: 'http', url: `${base}/mcp` } : { url: `${base}/mcp` } };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
    out(green(`  ✓ wrote ${path.relative(root, file)}`));
  }
}

async function cmdAudit(a: Args) {
  const root = path.resolve((a._[1] as string) ?? '.');
  let report: AuditReport;
  if (a.flags.diff) {
    const src = a.flags.diff === '-' || a.flags.diff === true ? fs.readFileSync(0, 'utf8') : fs.readFileSync(a.flags.diff as string, 'utf8');
    report = analyzeFiles(filesFromDiff(src), null);
  } else report = analyzeFiles(walk(root), null, manifests(root));

  const fmt = (a.flags.format as string) ?? (a.flags.json ? 'json' : 'text');
  if (fmt === 'json') out(JSON.stringify(report, null, 2));
  else if (fmt === 'markdown') out(prComment(report, { gatewayUrl: baseUrl(a) }));
  else {
    summarize(report, 100);
    for (const f of report.findings.slice(0, 3)) out(`\n${bold(f.title)}\n  ${f.detail}\n  ${green('fix:')} ${f.fix}`);
  }
  // CI gate: tokenzero audit --fail-over 30  → exit 1 when recoverable waste exceeds 30%.
  const gate = Number(a.flags['fail-over']);
  if (Number.isFinite(gate) && a.flags['fail-over'] !== undefined && report.estimated_waste_pct > gate) {
    err(red(`recoverable waste ${report.estimated_waste_pct}% exceeds --fail-over ${gate}%`));
    process.exitCode = 1;
  }
}

async function cmdDoctor(a: Args) {
  const saved = loadCreds(); const base = baseUrl(a) || saved?.url || 'https://tokenzero.sh'; const key = (a.flags.key as string) || process.env.TOKENZERO_KEY || saved?.api_key || '';
  const r = await api(base, '/v1/doctor', { headers: key ? { 'x-tokenzero-key': key } : {} });
  if (r.status !== 200) { err(red(`doctor: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)); process.exitCode = 1; return; }
  if (a.flags.json) { out(JSON.stringify(r.body, null, 2)); return; }
  const d = r.body;
  out(`${bold('tokenzero doctor')} · ${base} · gateway v${d.version} · ${d.authenticated ? 'workspace key accepted' : 'no workspace key (pass --key or set TOKENZERO_KEY for quota and settings checks)'}`);
  for (const c of d.checks) { const tag = c.status === 'pass' ? green('[PASS]') : c.status === 'warn' ? yellow('[WARN]') : dim('[INFO]'); out(`  ${tag} ${c.label}: ${c.detail}`); }
  out(dim(`  OPENAI_BASE_URL=${d.snippets.openai_base_url}`)); out(dim(`  ANTHROPIC_BASE_URL=${d.snippets.anthropic_base_url}`)); out(dim(`  dashboard: ${d.snippets.dashboard_url}`));
  if (!d.ok) { out(yellow(`  something needs attention; support: ${d.support.support_page} (${d.support.sla_target_response_minutes}-minute response target)`)); process.exitCode = 1; }
}

async function cmdUsage(a: Args) {
  const saved = loadCreds(); const base = baseUrl(a) || saved?.url || ''; const key = (a.flags.key as string) || process.env.TOKENZERO_KEY || saved?.api_key;
  if (!base || !key) { err(red('Need TOKENZERO_URL and TOKENZERO_KEY (run tokenzero init), or --url and --key.')); process.exitCode = 2; return; }
  const [u, s] = await Promise.all([api(base, '/v1/usage', { headers: { 'x-tokenzero-key': key } }), api(base, '/v1/ledger/stats', { headers: { 'x-tokenzero-key': key } })]);
  if (u.status !== 200) { err(red(`usage: ${u.status} ${JSON.stringify(u.body).slice(0, 200)}`)); process.exitCode = 1; return; }
  if (a.flags.json) { out(JSON.stringify({ usage: u.body, stats: s.body }, null, 2)); return; }
  const d = u.body;
  const barW = 30, filled = Math.round((d.free_tier_used_pct / 100) * barW);
  out(`${bold(d.workspace)} · ${d.month} · plan ${d.plan}`);
  out(`  routed spend  $${d.routed_usd.toFixed(2)} of $${d.free_tier_limit_usd} free  [${(d.free_tier_used_pct >= 80 ? yellow : green)('█'.repeat(filled))}${dim('░'.repeat(barW - filled))}] ${d.free_tier_used_pct}%`);
  out(`  actual spend  $${d.actual_usd.toFixed(2)}   saved ${green('$' + d.savings_usd.toFixed(2))}   requests ${d.requests}`);
  if (s.status === 200 && s.body.savings_pct != null) out(`  last 30 days  ${s.body.savings_pct}% saved · ${s.body.cache_hits} cache hits · projected $${s.body.projected_monthly_savings_usd.toFixed(2)}/mo`);
  if (d.engines_paused) out(yellow(`  engines paused: free tier reached; traffic passes through unoptimised until ${d.resets_at}`));
  out(dim(`  fee preview: $${d.fee_preview.estimated_fee_usd.toFixed(2)} (${d.fee_preview.label})`));
}

async function cmdRotate(a: Args) {
  const base = baseUrl(a); const key = (a.flags.key as string) || process.env.TOKENZERO_KEY;
  if (!base || !key) { err(red('Need TOKENZERO_URL and TOKENZERO_KEY (or --url and --key).')); process.exitCode = 2; return; }
  const root = path.resolve((a._[1] as string) ?? '.');
  const envFile = path.join(root, (a.flags['env-file'] as string) ?? '.env');
  if (!await confirm(`Rotate the workspace key? The current key stops working immediately.`, a)) { out(dim('cancelled')); return; }
  const r = await api(base, '/v1/workspaces/me/rotate-key', { method: 'POST', headers: { 'x-tokenzero-key': key } });
  if (r.status !== 200) { err(red(`rotate: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)); process.exitCode = 1; return; }
  const fresh: string = r.body.key;
  out(green(`✓ rotated; old key ${redactKey(key, key)} is now invalid`));
  if (fs.existsSync(envFile)) {
    const before = fs.readFileSync(envFile, 'utf8');
    const after = before.split(key).join(fresh);
    if (after !== before) { fs.writeFileSync(envFile, after, { mode: 0o600 }); out(green(`✓ updated ${path.relative(root, envFile) || '.env'} (TOKENZERO_KEY and /w/<key>/ base URLs)`)); return; }
  }
  out(`New key (shown once): ${fresh}`);
  out(dim('Update TOKENZERO_KEY and any /w/<key>/ base URLs wherever the old key was configured (CI secrets, hosting env).'));
}

async function cmdVerify(a: Args) {
  const base = baseUrl(a); const id = a._[1];
  if (base && a.flags.chain) return cmdVerifyChain(a, base);
  if (!base || !id) { err(red('usage: tokenzero verify <request_id> [--url …]  |  tokenzero verify --chain [--limit N]')); process.exitCode = 2; return; }
  const [r, k] = await Promise.all([api(base, `/v1/ledger/receipt/${encodeURIComponent(id)}`), api(base, '/.well-known/tokenzero.json')]);
  if (r.status !== 200) { err(red(`receipt: ${r.status}`)); process.exitCode = 1; return; }
  const jwk = (k.body?.keys ?? []).find((x: any) => x.kid === r.body.receipt.key_id);
  if (!jwk) { err(red(`no public key with kid ${r.body.receipt.key_id} at ${base}/.well-known/tokenzero.json`)); process.exitCode = 1; return; }
  const pub = crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
  const ok = crypto.verify(null, Buffer.from(canonical(r.body.receipt)), pub, Buffer.from(r.body.signature, 'base64url'));
  const rc = r.body.receipt;
  out(`${ok ? green('✓ valid') : red('✗ INVALID')} signature (Ed25519, key ${rc.key_id}, verified locally)`);
  out(`  ${rc.id} · ${new Date(rc.ts).toISOString()} · ${rc.provider} ${rc.requested_model}${rc.served_model && rc.served_model !== rc.requested_model ? ' → ' + rc.served_model : ''}`);
  out(`  baseline $${rc.baseline_usd} · actual $${rc.actual_usd} · saved $${rc.savings_usd} · engines ${rc.engines.join(',') || 'none'} · pricing ${rc.pricing_version}`);
  if (!ok) process.exitCode = 1;
}

/** Walk the workspace's receipt chain: every signature, every seq, every prev_receipt_hash, checked locally. */
async function cmdVerifyChain(a: Args, base: string) {
  const saved = loadCreds(); const key = (a.flags.key as string) || process.env.TOKENZERO_KEY || saved?.api_key || '';
  if (!key) { err(red('--chain needs the workspace key (TOKENZERO_KEY, --key, or saved credentials)')); process.exitCode = 2; return; }
  const limit = Number(a.flags.limit) || 50;
  const [c, k] = await Promise.all([api(base, `/v1/ledger/chain?limit=${limit}`, { headers: { 'x-tokenzero-key': key } }), api(base, '/.well-known/tokenzero.json')]);
  if (c.status !== 200) { err(red(`chain: ${c.status} ${JSON.stringify(c.body).slice(0, 200)}`)); process.exitCode = 1; return; }
  const items: { receipt: any; signature: string }[] = c.body.items ?? [];
  const keys = new Map<string, crypto.KeyObject>();
  for (const jwk of k.body?.keys ?? []) keys.set(jwk.kid, crypto.createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' }));
  const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
  let ok = true, reason = '';
  for (let i = 0; i < items.length && ok; i++) {
    const { receipt, signature } = items[i]; const pub = keys.get(receipt.key_id);
    if (!pub || !crypto.verify(null, Buffer.from(canonical(receipt)), pub, Buffer.from(signature, 'base64url'))) { ok = false; reason = `bad signature at seq ${receipt.seq}`; break; }
    const prev = items[i - 1];
    if (prev && receipt.seq !== prev.receipt.seq + 1) { ok = false; reason = `seq ${receipt.seq} does not follow ${prev.receipt.seq}`; }
    else if (prev && receipt.prev_receipt_hash !== sha(prev.signature)) { ok = false; reason = `prev_receipt_hash mismatch at seq ${receipt.seq}`; }
    else if (!prev && receipt.seq === 1 && receipt.prev_receipt_hash !== '0'.repeat(64)) { ok = false; reason = 'genesis receipt does not point at the zero hash'; }
  }
  if (a.flags.json) { out(JSON.stringify({ valid: ok, reason: reason || null, checked: items.length, head_seq: c.body.head_seq, server_verification: c.body.verification }, null, 2)); if (!ok) process.exitCode = 1; return; }
  out(`${ok ? green('✓ chain intact') : red('✗ CHAIN BROKEN')}: ${items.length} receipt(s) checked locally${c.body.head_seq != null ? `, head seq ${c.body.head_seq}` : ''}${reason ? ' — ' + reason : ''}`);
  if (items.length) out(dim(`  ${items[0].receipt.seq ?? '?'} … ${items.at(-1)!.receipt.seq ?? '?'} · savings in this run $${items.reduce((s, x) => s + (x.receipt.savings_usd ?? 0), 0).toFixed(4)} · key ${items[0].receipt.key_id}`));
  if (!ok) process.exitCode = 1;
}

function help() {
  out(`${bold('tokenzero')} v${VERSION} — cut your LLM bill with a BYOK gateway

  ${bold('tokenzero signup')} [--name NAME] [--json]  One command, no form: workspace + key, saved to ~/.config/tokenzero (0600).
  ${bold('tokenzero dashboard')} [--json]        One-click dashboard link for the saved key (key travels in the URL fragment only).
  ${bold('tokenzero init')} [dir] [--url URL] [--name NAME] [--yes] [--no-env] [--mcp] [--agent-rules] [--github-action | --no-github-action]
      Audit locally, create a workspace, point OPENAI_BASE_URL / ANTHROPIC_BASE_URL at the gateway.
      Git repositories are offered the PR cost-check workflow; --mcp writes .mcp.json and .cursor/mcp.json; --agent-rules adds an AGENTS.md section.
  ${bold('tokenzero audit')} [dir] [--json | --format markdown] [--diff file|-] [--fail-over PCT]
      Static token-waste audit. Runs locally; nothing is uploaded. --fail-over makes it a CI gate.
  ${bold('tokenzero usage')} [--json]          Routed spend vs the free tier, savings, fee preview.
  ${bold('tokenzero doctor')} [--key K] [--json] Six-check connection and receipt doctor: gateway, signer, pricing, key, quota, settings.
  ${bold('tokenzero verify')} <request_id>     Verify a savings receipt's signature offline.
  ${bold('tokenzero verify --chain')} [--limit N]  Verify the workspace's append-only receipt chain (signatures, seq, prev hashes).
  ${bold('tokenzero rotate-key')} [--yes]      Issue a new workspace key; rewrites it in .env. Old key dies immediately.

  Env: TOKENZERO_URL, TOKENZERO_KEY, NO_COLOR`);
}

async function main() {
  // `tokenzero audit | head` closes the pipe early; that is not an error.
  process.stdout.on('error', e => { if ((e as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0); throw e; });
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  if (a.flags.version || cmd === 'version') return out(VERSION);
  switch (cmd) {
    case 'init': return cmdInit(a);
    case 'signup': return cmdSignup(a);
    case 'dashboard': return cmdDashboard(a);
    case 'audit': return cmdAudit(a);
    case 'usage': return cmdUsage(a);
    case 'doctor': return cmdDoctor(a);
    case 'verify': return cmdVerify(a);
    case 'rotate-key': return cmdRotate(a);
    case undefined: case 'help': return help();
    default: err(red(`unknown command: ${cmd}`)); help(); process.exitCode = 2;
  }
}

main().catch(e => { err(red(`error: ${e?.message ?? e}`)); process.exitCode = 1; });
