// Local project scanning shared by the CLI and the stdio MCP server.
import fs from 'node:fs';
import path from 'node:path';
import { SOURCE_EXT, SKIP_PATH, MANIFEST_FILES, type SourceFile } from '../../src/audit-core.ts';

export function walk(root: string, limit = 5000): SourceFile[] {
  const files: SourceFile[] = [];
  const stack = [root];
  while (stack.length && files.length < limit) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      if (SKIP_PATH.test(rel + (e.isDirectory() ? '/' : ''))) continue;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && SOURCE_EXT.test(e.name)) {
        try { const st = fs.statSync(full); if (st.size < 400_000) files.push({ path: rel, content: fs.readFileSync(full, 'utf8') }); } catch { /* unreadable */ }
      }
    }
  }
  return files;
}

export function manifests(root: string): SourceFile[] {
  return MANIFEST_FILES.flatMap(n => { try { return [{ path: n, content: fs.readFileSync(path.join(root, n), 'utf8') }]; } catch { return []; } });
}
