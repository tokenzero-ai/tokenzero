import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { analyzeFiles, detectRepoKind, filesFromDiff, lex, prComment } from '../src/audit-core.ts';
import { costOf, normalizeModel } from '../src/pricing.ts';

const run = promisify(execFile);

test('analyzer: call sites in strings and comments are ignored', () => {
  const src = 'const s = `client.messages.create({ model: "claude-opus-5-5" })`;\n// openai.chat.completions.create()\n';
  assert.equal(analyzeFiles([{ path: 'a.ts', content: src }]).call_sites.length, 0);
  assert.equal(lex('x = "a"\n', 'a.py').literals[0].text, 'a');
});

test('analyzer: flags an uncached Anthropic prompt in an app, downgrades in a library', () => {
  const prompt = 'You are a careful support agent. Follow the refund policy exactly and cite the clause you used. '.repeat(80);
  const files = [{ path: 'app/triage.py', content: `SYSTEM = """${prompt}"""\nr = client.messages.create(model="claude-opus-5-5", system=SYSTEM, max_tokens=500, messages=m)\n` }];
  const app = analyzeFiles(files, null, [{ path: 'package.json', content: '{"private":true,"dependencies":{"next":"16"}}' }]);
  const lib = analyzeFiles(files, null, [{ path: 'pyproject.toml', content: '[project]\nname = "anthropic"\n' }]);
  assert.ok(app.findings.some(f => f.severity === 'high'));
  assert.ok(!lib.findings.some(f => f.severity === 'high'));
  assert.equal(detectRepoKind([{ path: 'pyproject.toml', content: '[project]\nname = "agent"\n' }], []).kind, 'unknown');
});

test('analyzer: each finding lands on the call that owns the prompt', () => {
  const src = [
    'from openai import OpenAI', 'client = OpenAI()', 'SYSTEM = "You are a helpful assistant. " * 200', '',
    'def summarize(text):', '    return client.chat.completions.create(', '        model="gpt-4o",',
    '        messages=[{"role": "user", "content": SYSTEM + "Summarize: " + text}], max_tokens=4096)', '',
    'def classify(text):', '    return client.chat.completions.create(', '        model="gpt-4o",',
    '        messages=[{"role": "user", "content": "Classify sentiment as pos/neg: " + text}])', '',
  ].join('\n');
  const r = analyzeFiles([{ path: 'app.py', content: src }]);
  const lines = (re: RegExp) => r.findings.filter(f => re.test(f.title)).map(f => f.line);
  assert.deepEqual(lines(/extraction\/classification/), [11], 'routing finding on classify() only');
  assert.deepEqual(lines(/Repeat-prone/), [11]);
  assert.match(r.findings.find(f => /static prompt tokens/.test(f.title))!.detail, /call at app\.py:6/, '"..." * 200 expanded and attributed to summarize()');
  assert.ok(r.estimated_waste_pct > 0);
  assert.match(prComment(r), new RegExp(`\\(${r.estimated_waste_pct}% recoverable\\)`), 'header agrees with the findings');
});

test('pricing: list-price math', () => {
  assert.equal(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(costOf('claude-opus-5-5', { input: 1_000_000, output: 0, cachedInput: 1_000_000 }), 0.2);
});

test('bundle: committed CLI matches sources and runs', async () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tzt-')), 'tokenzero.mjs');
  await run(process.execPath, ['cli/build.mjs', tmp]);
  const h = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  assert.equal(h(tmp), h('cli/bin/tokenzero.mjs'), 'run `npm run build` and commit cli/bin/tokenzero.mjs');
  const v = await run(process.execPath, ['cli/bin/tokenzero.mjs', 'version']);
  assert.equal(v.stdout.trim(), JSON.parse(fs.readFileSync('cli/package.json', 'utf8')).version, 'CLI VERSION constant matches cli/package.json');
});

test('analyzer: filesFromDiff preserves hunk line numbers and matches full-file findings', () => {
  const full = [
    '# line 1', '# line 2', '# line 3', '# line 4', '# line 5',
    '# line 6', '# line 7', '# line 8', '# line 9', '# line 10',
    'from openai import OpenAI',
    'client = OpenAI()',
    'SYSTEM_PROMPT = """' + 'You are an expert enterprise customer support triage agent. '.repeat(120) + '"""',
    'def classify_ticket(ticket_text: str) -> str:',
    '    resp = client.chat.completions.create(',
    '        model="gpt-4o",',
    '        messages=[{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": "Classify sentiment: " + ticket_text}],',
    '    )',
    '    return resp.choices[0].message.content',
  ].join('\n') + '\n';
  const hunk = [
    'diff --git a/app.py b/app.py',
    '--- a/app.py',
    '+++ b/app.py',
    '@@ -11,9 +11,9 @@',
    ...full.split('\n').slice(10, 19).map(l => '+' + l),
  ].join('\n') + '\n';
  const a = analyzeFiles([{ path: 'app.py', content: full }]);
  const b = analyzeFiles(filesFromDiff(hunk));
  assert.deepEqual(b.findings.map(f => ({ line: f.line, title: f.title })), a.findings.map(f => ({ line: f.line, title: f.title })));
  assert.equal(b.estimated_waste_pct, a.estimated_waste_pct);
});
