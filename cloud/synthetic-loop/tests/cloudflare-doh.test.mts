import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import type { RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Fault } from '../bridge/core.mts';
import { CLOUDFLARE_DOH_LIMITS, cloudflareLookup, cloudflareRequestOptions, parseCloudflareDnsJson } from '../bridge/cloudflare-doh.mts';
import type { CloudflareQuestionType } from '../bridge/cloudflare-doh.mts';

const hostname = 'callback.example';
const record = (data: string, type = 1, name = hostname + '.') => ({ name, type, TTL: 60, data });
const result = (type: CloudflareQuestionType = 1, Answer: unknown = [record('93.184.216.34')]) => ({ Status: 0, TC: false, RD: true, RA: true, AD: false, CD: false, Question: [{ name: hostname + '.', type }], Answer });
const parse = (value: unknown, type: CloudflareQuestionType = 1) => parseCloudflareDnsJson(JSON.stringify(value), hostname, type);
function safeFault(reason = 'callback_dns_failed') {
  return (error: unknown) => error instanceof Fault && error.reason === reason && error.message === reason && error.status === 503 && error.code === -32015 && !('cause' in error);
}

test('DNS JSON preserves every A and AAAA address, including private, duplicate, and invalid strings', () => {
  const addresses = ['93.184.216.34', '10.0.0.1', '198.18.1.1', 'bad-address', '93.184.216.34'];
  assert.deepEqual(parse(result(1, addresses.map(address => record(address)))), addresses.map(address => ({ address, family: 4 })));
  assert.deepEqual(parse(result(28, [record('2606:4700::1111', 28), record('::1', 28), record('bad-v6', 28)]), 28), [
    { address: '2606:4700::1111', family: 6 }, { address: '::1', family: 6 }, { address: 'bad-v6', family: 6 },
  ]);
});

test('canonicalizes DNS names, permits consistent unordered CNAME chains, and returns terminal addresses only', () => {
  const body = result(1, [record('93.184.216.34', 1, 'TARGET.EXAMPLE.'), record('target.example.', 5, 'alias.example.'), record('alias.example.', 5)]);
  body.Question[0].name = 'CALLBACK.EXAMPLE.';
  assert.deepEqual(parse(body), [{ address: '93.184.216.34', family: 4 }]);
  assert.deepEqual(parseCloudflareDnsJson(JSON.stringify(body), 'CALLBACK.EXAMPLE.', 1), [{ address: '93.184.216.34', family: 4 }]);
});

test('NOERROR without AAAA records is valid NODATA, including a consistent CNAME and SOA', () => {
  const noAnswer: Record<string, unknown> = result(28); delete noAnswer.Answer;
  noAnswer.Authority = [record('ns.example. hostmaster.example. 1 60 60 60 60', 6, 'example.')];
  assert.deepEqual(parse(noAnswer, 28), []);
  assert.deepEqual(parse(result(28, []), 28), []);
  assert.deepEqual(parse(result(28, [record('alias.example.', 5)]), 28), []);
});

test('rejects DNS failures, truncation, absent status, disabled validation and invalid question metadata', () => {
  for (const patch of [
    { Status: 3 }, { Status: 2 }, { Status: '0' }, { Status: undefined }, { TC: true }, { TC: undefined },
    { CD: true }, { RD: false }, { RA: false }, { Question: [] }, { Question: null },
    { Question: [{ name: 'wrong.example.', type: 1 }] }, { Question: [{ name: hostname, type: 28 }] },
    { Question: [{ name: hostname, type: '1' }] }, { Question: [{ name: hostname, type: 1 }, { name: hostname, type: 1 }] },
  ]) assert.throws(() => parse({ ...result(), ...patch }), safeFault());
});

test('rejects malformed JSON and non-object values without retaining response content', () => {
  for (const body of ['private-secret', '{"secret":', 'null', '[]', 'true', '"secret"']) {
    assert.throws(() => parseCloudflareDnsJson(body, hostname, 1), safeFault());
  }
});

test('rejects invalid record structures, wrong answer types, and untrusted extra address sections', () => {
  for (const Answer of [null, {}, [null], [record('93.184.216.34', 28)], [record('text', 16)],
    [{ ...record('x'), TTL: -1 }], [{ ...record('x'), TTL: 0x100000000 }], [{ ...record('x'), TTL: 1.1 }],
    [{ ...record('x'), type: '1' }], [{ ...record('x'), data: null }], [record('x'.repeat(254))],
    [record('93.184.216.34', 1, 'elsewhere.example.')],
  ]) assert.throws(() => parse(result(1, Answer)), safeFault());
  for (const section of ['Authority', 'Additional']) {
    assert.throws(() => parse({ ...result(), [section]: [record('127.0.0.1')] }), safeFault());
    assert.throws(() => parse({ ...result(), [section]: {} }), safeFault());
  }
});

test('rejects CNAME loops, conflicts, unrelated chains, and address records at an alias owner', () => {
  for (const Answer of [
    [record(hostname + '.', 5)],
    [record('alias.example.', 5), record(hostname + '.', 5, 'alias.example.')],
    [record('a.example.', 5), record('b.example.', 5)],
    [record('unrelated.example.', 5, 'elsewhere.example.')],
    [record('alias.example.', 5), record('93.184.216.34')],
    [record('https://private.example/path?secret=x', 5)],
  ]) assert.throws(() => parse(result(1, Answer)), safeFault());
});

test('bounds body bytes, total records across sections, and CNAME depth', () => {
  assert.throws(() => parseCloudflareDnsJson(' '.repeat(CLOUDFLARE_DOH_LIMITS.bytes + 1), hostname, 1), safeFault());
  assert.throws(() => parse(result(1, Array.from({ length: 65 }, () => record('93.184.216.34')))), safeFault());
  assert.throws(() => parse({ ...result(1, Array.from({ length: 64 }, () => record('93.184.216.34'))), Authority: [record('ns.example.', 2, 'example.')] }), safeFault());
  const aliases = Array.from({ length: 17 }, (_, index) => record(`alias${index}.example.`, 5, index === 0 ? hostname + '.' : `alias${index - 1}.example.`));
  assert.throws(() => parse(result(1, aliases)), safeFault());
});

test('fixed request options pin resolver IP while preserving TLS identity, Host and verification', () => {
  const signal = new AbortController().signal;
  const options = cloudflareRequestOptions('CALLBACK.EXAMPLE.', 28, signal);
  assert.equal(options.protocol, 'https:'); assert.equal(options.hostname, 'cloudflare-dns.com'); assert.equal(options.port, 443);
  assert.equal(options.servername, 'cloudflare-dns.com'); assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
  assert.equal(options.family, 4); assert.equal(options.minVersion, 'TLSv1.2'); assert.equal(options.maxHeaderSize, 8192);
  assert.equal(options.method, 'GET'); assert.equal(options.signal, signal);
  assert.deepEqual(options.headers, { Host: 'cloudflare-dns.com', Accept: 'application/dns-json', 'Accept-Encoding': 'identity' });
  assert.equal(options.path, '/dns-query?name=callback.example&type=28&do=false&cd=false');
  options.lookup!('cloudflare-dns.com', { family: 4 }, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, '1.1.1.1'); assert.equal(family, 4);
  });
  assert.equal(options.auth, undefined); assert.equal(options.checkServerIdentity, undefined); assert.equal(options.ca, undefined);
});

test('rejects input URLs, paths, credentials, IP literals and malformed hostnames before any request', async t => {
  t.mock.method(https, 'request', () => { assert.fail('network call is forbidden'); });
  for (const value of ['https://callback.example/private?signature=secret', 'callback.example/path', 'callback.example?secret=x',
    'user:secret@callback.example', '127.0.0.1', '::1', '[::1]', '1.2.3', '', '.', 'a..example', 'x'.repeat(64) + '.example',
    'callback.example\n', 'callback.example\\secret', 'callback_foo.example', '-callback.example', 'callback-.example', 'café.example',
  ]) await assert.rejects(cloudflareLookup(value, new AbortController().signal), safeFault('invalid_callback'));
});

// Transport mocks have no socket, DNS, TLS or network implementation. Every
// resolver test replaces https.request before invoking cloudflareLookup.
type MockResponse = PassThrough & { headers: IncomingMessage['headers']; statusCode: number; complete: boolean };
type Stub = { options: RequestOptions; request: EventEmitter & { destroyed: boolean; destroy: () => void }; response?: MockResponse };
function stubRequests(t: TestContext, handle: (call: Stub, callback: (res: IncomingMessage) => void) => void) {
  const calls: Stub[] = [];
  t.mock.method(https, 'request', (options: RequestOptions, callback: (res: IncomingMessage) => void) => {
    const request = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; }, end() {} });
    const call: Stub = { options, request }; calls.push(call);
    queueMicrotask(() => handle(call, callback));
    return request;
  });
  return calls;
}
function respond(call: Stub, callback: (res: IncomingMessage) => void, body: string | Buffer, statusCode = 200, headers: IncomingMessage['headers'] = {}) {
  const response = Object.assign(new PassThrough(), { statusCode, headers: { 'content-type': 'application/dns-json', ...headers }, complete: true });
  call.response = response; callback(response as unknown as IncomingMessage); response.end(body);
}
function typeFor(call: Stub): CloudflareQuestionType { return Number(new URL('https://unused.example' + call.options.path).searchParams.get('type')) as CloudflareQuestionType; }

test('lookup queries both record families and preserves every candidate without sorting or filtering', async t => {
  const calls = stubRequests(t, (call, callback) => {
    const type = typeFor(call);
    respond(call, callback, JSON.stringify(result(type, type === 1 ? [record('93.184.216.34'), record('198.18.0.1')] : [record('::1', 28)])));
  });
  assert.deepEqual(await cloudflareLookup(hostname, new AbortController().signal), [
    { address: '93.184.216.34', family: 4 }, { address: '198.18.0.1', family: 4 }, { address: '::1', family: 6 },
  ]);
  assert.deepEqual(calls.map(typeFor), [1, 28]);
  assert.ok(calls.every(call => call.options.hostname === 'cloudflare-dns.com'));
});

test('lookup supports IPv4-only NOERROR but rejects inconsistent canonical chains across A and AAAA', async t => {
  let inconsistent = false;
  stubRequests(t, (call, callback) => {
    const type = typeFor(call);
    respond(call, callback, JSON.stringify(result(type, type === 1 ? [record('93.184.216.34')] : inconsistent ? [record('alias.example.', 5)] : [])));
  });
  assert.deepEqual(await cloudflareLookup(hostname, new AbortController().signal), [{ address: '93.184.216.34', family: 4 }]);
  inconsistent = true;
  await assert.rejects(cloudflareLookup(hostname, new AbortController().signal), safeFault());
});

test('redirects, HTTP failures, wrong MIME types and compression fail closed without a follow-up URL', async t => {
  for (const [status, headers] of [[302, { location: 'https://private.example/secret' }], [500, {}], [200, { 'content-type': 'text/html' }], [200, { 'content-encoding': 'gzip' }]] as const) {
    const calls = stubRequests(t, (call, callback) => respond(call, callback, 'private-secret-response', status, headers));
    await assert.rejects(cloudflareLookup(hostname, new AbortController().signal), safeFault());
    assert.equal(calls.length, 2); assert.ok(calls.every(call => call.request.destroyed));
    t.mock.restoreAll();
  }
});

test('rejects oversized streamed/declared bodies, invalid UTF-8, and mismatched content lengths', async t => {
  for (const [body, headers] of [
    [Buffer.alloc(CLOUDFLARE_DOH_LIMITS.bytes + 1, 32), {}], ['', { 'content-length': String(CLOUDFLARE_DOH_LIMITS.bytes + 1) }],
    [Buffer.from([0xff, 0xff]), {}], ['{}', { 'content-length': '3' }], ['{}', { 'content-length': '-1' }],
  ] as [string | Buffer, IncomingMessage['headers']][]) {
    const calls = stubRequests(t, (call, callback) => respond(call, callback, body, 200, headers));
    await assert.rejects(cloudflareLookup(hostname, new AbortController().signal), safeFault());
    assert.ok(calls.every(call => call.request.destroyed)); t.mock.restoreAll();
  }
});

test('one failed DNS family fails the whole lookup rather than retaining a partial public answer', async t => {
  stubRequests(t, (call, callback) => respond(call, callback, JSON.stringify(typeFor(call) === 1 ? result() : { ...result(28, []), Status: 2 })));
  await assert.rejects(cloudflareLookup(hostname, new AbortController().signal), safeFault());
});

test('request failures and certificate failures expose only finite sanitized Fault reasons and no fallback', async t => {
  for (const [code, reason] of [['ECONNRESET', 'callback_dns_failed'], ['ENOTFOUND', 'callback_dns_failed'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'callback_tls_failed']]) {
    const calls = stubRequests(t, call => call.request.emit('error', Object.assign(new Error('private-url/path?secret=do-not-expose'), { code })));
    await assert.rejects(cloudflareLookup(hostname, new AbortController().signal), safeFault(reason));
    assert.equal(calls.length, 2); assert.ok(calls.every(call => call.request.destroyed)); t.mock.restoreAll();
  }
});

test('caller abort destroys both pending queries and does not expose a secret-bearing abort reason', async t => {
  const calls = stubRequests(t, () => {}), controller = new AbortController();
  const pending = cloudflareLookup(hostname, controller.signal);
  controller.abort(new Error('secret-abort-reason'));
  await assert.rejects(pending, safeFault('callback_timeout'));
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.request.destroyed));
});

test('already aborted lookup makes no request', async t => {
  t.mock.method(https, 'request', () => assert.fail('network call is forbidden'));
  await assert.rejects(cloudflareLookup(hostname, AbortSignal.abort('secret')), safeFault('callback_timeout'));
});

test('independent deadline aborts both queries even when caller signal never aborts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = stubRequests(t, () => {});
  const pending = cloudflareLookup(hostname, new AbortController().signal);
  t.mock.timers.tick(CLOUDFLARE_DOH_LIMITS.timeoutMs);
  await assert.rejects(pending, safeFault('callback_timeout'));
  assert.ok(calls.every(call => call.request.destroyed));
});

test('premature response close and response stream errors cannot leave a partial lookup pending', async t => {
  for (const event of ['close', 'error', 'aborted']) {
    const calls = stubRequests(t, (call, callback) => {
      const response = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'application/dns-json' }, complete: false });
      call.response = response; callback(response as unknown as IncomingMessage);
      response.emit(event, new Error('private-response-secret'));
    });
    await assert.rejects(cloudflareLookup(hostname, new AbortController().signal), safeFault());
    assert.ok(calls.every(call => call.request.destroyed)); t.mock.restoreAll();
  }
});


test('strict JSON rejects duplicate DNS fields and nested record data rather than choosing a preferred value', () => {
  const valid = JSON.stringify(result());
  for (const body of [
    valid.replace('"Status":0', '"Status":3,"Status":0'),
    valid.replace('"TC":false', '"TC":true,"TC":false'),
    valid.replace('"type":1', '"type":28,"type":1'),
    valid.replace('"data":"93.184.216.34"', '"data":"127.0.0.1","data":"93.184.216.34"'),
  ]) assert.throws(() => parseCloudflareDnsJson(body, hostname, 1), safeFault());
});
