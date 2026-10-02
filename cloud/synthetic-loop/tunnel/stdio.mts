import { serve } from './server.mts';
const dir = process.env.STATS_TUNNEL_RUN_DIR;
if (!dir) throw new Error('private_runtime_directory_required');
try { await serve(dir); } catch { process.stderr.write('Diagnostic runtime stopped; check private access and local configuration.\n'); process.exitCode = 1; }
