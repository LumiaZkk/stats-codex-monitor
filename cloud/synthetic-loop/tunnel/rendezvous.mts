// Same-UID discovery metadata, never credentials or telemetry. The caller must
// validate its private socket and verified scope before publishing. Processes
// running as the same UID remain the trust boundary, including pathname races.
import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, normalize, parse, relative, sep } from 'node:path';
import { Fault } from '../bridge/core.mts';
import { parseStrictJson } from '../bridge/json.mts';

export const RUNTIME_DESCRIPTOR_MAX_BYTES = 4096;
export const RUNTIME_DESCRIPTOR_LIMIT = 8;
export const RUNTIME_DIRECTORY_ENTRY_LIMIT = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LOCK_NAME = '.publication.lock';
const DESCRIPTOR_KEYS = 'expires_at,instance_id,kind,protocol_version,runtime_pid,schema_version,scope_hash,socket_path,started_at,uid';

export type RuntimeIdentity = {
  instance_id: string; protocol_version: 2; uid: number; runtime_pid: number;
  started_at: string; expires_at: string; scope_hash: string;
};
export type RuntimeDescriptor = RuntimeIdentity & {
  schema_version: 1; kind: 'stats_runtime_descriptor'; socket_path: string;
};
export type RuntimePublicationOptions = {
  // The runner can preserve the actual user home before isolating child HOME.
  // An explicitly supplied home undergoes exactly the same production checks.
  home?: string; now?: () => number; probePid?: (pid: number) => void;
};
type RecordFile<T> = { stat: Stats; value: T; bytes: Buffer };
type PublicationLock = { schema_version: 1; kind: 'stats_runtime_publication_lock'; instance_id: string; uid: number; runtime_pid: number };

const fail = (reason: string): never => { throw new Fault(reason); };
const errno = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;
const sameInode = (left: Stats, right: Stats) => left.dev === right.dev && left.ino === right.ino;
function effectiveUid() {
  if (!process.geteuid) return fail('runtime_rendezvous_unavailable');
  return process.geteuid();
}
function ownDataObject(value: unknown, keys: string): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).every(key => typeof key === 'string')
    && Object.getOwnPropertyNames(value).sort().join(',') === keys
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(field => 'value' in field && field.enumerable);
}
function canonicalInstant(value: unknown): value is string {
  return typeof value === 'string' && INSTANT.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function validateRuntimeDescriptor(value: unknown): asserts value is RuntimeDescriptor {
  if (!ownDataObject(value, DESCRIPTOR_KEYS)
    || value.schema_version !== 1 || value.kind !== 'stats_runtime_descriptor' || value.protocol_version !== 2
    || typeof value.instance_id !== 'string' || !UUID.test(value.instance_id)
    || !Number.isSafeInteger(value.uid) || (value.uid as number) < 0 || (value.uid as number) > 0xffff_ffff
    || !Number.isSafeInteger(value.runtime_pid) || (value.runtime_pid as number) <= 0 || (value.runtime_pid as number) > 0x7fff_ffff
    || !canonicalInstant(value.started_at) || !canonicalInstant(value.expires_at)
    || Date.parse(value.expires_at) <= Date.parse(value.started_at) || Date.parse(value.expires_at) - Date.parse(value.started_at) > 3_600_000
    || typeof value.scope_hash !== 'string' || !/^[0-9a-f]{64}$/.test(value.scope_hash)
    || typeof value.socket_path !== 'string' || !isAbsolute(value.socket_path) || value.socket_path.includes('\0')
    || normalize(value.socket_path) !== value.socket_path
    || Buffer.byteLength(JSON.stringify(value)) + 1 > RUNTIME_DESCRIPTOR_MAX_BYTES) fail('invalid_runtime_descriptor');
}
function validateLock(value: unknown): asserts value is PublicationLock {
  if (!ownDataObject(value, 'instance_id,kind,runtime_pid,schema_version,uid')
    || value.schema_version !== 1 || value.kind !== 'stats_runtime_publication_lock'
    || typeof value.instance_id !== 'string' || !UUID.test(value.instance_id)
    || !Number.isSafeInteger(value.uid) || (value.uid as number) < 0 || (value.uid as number) > 0xffff_ffff
    || !Number.isSafeInteger(value.runtime_pid) || (value.runtime_pid as number) <= 0 || (value.runtime_pid as number) > 0x7fff_ffff) fail('unsafe_runtime_publication_lock');
}
export function runtimeDescriptorCachePath(home: string = userInfo().homedir): string {
  if (!isAbsolute(home) || normalize(home) !== home || home.includes('\0')) fail('unsafe_runtime_home');
  return join(home, 'Library', 'Caches', 'stats-codex-monitor', 'runtime-v1');
}
function checkDirectory(path: string, uid: number, privateMode: boolean): Stats {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid
    || (privateMode ? (stat.mode & 0o7777) !== 0o700 : (stat.mode & 0o022) !== 0)) fail('unsafe_runtime_directory');
  return stat;
}
function checkAncestors(path: string) {
  let current = parse(path).root;
  for (const component of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe_runtime_directory');
  }
}
function prepareDirectory(home: string, uid: number): { path: string; stat: Stats; check: () => void } {
  const path = runtimeDescriptorCachePath(home);
  checkAncestors(home); checkDirectory(home, uid, false);
  let current = home;
  for (const [index, component] of ['Library', 'Caches', 'stats-codex-monitor', 'runtime-v1'].entries()) {
    current = join(current, component);
    try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if (!errno(error, 'EEXIST')) throw error; }
    checkDirectory(current, uid, index >= 2);
  }
  const stat = checkDirectory(path, uid, true);
  const check = () => {
    checkAncestors(path);
    checkDirectory(home, uid, false);
    checkDirectory(join(home, 'Library'), uid, false);
    checkDirectory(join(home, 'Library', 'Caches'), uid, false);
    checkDirectory(dirname(path), uid, true);
    if (!sameInode(stat, checkDirectory(path, uid, true))) fail('runtime_directory_replaced');
  };
  return { path, stat, check };
}
function checkFile(stat: Stats, uid: number) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600
    || stat.size === 0 || stat.size > RUNTIME_DESCRIPTOR_MAX_BYTES) fail('unsafe_runtime_descriptor_file');
}
function readRecord<T>(path: string, uid: number, validate: (value: unknown) => asserts value is T): RecordFile<T> {
  const before = lstatSync(path); checkFile(before, uid);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd); checkFile(stat, uid);
    if (!sameInode(before, stat)) fail('runtime_descriptor_replaced');
    const bytes = Buffer.alloc(RUNTIME_DESCRIPTOR_MAX_BYTES + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    const after = fstatSync(fd); checkFile(after, uid);
    if (length !== stat.size || length !== after.size || !sameInode(stat, after)) fail('runtime_descriptor_replaced');
    const content = bytes.subarray(0, length);
    // A fatal UTF-8 decoder prevents replacement characters from changing bytes.
    const value = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(content)); validate(value);
    return { stat, value, bytes: content };
  } finally { closeSync(fd); }
}
function readDescriptor(path: string, uid: number, filename: string) {
  const record = readRecord(path, uid, validateRuntimeDescriptor);
  if (filename !== `${record.value.instance_id}.json` || record.value.uid !== uid) fail('runtime_descriptor_binding_mismatch');
  return record;
}
function removeRecord<T>(path: string, record: RecordFile<T>, uid: number, validate: (value: unknown) => asserts value is T, checkDirectoryIdentity: () => void): boolean {
  try {
    checkDirectoryIdentity();
    const current = readRecord(path, uid, validate);
    if (!sameInode(current.stat, record.stat) || !current.bytes.equals(record.bytes)) return false;
    // The final lstat catches replacement during validation. Directory ownership
    // excludes other users; this is not protection against a hostile same UID.
    checkDirectoryIdentity();
    const latest = lstatSync(path); checkFile(latest, uid);
    if (!sameInode(latest, record.stat)) return false;
    unlinkSync(path); return true;
  } catch { return false; }
}
function processAbsent(pid: number, probePid: (pid: number) => void): boolean {
  try { probePid(pid); return false; } catch (error) { return errno(error, 'ESRCH'); }
}
function boundedEntries(path: string): string[] {
  const directory = opendirSync(path, { bufferSize: RUNTIME_DIRECTORY_ENTRY_LIMIT + 1 });
  const names: string[] = [];
  try {
    for (;;) {
      const entry = directory.readSync(); if (!entry) break;
      names.push(entry.name);
      if (names.length > RUNTIME_DIRECTORY_ENTRY_LIMIT) fail('runtime_directory_entry_limit');
    }
  } finally { directory.closeSync(); }
  return names;
}
function writePrivateRecord<T>(path: string, value: T, uid: number, checkDirectoryIdentity: () => void): RecordFile<T> {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const created = fstatSync(fd);
  try {
    writeFileSync(fd, bytes); fsyncSync(fd);
    const stat = fstatSync(fd); checkFile(stat, uid);
    return { stat, value, bytes };
  } catch (error) {
    // An incomplete write cannot pass the schema reader. Only this exclusively
    // created inode may be removed, after checking its directory and ownership.
    try {
      checkDirectoryIdentity(); const current = lstatSync(path);
      if (current.isFile() && current.uid === uid && sameInode(current, created)) unlinkSync(path);
    } catch { /* Preserve anything whose identity cannot be proved. */ }
    throw error;
  } finally { closeSync(fd); }
}
function acquireLock(directory: ReturnType<typeof prepareDirectory>, descriptor: RuntimeDescriptor, uid: number, probePid: (pid: number) => void): () => void {
  const path = join(directory.path, LOCK_NAME);
  const value: PublicationLock = { schema_version: 1, kind: 'stats_runtime_publication_lock', instance_id: descriptor.instance_id, uid, runtime_pid: process.pid };
  const tempPath = join(directory.path, `.publication-${randomUUID()}.tmp`);
  directory.check();
  const temp = writePrivateRecord(tempPath, value, uid, directory.check);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      directory.check();
      try {
        linkSync(tempPath, path);
        return () => { removeRecord(path, temp, uid, validateLock, directory.check); };
      } catch (error) {
        if (!errno(error, 'EEXIST')) throw error;
        const existing = readRecord(path, uid, validateLock);
        if (existing.value.uid !== uid || !processAbsent(existing.value.runtime_pid, probePid)) fail('runtime_publication_busy');
        // Publication locks are distinct internal metadata. Their exact schema,
        // own UID, instance, bytes and inode must match before stale recovery.
        if (!removeRecord(path, existing, uid, validateLock, directory.check)) fail('runtime_publication_busy');
      }
    }
    return fail('runtime_publication_busy');
  } finally { removeRecord(tempPath, temp, uid, validateLock, directory.check); }
}

/** Publish only after the caller has opened and verified its socket. Synchronous
 * cleanup is idempotent and safe for both normal finally and process exit. */
export function publishRuntimeDescriptor(descriptor: RuntimeDescriptor, options: RuntimePublicationOptions = {}): () => void {
  validateRuntimeDescriptor(descriptor);
  const uid = effectiveUid(), now = (options.now ?? Date.now)();
  if (descriptor.uid !== uid || descriptor.runtime_pid !== process.pid) fail('runtime_identity_mismatch');
  if (!Number.isFinite(now) || Date.parse(descriptor.started_at) > now + 1000 || Date.parse(descriptor.expires_at) <= now) fail('runtime_descriptor_expired');
  const home = options.home ?? userInfo().homedir;
  const directory = prepareDirectory(home, uid);
  const probePid = options.probePid ?? ((pid: number) => { process.kill(pid, 0); });
  // Bound even junk entries before creating any transient publication files.
  boundedEntries(directory.path);
  const releaseLock = acquireLock(directory, descriptor, uid, probePid);
  let published: RecordFile<RuntimeDescriptor> | undefined;
  const destination = join(directory.path, `${descriptor.instance_id}.json`);
  try {
    let count = 0;
    for (const filename of boundedEntries(directory.path)) {
      if (!filename.endsWith('.json') || !UUID.test(filename.slice(0, -5))) continue;
      const path = join(directory.path, filename);
      const existing = readDescriptor(path, uid, filename);
      const stale = Date.parse(existing.value.expires_at) <= now || processAbsent(existing.value.runtime_pid, probePid);
      if (stale) {
        if (!removeRecord(path, existing, uid, validateRuntimeDescriptor, directory.check)) fail('runtime_descriptor_replaced');
      } else {
        count++;
        if (filename === `${descriptor.instance_id}.json`) fail('runtime_descriptor_conflict');
      }
    }
    if (count >= RUNTIME_DESCRIPTOR_LIMIT) fail('runtime_descriptor_limit');
    const tempPath = join(directory.path, `.descriptor-${randomUUID()}.tmp`);
    directory.check();
    const temp = writePrivateRecord(tempPath, descriptor, uid, directory.check);
    try {
      directory.check();
      try { linkSync(tempPath, destination); } catch (error) {
        if (errno(error, 'EEXIST')) fail('runtime_descriptor_conflict');
        throw error;
      }
      published = temp;
    } finally { removeRecord(tempPath, temp, uid, validateRuntimeDescriptor, directory.check); }
  } finally { releaseLock(); }
  let cleaned = false;
  return () => {
    if (cleaned) return; cleaned = true;
    if (published) removeRecord(destination, published, uid, validateRuntimeDescriptor, directory.check);
  };
}
