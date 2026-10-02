// Native-side smoke driver. Fixed synthetic fixture only; no telemetry inputs.
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { privateFile } from './stores.mts';
const [dir,op,id] = process.argv.slice(2);
if (!dir || !['diagnose','result','cancel'].includes(op)) throw new Error('Usage: node client.mts <private-run-directory> diagnose|result|cancel [request-id]');
privateFile(dir,true);
const input = op === 'diagnose' ? {op,idempotency_key:id ?? randomUUID()} : {op,request_id:id};
const socket = connect(join(dir,'native.sock')); socket.setEncoding('utf8'); socket.setTimeout(10_000,() => socket.destroy(new Error('timeout')));
socket.on('connect',() => socket.write(JSON.stringify(input)+'\n'));
socket.on('data',chunk => process.stdout.write(chunk));
socket.on('error',() => { process.stderr.write('Local synthetic request failed.\n'); process.exitCode = 1; });
