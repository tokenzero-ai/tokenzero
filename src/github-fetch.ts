// Read-only fetching of public GitHub repositories for static audits. Pure: the
// optional token is passed in, nothing is read from the environment or disk, so
// the server, the CLI and the stdio MCP server share it.
import { SOURCE_EXT, SKIP_PATH, MANIFEST_FILES, type SourceFile } from './audit-core.ts';

const GH = 'https://api.github.com';
const UA = 'TokenZero-Audit/0.1 (+https://tokenzero.sh)';
const ghHeaders = (token?: string): Record<string, string> => ({ 'user-agent': UA, accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) });

export interface FetchOptions { token?: string; maxFiles?: number; }


export async function fetchRepoFiles(repo: string, opts: FetchOptions = {}): Promise<{ files: SourceFile[]; manifests: SourceFile[]; branch: string; total_candidates: number }> {
  const maxFiles = opts.maxFiles ?? 120;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repo must look like owner/name');
  const meta = await fetch(`${GH}/repos/${repo}`, { headers: ghHeaders(opts.token) });
  if (meta.status === 404) throw new Error('repository not found (private repos are not supported)');
  if (!meta.ok) throw new Error(`GitHub API ${meta.status}: ${(await meta.text()).slice(0, 200)}`);
  const branch = (await meta.json() as any).default_branch as string;
  const tree = await fetch(`${GH}/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers: ghHeaders(opts.token) });
  if (!tree.ok) throw new Error(`GitHub tree ${tree.status}`);
  const treeAll = (await tree.json() as any).tree as any[];
  const allPaths: string[] = treeAll.map(e => e.path);
  const entries = treeAll.filter(e => e.type === 'blob' && SOURCE_EXT.test(e.path) && !SKIP_PATH.test(e.path) && (e.size ?? 0) < 200_000);
  // Prioritise files likely to contain LLM calls: strong name signals first, then weak ones,
  // larger files first within a group (call sites live in real modules, not 40-byte __init__s).
  const score = (p: string) => /openai|anthropic|claude|gemini|llm|prompt|complet|respons|inference|generat/i.test(p) ? 0 : /\bai\b|agent|chat|model|rag|embed|assistant/i.test(p) ? 1 : 2;
  entries.sort((a, b) => score(a.path) - score(b.path) || b.size - a.size);
  const picked: typeof entries = [];
  let bytes = 0;
  for (const e of entries) { if (picked.length >= maxFiles || bytes + e.size > 4_000_000) break; picked.push(e); bytes += e.size; }
  const files = await Promise.all(picked.map(async e => {
    const r = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${e.path}`, { headers: { 'user-agent': UA } });
    return { path: e.path, content: r.ok ? await r.text() : '' };
  }));
  const tree0 = new Set(allPaths);
  const manifests = (await Promise.all(MANIFEST_FILES.filter(n => tree0.has(n)).map(async n => {
    const r = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${n}`, { headers: { 'user-agent': UA } });
    return r.ok ? { path: n, content: await r.text() } : null;
  }))).filter((m): m is SourceFile => !!m);
  return { files, manifests, branch, total_candidates: entries.length };
}

export async function fetchPrDiff(repo: string, pr: number, token?: string): Promise<string> {
  const r = await fetch(`${GH}/repos/${repo}/pulls/${pr}`, { headers: { ...ghHeaders(token), accept: 'application/vnd.github.v3.diff' } });
  if (!r.ok) throw new Error(`GitHub PR ${r.status}`);
  return r.text();
}
