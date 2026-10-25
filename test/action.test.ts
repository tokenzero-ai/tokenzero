import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ACTION = path.resolve('action/run.mjs');
const CLI = path.resolve('cli/bin/tokenzero.mjs');

// Mock GitHub REST API: issue comments on one PR.
let api: http.Server, apiUrl = '', comments: { id: number; body: string }[] = [], calls: string[] = [], deny = false;
before(async () => {
  api = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    calls.push(`${req.method} ${req.url!.split('?')[0]}`);
    if (deny && req.method !== 'GET') { res.writeHead(403); return res.end('{"message":"Resource not accessible by integration"}'); }
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(comments)); }
    const body = JSON.parse(raw).body;
    if (req.method === 'POST') comments.push({ id: comments.length + 1, body });
    if (req.method === 'PATCH') { const id = Number(req.url!.split('/').pop()); comments.find(c => c.id === id)!.body = body; }
    res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' }); res.end('{}');
  });
  await new Promise<void>(r => api.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${(api.address() as any).port}`;
});
after(() => api.close());

function repoWith(change: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-act-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true,"dependencies":{"next":"16"}}');
  fs.writeFileSync(path.join(dir, 'app.ts'), 'export const x = 1;\n');
  g('add', '-A'); g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'llm.ts'), change);
  g('add', '-A'); g('commit', '-qm', 'pr');
  return { dir, base };
}

async function act(dir: string, base: string, extra: Record<string, string> = {}) {
  const ev = path.join(dir, '..', path.basename(dir) + '-event.json');
  fs.writeFileSync(ev, JSON.stringify({ pull_request: { number: 7, base: { sha: base } }, repository: { full_name: 'acme/app' } }));
  const out = path.join(dir, '..', path.basename(dir) + '-out'), sum = out + '-summary';
  const env = { PATH: process.env.PATH!, GITHUB_EVENT_PATH: ev, GITHUB_REPOSITORY: 'acme/app', GITHUB_API_URL: apiUrl, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum, INPUT_GITHUB_TOKEN: 'ghs_test', TOKENZERO_CLI: CLI, ...extra };
  const r = await run(process.execPath, [ACTION], { cwd: dir, env }).then(x => ({ code: 0, ...x }), (e: any) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
  return { ...r, outputs: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '', summary: fs.existsSync(sum) ? fs.readFileSync(sum, 'utf8') : '' };
}

const RISKY = `const SYSTEM_PROMPT = \`${'Follow the refund policy exactly and cite the clause you used. '.repeat(120)}\`;\nexport async function triage(client, t) {\n  return client.messages.create({ model: "claude-opus-5-5", system: SYSTEM_PROMPT, max_tokens: 400, messages: [{ role: "user", content: "Classify this ticket: " + t }] });\n}\n`;

test('action: posts one marked comment, updates it on the next push, summary and outputs set', async () => {
  comments = []; calls = []; deny = false;
  const { dir, base } = repoWith(RISKY);
  const a = await act(dir, base);
  assert.equal(a.code, 0, a.stdout + a.stderr);
  assert.equal(comments.length, 1);
  assert.ok(comments[0].body.startsWith('<!-- tokenzero-cost-check -->'));
  assert.match(comments[0].body, /static prompt/);
  // Only two hosts may ever appear: the public repo, and the gateway URL baked into the
  // CLI (scripts/bake-default-url.sh refuses any host that does not prove our signing key).
  for (const u of comments[0].body.match(/https?:\/\/[^\s)`>\]]+/g) ?? []) assert.match(u, /^(https:\/\/github\.com\/tokenzero-ai\/tokenzero|https:\/\/tokenzero\.sh(\/|$))/, u);
  assert.match(a.outputs, /^waste-pct=\d+$/m); assert.match(a.outputs, /^high=[1-9]/m);
  assert.match(a.summary, /TokenZero cost check/);
  const b = await act(dir, base);
  assert.equal(b.code, 0);
  assert.equal(comments.length, 1, 'second run updates, never stacks');
  assert.ok(calls.includes('PATCH /repos/acme/app/issues/comments/1'));
});

test('action: clean PR posts nothing new; fork PR (403) degrades to summary; fail-over gates', async () => {
  comments = []; calls = []; deny = false;
  const clean = repoWith('export const add = (a: number, b: number) => a + b;\n');
  const c = await act(clean.dir, clean.base);
  assert.equal(c.code, 0);
  assert.equal(comments.length, 0, 'no comment on a clean PR by default');
  assert.match(c.stdout, /PR comment skipped/);

  deny = true;
  const risky = repoWith(RISKY);
  const f = await act(risky.dir, risky.base);
  assert.equal(f.code, 0, 'read-only token must not fail the build');
  assert.match(f.stdout, /::warning::could not comment on this PR \(403/);
  assert.match(f.summary, /TokenZero cost check/);

  deny = false; comments = [];
  const gated = await act(risky.dir, risky.base, { INPUT_FAIL_OVER: '1' });
  assert.equal(gated.code, 1);
  assert.match(gated.stdout, /::error::estimated recoverable waste/);
});
