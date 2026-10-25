// TokenZero cost check (GitHub Action). Dependency-free; uses the CLI bundle that
// ships in the same repository, so the analyzer version is pinned to the action ref.
//
// pull_request events: audits the diff base...head and keeps ONE comment per PR up to
// date (found by a hidden marker), so pushes never stack comments. Other events: audits
// the checkout and writes the job summary only. Fork PRs get a read-only token, so the
// comment step degrades to the summary instead of failing the build.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = process.env.TOKENZERO_CLI || path.join(here, '..', 'cli', 'bin', 'tokenzero.mjs');
const MARKER = '<!-- tokenzero-cost-check -->';
const env = process.env;
const API = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

const log = (m) => process.stdout.write(m + '\n');
const warn = (m) => process.stdout.write(`::warning::${m}\n`);
const setOutput = (k, v) => { if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${k}=${v}\n`); };
const summary = (md) => { if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, md + '\n'); };
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const cli = (args, input) => execFileSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...env, NO_COLOR: '1' } });

async function gh(method, url, token, body) {
  const r = await fetch(API + url, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'tokenzero-action', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) { const e = new Error(`GitHub ${method} ${url}: ${r.status} ${text.slice(0, 200)}`); e.status = r.status; throw e; }
  return text ? JSON.parse(text) : null;
}

/** Changes introduced by the PR: merge-base diff, fetching the base commit if the checkout is shallow. */
function prDiff(baseSha) {
  try { git('cat-file', '-e', `${baseSha}^{commit}`); }
  catch { log(`fetching base ${baseSha.slice(0, 12)} (shallow checkout)`); git('fetch', '--no-tags', '--depth=200', 'origin', baseSha); }
  try { return git('diff', '--no-color', '--unified=3', `${baseSha}...HEAD`); }
  catch { return git('diff', '--no-color', '--unified=3', baseSha, 'HEAD'); } // no merge base in shallow history
}

async function upsertComment({ repo, number, token, body, onlyIfExists }) {
  let existing = null;
  for (let page = 1; page <= 10 && !existing; page++) {
    const list = await gh('GET', `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`, token);
    existing = list.find(c => typeof c.body === 'string' && c.body.includes(MARKER)) ?? null;
    if (list.length < 100) break;
  }
  if (existing) { await gh('PATCH', `/repos/${repo}/issues/comments/${existing.id}`, token, { body }); return 'updated'; }
  if (onlyIfExists) return 'skipped';
  await gh('POST', `/repos/${repo}/issues/${number}/comments`, token, { body });
  return 'created';
}

async function main() {
  const event = env.GITHUB_EVENT_PATH && fs.existsSync(env.GITHUB_EVENT_PATH) ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const pr = event.pull_request;
  let report, markdown;
  if (pr) {
    const diff = prDiff(pr.base.sha);
    report = JSON.parse(cli(['audit', '--diff', '-', '--json'], diff));
    markdown = cli(['audit', '--diff', '-', '--format', 'markdown'], diff);
  } else {
    const dir = env.INPUT_PATH || '.';
    report = JSON.parse(cli(['audit', dir, '--json']));
    markdown = cli(['audit', dir, '--format', 'markdown']);
  }
  const high = report.findings.filter(f => f.severity === 'high').length;
  setOutput('waste-pct', report.estimated_waste_pct);
  setOutput('findings', report.findings.length);
  setOutput('high', high);
  summary(markdown);
  log(`TokenZero: ${report.call_sites.length} call site(s), ${report.findings.length} finding(s), ~${report.estimated_waste_pct}% recoverable`);

  if (pr) {
    const repo = env.GITHUB_REPOSITORY || event.repository?.full_name;
    const token = env.INPUT_GITHUB_TOKEN;
    const clean = report.findings.length === 0;
    if (!token) warn('no github-token; results are in the job summary only');
    else {
      try {
        // A clean PR updates an existing comment (so a fixed PR shows it is fixed) but
        // does not open a new one unless asked to.
        const r = await upsertComment({ repo, number: pr.number, token, body: markdown, onlyIfExists: clean && env.INPUT_COMMENT_ON_CLEAN !== 'true' });
        log(`PR comment ${r}`);
      } catch (e) {
        if (e.status === 403 || e.status === 404) warn(`could not comment on this PR (${e.status}; fork PRs get a read-only token). Results are in the job summary.`);
        else throw e;
      }
    }
  }

  const gate = env.INPUT_FAIL_OVER;
  if (gate !== undefined && gate !== '' && report.estimated_waste_pct > Number(gate)) {
    process.stdout.write(`::error::estimated recoverable waste ${report.estimated_waste_pct}% exceeds fail-over ${gate}%\n`);
    process.exitCode = 1;
  }
}

main().catch(e => { process.stdout.write(`::error::${String(e?.message ?? e).slice(0, 500)}\n`); process.exitCode = 1; });
