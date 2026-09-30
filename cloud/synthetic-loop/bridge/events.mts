import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Fault, EVENT_NAME, filterSchema, eventSchema, digest, principal, validate } from './core.mts';
export type Subscription = { id: string; owner: string; name: string; arguments: { stream_id: string }; url: string; secret: string; previousSecret?: string; rotationUntil?: number; expiresAt: number; verifiedUntil: number };
export interface SubscriptionStore { get(id: string): Promise<Subscription | null>; put(s: Subscription): Promise<void>; remove(id: string): Promise<void>; }
export type SafePost = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;
// Finite diagnostic vocabulary only. Never retain URL, secret, headers, response
// body, request fields or arbitrary exception messages in diagnostic state.
const safeReasons = ['invalid_event','invalid_schema','invalid_callback','invalid_signing_secret','invalid_ttl','replay_unsupported','access_revoked','authentication_required','non_public_callback','callback_transport_unverified','callback_timeout','callback_dns_failed','callback_tls_failed','callback_connection_failed','callback_transport_error','callback_http_error','invalid_challenge_response','challenge_failed','subscription_limit'] as const;
type SafeReason = typeof safeReasons[number] | 'subscription_failed';
const addressCategories = ['public_ipv4','non_public_ipv4','benchmark_ipv4','unsupported_ipv6','invalid_address'] as const;
export type AddressCategories = Record<typeof addressCategories[number],number>;
export class CallbackAddressFault extends Fault {
  readonly addressCategories: AddressCategories;
  constructor(counts: AddressCategories) {
    super('non_public_callback',503,-32015);
    this.addressCategories = Object.freeze(Object.fromEntries(addressCategories.map(k=>[k,Number.isSafeInteger(counts[k]) && counts[k]>=0 ? Math.min(counts[k],1000) : 0])) as AddressCategories);
  }
}
export type SubscriptionDiagnostic = { stage: 'validating' | 'verifying' | 'storing' | 'accepted' | 'failed'; reason?: SafeReason; http_status?: number; address_categories?: AddressCategories };
function safeReason(error: unknown): SafeReason { return error instanceof Fault && (safeReasons as readonly string[]).includes(error.reason) ? error.reason as SafeReason : 'subscription_failed'; }
export function callbackFault(error: unknown): Fault {
  if (error instanceof CallbackAddressFault) return error;
  if (error instanceof Fault && ['invalid_callback','non_public_callback','callback_transport_unverified','callback_timeout','callback_dns_failed','callback_tls_failed','callback_connection_failed','callback_transport_error'].includes(error.reason)) return new Fault(error.reason,503,-32015);
  const code = (error as { code?: unknown })?.code;
  const reason = ['ABORT_ERR','ETIMEDOUT'].includes(String(code)) || (error as { name?: unknown })?.name === 'TimeoutError' ? 'callback_timeout'
    : ['ENOTFOUND','EAI_AGAIN'].includes(String(code)) ? 'callback_dns_failed'
    : ['ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT'].includes(String(code)) ? 'callback_tls_failed'
    : ['ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ENETUNREACH'].includes(String(code)) ? 'callback_connection_failed' : 'callback_transport_error';
  return new Fault(reason,503,-32015);
}
export function signingKey(secret: unknown): Buffer {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Fault('invalid_signing_secret');
  const raw = secret.slice(6); const decoded = Buffer.from(raw, 'base64');
  if (decoded.length < 24 || decoded.length > 64 || decoded.toString('base64') !== raw) throw new Fault('invalid_signing_secret');
  return decoded;
}
export function signedHeaders(id: string, sub: Subscription, body: string, now: number) {
  if (Buffer.byteLength(body) > 262_144) throw new Fault('event_too_large');
  const ts = String(Math.floor(now / 1000));
  const sign = (secret: string) => 'v1,' + createHmac('sha256', signingKey(secret)).update(`${id}.${ts}.${body}`).digest('base64');
  const signatures = [sign(sub.secret)];
  if (sub.previousSecret && (sub.rotationUntil ?? 0) > now) signatures.push(sign(sub.previousSecret));
  return { 'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signatures.join(' '), 'X-MCP-Subscription-Id': sub.id };
}
function callbackUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) throw new Fault('invalid_callback');
  let url: URL; try { url = new URL(value); } catch { throw new Fault('invalid_callback'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) throw new Fault('invalid_callback');
  return url.href;
}
export class Events {
  store: SubscriptionStore; post: SafePost; clock: () => number; access: (owner: string) => Promise<boolean>;
  lastSubscription: SubscriptionDiagnostic | null = null;
  constructor(store: SubscriptionStore, post: SafePost, access: (owner: string) => Promise<boolean>, clock = Date.now) { this.store = store; this.post = post; this.clock = clock; this.access = access; }
  async identity(owner: string, value: unknown, subscribe: boolean) {
    principal(owner); if (!await this.access(owner)) throw new Fault('access_revoked', 403, -32003);
    const p = value as { name?: string; arguments?: unknown; delivery?: { mode?: string; url?: string; secret?: string }; ttlMs?: number | null; cursor?: unknown };
    if (p?.name !== EVENT_NAME || p.delivery?.mode !== 'webhook') throw new Fault('invalid_event');
    validate(filterSchema, p.arguments);
    if (p.cursor != null) throw new Fault('replay_unsupported');
    const url = callbackUrl(p.delivery.url);
    if (subscribe) signingKey(p.delivery.secret);
    return { p, url, id: 'sub_' + digest({ owner, url, name: p.name, arguments: p.arguments }) };
  }
  async subscribe(owner: string, value: unknown) {
    this.lastSubscription = { stage:'validating' };
    try { return await this.subscribeValidated(owner,value); }
    catch (error) { this.lastSubscription = { stage:'failed', reason:safeReason(error), ...(this.lastSubscription.http_status === undefined ? {} : {http_status:this.lastSubscription.http_status}), ...(error instanceof CallbackAddressFault ? {address_categories:error.addressCategories} : {}) }; throw error; }
  }
  private async subscribeValidated(owner: string, value: unknown) {
    const { p, url, id } = await this.identity(owner, value, true); const now = this.clock();
    if (p.ttlMs != null && (!Number.isSafeInteger(p.ttlMs) || p.ttlMs <= 0)) throw new Fault('invalid_ttl');
    const ttl = Math.min(p.ttlMs ?? 30 * 60_000, 30 * 60_000);
    const previous = await this.store.get(id);
    const sub: Subscription = { id, owner, name: EVENT_NAME, arguments: p.arguments as { stream_id: string }, url, secret: p.delivery!.secret!, expiresAt: now + ttl, verifiedUntil: now + Math.min(ttl, 300_000) };
    if (previous && previous.secret !== sub.secret && previous.expiresAt > now) { sub.previousSecret = previous.secret; sub.rotationUntil = now + 60_000; }
    if (!previous || previous.verifiedUntil <= now || previous.secret !== sub.secret) {
      const challenge = randomUUID(); const body = JSON.stringify({ type: 'verification', challenge });
      this.lastSubscription = {stage:'verifying'};
      let response: Awaited<ReturnType<SafePost>>;
      try { response = await this.post(url, body, signedHeaders('msg_verification_' + randomUUID(), sub, body, now)); }
      catch (error) { throw callbackFault(error); }
      if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) this.lastSubscription.http_status = response.status;
      if (response.status < 200 || response.status >= 300) throw new Fault('callback_http_error',503,-32015);
      let echoed: unknown;
      try { echoed = JSON.parse(response.body).challenge; } catch { throw new Fault('invalid_challenge_response',503,-32015); }
      if (typeof echoed !== 'string' || Buffer.byteLength(echoed) !== Buffer.byteLength(challenge) || !timingSafeEqual(Buffer.from(echoed), Buffer.from(challenge))) throw new Fault('challenge_failed',503,-32015);
    } else sub.verifiedUntil = previous.verifiedUntil;
    this.lastSubscription = {stage:'storing',...(this.lastSubscription?.http_status === undefined ? {} : {http_status:this.lastSubscription.http_status})};
    await this.store.put(sub);
    this.lastSubscription.stage = 'accepted';
    return { id, refreshBefore: new Date(sub.expiresAt).toISOString(), cursor: null, truncated: false };
  }
  async unsubscribe(owner: string, params: unknown) { const { id } = await this.identity(owner, params, false); await this.store.remove(id); return {}; }
  async deliver(owner: string, id: string, event: { eventId: string; name: string; data: { stream_id: string }; [key: string]: unknown }, stillPending: () => Promise<boolean>, delay: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))) {
    principal(owner); validate(eventSchema, event.data);
    for (let attempt = 0; attempt < 3; attempt++) {
      const sub = await this.store.get(id); const now = this.clock();
      if (!sub || sub.owner !== owner) throw new Fault('subscription_not_found', 404);
      if (sub.expiresAt <= now || !await this.access(owner)) { await this.store.remove(id); throw new Fault('subscription_inactive', 409); }
      if (event.name !== sub.name || event.data.stream_id !== sub.arguments.stream_id) throw new Fault('event_filter_mismatch');
      if (!await stillPending()) throw new Fault('request_terminal', 409);
      const body = JSON.stringify(event);
      let status = 0;
      try { status = (await this.post(sub.url, body, signedHeaders(event.eventId, sub, body, now))).status; } catch { /* A transient network failure may be retried with the same event ID. */ }
      if (status >= 200 && status < 300) return { received: true, analysis_complete: false, event_id: event.eventId, attempts: attempt + 1 };
      if (status === 410) { await this.store.remove(id); throw new Fault('callback_gone', 410); }
      if (status === 413 || (status >= 400 && status < 500 && status !== 429)) throw new Fault('callback_rejected', status);
      if (attempt < 2) await delay(250 * 2 ** attempt);
    }
    throw new Fault('delivery_failed', 503);
  }
}
