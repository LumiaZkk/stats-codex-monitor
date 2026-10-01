import type { Readable } from 'node:stream';

export async function readRuntimeKey(input: Readable, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const abort = () => input.destroy(new Error('runtime_key_input_cancelled'));
  signal?.addEventListener('abort', abort, {once:true});
  const chunks: Buffer[] = []; let bytes = 0;
  try {
  for await (const chunk of input) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > 2049) throw new Error('invalid_runtime_key');
    chunks.push(data);
  }
  const value = Buffer.concat(chunks).toString('utf8');
  if (!/^sk-[^\s]{1,2044}\n$/.test(value)) throw new Error('invalid_runtime_key');
  return value.slice(0, -1);
  } finally { signal?.removeEventListener('abort', abort); }
}

// Parsed as argv by the official stdio launcher; never interpreted by a shell.
// The OS env utility clears the inherited key before executing Node.
export function stdioRuntimeCommand(node: string, server: string, environment: Record<string, string>): string {
  if (![node, server].every(p => /^\/[a-zA-Z0-9/_.-]+$/.test(p))) throw new Error('invalid_runtime_path');
  const permitted = ['HOME','NODE_ENV','PATH','STATS_CALLBACK_RESOLVER','STATS_RUNTIME_USER_HOME','STATS_TUNNEL_RUN_DIR','XDG_CONFIG_HOME'];
  const entries = Object.entries(environment).sort(([a],[b]) => a.localeCompare(b));
  if (entries.some(([key,value]) => !permitted.includes(key) || !/^[a-zA-Z0-9/_:.-]+$/.test(value))) throw new Error('invalid_stdio_environment');
  return ['/usr/bin/env', '-i', ...entries.map(([key,value]) => `${key}=${value}`), node, server].join(' ');
}
