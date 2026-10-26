// MCP protocol plumbing shared by the hosted Streamable HTTP endpoint (src/mcp.ts)
// and the stdio package (mcp/src/main.ts). Dual-era, per the 2026-07-28 revision:
//
//   modern  (2026-07-28+)  no handshake; every request carries its protocol version
//                          and client capabilities in params._meta, results carry
//                          resultType and the server's identity in _meta, list results
//                          carry caching hints, and server/discover must exist.
//   legacy  (<= 2025-11-25) initialize / notifications/initialized handshake, ping.
//
// A request is modern when its _meta names a protocol version; otherwise it is served
// with legacy semantics. Both eras are served on the same endpoint or process.
export const MCP_MODERN_VERSIONS = ['2026-07-28'] as const;
export const MCP_LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;

export const META = {
  version: 'io.modelcontextprotocol/protocolVersion',
  clientInfo: 'io.modelcontextprotocol/clientInfo',
  clientCapabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
} as const;

// JSON-RPC error codes. -32020..-32099 is the range the MCP spec reserves.
export const RPC = { parse: -32700, methodNotFound: -32601, invalidParams: -32602, internal: -32603, headerMismatch: -32020, unsupportedVersion: -32022 } as const;

/** Freshness hint on cacheable results (tools/list, server/discover): the tool set changes only with a release. */
export const LIST_TTL_MS = 3_600_000;

export interface ServerIdentity { name: string; version: string }

export function requestedVersion(m: any): string | undefined {
  const v = m?.params?._meta?.[META.version];
  return typeof v === 'string' ? v : undefined;
}
export const isModern = (m: any): boolean => requestedVersion(m) !== undefined;
export const versionSupported = (v: string): boolean => (MCP_MODERN_VERSIONS as readonly string[]).includes(v);

export function unsupportedVersionError(requested: string) {
  return { code: RPC.unsupportedVersion, message: 'Unsupported protocol version', data: { supported: [...MCP_MODERN_VERSIONS], requested } };
}

/** Wrap a result the modern way: resultType, server identity, and cache hints for list-like results. */
export function modernResult(result: Record<string, unknown>, server: ServerIdentity, cacheable = false) {
  return { resultType: 'complete', ...result, ...(cacheable ? { ttlMs: LIST_TTL_MS, cacheScope: 'public' } : {}), _meta: { [META.serverInfo]: server } };
}

export function discoverResult(server: ServerIdentity, capabilities: Record<string, unknown>, instructions: string) {
  return modernResult({ supportedVersions: [...MCP_MODERN_VERSIONS], capabilities, instructions }, server, true);
}

/** Streamable HTTP mirrors body fields into headers; values outside plain ASCII use a Base64 sentinel. */
export function decodeHeaderValue(v: string): string {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
}

/**
 * Server-side validation of the standard request headers on a modern HTTP request.
 * Returns an error message, or null when the headers agree with the body.
 */
export function validateHttpHeaders(headers: Record<string, string | string[] | undefined>, m: any): string | null {
  const h = (k: string) => { const v = headers[k]; return Array.isArray(v) ? v[0] : v; };
  const pv = h('mcp-protocol-version');
  if (!pv) return 'missing MCP-Protocol-Version header';
  if (pv !== requestedVersion(m)) return `MCP-Protocol-Version header '${pv}' does not match body value '${requestedVersion(m)}'`;
  const method = h('mcp-method');
  if (!method) return 'missing Mcp-Method header';
  if (method !== m?.method) return `Mcp-Method header '${method}' does not match body value '${m?.method}'`;
  if (m?.method === 'tools/call' || m?.method === 'resources/read' || m?.method === 'prompts/get') {
    const want = m?.params?.name ?? m?.params?.uri;
    const name = h('mcp-name');
    if (!name) return 'missing Mcp-Name header';
    if (/[^\x20-\x7e\t]/.test(name)) return 'Mcp-Name header contains invalid characters';
    const got = decodeHeaderValue(name);
    if (got !== want) return `Mcp-Name header '${got}' does not match body value '${want}'`;
  }
  return null;
}
