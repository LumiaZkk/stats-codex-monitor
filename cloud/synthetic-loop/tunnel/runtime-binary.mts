// Exact official release bytes, not a filename or a self-reported version.
import { constants } from 'node:fs';
import { open, lstat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const RUNTIME_VERSION = '0.0.15';
export const RUNTIME_COMMIT = 'a390c168ff1b2d14e73a95991c186c6aba3ff5a0';
export const RUNTIME_ARTIFACTS = {
  'darwin-arm64': { archive: 'e416ea9ea13e1b8be0d0a355fbd28143cfa55fe5a32b2986fce1a516d7b5e2ad', binary: 'fcc8e40de0606b8909c7ee44a0816d33d616949389ff37938e2657c7a2333025' },
  'darwin-x64': { archive: '2d3a2b3a985ad2fcfddc4a82a0caa6624ee9383e7d85e82563bf1fe3ce905794', binary: 'e17ffc98dce25a31c22714875267eeb309abdb35bea450c5801272317559f033' },
  'linux-x64': { archive: 'f26f8b3ee6c335e38fa5cfbe6ce5635f53738f08a26eecf07d6cebacab4a1abf', binary: '9755c5f60f40ac64e1a71f9b7d14bc6135fb3fe7170d79c6695881d3aa1255d5' },
} as const;

async function verifiedBytes(path: string): Promise<Buffer> {
  const expected = RUNTIME_ARTIFACTS[`${process.platform}-${process.arch}` as keyof typeof RUNTIME_ARTIFACTS];
  if (!expected) throw new Error('unsupported_runtime_platform');
  // O_NONBLOCK prevents a FIFO/device candidate from hanging before fstat.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 64 * 1024 * 1024) throw new Error('invalid_runtime_binary');
    // Bound actual reads as well as the initial stat; a growing file must not
    // turn this pre-credential check into an unbounded allocation.
    const chunks: Buffer[] = []; let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65_536, stat.size + 1 - size));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > stat.size) throw new Error('invalid_runtime_binary');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== stat.size || createHash('sha256').update(bytes).digest('hex') !== expected.binary) throw new Error('unverified_runtime_binary');
    return bytes;
  } finally { await file.close(); }
}

export async function verifyRuntimeBinary(path: string): Promise<void> { await verifiedBytes(path); }

export async function prepareRuntimeBinary(path: string, privateDirectory: string): Promise<string> {
  const stat = await lstat(privateDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid!() || (stat.mode & 0o077) !== 0) throw new Error('private_runtime_directory_required');
  const bytes = await verifiedBytes(path);
  const destination = join(privateDirectory, 'verified-tunnel-client-runtime');
  await writeFile(destination, bytes, { mode: 0o700, flag: 'wx' });
  await verifyRuntimeBinary(destination);
  return destination;
}

export function runtimeVersionValid(value: string): boolean {
  return value.startsWith(RUNTIME_VERSION + ' ') && value.includes('git sha: ' + RUNTIME_COMMIT + ' ') && /(?:^| )flavor=runtime\s*$/.test(value) && !value.includes('invalid runtime build metadata');
}
