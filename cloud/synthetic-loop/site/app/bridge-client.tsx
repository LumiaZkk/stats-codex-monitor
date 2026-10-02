'use client';
import { useRef, useState } from 'react';
import { inspectNativeRequestFile } from '@/bridge/import-file.mts';
import type { NativeTransferRequest } from '@/bridge/core.mts';
type Result = { request: { request_id: string; expires_at: string; client_request?: NativeTransferRequest }; status: string; request_hash: string; proposal: unknown };
export default function BridgeClient() {
  const [result, setResult] = useState<Result | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [pending, setPending] = useState<NativeTransferRequest | null>(null), [requestId, setRequestId] = useState(''), [copied, setCopied] = useState(false);
  const selection = useRef(0);
  async function chooseFile(file?: File) {
    const revision = ++selection.current; setPending(null); setResult(null); setRequestId(''); setError(''); if (!file) return;
    try { if (file.size > 16384) throw new Error('Request file exceeds 16 KiB'); const checked = await inspectNativeRequestFile(await file.text()); if (revision === selection.current) setPending(checked); }
    catch (e) { if (revision === selection.current) setError(e instanceof Error ? e.message : 'Invalid file'); }
  }
  async function call(method: 'POST'|'GET'|'DELETE', transfer = false) {
    setBusy(true); setError('');
    try {
      const id = method === 'DELETE' ? (result?.request.request_id ?? '') : (requestId || result?.request.request_id || '');
      const response = await fetch((transfer ? '/api/transfers' : '/api/requests') + (method === 'POST' ? '' : '?request_id=' + encodeURIComponent(id)), { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(transfer ? pending : { idempotency_key: crypto.randomUUID(), fixture: 'high-cpu-v1' }) } : {}) });
      const data = await response.json() as Result & { error?: string }; if (!response.ok) throw new Error(data.error ?? 'Request unavailable'); setResult(data); setRequestId(data.request.request_id); setCopied(false);
    } catch (e) { setError(e instanceof Error ? e.message : 'Request unavailable'); } finally { setBusy(false); }
  }
  async function download() {
    if (!result) return; setBusy(true); setError('');
    try { const response = await fetch('/api/transfers?request_id='+encodeURIComponent(result.request.request_id), { cache: 'no-store' }); if (!response.ok) { const data = await response.json() as {error?:string}; throw new Error(data.error ?? 'Result unavailable'); }
      const url=URL.createObjectURL(await response.blob()); const a=document.createElement('a'); a.href=url; a.download='stats-synthetic-result.json'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    } catch(e) { setError(e instanceof Error ? e.message : 'Download failed'); } finally { setBusy(false); }
  }
  async function copyRequest() { if (!result) return; try { await navigator.clipboard.writeText('请分析 Stats 的模拟请求 '+result.request.request_id+'，读取请求后提交符合结构的 dry-run 建议。不要执行任何动作。'); setCopied(true); } catch { setError('Copy unavailable. Select the request ID below manually.'); } }
  return <main className="bridge-main">
    <p className="eyebrow">STATS · SYNTHETIC TRANSFER</p><h1>Move a test request between Stats and dot</h1>
    <p className="intro">Sign-in stays in this browser. The app exchanges files, with no account token or telemetry upload.</p>
    <section className="notice"><strong>Manual transfer only</strong><p>Export a synthetic request from the app, submit it here, then ask dot in your conversation to analyze its request ID. Refresh and download the result to import into the app.</p><p>No automatic wake-up. Imported advice is unsigned and dry-run; any local check needs its own explicit approval in the app.</p></section>
    <section className="panel"><h2>1. Choose the app’s synthetic request</h2><input aria-label="Synthetic request JSON" type="file" accept=".json,application/json" disabled={busy} onChange={e=>void chooseFile(e.target.files?.[0])}/>
      {pending && <div className="preview"><p><strong>Fixed fixture:</strong> CPU 92% · memory pressure normal · free disk 80 GiB</p><p className="wrap">Client request: {pending.client_request_id}</p><p>Expires: {pending.expires_at}</p><p>No file has been submitted yet.</p><button disabled={busy} onClick={()=>void call('POST',true)}>Submit synthetic request</button></div>}
    </section>
    <section className="panel"><h2>2. Retrieve the request</h2><div className="row"><input aria-label="Request ID" placeholder="Request ID" value={requestId} onChange={e=>setRequestId(e.target.value)} disabled={busy}/><button disabled={busy || !requestId} onClick={()=>void call('GET')}>Refresh result</button></div>
      {!result && <p className="secondary">A submitted request ID appears here. You can also paste one you created earlier.</p>}
      {result && <div aria-live="polite"><h3>Status: {result.status}</h3><p className="wrap">Request ID: {result.request.request_id}</p><p>Expires: {result.request.expires_at}</p><div className="row"><button disabled={busy || result.status!=='requested'} onClick={()=>void copyRequest()}>{copied?'Instruction copied':'Copy instruction for dot'}</button><button disabled={busy || result.status==='cancelled'} onClick={()=>void call('DELETE')}>Cancel request</button></div>
        <details><summary>Immutable request hash</summary><p className="wrap">{result.request_hash}</p></details>
        <pre>{result.proposal ? JSON.stringify(result.proposal,null,2) : 'No proposal available. Ask dot to read this request; then refresh.'}</pre>
        <button disabled={busy || result.status!=='proposed' || !result.request.client_request} onClick={()=>void download()}>Download result for the app</button><p className="secondary">Import this file into Stats, review the exact actions, then separately authorize a local check. Cancelling here cannot recall a file already downloaded; cancel its local check in the app too.</p>
      </div>}
    </section>
    {error && <p role="alert" className="error">{error}</p>}
    <details className="panel"><summary>Browser-only protocol test</summary><p>Creates the same fixed fixture without an app export. These requests cannot produce native transfer files.</p><button disabled={busy} onClick={()=>void call('POST')}>Create browser test</button></details>
    <style>{`.bridge-main{max-width:880px;margin:3rem auto;padding:0 1.5rem 3rem;font-family:system-ui;line-height:1.6;color:#172033}.eyebrow{color:#2563eb;font-weight:700;letter-spacing:.06em;font-size:.875rem}h1{font-size:2.1rem;line-height:1.2;font-weight:750;margin:.75rem 0}h2{font-size:1.2rem;font-weight:700;margin:0 0 1rem}h3{font-weight:650;margin:1rem 0}.intro{font-size:1.1rem}.notice{background:#eff6ff;border:1px solid #93c5fd;border-radius:12px;padding:1rem 1.2rem;margin:1.5rem 0}.notice p{margin:.6rem 0}.panel{border:1px solid #cbd5e1;border-radius:12px;padding:1.2rem;margin:1rem 0}.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.row input{flex:1;min-width:180px;padding:.6rem;border:1px solid #94a3b8;border-radius:6px;font:inherit}button{background:#1d4ed8;color:white;padding:.65rem 1rem;border-radius:8px;font:inherit;border:none;cursor:pointer}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #60a5fa;outline-offset:3px}.preview{margin-top:1rem;background:#f8fafc;padding:1rem;border-radius:8px}.preview p{margin:.5rem 0}.wrap,pre{overflow-wrap:anywhere}pre{white-space:pre-wrap;background:#f1f5f9;padding:1rem;border-radius:8px;font-size:.875rem;margin:1rem 0}.secondary{font-size:.9rem;color:#475569;margin:.75rem 0}.error{color:#991b1b;background:#fef2f2;padding:1rem;border-radius:8px}summary{cursor:pointer;font-weight:600}details p{margin:.75rem 0}@media(max-width:520px){.bridge-main{margin:1.5rem auto;padding:0 1rem 2rem}h1{font-size:1.7rem}.panel{padding:1rem}.row>*{width:100%}}`}</style>
  </main>;
}
