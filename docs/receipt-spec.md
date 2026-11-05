# TokenZero receipt format

Status: open specification, Apache-2.0. Versions 1, 2 and 3 are all current: a verifier must accept all three.
Reference verifier: [`verifier/tokenzero-verify.mjs`](../verifier/tokenzero-verify.mjs) (zero dependencies, Node 20+
and browsers). A browser version that needs no account runs at <https://tokenzero.sh/verify>.

A receipt is a record of one metered LLM call, signed by the ledger that recorded it. It holds hashes, counts,
prices and identifiers only, never prompt or response text. Anyone can verify a receipt offline with the issuer's public key.

## 1. Signing

- **Algorithm:** Ed25519 (RFC 8032).
- **Signed bytes:** the UTF-8 *canonical JSON* of the receipt object:
  - object keys sorted by UTF-16 code unit order (JavaScript `Array.prototype.sort`);
  - no whitespace;
  - members whose value is `undefined` dropped;
  - numbers and strings serialised as `JSON.stringify` does.

  The reference function is 6 lines (`canonical()` in the verifier).
- **Signature:** base64url without padding, delivered next to the receipt, never inside it: `{"receipt": {…}, "signature": "…"}`.
- **Public keys:** `GET <issuer>/.well-known/tokenzero.json` returns `{"keys":[{"kid","kty":"OKP","crv":"Ed25519","x"}]}`
  (JWK). The receipt's `key_id` selects the key.

## 2. Chain

Receipts of one workspace form an append-only chain:

- `seq` starts at 1 and increases by exactly 1;
- `prev_receipt_hash` is the lowercase hex SHA-256 of the previous receipt's signature string, or 64 zeros for the genesis receipt.

`GET /v1/ledger/chain` returns a run to check. A gap or a mismatch means a receipt was removed or altered.

## 3. Fields

### Version 1 (all versions)

| field | meaning |
|---|---|
| `v` | 1, 2 or 3 |
| `id` | `req_…`, unique |
| `ts` | Unix ms |
| `workspace` | the account (principal) the call belongs to |
| `provider` | provider id |
| `requested_model` | the model the caller asked for |
| `served_model` | the model that answered |
| `usage` | `{input, output, cached, cache_write}` token counts as the provider reported them |
| `baseline_usd` | what the call would have cost **calling the provider directly** (see §4) |
| `actual_usd` | what the provider billed for it |
| `savings_usd` | `baseline_usd − actual_usd` |
| `engines` | which processing steps acted (cache-format, cascade, budget-cap, …) |
| `price_tier` | optional; set only for a non-standard tier |
| `cache_break` | optional |
| `seq`, `prev_receipt_hash` | chain (§2) |
| `pricing_version` | the price table used |
| `key_id` | the signing key |

All dollar fields are rounded to 8 decimals.

### Version 2 (adds the savings split)

| field | meaning |
|---|---|
| `savings_breakdown.tz_cache_usd` | the call was answered from the ledger operator's own cache; the provider was never called |
| `savings_breakdown.tz_caused_provider_cache_usd` | a provider prompt-cache effect the operator **caused**: a cache breakpoint it inserted, or a long TTL it chose. It is net of the write premium, so it is negative while a write has not paid back |
| `savings_breakdown.routing_usd` | the rest of the saving: a cheaper model served by the operator's routing |
| `savings_breakdown.provider_native_cache_usd` | the provider's **own** cache effect: automatic caching, or a directive the caller set. **Informational; never part of savings or the fee basis** |
| `cache_attribution` | `tz_cache` \| `inserted` \| `caller` \| `automatic` \| `none` |
| `fee_basis_usd` | the amount any performance fee is computed on; equals `savings_usd` |

### Version 3 (adds identity and ingestion)

| field | meaning |
|---|---|
| `agent` | `{id, principal, budget_id}`: `id` from `X-TokenZero-Agent` (or null); `principal` = `workspace`; `budget_id` = the budget that applied (or null) |
| `cap_event` | optional: `rejected` (the call was refused at a budget cap; nothing reached the provider) or `routed` (a budget served a cheaper model at its cap) |
| `key_fp` | a non-reversible fingerprint of the provider key used, scoped to the workspace |
| `ingestion_source` | `gateway` (the operator proxied the call) or `record_only` (the customer pushed the usage; nothing was proxied) |
| `not_computable` | optional: the fields that cannot be computed from the data available, by name. They are null, **never estimated** |

## 4. The counterfactual (what "baseline" means)

`baseline_usd` is what a direct call to the provider, with the same request, would have been billed:

- **Automatic caching** (OpenAI, Gemini implicit, DeepSeek, xAI, OpenRouter non-Claude) or a **cache directive the
  caller set:** a direct call gets the same cache reads and pays the same short-TTL writes, so both are in the
  baseline, and the difference shows as `provider_native_cache_usd`.
- **Breakpoint-only providers** (Anthropic and Claude via Bedrock/OpenRouter), when the caller set no breakpoint: a direct
  call gets no cache reads. Cache reads there come from the breakpoint the operator inserted, so they count as
  `tz_caused_provider_cache_usd`.
- **A budget routing at its cap** (`cap_event: routed`) is the customer's own policy, so the baseline is the served model
  and routing books no saving.

## 5. Checks a verifier performs

The reference verifier checks:

1. The signature is valid over the canonical JSON under the published key `key_id`.
2. `savings_usd = baseline_usd − actual_usd` (to 1e-8).
3. v2+:
   - `tz_cache + tz_caused_provider_cache + routing = savings_usd` (to 2e-8);
   - `fee_basis_usd = savings_usd`;
   - `tz_cache` ⇒ `actual_usd = 0` and the whole saving is `tz_cache_usd`;
   - `automatic` / `caller` ⇒ `tz_caused_provider_cache_usd ≤ 0`;
   - `none` ⇒ no cache effect on either side;
   - `tz_cache_usd = 0` unless the cache served the call.
4. v3:
   - `agent.principal = workspace`;
   - `ingestion_source ∈ {gateway, record_only}`;
   - `cap_event: rejected` ⇒ `actual_usd = 0`;
   - a cap event names its budget;
   - `record_only` ⇒ no saving and no fee basis, and `not_computable` is present.
5. A chain run: contiguous `seq`, and `prev_receipt_hash` links.

## 6. Record-only receipts

A record-only receipt documents spend the operator did not route: the customer pushes usage
(`POST /v1/records`).

- The provider's bill is taken as reported, or priced from the published table when the customer sends only token counts.
- The operator caused nothing, so `savings_usd` and `fee_basis_usd` are 0.
- Anything the usage data cannot establish is listed in `not_computable` and left null. For example, `provider_native_cache_usd` when no cached-token count was given.

## 7. Versioning

New fields are only ever **added**, under a new `v`. An issuer never changes the meaning of an existing field, and
verifiers must ignore fields they do not know.
