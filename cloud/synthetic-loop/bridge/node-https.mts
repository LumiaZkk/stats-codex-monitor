// Portable Node transport only; DO NOT import from the Workers application.
// Workers' https wrapper ignores lookup. There is deliberately no fetch fallback.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import { Fault } from './core.mts';
import { CallbackAddressFault } from './events.mts';
import type { AddressCategories, SafePost } from './events.mts';
export function publicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false; // Conservative spike: IPv6 needs separate vetted classification.
  const [a,b,c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168 || b === 88)) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
export function classifyAddresses(addresses: readonly {address:string;family:number}[]): AddressCategories {
  const counts: AddressCategories = {public_ipv4:0,non_public_ipv4:0,benchmark_ipv4:0,unsupported_ipv6:0,invalid_address:0};
  for (const {address,family} of addresses) {
    if (family===4 && isIP(address)===4) {
      if(publicIPv4(address))counts.public_ipv4++;
      else {counts.non_public_ipv4++;const [a,b]=address.split('.').map(Number);if(a===198 && (b===18 || b===19))counts.benchmark_ipv4++;}
    } else if(family===6 && isIP(address)===6)counts.unsupported_ipv6++;
    else counts.invalid_address++;
  }
  return counts;
}
export type CallbackLookup = (hostname:string,signal:AbortSignal) => Promise<{address:string;family:number}[]>;
export function makePinnedHttpsPost(resolve:CallbackLookup = hostname=>lookup(hostname,{all:true}), lifetime?:AbortSignal): SafePost { return async (value, body, headers) => {
  if (process.versions.workerd) throw new Fault('callback_transport_unverified', 503, -32015);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || isIP(url.hostname)) throw new Fault('invalid_callback');
  const deadline = AbortSignal.any([AbortSignal.timeout(10_000),...(lifetime ? [lifetime] : [])]);
  deadline.throwIfAborted();
  const addresses = await Promise.race([resolve(url.hostname,deadline), new Promise<never>((_, reject) => deadline.addEventListener('abort', () => reject(new Fault('callback_timeout')), { once: true }))]);
  deadline.throwIfAborted();
  // Reject the whole DNS answer if any address is not explicitly allowed.
  if (addresses.length === 0 || !addresses.every(a => a.family===4 && publicIPv4(a.address))) throw new CallbackAddressFault(classifyAddresses(addresses));
  const chosen = addresses[0];
  return await new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers, agent: false, family: 4, servername: url.hostname, rejectUnauthorized: true, signal: deadline, maxHeaderSize: 8192,
      lookup: (_hostname, _options, cb) => cb(null, chosen.address, 4),
    }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 8192) { res.destroy(new Error('response_too_large')); return; } chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end(body);
  });
}; }
export const pinnedHttpsPost: SafePost = makePinnedHttpsPost();
