// Optional Node-only resolver. Importing this module does not make a request or
// change the operating system's DNS. The caller must explicitly select it.
// Cloudflare JSON DoH: https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/
import https from 'node:https';
import type { RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { Fault } from './core.mts';
import { parseStrictJson } from './json.mts';

export type CloudflareAddress = { address: string; family: number };
export type CloudflareQuestionType = 1 | 28;
export const CLOUDFLARE_DOH_LIMITS = Object.freeze({ bytes: 32_768, records: 64, aliases: 16, timeoutMs: 5_000 });
const RESOLVER = 'cloudflare-dns.com';
const BOOTSTRAP = '1.1.1.1';
type Reason = 'invalid_callback' | 'callback_dns_failed' | 'callback_timeout' | 'callback_tls_failed' | 'callback_transport_unverified';
const fault = (reason: Reason = 'callback_dns_failed') => new Fault(reason, 503, -32015);
const fail = (): never => { throw fault(); };
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function dnsName(value: unknown): string {
  if (typeof value !== 'string') return fail();
  const name = value.endsWith('.') ? value.slice(0, -1) : value;
  // No URL, credentials, path, query, IP literal, escaped DNS label or Unicode
  // reaches the resolver. URL.hostname supplies punycode before this boundary.
  if (!name || name.length > 253 || isIP(name) || /^[\d.]+$/.test(name) ||
      !name.split('.').every(label => label.length <= 63 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label))) return fail();
  return name.toLowerCase();
}
function queryName(hostname: string): string {
  try { return dnsName(hostname); } catch { throw fault('invalid_callback'); }
}
function questionType(type: CloudflareQuestionType): void { if (type !== 1 && type !== 28) fail(); }

// Pure construction helper for offline verification. The destination and TLS
// identity cannot be supplied by a caller. agent:false avoids shared/proxy agents.
export function cloudflareRequestOptions(hostname: string, type: CloudflareQuestionType, signal: AbortSignal): RequestOptions {
  const name = queryName(hostname); questionType(type);
  return {
    protocol: 'https:', hostname: RESOLVER, port: 443,
    path: '/dns-query?' + new URLSearchParams({ name, type: String(type), do: 'false', cd: 'false' }).toString(),
    method: 'GET', headers: { Host: RESOLVER, Accept: 'application/dns-json', 'Accept-Encoding': 'identity' },
    agent: false, family: 4, servername: RESOLVER,
    rejectUnauthorized: true, minVersion: 'TLSv1.2', signal, maxHeaderSize: 8192,
    // Pin only the resolver connection. Never use OS DNS, including as fallback.
    lookup: (_hostname, _options, callback) => callback(null, BOOTSTRAP, 4),
  };
}

type RecordData = { name: string; type: number; data: string };
function records(value: unknown): RecordData[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CLOUDFLARE_DOH_LIMITS.records) return fail();
  return value.map(record => {
    if (!isObject(record) || !Number.isInteger(record.type) || (record.type as number) < 1 || (record.type as number) > 65535 ||
        !Number.isInteger(record.TTL) || (record.TTL as number) < 0 || (record.TTL as number) > 0xffffffff ||
        typeof record.data !== 'string' || record.data.length > 4096) return fail();
    return { name: dnsName(record.name), type: record.type as number, data: record.data };
  });
}

// A parser, not an address-policy filter. In particular, private, malformed and
// IPv6 address strings are retained for the callback transport's whole-answer
// validation. Nothing here connects to a returned address.
type DnsResult = { addresses: CloudflareAddress[]; chain: string[] };
function parseDnsResult(body: string, hostname: string, type: CloudflareQuestionType): DnsResult {
  const name = queryName(hostname); questionType(type);
  if (typeof body !== 'string' || Buffer.byteLength(body) > CLOUDFLARE_DOH_LIMITS.bytes) return fail();
  let result: unknown; try { result = parseStrictJson(body); } catch { return fail(); }
  if (!isObject(result) || result.Status !== 0 || result.TC !== false || result.CD === true ||
      (result.RD !== undefined && result.RD !== true) || (result.RA !== undefined && result.RA !== true) ||
      !Array.isArray(result.Question) || result.Question.length !== 1) return fail();
  const question = result.Question[0];
  if (!isObject(question) || dnsName(question.name) !== name || question.type !== type) return fail();
  const answers = records(result.Answer), authority = records(result.Authority), additional = records(result.Additional);
  if (answers.length + authority.length + additional.length > CLOUDFLARE_DOH_LIMITS.records) return fail();
  // Address/alias records outside Answer are not silently discarded. Unrelated
  // glue is unsupported by this intentionally narrow callback resolver.
  if ([...authority, ...additional].some(record => [1, 5, 28, 39].includes(record.type))) return fail();
  const aliases = new Map<string, string>();
  const addresses: RecordData[] = [];
  for (const record of answers) {
    if (record.type === 5) {
      const target = dnsName(record.data), previous = aliases.get(record.name);
      if (previous !== undefined && previous !== target) return fail();
      aliases.set(record.name, target);
    } else if (record.type === type) {
      if (record.data.length > 253) return fail();
      addresses.push(record);
    } else return fail();
  }
  const visited = new Set<string>(); let terminal = name;
  while (aliases.has(terminal)) {
    if (visited.has(terminal) || visited.size >= CLOUDFLARE_DOH_LIMITS.aliases) return fail();
    visited.add(terminal); terminal = aliases.get(terminal)!;
  }
  if (visited.size !== aliases.size || addresses.some(record => record.name !== terminal)) return fail();
  // NOERROR + no addresses is valid NODATA (notably for an IPv4-only name's
  // AAAA query). NXDOMAIN, SERVFAIL and truncated results already failed above.
  return { addresses: addresses.map(record => ({ address: record.data, family: type === 1 ? 4 : 6 })), chain: [...visited, terminal] };
}

export function parseCloudflareDnsJson(body: string, hostname: string, type: CloudflareQuestionType): CloudflareAddress[] {
  return parseDnsResult(body, hostname, type).addresses;
}

function networkReason(error: unknown, signal: AbortSignal): Reason {
  if (signal.aborted || (isObject(error) && error.code === 'ABORT_ERR')) return 'callback_timeout';
  const code = isObject(error) ? error.code : undefined;
  return typeof code === 'string' && ['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code)
    ? 'callback_tls_failed' : 'callback_dns_failed';
}

function query(hostname: string, type: CloudflareQuestionType, signal: AbortSignal): Promise<DnsResult> {
  return new Promise((resolve, reject) => {
    let req: ClientRequest | undefined, response: IncomingMessage | undefined, settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const rejectSafe = (reason: Reason = 'callback_dns_failed') => {
      if (settled) return;
      settled = true; cleanup(); reject(fault(reason));
      response?.destroy(); req?.destroy();
    };
    const onAbort = () => rejectSafe('callback_timeout');
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      req = https.request(cloudflareRequestOptions(hostname, type, signal), res => {
        response = res;
        // No redirect support: a 3xx is a resolver failure, never a second URL.
        const contentType = res.headers['content-type'];
        const encoding = res.headers['content-encoding'];
        const length = res.headers['content-length'];
        res.on('error', () => rejectSafe());
        res.on('aborted', () => rejectSafe());
        res.on('close', () => { if (!settled) rejectSafe(); });
        if (settled) { res.destroy(); return; }
        if (res.statusCode !== 200 || typeof contentType !== 'string' || contentType.split(';')[0].trim().toLowerCase() !== 'application/dns-json' ||
            (encoding !== undefined && encoding !== 'identity') ||
            (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > CLOUDFLARE_DOH_LIMITS.bytes))) { rejectSafe(); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > CLOUDFLARE_DOH_LIMITS.bytes) { rejectSafe(); return; }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          if (!res.complete || (length !== undefined && Number(length) !== bytes)) { rejectSafe(); return; }
          try {
            const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
            const addresses = parseDnsResult(body, hostname, type);
            settled = true; cleanup(); resolve(addresses);
          } catch { rejectSafe(); }
        });
      });
      req.on('error', error => rejectSafe(networkReason(error, signal)));
      if (settled) req.destroy(); else req.end();
    } catch (error) { rejectSafe(networkReason(error, signal)); }
  });
}

export async function cloudflareLookup(hostname: string, signal: AbortSignal): Promise<CloudflareAddress[]> {
  if (process.versions.workerd) throw fault('callback_transport_unverified');
  const name = queryName(hostname);
  if (signal.aborted) throw fault('callback_timeout');
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(onAbort, CLOUDFLARE_DOH_LIMITS.timeoutMs);
  try {
    const [ipv4, ipv6] = await Promise.all([query(name, 1, controller.signal), query(name, 28, controller.signal)]);
    // Mixed canonical chains are an inconsistent resolution, even if both
    // responses separately passed validation. Retry through the caller only.
    if (JSON.stringify(ipv4.chain) !== JSON.stringify(ipv6.chain)) throw fault();
    // Do not prefer/filter/deduplicate IPv4: the caller must validate all results.
    return [...ipv4.addresses, ...ipv6.addresses];
  } finally {
    clearTimeout(timeout); signal.removeEventListener('abort', onAbort);
    controller.abort(); // Cancel the sibling query immediately if either failed.
  }
}
