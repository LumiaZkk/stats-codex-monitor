import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { publishRuntimeDescriptor, RUNTIME_DESCRIPTOR_LIMIT, RUNTIME_DESCRIPTOR_MAX_BYTES, RUNTIME_DIRECTORY_ENTRY_LIMIT, runtimeDescriptorCachePath, validateRuntimeDescriptor } from '../tunnel/rendezvous.mts';
import type { RuntimeDescriptor, RuntimePublicationOptions } from '../tunnel/rendezvous.mts';

const NOW = Date.parse('2026-10-01T01:02:03.000Z');
const uid = process.geteuid!();
const errorWithCode = (code: string) => Object.assign(new Error(code), { code });
function setup() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'stats-rendezvous-')));
  chmodSync(home, 0o700);
  const directory = runtimeDescriptorCachePath(home);
  const descriptor = (overrides: Partial<RuntimeDescriptor> = {}): RuntimeDescriptor => ({
    schema_version: 1, kind: 'stats_runtime_descriptor', instance_id: randomUUID(), protocol_version: 2,
    uid, runtime_pid: process.pid, started_at: new Date(NOW - 1000).toISOString(),
    expires_at: new Date(NOW + 60_000).toISOString(), scope_hash: 'a'.repeat(64), socket_path: join(home, 'native.sock'), ...overrides,
  });
  const options: RuntimePublicationOptions = { home, now: () => NOW };
  const prepare = () => mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = (value: RuntimeDescriptor) => join(directory, `${value.instance_id}.json`);
  const write = (value: RuntimeDescriptor, name = `${value.instance_id}.json`) => {
    prepare(); const result = join(directory, name);
    writeFileSync(result, JSON.stringify(value) + '\n', { mode: 0o600 }); return result;
  };
  return { home, directory, descriptor, options, prepare, path, write, close: () => rmSync(home, { recursive: true, force: true }) };
}

test('publishes only the frozen nonsecret descriptor with private modes and idempotent synchronous removal', () => {
  const s = setup();
  try {
    const descriptor = s.descriptor(), cleanup = publishRuntimeDescriptor(descriptor, s.options);
    assert.equal(typeof cleanup, 'function');
    assert.deepEqual(JSON.parse(readFileSync(s.path(descriptor), 'utf8')), descriptor);
    assert.deepEqual(readdirSync(s.directory), [`${descriptor.instance_id}.json`]);
    for (const path of [s.directory, dirname(s.directory)]) {
      const stat = lstatSync(path); assert.equal(stat.uid, uid); assert.equal(stat.mode & 0o7777, 0o700);
    }
    const stat = lstatSync(s.path(descriptor)); assert.equal(stat.uid, uid); assert.equal(stat.mode & 0o7777, 0o600);
    assert.equal(stat.nlink, 1); assert.equal(cleanup(), undefined); assert.equal(cleanup(), undefined);
    assert.deepEqual(readdirSync(s.directory), []);
  } finally { s.close(); }
});

test('the default cache path uses the account home rather than mutable child HOME', () => {
  const previous = process.env.HOME;
  try {
    process.env.HOME = '/this-is-an-isolated-child-home';
    assert.equal(runtimeDescriptorCachePath(), join(userInfo().homedir, 'Library/Caches/stats-codex-monitor/runtime-v1'));
    assert.throws(() => runtimeDescriptorCachePath('relative-home'), /unsafe_runtime_home/);
    assert.throws(() => runtimeDescriptorCachePath('/tmp/../tmp/home'), /unsafe_runtime_home/);
  } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; }
});

test('schema rejects unknown fields, malformed identifiers, timestamps, protocol, path and numbers', () => {
  const s = setup();
  try {
    const base = s.descriptor(); validateRuntimeDescriptor(base);
    for (const change of [
      { schema_version: 2 }, { kind: 'other' }, { protocol_version: 1 }, { access_token: 'never-publish' },
      { instance_id: base.instance_id.toUpperCase() }, { instance_id: '00000000-0000-0000-0000-000000000000' },
      { uid: -1 }, { uid: 0.5 }, { uid: 0x1_0000_0000 }, { runtime_pid: 0 }, { runtime_pid: 0x8000_0000 }, { runtime_pid: Number.MAX_SAFE_INTEGER + 1 },
      { started_at: '2026-02-30T01:02:03.000Z' }, { started_at: '2026-10-01T01:02:02Z' },
      { started_at: '2026-10-01T01:02:02.000+00:00' }, { expires_at: base.started_at }, { expires_at: new Date(NOW + 3_600_000).toISOString() },
      { scope_hash: 'A'.repeat(64) }, { scope_hash: 'a'.repeat(63) },
      { socket_path: 'native.sock' }, { socket_path: '/tmp/../native.sock' }, { socket_path: '/tmp/a\0b' },
    ]) assert.throws(() => validateRuntimeDescriptor({ ...base, ...change }), /invalid_runtime_descriptor/, JSON.stringify(change));
    const { uid: _uid, ...missing } = base; assert.throws(() => validateRuntimeDescriptor(missing));
    for (const value of [null, [], Object.create(base), { ...base, [Symbol('secret')]: true }]) assert.throws(() => validateRuntimeDescriptor(value));
    const accessor = { ...base }; Object.defineProperty(accessor, 'uid', { get() { throw new Error('getter should not run'); }, enumerable: true });
    assert.throws(() => validateRuntimeDescriptor(accessor), /invalid_runtime_descriptor/);
  } finally { s.close(); }
});

test('schema enforces the total UTF-8 byte limit including the publication newline', () => {
  const s = setup();
  try {
    const base = s.descriptor({ socket_path: '/' });
    const budget = RUNTIME_DESCRIPTOR_MAX_BYTES - Buffer.byteLength(JSON.stringify(base)) - 1;
    const boundary = { ...base, socket_path: '/' + 'x'.repeat(budget) };
    validateRuntimeDescriptor(boundary);
    assert.equal(Buffer.byteLength(JSON.stringify(boundary)) + 1, RUNTIME_DESCRIPTOR_MAX_BYTES);
    assert.throws(() => validateRuntimeDescriptor({ ...boundary, socket_path: boundary.socket_path + 'x' }), /invalid_runtime_descriptor/);
    assert.throws(() => validateRuntimeDescriptor({ ...base, socket_path: '/' + '界'.repeat(budget) }), /invalid_runtime_descriptor/);
  } finally { s.close(); }
});

test('publication binds the current effective UID and process PID and rejects stale or future identity', () => {
  const s = setup();
  try {
    for (const change of [{ uid: uid + 1 }, { runtime_pid: process.pid + 1 }]) {
      assert.throws(() => publishRuntimeDescriptor(s.descriptor(change), s.options), /runtime_identity_mismatch/);
    }
    assert.throws(() => publishRuntimeDescriptor(s.descriptor({ expires_at: new Date(NOW).toISOString() }), s.options), /runtime_descriptor_expired/);
    assert.throws(() => publishRuntimeDescriptor(s.descriptor({ started_at: new Date(NOW + 2000).toISOString() }), s.options), /runtime_descriptor_expired/);
    assert.equal(existsSync(s.directory), false);
  } finally { s.close(); }
});

test('existing home/Library/Caches can be user-owned 0755 while app directories must be exactly 0700', () => {
  const s = setup();
  try {
    chmodSync(s.home, 0o755);
    mkdirSync(join(s.home, 'Library/Caches'), { recursive: true, mode: 0o755 });
    const cleanup = publishRuntimeDescriptor(s.descriptor(), s.options); cleanup();
    chmodSync(s.directory, 0o755);
    assert.throws(() => publishRuntimeDescriptor(s.descriptor(), s.options), /unsafe_runtime_directory/);
    assert.equal(lstatSync(s.directory).mode & 0o7777, 0o755);
    chmodSync(s.directory, 0o700); chmodSync(dirname(s.directory), 0o770);
    assert.throws(() => publishRuntimeDescriptor(s.descriptor(), s.options), /unsafe_runtime_directory/);
    chmodSync(dirname(s.directory), 0o700); chmodSync(join(s.home, 'Library'), 0o777);
    assert.throws(() => publishRuntimeDescriptor(s.descriptor(), s.options), /unsafe_runtime_directory/);
  } finally { s.close(); }
});

test('rejects symbolic links at home, intermediate directories and descriptor entries without following them', () => {
  const s = setup(), outside = setup();
  try {
    const linkedHome = join(outside.home, 'linked-home'); symlinkSync(s.home, linkedHome);
    assert.throws(() => publishRuntimeDescriptor(s.descriptor(), { ...s.options, home: linkedHome }), /unsafe_runtime_directory/);
    symlinkSync(outside.home, join(s.home, 'Library'));
    assert.throws(() => publishRuntimeDescriptor(s.descriptor(), s.options), /unsafe_runtime_directory/);
    assert.deepEqual(readdirSync(outside.home), ['linked-home']);
    rmSync(join(s.home, 'Library')); s.prepare();
    const stale = s.descriptor({ expires_at: new Date(NOW).toISOString() });
    const externalFile = outside.write(stale); symlinkSync(externalFile, s.path(stale));
    assert.throws(() => publishRuntimeDescriptor(s.descriptor(), s.options), /unsafe_runtime_descriptor_file/);
    assert.ok(lstatSync(s.path(stale)).isSymbolicLink()); assert.ok(existsSync(externalFile));
  } finally { s.close(); outside.close(); }
});

test('rejects unsafe ownership of a home and descriptor without chmod, chown or deletion', { skip: uid !== 0 }, () => {
  const s = setup();
  try {
    chownSync(s.home, 1, 1);
    assert.throws(() => publishRuntimeDescriptor(s.descriptor(), s.options), /unsafe_runtime_directory/);
    assert.equal(lstatSync(s.home).uid, 1); chownSync(s.home, uid, process.getegid!());
    const old = s.descriptor({ expires_at: new Date(NOW).toISOString() }), path = s.write(old); chownSync(path, 1, 1);
    assert.throws(() => publishRuntimeDescriptor(s.descriptor(), s.options), /unsafe_runtime_descriptor_file/);
    assert.equal(lstatSync(path).uid, 1); assert.ok(existsSync(path));
  } finally { s.close(); }
});

test('foreign descriptor and cache ownership fail closed without requiring root privileges', t => {
  const s = setup(); const original = fs.lstatSync;
  try {
    const old = s.descriptor({ expires_at: new Date(NOW).toISOString() }), path = s.write(old);
    for (const foreignPath of [path, s.directory]) {
      const mock = t.mock.method(fs, 'lstatSync', ((...args: Parameters<typeof fs.lstatSync>) => {
        const stat = original(...args);
        if (String(args[0]) === foreignPath) Object.defineProperty(stat, 'uid', { value: uid + 1 });
        return stat;
      }) as typeof fs.lstatSync);
      syncBuiltinESMExports();
      try { assert.throws(() => publishRuntimeDescriptor(s.descriptor(), s.options), /unsafe_runtime_(descriptor_file|directory)/); }
      finally { mock.mock.restore(); syncBuiltinESMExports(); }
      assert.ok(existsSync(path)); assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), old);
    }
  } finally { s.close(); }
});

test('does not delete unsafe modes, malformed JSON, oversized files, duplicate keys or filename binding mismatches', () => {
  const s = setup();
  try {
    for (const mutation of ['mode', 'json', 'oversize', 'duplicate', 'filename', 'uid', 'extra', 'invalid-utf8']) {
      const stale = s.descriptor({ expires_at: new Date(NOW).toISOString() }), path = s.write(stale);
      if (mutation === 'mode') chmodSync(path, 0o644);
      if (mutation === 'json') writeFileSync(path, '{');
      if (mutation === 'oversize') writeFileSync(path, 'x'.repeat(RUNTIME_DESCRIPTOR_MAX_BYTES + 1));
      if (mutation === 'duplicate') writeFileSync(path, JSON.stringify(stale).replace('"schema_version":1', '"schema_version":1,"schema_version":1'));
      if (mutation === 'filename') writeFileSync(path, JSON.stringify({ ...stale, instance_id: randomUUID() }));
      if (mutation === 'uid') writeFileSync(path, JSON.stringify({ ...stale, uid: uid + 1 }));
      if (mutation === 'extra') writeFileSync(path, JSON.stringify({ ...stale, credential: 'invalid-extra-field' }));
      if (mutation === 'invalid-utf8') writeFileSync(path, Buffer.from([0xff]));
      const before = readFileSync(path);
      assert.throws(() => publishRuntimeDescriptor(s.descriptor(), s.options), Error, mutation);
      assert.ok(readFileSync(path).equals(before), mutation); rmSync(path);
      assert.deepEqual(readdirSync(s.directory), []);
    }
  } finally { s.close(); }
});

test('preserves arbitrary files and scans only one directory with a fixed entry bound', () => {
  const s = setup();
  try {
    const unrelated = s.write(s.descriptor({ expires_at: new Date(NOW).toISOString() }), 'notes.json');
    const nested = join(s.directory, 'unrelated-folder'); mkdirSync(nested, { mode: 0o700 });
    writeFileSync(join(nested, 'keep.txt'), 'keep');
    const cleanup = publishRuntimeDescriptor(s.descriptor(), s.options); cleanup();
    assert.ok(existsSync(unrelated)); assert.equal(readFileSync(join(nested, 'keep.txt'), 'utf8'), 'keep');
    for (let index = 0; index <= RUNTIME_DIRECTORY_ENTRY_LIMIT; index++) writeFileSync(join(s.directory, `keep-${index}`), 'keep');
    const before = readdirSync(s.directory).sort();
    assert.throws(() => publishRuntimeDescriptor(s.descriptor(), s.options), /runtime_directory_entry_limit/);
    assert.deepEqual(readdirSync(s.directory).sort(), before);
  } finally { s.close(); }
});

test('live instance collision fails closed with no overwrite or leftover temporary files', () => {
  const s = setup();
  try {
    const first = s.descriptor(), cleanup = publishRuntimeDescriptor(first, s.options), path = s.path(first);
    const inode = lstatSync(path).ino, bytes = readFileSync(path);
    assert.throws(() => publishRuntimeDescriptor({ ...first, scope_hash: 'b'.repeat(64) }, s.options), /runtime_descriptor_conflict/);
    assert.equal(lstatSync(path).ino, inode); assert.ok(readFileSync(path).equals(bytes));
    assert.deepEqual(readdirSync(s.directory), [`${first.instance_id}.json`]); cleanup();
  } finally { s.close(); }
});

test('hard-link install still refuses a destination created after the bounded scan', () => {
  const s = setup();
  try {
    const existing = s.descriptor(), desired = s.descriptor(); s.write(existing);
    const competitor = { ...desired, scope_hash: 'b'.repeat(64) };
    assert.throws(() => publishRuntimeDescriptor(desired, { ...s.options, probePid: () => { s.write(competitor); } }), /runtime_descriptor_conflict/);
    assert.deepEqual(JSON.parse(readFileSync(s.path(desired), 'utf8')), competitor);
    assert.deepEqual(readdirSync(s.directory).sort(), [`${existing.instance_id}.json`, `${desired.instance_id}.json`].sort());
  } finally { s.close(); }
});

test('max eight live descriptors; EPERM and other PID errors never mean dead', () => {
  for (const code of ['EPERM', 'EACCES', 'EINVAL']) {
    const s = setup();
    try {
      for (let index = 0; index < RUNTIME_DESCRIPTOR_LIMIT; index++) s.write(s.descriptor());
      const before = readdirSync(s.directory).sort();
      assert.throws(() => publishRuntimeDescriptor(s.descriptor(), { ...s.options, probePid: () => { throw errorWithCode(code); } }), /runtime_descriptor_limit/);
      assert.deepEqual(readdirSync(s.directory).sort(), before);
    } finally { s.close(); }
  }
});

test('removes validated expired or demonstrably absent PID records before enforcing the limit', () => {
  const s = setup();
  try {
    const expired = s.descriptor({ expires_at: new Date(NOW).toISOString() }); s.write(expired);
    const dead = s.descriptor({ runtime_pid: process.pid + 100_000 }); s.write(dead);
    for (let index = 0; index < RUNTIME_DESCRIPTOR_LIMIT - 2; index++) s.write(s.descriptor());
    const fresh = s.descriptor(), cleanup = publishRuntimeDescriptor(fresh, { ...s.options, probePid: pid => {
      if (pid === dead.runtime_pid) throw errorWithCode('ESRCH'); throw errorWithCode('EPERM');
    } });
    assert.equal(existsSync(s.path(expired)), false); assert.equal(existsSync(s.path(dead)), false);
    assert.equal(readdirSync(s.directory).length, RUNTIME_DESCRIPTOR_LIMIT - 1); cleanup();
  } finally { s.close(); }
});

test('stale cleanup never deletes a fresh replacement inode observed during PID probing', () => {
  const s = setup();
  try {
    const old = s.descriptor({ runtime_pid: process.pid + 100_000 }), path = s.write(old);
    const replacement = { ...old, runtime_pid: process.pid };
    assert.throws(() => publishRuntimeDescriptor(s.descriptor(), { ...s.options, probePid: pid => {
      assert.equal(pid, old.runtime_pid); renameSync(path, path + '.old'); s.write(replacement); throw errorWithCode('ESRCH');
    } }), /runtime_descriptor_replaced/);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), replacement);
  } finally { s.close(); }
});

test('shutdown cleanup preserves replacement inode, changed identity and changed bytes', () => {
  for (const replacement of ['inode', 'identity', 'bytes']) {
    const s = setup();
    try {
      const first = s.descriptor(), cleanup = publishRuntimeDescriptor(first, s.options), path = s.path(first);
      if (replacement === 'inode') { renameSync(path, path + '.old'); s.write(first); }
      if (replacement === 'identity') writeFileSync(path, JSON.stringify({ ...first, instance_id: randomUUID() }) + '\n');
      if (replacement === 'bytes') writeFileSync(path, JSON.stringify({ ...first, scope_hash: 'b'.repeat(64) }) + '\n');
      const expected = readFileSync(path); cleanup(); cleanup(); assert.ok(readFileSync(path).equals(expected));
    } finally { s.close(); }
  }
});

test('shutdown cleanup leaves a symlink or replaced containing directory untouched', () => {
  const s = setup(), outside = setup();
  try {
    const first = s.descriptor(), cleanup = publishRuntimeDescriptor(first, s.options), path = s.path(first);
    renameSync(path, path + '.old'); const external = outside.write(first); symlinkSync(external, path);
    cleanup(); assert.ok(lstatSync(path).isSymbolicLink()); assert.ok(existsSync(external));
    rmSync(path); const second = s.descriptor(), cleanup2 = publishRuntimeDescriptor(second, s.options);
    renameSync(s.directory, s.directory + '.old'); s.prepare(); s.write(second);
    cleanup2(); assert.ok(existsSync(s.path(second)));
  } finally { s.close(); outside.close(); }
});

test('publication lock rejects live, denied, malformed and symlink holders; recovers only a validated dead holder', () => {
  for (const state of ['live', 'EPERM', 'malformed', 'symlink', 'dead']) {
    const s = setup();
    try {
      s.prepare(); const path = join(s.directory, '.publication.lock');
      const lock = { schema_version: 1, kind: 'stats_runtime_publication_lock', instance_id: randomUUID(), uid, runtime_pid: process.pid + 100_000 };
      if (state === 'symlink') symlinkSync('/does-not-exist', path);
      else writeFileSync(path, state === 'malformed' ? '{}' : JSON.stringify(lock), { mode: 0o600 });
      const options = { ...s.options, probePid: () => { if (state === 'dead') throw errorWithCode('ESRCH'); if (state === 'EPERM') throw errorWithCode('EPERM'); } };
      if (state === 'dead') { const cleanup = publishRuntimeDescriptor(s.descriptor(), options); assert.equal(existsSync(path), false); cleanup(); }
      else { assert.throws(() => publishRuntimeDescriptor(s.descriptor(), options)); assert.ok(lstatSync(path)); }
      assert.equal(readdirSync(s.directory).filter(name => name.endsWith('.tmp')).length, 0);
    } finally { s.close(); }
  }
});

test('a crashed process descriptor is reclaimed using the real OS ESRCH probe', () => {
  const s = setup();
  try {
    const descriptor = s.descriptor();
    const script = `import {publishRuntimeDescriptor} from ${JSON.stringify(new URL('../tunnel/rendezvous.mts', import.meta.url).href)};
      publishRuntimeDescriptor({...${JSON.stringify(descriptor)},runtime_pid:process.pid},${JSON.stringify({ home: s.home })});`;
    // Use current timestamps because this child intentionally uses production time.
    const current = new Date().toISOString(), future = new Date(Date.now() + 60_000).toISOString();
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script.replace(descriptor.started_at, current).replace(descriptor.expires_at, future)], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); assert.ok(existsSync(s.path(descriptor)));
    const cleanup = publishRuntimeDescriptor(s.descriptor(), s.options);
    assert.equal(existsSync(s.path(descriptor)), false); cleanup();
  } finally { s.close(); }
});

test('concurrent publishers cannot exceed eight descriptors or overwrite one another', async () => {
  const s = setup(); const workers: Worker[] = [];
  try {
    for (let index = 0; index < RUNTIME_DESCRIPTOR_LIMIT - 1; index++) s.write(s.descriptor());
    const gate = new SharedArrayBuffer(4), signal = new Int32Array(gate);
    const ready: Promise<void>[] = [], finished: Promise<{ ok: boolean; reason?: string }>[] = [];
    for (let index = 0; index < 8; index++) {
      const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
        import(workerData.module).then(({publishRuntimeDescriptor})=>{
          parentPort.postMessage('ready'); Atomics.wait(new Int32Array(workerData.gate),0,0);
          try {publishRuntimeDescriptor(workerData.descriptor,{home:workerData.home,now:()=>workerData.now});parentPort.postMessage({ok:true});}
          catch(error){parentPort.postMessage({ok:false,reason:error.message});}
        }).catch(error=>{throw error;});`, { eval: true, workerData: {
          module: new URL('../tunnel/rendezvous.mts', import.meta.url).href, descriptor: s.descriptor(), home: s.home, now: NOW, gate,
        } });
      workers.push(worker);
      ready.push(new Promise((resolve, reject) => { worker.on('message', value => { if (value === 'ready') resolve(); }); worker.once('error', reject); }));
      finished.push(new Promise((resolve, reject) => { worker.on('message', value => { if (value !== 'ready') resolve(value); }); worker.once('error', reject); }));
    }
    await Promise.all(ready); Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
    const results = await Promise.all(finished);
    assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
    for (const result of results) if (!result.ok) assert.match(result.reason!, /runtime_publication_busy|runtime_descriptor_limit|ENOENT/);
    assert.equal(readdirSync(s.directory).length, RUNTIME_DESCRIPTOR_LIMIT);
    assert.equal(new Set(readdirSync(s.directory)).size, RUNTIME_DESCRIPTOR_LIMIT);
    for (const name of readdirSync(s.directory)) {
      assert.match(name, /\.json$/); assert.equal(lstatSync(join(s.directory, name)).nlink, 1);
    }
  } finally { await Promise.all(workers.map(worker => worker.terminate())); s.close(); }
});
