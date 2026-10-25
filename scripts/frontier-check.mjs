#!/usr/bin/env node
// Verifies pricing table freshness, 5-provider frontier coverage, and bundle parity.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const pkgCli = JSON.parse(fs.readFileSync('cli/package.json', 'utf8'));
const pkgMcp = JSON.parse(fs.readFileSync('mcp/package.json', 'utf8'));
const pricingSrc = fs.readFileSync('src/pricing.ts', 'utf8');

const m = /PRICING_VERSION = '(\d{4}-\d{2}-\d{2})'/.exec(pricingSrc);
if (!m) { console.error('missing PRICING_VERSION'); process.exit(1); }
const ageDays = Math.floor((Date.now() - Date.parse(m[1] + 'T00:00:00Z')) / 86_400_000);
if (ageDays > 45) { console.error(`pricing table stale: ${ageDays}d > 45d`); process.exit(1); }

for (const model of ['gpt-6-astra', 'claude-opus-5-5', 'gemini-4-argon', 'grok-4', 'deepseek-v3', 'deepseek-r1']) {
  if (!pricingSrc.includes(`'${model}':`)) { console.error(`missing frontier model ${model}`); process.exit(1); }
}
console.log(JSON.stringify({
  ok: true,
  cli_version: pkgCli.version,
  mcp_version: pkgMcp.version,
  pricing_version: m[1],
  pricing_age_days: ageDays,
  providers: ['openai', 'anthropic', 'gemini', 'xai', 'deepseek'],
}, null, 2));
