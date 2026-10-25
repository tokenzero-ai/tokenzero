// Deterministic JSON serialization for signed receipts: sorted keys, no
// whitespace, undefined fields dropped. Pure so verifiers (CLI, browsers,
// third parties) can reproduce the signed bytes without the server.
export function canonical(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  const o = obj as Record<string, unknown>;
  return '{' + Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
}
