// MCP Events (SEP-3415, draft "io.modelcontextprotocol/events", PR head read 2026-11-01): the event types TokenZero
// offers. Descriptors only, no database access, so the stdio @tokenzero/mcp bundle can list them offline.
// Poll delivery first; push and webhook are not offered yet (a request for them answers Unsupported).
export const EVENTS_EXTENSION = 'io.modelcontextprotocol/events';
export const EVENT_ERR = { invalidParams: -32602, notFound: -32023, forbidden: -32024, resourceExhausted: -32025, unsupported: -32026 } as const;

const keyNote = 'Needs a workspace key (x-tokenzero-key or TOKENZERO_KEY).';
export const EVENT_TYPES = [
  {
    name: 'spend.threshold_crossed',
    description: `Fires once per period when the workspace's metered LLM spend through TokenZero crosses a dollar threshold: wake an agent on a cost spike. ${keyNote}`,
    delivery: ['poll'],
    inputSchema: { type: 'object', properties: { usd: { type: 'number', exclusiveMinimum: 0, description: 'threshold in USD of actual (post-savings) spend' }, window: { type: 'string', enum: ['day', 'month'], default: 'day', description: 'UTC calendar period the spend accumulates over' } }, required: ['usd'] },
    payloadSchema: { type: 'object', properties: { workspace: { type: 'string' }, window: { type: 'string' }, period: { type: 'string' }, threshold_usd: { type: 'number' }, spend_usd: { type: 'number' }, crossed_at: { type: 'string', format: 'date-time' }, request_id: { type: 'string' }, dashboard_url: { type: 'string' } } },
  },
  {
    name: 'savings.daily_report',
    description: `One event per completed UTC day with traffic: requests, list-price baseline, actual spend and signed savings. ${keyNote}`,
    delivery: ['poll'],
    inputSchema: { type: 'object', properties: {} },
    payloadSchema: { type: 'object', properties: { workspace: { type: 'string' }, date: { type: 'string', format: 'date' }, requests: { type: 'integer' }, cache_hits: { type: 'integer' }, baseline_usd: { type: 'number' }, actual_usd: { type: 'number' }, savings_usd: { type: 'number' }, savings_pct: { type: 'number' } } },
  },
  {
    name: 'upstream.auth_failed',
    description: `Fires when a provider rejects the BYOK key a call carried (401/403), with the fix and a keyless sandbox link. ${keyNote}`,
    delivery: ['poll'],
    inputSchema: { type: 'object', properties: { provider: { type: 'string', description: 'only this provider (openai, anthropic, gemini, ...)' } } },
    payloadSchema: { type: 'object', properties: { workspace: { type: 'string' }, request_id: { type: 'string' }, provider: { type: 'string' }, status: { type: 'integer' }, model: { type: ['string', 'null'] }, at: { type: 'string', format: 'date-time' }, fix: { type: 'string' }, keyless_sandbox: { type: 'string' } } },
  },
  {
    name: 'pricing.changed',
    description: 'Fires when a list price in TokenZero\'s curated, provider-verified pricing table changes (one event per model and field). No key needed.',
    delivery: ['poll'],
    inputSchema: { type: 'object', properties: { models: { type: 'array', items: { type: 'string' }, description: 'only these model ids' } } },
    payloadSchema: { type: 'object', properties: { model: { type: 'string' }, field: { type: 'string', enum: ['input', 'output', 'cachedInput', 'cacheWrite', 'added', 'removed'] }, old: { type: ['number', 'null'] }, new: { type: ['number', 'null'] }, unit: { type: 'string' }, pricing_version: { type: 'string' } } },
  },
] as const;
export type EventName = typeof EVENT_TYPES[number]['name'];
