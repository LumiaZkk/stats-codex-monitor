import { Fault } from '../bridge/core.mts';
import { cloudflareLookup } from '../bridge/cloudflare-doh.mts';
import { makePinnedHttpsPost, pinnedHttpsPost } from '../bridge/node-https.mts';
export type CallbackResolver = 'system' | 'cloudflare_doh';
export function validateCallbackResolver(value:unknown): CallbackResolver {
  if(value===undefined || value==='system')return 'system';
  if(value==='cloudflare_doh')return value;
  throw new Fault('invalid_callback_resolver');
}
export function callbackTransport(value:unknown,lifetime?:AbortSignal) {
  const mode=validateCallbackResolver(value);
  return {mode,post:mode==='system' ? (lifetime ? makePinnedHttpsPost(undefined,lifetime) : pinnedHttpsPost) : makePinnedHttpsPost(cloudflareLookup,lifetime)};
}
