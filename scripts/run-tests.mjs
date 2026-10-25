#!/usr/bin/env node
// Runs the TypeScript test suite across Node 20, 22, 24, and 26+.
// On Node 22.6+ / 24+, native type-stripping runs .ts directly; on Node 20 or older Node 22,
// esbuild transpiles test/*.test.ts into a temporary directory before invoking node --test.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

const files = fs.readdirSync('test').filter(f => f.endsWith('.test.ts')).map(f => path.join('test', f));
const [major, minor] = process.versions.node.split('.').map(Number);

if (major >= 24 || (major === 22 && minor >= 6)) {
  const flags = major >= 24 ? ['--no-warnings=ExperimentalWarning'] : ['--experimental-strip-types', '--no-warnings=ExperimentalWarning'];
  const r = spawnSync(process.execPath, [...flags, '--test', ...files], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-test-'));
try {
  const outFiles = [];
  for (const f of files) {
    const out = path.join(tmp, path.basename(f, '.ts') + '.mjs');
    await build({
      entryPoints: [f],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      outfile: out,
      packages: 'bundle',
    });
    outFiles.push(out);
  }
  const r = spawnSync(process.execPath, ['--test', ...outFiles], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
