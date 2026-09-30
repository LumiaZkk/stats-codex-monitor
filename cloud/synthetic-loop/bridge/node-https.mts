// Portable Node transport only; DO NOT import from the Workers application.
// Workers' https wrapper ignores lookup. There is deliberately no fetch fallback.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { Fault } from './core.mts';
import type { SafePost } from './events.mts';
export function publicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false; // Conservative spike: IPv6 needs separate vetted classification.
  const [a,b,c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168 || b === 88)) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
export const pinnedHttpsPost: SafePost = async (value, body, headers) => {
  if (process.versions.workerd) throw new Fault('callback_transport_unverified', 503, -32015);
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || isIP(url.hostname)) throw new Fault('invalid_callback');
  const deadline = AbortSignal.timeout(10_000);
  const addresses = await Promise.race([lookup(url.hostname, { all: true }), new Promise<never>((_, reject) => deadline.addEventListener('abort', () => reject(new Error('timeout')), { once: true }))]);
  // Reject the whole DNS answer if any address is not explicitly allowed.
  if (addresses.length === 0 || !addresses.every(a => publicIPv4(a.address))) throw new Fault('non_public_callback');
  const chosen = addresses[0];
  return await new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers, agent: false, family: 4, servername: url.hostname, rejectUnauthorized: true, signal: deadline, maxHeaderSize: 8192,
      lookup: (_hostname, _options, cb) => cb(null, chosen.address, 4),
    }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 8192) { res.destroy(new Error('response_too_large')); return; } chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end(body);
  });
};
