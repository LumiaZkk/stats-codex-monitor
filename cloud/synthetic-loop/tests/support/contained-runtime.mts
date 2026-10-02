import { assertCleanEnvironment } from './assert-clean-environment.mts';
import assert from 'node:assert/strict';
await assertCleanEnvironment();
const {serve}=await import('../../tunnel/server.mts');
// In-memory signed-event sink for this isolated child only. Production serve()
// retains its real verified HTTPS transport; no environment switch enables this.
await serve(process.env.STATS_TUNNEL_RUN_DIR!,async(url,text,headers)=>{
  assert.equal(url,'https://fixture.invalid/events');assert.match(headers['webhook-signature'],/^v1,/);
  const body=JSON.parse(text);
  if(body.type==='verification')return{status:200,body:JSON.stringify({challenge:body.challenge})};
  assert.ok(['diagnostic.requested','diagnostic.receipt_ready'].includes(body.name));
  assert.equal(body.data.stream_id,'global-device-v1');
  return{status:200,body:'{}'};
});
