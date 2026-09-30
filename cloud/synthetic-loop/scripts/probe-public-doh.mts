// Credential-free, fixed public hostnames only. This does not enable the runtime
// resolver or contact an event callback. Run separately before approved setup.
import { request } from 'node:https';
import { cloudflareLookup } from '../bridge/cloudflare-doh.mts';
import { classifyAddresses,selectCallbackAddress } from '../bridge/node-https.mts';
import { Fault } from '../bridge/core.mts';
if(process.argv.length!==2)throw new Error('This probe takes no hostname or credential arguments.');
try {
 for(const [fixture,hostname] of [['openai_docs','developers.openai.com'],['cloudflare_public_dns','one.one.one.one']]){
  const addresses=await cloudflareLookup(hostname,AbortSignal.timeout(10_000));
  process.stdout.write(JSON.stringify({phase:'public_dns',fixture,resolver:'cloudflare_doh',categories:classifyAddresses(addresses)})+'\n');
  const chosen=selectCallbackAddress(addresses);
  if(fixture==='cloudflare_public_dns' && !addresses.some(a=>a.family===6))throw new Fault('public_dual_stack_unavailable');
  const status=await new Promise<number>((resolve,reject)=>{
    const req=request(`https://${hostname}/`,{method:'HEAD',agent:false,family:4,servername:hostname,rejectUnauthorized:true,signal:AbortSignal.timeout(10_000),maxHeaderSize:8192,lookup:(_h,_o,cb)=>cb(null,chosen.address,4)},res=>{res.resume();resolve(res.statusCode??0);});
    req.on('error',()=>reject(new Fault('callback_connection_failed')));req.end();
  });
  process.stdout.write(JSON.stringify({phase:'public_https',fixture,tls_verified:true,http_status:status,redirect_followed:false})+'\n');
 }
} catch(error) {
  const allowed=['invalid_callback','callback_dns_failed','callback_timeout','callback_tls_failed','callback_transport_unverified','non_public_callback','callback_ipv4_unavailable','callback_connection_failed','public_dual_stack_unavailable'];
  const reason=error instanceof Fault && allowed.includes(error.reason) ? error.reason : 'public_probe_failed';
  process.stderr.write(JSON.stringify({phase:'failed',reason})+'\n');process.exitCode=1;
}
