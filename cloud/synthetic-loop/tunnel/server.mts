// Real synthetic-only private runtime. Its owner boundary is the verified exclusive
// personal tunnel, not an invented per-request header or an unauthenticated web port.
import { readFileSync, chmodSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { join } from 'node:path';
import { Bridge, Fault, createSchema, object, requestArgsSchema, validate } from '../bridge/core.mts';
import { Events } from '../bridge/events.mts';
import type { SafePost } from '../bridge/events.mts';
import { pinnedHttpsPost } from '../bridge/node-https.mts';
import { rpc } from '../bridge/mcp.mts';
import { parseStrictJson } from '../bridge/json.mts';
import { leasePrincipal } from './identity.mts';
import { RuntimeStore, privateFile } from './stores.mts';

export class SyntheticRuntime {
  store: RuntimeStore; bridge: Bridge; events: Events; access: () => string; busy = false;
  constructor(store: RuntimeStore, access: () => string, post: SafePost = pinnedHttpsPost) {
    this.store = store; this.access = access; this.bridge = new Bridge(store.requests);
    this.events = new Events(store.subscriptions, post, async owner => { try { return access() === owner; } catch { return false; } });
  }
  async create(input: unknown) { const result = await this.bridge.create(this.access(), input); void this.pump(); return result; }
  async pump() {
    if (this.busy) return; this.busy = true;
    try {
      const owner = this.access();
      for (const id of this.store.pending(owner)) {
        const event = await this.bridge.event(owner,id);
        for (const sub of this.store.active(owner)) {
          if (!this.store.begin(event.eventId,sub.id)) continue;
          try { await this.events.deliver(owner,sub.id,event,async () => this.access() === owner && (await this.bridge.read(owner,id)).status === 'requested'); this.store.acknowledge(event.eventId,sub.id); }
          catch (e) { if(e instanceof Fault && ['callback_rejected','callback_gone','subscription_not_found','subscription_inactive','request_terminal','event_filter_mismatch'].includes(e.reason))this.store.reject(event.eventId,sub.id); /* No callback URL, payload or secret logged. */ }
        }
      }
    } catch { /* Expired access stops delivery. */ }
    finally { this.busy = false; }
  }
  async mcp(value: unknown) {
    const owner = this.access();
    const input = value as { method?: string; params?: { name?: string; arguments?: unknown } };
    const result = await rpc(this.bridge,owner,value,this.events);
    if ('result' in result && result.result && typeof result.result === 'object') {
      if (input.method === 'events/list') (result.result as { events: { description: string }[] }).events[0].description = 'A fixed synthetic diagnostic fixture was created on the private local test runtime. No real metrics or native commands.';
      if (input.method === 'tools/call' && input.params?.name === 'get_bridge_status') {
        const data = { synthetic_only: true, identity_boundary: 'exclusive_personal_tunnel', callback_delivery: this.store.active(owner).length ? 'verified_subscription' : 'awaiting_subscription', last_subscription_attempt: this.events.lastSubscription, same_dot_roundtrip: 'not_verified', native_execution: 'not_supported', transfer_mode: 'private_local_socket', observed_methods: await this.store.requests.methods(owner) };
        result.result = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false };
      }
    }
    if (input.method === 'tools/call') setImmediate(()=>void this.pump());
    return result;
  }
  async local(value: unknown) {
    const p = value as { op?: string; idempotency_key?: string; request_id?: string };
    if (p?.op === 'diagnose') {
      validate(object({ op: { const: 'diagnose' }, idempotency_key: createSchema.properties!.idempotency_key }), value);
      return this.create({ idempotency_key:p.idempotency_key, fixture:'high-cpu-v1' });
    }
    if (p?.op === 'result' || p?.op === 'cancel') {
      validate(object({ op: { enum: ['result','cancel'] }, request_id:requestArgsSchema.properties!.request_id }),value);
      return p.op === 'cancel' ? this.bridge.cancel(this.access(),p.request_id!) : this.bridge.read(this.access(),p.request_id!);
    }
    throw new Fault('unsupported_local_operation');
  }
}

export async function serve(dir: string) {
  process.umask(0o077); privateFile(dir,true);
  // API key stays with the official client/runner. This server never uses it.
  delete process.env.CONTROL_PLANE_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_ADMIN_KEY;
  const access = () => { const p = join(dir,'access.json'); privateFile(p); return leasePrincipal(parseStrictJson(readFileSync(p,'utf8'))); };
  access(); const store = new RuntimeStore(join(dir,'state.sqlite')); const runtime = new SyntheticRuntime(store,access);
  const socketPath = join(dir,'native.sock');
  if(existsSync(socketPath)) {
    const s=lstatSync(socketPath);if(!s.isSocket() || (s.mode & 0o077)!==0 || (process.getuid && s.uid!==process.getuid()))throw new Fault('unsafe_socket_path');
    await new Promise<void>((resolve,reject)=>{const probe=connect(socketPath);probe.setTimeout(500,()=>{probe.destroy();reject(new Fault('socket_busy'));});probe.once('connect',()=>{probe.destroy();reject(new Fault('socket_busy'));});probe.once('error',e=>{if((e as NodeJS.ErrnoException).code==='ECONNREFUSED'){unlinkSync(socketPath);resolve();}else reject(new Fault('socket_unavailable'));});});
  }
  const server = createServer(socket => {
    socket.setTimeout(5000,() => socket.destroy()); socket.setEncoding('utf8'); let text = '', used = false;
    socket.on('data',async chunk => {
      if (used) return; text += chunk;
      if (Buffer.byteLength(text) > 16_384) { used = true; socket.destroy(); return; }
      if (!text.includes('\n')) return; used = true;
      try { const response = await runtime.local(parseStrictJson(text.trim())); socket.end(JSON.stringify({result:response})+'\n'); }
      catch (e) { socket.end(JSON.stringify({error:e instanceof Fault ? e.reason : 'request_rejected'})+'\n'); }
    });
    socket.on('error',() => {});
  });
  await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(socketPath,resolve); }); chmodSync(socketPath,0o600);
  // Independent lease watchdog: if the runner dies, close stdio on expiry. The
  // official client's stdio EOF handling then shuts down its credentialed daemon.
  const watchdog=setInterval(()=>{try{access();}catch{process.stderr.write('Private runtime access expired.\n');process.exit(1);}},1000);watchdog.unref();
  const timer = setInterval(() => void runtime.pump(),30_000); timer.unref();
  let input = ''; process.stdin.setEncoding('utf8');
  try {
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 16_384) throw new Fault('message_too_large');
      while (input.includes('\n')) {
        const at = input.indexOf('\n'), line = input.slice(0,at); input = input.slice(at+1); if (!line.trim()) continue;
        let id: unknown = null, notify = false;
        try { const request = parseStrictJson(line) as { id?: unknown }; notify = !Object.hasOwn(request,'id'); id = request.id ?? null; const response = await runtime.mcp(request); if (!notify) process.stdout.write(JSON.stringify(response)+'\n'); }
        catch (e) { if (!notify) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32001,message:e instanceof Fault ? e.reason : 'request_rejected'}})+'\n'); }
      }
    }
  } finally { clearInterval(timer); clearInterval(watchdog); server.close(); store.close(); }
}
