import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const BUNDLE = path.resolve('mcp/bin/tokenzero-mcp.mjs');
const run = promisify(execFile);

/** Drive the stdio server: write requests, collect one response per id. */
async function session(requests: object[], cwd: string, env: Record<string, string> = {}) {
  const p = spawn(process.execPath, [BUNDLE], { cwd, env: { PATH: process.env.PATH!, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const out: any[] = []; let buf = '';
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  for (const r of requests) p.stdin.write(JSON.stringify(r) + '\n');
  const want = requests.filter((r: any) => r.id !== undefined).length;
  const deadline = Date.now() + 15_000;
  while (out.length < want && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  p.kill();
  return out;
}

test('committed MCP bundle is up to date and dependency-free', async () => {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tz-mcpb-')), 'b.mjs');
  await run(process.execPath, ['mcp/build.mjs', tmp]);
  const h = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  assert.equal(h(tmp), h(BUNDLE), 'stale bundle: run `node mcp/build.mjs` and commit mcp/bin/tokenzero-mcp.mjs');
  assert.ok(!fs.readFileSync(BUNDLE, 'utf8').includes('js-tiktoken'));
});

test('stdio MCP: initialize, list tools, local audit of the working directory, arbitrage, errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-mcp-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true,"dependencies":{"next":"16"}}');
  fs.writeFileSync(path.join(dir, 'triage.ts'), `const SYSTEM_PROMPT = \`${'Follow the refund policy exactly and cite the clause. '.repeat(120)}\`;\nconst r = await client.messages.create({ model: "claude-opus-5-5", system: SYSTEM_PROMPT, max_tokens: 500, messages });\n`);
  const res = await session([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'audit_repo_token_waste', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'calculate_model_arbitrage', arguments: { model: 'gpt-6-astra', input_tokens: 3000, output_tokens: 300, static_tokens: 2000 } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'optimize_prompt_payload', arguments: { body: { model: 'gpt-6.1-sol' } } } },
    { jsonrpc: '2.0', id: 6, method: 'nope' },
  ], dir, { TOKENZERO_URL: 'http://127.0.0.1:9' }); // closed port: hermetic, whatever URL the bundle has baked in
  const by = (id: number) => res.find(r => r.id === id);
  assert.equal(by(1).result.protocolVersion, '2025-06-18');
  assert.equal(by(1).result.serverInfo.version, JSON.parse(fs.readFileSync('mcp/package.json', 'utf8')).version, 'MCP version matches mcp/package.json');
  assert.deepEqual(by(2).result.tools.map((t: any) => t.name), ['audit_repo_token_waste', 'calculate_model_arbitrage', 'optimize_prompt_payload', 'workspace_metrics', 'provision_workspace']);
  const audit = by(3).result.structuredContent;
  assert.equal(audit.repo_kind, 'app');
  assert.ok(audit.findings.some((f: any) => f.severity === 'high' && /static prompt/.test(f.title)));
  assert.equal(by(4).result.structuredContent.alternatives[0].model, 'gpt-6.1-sol');
  assert.equal(by(5).result.isError, true, 'unreachable service → clear tool error, not a crash');
  assert.match(by(5).result.content[0].text, /could not reach the TokenZero service at http:\/\/127\.0\.0\.1:9 .*TOKENZERO_URL/);
  assert.equal(by(6).error.code, -32601);
  assert.equal(res.length, 6, 'no response to notifications');
});

test('stdio MCP: 2026-07-28 clients (no handshake) and legacy clients are both served', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-mcp-'));
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
  const res = await session([
    { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: meta } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'calculate_model_arbitrage', arguments: { model: 'gpt-6-astra', input_tokens: 1000, output_tokens: 100 }, _meta: meta } },
    { jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } },
    { jsonrpc: '2.0', id: 5, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'old', version: '1' } } },
    { jsonrpc: '2.0', id: 6, method: 'ping', params: { _meta: meta } },
  ], dir, { TOKENZERO_URL: 'http://127.0.0.1:9' });
  const by = (id: number) => res.find(r => r.id === id);
  assert.equal(by(1).result.resultType, 'complete');
  assert.deepEqual(by(1).result.supportedVersions, ['2026-07-28']);
  assert.equal(by(1).result._meta['io.modelcontextprotocol/serverInfo'].name, 'tokenzero');
  assert.equal(by(1).result.cacheScope, 'public'); assert.ok(by(1).result.ttlMs > 0);
  assert.equal(by(2).result.resultType, 'complete'); assert.equal(by(2).result.tools.length, 5); assert.ok(by(2).result.ttlMs > 0);
  assert.equal(by(3).result.resultType, 'complete'); assert.equal(by(3).result.isError, false);
  assert.equal(by(4).error.code, -32022, 'UnsupportedProtocolVersionError');
  assert.deepEqual(by(4).error.data, { supported: ['2026-07-28'], requested: '1900-01-01' });
  assert.equal(by(5).result.protocolVersion, '2025-11-25', 'legacy handshake still works');
  assert.equal(by(6).error.code, -32601, 'ping was removed from the modern protocol');
});

test('stdio MCP: provision_workspace is listed and fails cleanly without a reachable service', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-mcp-'));
  const res = await session([
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'provision_workspace', arguments: { name: 'x' }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } },
  ], dir, { TOKENZERO_URL: 'http://127.0.0.1:9' });
  const by = (id: number) => res.find(r => r.id === id);
  assert.ok(by(1).result.tools.some((t: any) => t.name === 'provision_workspace'));
  assert.equal(by(2).result.isError, true); assert.match(by(2).result.content[0].text, /could not reach the TokenZero service/);
});
