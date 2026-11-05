#!/usr/bin/env node
// TokenZero receipt verifier — open source (Apache-2.0), zero dependencies, runs in Node >= 20 and in browsers.
// Spec: docs/receipt-spec.md. It checks, without trusting TokenZero:
//   1. the Ed25519 signature over the receipt's canonical JSON, against the published key (/.well-known/tokenzero.json);
//   2. the arithmetic: savings = baseline - actual; v2+: the three buckets add up to savings, fee_basis = savings,
//      the cache attribution is consistent with the buckets; v3: agent identity, cap events, record-only rules;
//   3. (optional) a chain run: contiguous seq and prev_receipt_hash = sha256(previous signature).
//
//   node tokenzero-verify.mjs receipt.json            # a file holding {"receipt":…, "signature":…} (GET /v1/ledger/receipt/{id})
//   node tokenzero-verify.mjs --id req_…              # fetch it from https://tokenzero.sh first
//   node tokenzero-verify.mjs --chain chain.json      # a run from GET /v1/ledger/chain
// Exit code 0 = every check passed.

export const DEFAULT_ISSUER = 'https://tokenzero.sh';
const EPS = 2e-8; // receipts round dollar fields to 8 decimals; a sum of three rounded values can differ by 2 units

/** The signed bytes: sorted keys, no whitespace, undefined dropped (identical to src/canonical.ts). */
export function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  return '{' + Object.keys(obj).sort().filter(k => obj[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

const subtle = () => globalThis.crypto?.subtle ?? null;
const b64u = (s) => { const b = s.replace(/-/g, '+').replace(/_/g, '/'); const p = b + '='.repeat((4 - (b.length % 4)) % 4); const bin = atob(p); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const hex = (buf) => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');

export async function fetchKeys(issuer = DEFAULT_ISSUER) {
  const r = await fetch(issuer.replace(/\/$/, '') + '/.well-known/tokenzero.json');
  if (!r.ok) throw new Error('could not fetch ' + issuer + '/.well-known/tokenzero.json: HTTP ' + r.status);
  return (await r.json()).keys;
}

export async function verifySignature(receipt, signature, keys) {
  const jwk = (keys ?? []).find(k => k.kid === receipt.key_id && k.crv === 'Ed25519');
  if (!jwk) return { ok: false, reason: `no published key with kid ${receipt.key_id}` };
  try {
    const key = await subtle().importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, { name: 'Ed25519' }, false, ['verify']);
    const ok = await subtle().verify({ name: 'Ed25519' }, key, b64u(signature), new TextEncoder().encode(canonical(receipt)));
    return { ok, reason: ok ? 'Ed25519 signature valid over the canonical JSON' : 'signature does not match these bytes (the receipt was altered or signed by another key)' };
  } catch (e) { return { ok: false, reason: 'Ed25519 unavailable in this runtime: ' + (e?.message ?? e) }; }
}

const near = (a, b, eps = EPS) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= eps;

/** Arithmetic and consistency checks by receipt version. Each check: {name, ok, detail}. */
export function checkMath(r) {
  const out = [];
  const add = (name, ok, detail) => out.push({ name, ok: !!ok, detail });
  const nc = new Set(Array.isArray(r.not_computable) ? r.not_computable : []);
  add('version is known', [1, 2, 3].includes(r.v), `v=${r.v}`);
  if (r.baseline_usd != null && r.actual_usd != null && r.savings_usd != null) add('savings_usd = baseline_usd - actual_usd', near(r.savings_usd, Math.round((r.baseline_usd - r.actual_usd) * 1e8) / 1e8), `${r.baseline_usd} - ${r.actual_usd} = ${r.savings_usd}`);
  else add('dollar fields present or explicitly not computable', r.savings_usd == null ? (nc.size > 0 || r.baseline_usd == null || r.actual_usd == null) : true, 'savings null only when an input is missing');
  if (r.v >= 2) {
    const b = r.savings_breakdown;
    if (b && r.savings_usd != null) {
      const parts = ['tz_cache_usd', 'tz_caused_provider_cache_usd', 'routing_usd'];
      if (parts.every(k => typeof b[k] === 'number')) add('tz_cache + tz_caused_provider_cache + routing = savings_usd', near(b.tz_cache_usd + b.tz_caused_provider_cache_usd + b.routing_usd, r.savings_usd), `${b.tz_cache_usd} + ${b.tz_caused_provider_cache_usd} + ${b.routing_usd} vs ${r.savings_usd}`);
      for (const k of parts) if (b[k] == null) add(`${k} null only when declared not computable`, nc.has(k), nc.has(k) ? 'declared not_computable' : 'null without declaration');
      const a = r.cache_attribution;
      if (a === 'tz_cache') add('tz_cache: provider never called (actual 0) and the whole saving is the TokenZero cache bucket', r.actual_usd === 0 && near(b.tz_cache_usd, r.savings_usd), `actual ${r.actual_usd}, tz_cache ${b.tz_cache_usd}`);
      if (a === 'automatic' || a === 'caller') add(`${a}: the provider discount is informational, never a TokenZero cache saving (tz_caused <= 0)`, typeof b.tz_caused_provider_cache_usd !== 'number' || b.tz_caused_provider_cache_usd <= EPS, `tz_caused ${b.tz_caused_provider_cache_usd}`);
      if (a === 'none') add('none: no provider-cache effect on either side', (b.tz_caused_provider_cache_usd ?? 0) === 0 && (b.provider_native_cache_usd ?? 0) === 0, `tz_caused ${b.tz_caused_provider_cache_usd}, native ${b.provider_native_cache_usd}`);
      if (a !== 'tz_cache') add('tz_cache_usd is 0 unless the TokenZero cache served the call', (b.tz_cache_usd ?? 0) === 0, `tz_cache ${b.tz_cache_usd}`);
    }
    if ('fee_basis_usd' in r) add('fee_basis_usd = savings_usd', r.fee_basis_usd === r.savings_usd, `${r.fee_basis_usd} vs ${r.savings_usd}`);
  }
  if (r.v >= 3) {
    add('agent.principal is the workspace', r.agent && r.agent.principal === r.workspace, `${r.agent?.principal} vs ${r.workspace}`);
    add('ingestion_source is gateway or record_only', r.ingestion_source === 'gateway' || r.ingestion_source === 'record_only', String(r.ingestion_source));
    if (r.cap_event === 'rejected') add('a rejected call cost nothing', r.actual_usd === 0, `actual ${r.actual_usd}`);
    if (r.cap_event) add('a cap event names its budget', !!r.agent?.budget_id, String(r.agent?.budget_id));
    if (r.ingestion_source === 'record_only') {
      add('record_only: TokenZero did not proxy it, so it books no TokenZero saving', (r.savings_usd ?? 0) === 0 && (r.fee_basis_usd ?? 0) === 0, `savings ${r.savings_usd}, fee basis ${r.fee_basis_usd}`);
      add('record_only: every bucket it could not compute is declared, never estimated', Array.isArray(r.not_computable), JSON.stringify(r.not_computable ?? null));
    }
  }
  return out;
}

export async function verifyChain(items) {
  const res = [];
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1].receipt, b = items[i].receipt;
    if (a.seq == null || b.seq == null) continue;
    const h = hex(await subtle().digest('SHA-256', new TextEncoder().encode(items[i - 1].signature)));
    res.push({ seq: b.seq, ok: b.seq === a.seq + 1 && b.prev_receipt_hash === h, detail: b.seq !== a.seq + 1 ? `seq ${a.seq} -> ${b.seq}` : b.prev_receipt_hash === h ? 'linked' : 'prev_receipt_hash mismatch' });
  }
  return { ok: res.every(x => x.ok), links: res };
}

/** Everything for one {receipt, signature}: signature + math. */
export async function verifyReceipt(item, keys) {
  const sig = await verifySignature(item.receipt, item.signature, keys);
  const math = checkMath(item.receipt);
  return { ok: sig.ok && math.every(c => c.ok), signature: sig, math };
}

// ---- CLI ---------------------------------------------------------------------
const isMain = typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === new URL('file://' + process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const issuer = (args.includes('--issuer') ? args[args.indexOf('--issuer') + 1] : null) ?? DEFAULT_ISSUER;
  const { readFile } = await import('node:fs/promises');
  let items;
  if (args[0] === '--id') { const r = await fetch(`${issuer}/v1/ledger/receipt/${encodeURIComponent(args[1])}`); items = [await r.json()]; }
  else if (args[0] === '--chain') { const j = JSON.parse(await readFile(args[1], 'utf8')); items = j.items ?? j; }
  else if (args[0]) { const j = JSON.parse(await readFile(args[0], 'utf8')); items = Array.isArray(j) ? j : j.items ?? [j]; }
  else { console.error('usage: tokenzero-verify.mjs <receipt.json> | --id req_… | --chain chain.json [--issuer https://tokenzero.sh]'); process.exit(2); }
  const keys = await fetchKeys(issuer);
  let allOk = true;
  for (const it of items) {
    const v = await verifyReceipt(it, keys); allOk &&= v.ok;
    console.log(`${v.ok ? 'PASS' : 'FAIL'} ${it.receipt?.id} (v${it.receipt?.v}) — ${v.signature.reason}`);
    for (const c of v.math) if (!c.ok || process.env.VERBOSE) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
  }
  if (items.length > 1) { const ch = await verifyChain(items); allOk &&= ch.ok; console.log(`${ch.ok ? 'PASS' : 'FAIL'} chain of ${items.length}: ${ch.links.filter(l => !l.ok).map(l => l.seq + ' ' + l.detail).join('; ') || 'every link valid'}`); }
  process.exit(allOk ? 0 : 1);
}
