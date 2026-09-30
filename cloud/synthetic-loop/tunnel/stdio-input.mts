import type { Readable } from 'node:stream';
import { Fault } from '../bridge/core.mts';

// Keep the pipe flowing while one handler awaits network I/O. A paused
// for-await loop cannot observe EOF until that handler returns. The queue is
// bounded independently, so continuous consumption cannot grow without limit.
export async function consumeStdio(input:Readable,handle:(line:string)=>Promise<void>,lifetime:AbortController):Promise<void> {
  input.setEncoding('utf8');
  await new Promise<void>((resolve,reject)=>{
    let text='',bytes=0,busy=false,ended=false,settled=false,error:Fault|undefined;
    const queue:string[]=[];
    const cleanup=()=>{input.off('data',onData);input.off('end',onEnd);input.off('close',onEnd);input.off('error',onError);input.pause();};
    const finish=()=>{if(ended && !busy && !settled){settled=true;cleanup();error ? reject(error) : resolve();}};
    const stop=(reason?:Fault)=>{if(ended)return;ended=true;error=reason;lifetime.abort();queue.length=0;text='';bytes=0;finish();};
    const pump=async()=>{
      if(busy || ended)return;busy=true;
      try {while(queue.length && !ended){const line=queue.shift()!;bytes-=Buffer.byteLength(line);await handle(line);}}
      catch {stop(new Fault('stdio_handler_failed'));}
      finally {busy=false;finish();}
    };
    const onData=(chunk:string)=>{
      if(ended)return;text+=chunk;
      if(Buffer.byteLength(text)+bytes>16_384){stop(new Fault('message_too_large'));return;}
      while(text.includes('\n')){
        const at=text.indexOf('\n'),line=text.slice(0,at);text=text.slice(at+1);
        if(!line.trim())continue;queue.push(line);bytes+=Buffer.byteLength(line);
        if(queue.length>8){stop(new Fault('stdio_queue_limit'));return;}
      }
      void pump();
    };
    const onEnd=()=>stop();
    const onError=()=>stop(new Fault('stdio_input_failed'));
    input.on('data',onData);input.once('end',onEnd);input.once('close',onEnd);input.once('error',onError);
    if(input.destroyed || input.readableEnded)stop();
  });
}
