#!/usr/bin/env node
// Portable test runner: `npm test` works on Node 20, 22, 24 and 26.
//
// The tests are TypeScript. Node 24+ runs them directly (type stripping). Older
// Node has no TypeScript support, so there the tests are bundled to JavaScript
// with esbuild (already a devDependency) into .test-dist/ and run from there.
// Either way node:test gets an explicit file list, never a quoted glob (Node 20
// does not expand those).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const testDir = path.join(root, 'test');
const files = fs.readdirSync(testDir).filter(f => f.endsWith('.test.ts')).sort().map(f => path.join(testDir, f));
if (!files.length) { console.error('run-tests: no test/*.test.ts files'); process.exit(1); }

const [major, minor] = process.versions.node.split('.').map(Number);
const native = major >= 24 || (major === 22 && minor >= 18); // unflagged type stripping

let target = files;
if (!native) {
  const esbuild = await import('esbuild');
  const out = path.join(root, '.test-dist');
  fs.rmSync(out, { recursive: true, force: true });
  await esbuild.build({ entryPoints: files, outdir: out, bundle: true, platform: 'node', format: 'esm', target: `node${major}`, packages: 'external', sourcemap: 'inline', logLevel: 'warning', outExtension: { '.js': '.test.mjs' } });
  target = fs.readdirSync(out).filter(f => f.endsWith('.test.mjs')).map(f => path.join(out, f));
}

const r = spawnSync(process.execPath, ['--no-warnings', '--test', ...target], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
