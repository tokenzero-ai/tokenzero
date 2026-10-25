import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { analyzeFiles, detectRepoKind, lex } from '../src/audit-core.ts';
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
