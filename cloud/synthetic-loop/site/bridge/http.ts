import { env } from 'cloudflare:workers';
import { Bridge } from './core.mts';
import { D1Store } from './d1-store.mts';
export { jsonBody, owner, sameOrigin, failure } from './http-body.mts';
export const newBridge = () => { if (!env.DB) throw new Error('storage_unavailable'); return new Bridge(new D1Store(env.DB)); };
