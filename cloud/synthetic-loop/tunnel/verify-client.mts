import { verifyRuntimeBinary } from './runtime-binary.mts';
const [path, ...extra] = process.argv.slice(2);
try {
  if (!path || extra.length) throw new Error('invalid_arguments');
  await verifyRuntimeBinary(path);
} catch {
  process.stderr.write('The pinned runtime-only client is required. No key was requested and no candidate binary was executed.\n');
  process.exitCode = 1;
}
