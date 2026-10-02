import { RealPanelController, type RealPanelState } from './real-panel-controller.mts';
import type { PanelApp } from './panel-view.mts';
import type { RealSnapshot } from '../bridge/real-contract.mts';

const messages: Record<RealPanelState['phase'], string> = {
  booting: '正在连接当前 Mac 的诊断服务…', ready: '从整台 Mac 开始，查看系统负载和主要资源占用。无需先选择应用。',
  creating: '正在提交本次采集意向…请勿重复提交。', awaiting_native: '正在等待 Mac 上的 Stats 接收本次诊断。',
  awaiting_consent: '请先在 Mac 上的 Stats 确认本次采集，再预览数据并同意发送。',
  waiting: '采样已收到，正在等待已绑定的 dot 的诊断分析。每 5 秒检查一次结果。',
  proposed: '建议已收到。需要执行的动作只可在 Mac 上的 Stats 窗口确认；这里等待真实回执。',
  cancelling: '正在确认取消，已暂停查询。', cancelled: '本次诊断已取消。取消不会撤销已经发生的操作；如有已验证回执，将保留展示。',
  declined: '本次采集或发送未获同意，没有提交诊断快照。', expired: '本次诊断已到期，已停止查询。',
  complete: '已收到并验证 Mac 返回的本地回执。下方展示执行记录和可用的前后读数。',
  unconfirmed: '连接或结果尚未确认，已暂停自动查询。重试会继续同一次请求。',
  offline: '连接不可用，已停止查询。请重新打开面板确认当前 Mac 的连接。',
  invalid: '结果的来源、绑定或完整性验证未通过，已停止查询。请重新打开面板。',
  disposed: '面板已关闭，已停止查询。',
};
export function formatBytes(value: number | null): string {
  if (value === null) return '不可用';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}
export const formatCPU = (value: number | null): string => value === null ? '不可用' : `${(value / 100).toFixed(1)}%`;
export const formatPressure = (value: RealSnapshot['memory_pressure']): string => value === null ? '不可用' : ({ normal: '正常', warning: '偏高', critical: '紧张' }[value]);
const rate = (value: number | null) => value === null ? '不可用' : `${formatBytes(value)}/s`;
function time(value: string | null | undefined): string {
  if (!value) return '未取得采样时间';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short' }).format(new Date(value));
}
export function installDiagnosticPanel(app: PanelApp, doc: Document = document, win: Window = window) {
  const el = (id: string): HTMLElement => { const found = doc.getElementById(id); if (!found) throw new Error(`missing_panel_element:${id}`); return found; };
  const text = (id: string, value: string) => { el(id).textContent = value; };
  const create = el('global-create') as HTMLButtonElement, retry = el('global-retry') as HTMLButtonElement, cancel = el('global-cancel') as HTMLButtonElement, refresh = el('global-refresh') as HTMLButtonElement;
  const rows = (id: string, content: string[][]) => {
    const nodes = content.map(values => {
      const row = doc.createElement('tr');
      for (const value of values) { const cell = doc.createElement('td'); cell.textContent = value; row.appendChild(cell); }
      return row;
    });
    el(id).replaceChildren(...nodes);
  };
  const render = (state: RealPanelState) => {
    const { result, initial } = state, body = result?.parsedBody, plan = result?.parsedPlan, receipt = result?.parsedReceipt;
    refresh.disabled = !state.canRefresh; refresh.hidden = !['ready', 'cancelled', 'declined', 'expired', 'complete', 'unconfirmed'].includes(state.phase); refresh.textContent = state.refreshing ? '正在刷新…' : '刷新连接';
    create.disabled = !state.canCreate; retry.disabled = !state.canRetry; cancel.disabled = !state.canCancel;
    retry.hidden = state.phase !== 'unconfirmed'; cancel.hidden = !state.canCancel && state.phase !== 'cancelling';
    create.textContent = result ? '开始新的全机诊断' : '开始全机诊断';
    let message = messages[state.phase];
    if (state.phase === 'ready' && initial) {
      if (!initial.real_enabled) message = '当前连接未启用全机诊断。请连接已启用真实诊断的 Stats 运行实例。';
      else if (!initial.real_subscription_ready) message = '已绑定的 dot 的诊断与回执订阅尚未就绪。就绪后请刷新连接。';
      else if (!initial.native_collection_available) message = '尚未检测到 Mac 上的 Stats 采集服务。请打开 Mac 上的 Stats，再刷新连接。';
    }
    if (state.reason === 'refresh_unconfirmed') message = '连接检查尚未确认。请刷新连接后继续。';
    if (state.reason === 'receipt_window_expired') message = '等待本地回执的时间已结束。尚未确认执行结果，请在 Mac 上检查；这里不会推断操作成功。';
    if (state.phase === 'proposed' && plan && Date.parse(plan.expires_at) <= Date.now()) message = '本地批准有效期已结束。正在等待有效期内已开始操作的最终回执；不会发起新的动作。';
    if (state.phase === 'proposed' && result?.status === 'cancelled') message = '取消已确认。正在等待已开始操作的最终回执；取消不会撤销已经发生的操作。';
    text('global-status', message);
    const active = !['booting', 'invalid', 'offline', 'disposed', 'unconfirmed'].includes(state.phase) && !!initial;
    text('global-connection', active ? '上次连接检查通过' : state.phase === 'unconfirmed' ? '连接待确认' : state.phase === 'offline' ? '连接已断开' : state.phase === 'invalid' ? '校验未通过' : '连接中');
    el('global-connection').setAttribute('data-live', String(active));
    text('global-status-label', ({ awaiting_consent: '等待采集确认', awaiting_native: '等待 Mac 接收', waiting: '正在分析', proposed: '等待本地回执', complete: '诊断已完成', cancelled: '已取消', declined: '已拒绝', expired: '已到期', invalid: '校验未通过', offline: '已离线', unconfirmed: '等待确认', creating: '正在启动' } as Record<string, string>)[state.phase] ?? '准备开始');
    const step = receipt ? 4 : plan ? 3 : body ? 2 : result ? 1 : 0;
    for (let i = 1; i <= 4; i++) el(`step-${i}`).setAttribute('data-state', i < step ? 'done' : i === step ? 'current' : 'pending');
    el('snapshot-section').hidden = !body;
    el('consumer-section').hidden = !body;
    if (body) {
      text('snapshot-time', `采集于 ${time(body.created_at)} · 本次快照`);
      const s = body.snapshot;
      text('metric-cpu', formatCPU(s.host_cpu_basis_points)); text('metric-cpu-time', time(s.cpu_observed_at));
      text('metric-memory', formatPressure(s.memory_pressure)); text('metric-memory-detail', `交换空间 ${formatBytes(s.swap_used_bytes)}`); text('metric-memory-time', time(s.memory_observed_at));
      text('metric-disk', formatBytes(s.disk_free_bytes)); text('metric-disk-time', time(s.disk_observed_at));
      text('metric-io', rate(s.disk_read_bytes_per_second)); text('metric-io-detail', `写入 ${rate(s.disk_write_bytes_per_second)}`); text('metric-io-time', time(s.io_observed_at));
      const c = body.coverage;
      text('coverage', `覆盖 ${c.sampled_processes} 个可见进程 · ${c.unavailable_processes} 个不可用${c.truncated ? ' · 已达到扫描上限，覆盖不完整' : ''}。最多扫描 ${c.pid_limit} 个进程；辅助进程分别展示，未合并到所属应用。`);
      rows('consumer-rows', body.consumers.map(item => [
        item.category === 'ordinary_gui_app' ? item.display_name : ({ protected_app: '受保护应用', system_process: '系统进程', app_helper: '应用辅助进程', unknown_process: '其他进程' }[item.category]),
        ({ ordinary_gui_app: '应用', protected_app: '受保护', system_process: '系统', app_helper: '辅助进程', unknown_process: '其他' }[item.category]),
        formatCPU(item.cpu_basis_points), formatBytes(item.resident_bytes), time(item.observed_at),
      ]));
      el('consumer-empty').hidden = body.consumers.length !== 0;
      text('recent-samples', body.recent_samples.length ? body.recent_samples.map(sample => `${time(sample.observed_at)}  CPU ${formatCPU(sample.host_cpu_basis_points)} · 内存${formatPressure(sample.memory_pressure)}`).join('\n') : '没有可用的近期样本。');
    }
    el('recommendation-section').hidden = !plan;
    if (plan) {
      const action = plan.actions[0], target = action?.type === 'quit_app' ? body?.candidates.find(candidate => candidate.candidate_id === action.candidate_id) : null;
      text('recommendation-title', plan.decision === 'recommend_quit' ? `建议退出 ${target?.display_name ?? '所选应用'}` : plan.decision === 'observe' ? '建议继续观察 60 秒' : '暂不需要操作');
      text('recommendation-summary', plan.summary);
      text('approval-note', receipt ? '本次建议的结果见下方已验证回执。' : result?.status === 'cancelled' ? '此建议已取消，只保留用于核对回执。' : Date.parse(plan.expires_at) <= Date.now() ? '此建议已过批准有效期，只保留用于核对回执。' : plan.decision === 'no_action' ? '正在等待 Mac 上的 Stats确认无需操作的回执。' : `请在 Mac 上的 Stats 窗口查看并批准或拒绝。批准有效至 ${time(plan.expires_at)}。`);
    }
    el('receipt-section').hidden = !receipt;
    if (receipt) {
      text('receipt-title', ({ no_action: '未执行操作', observed: '已完成观察', declined: '已拒绝本地操作', cancelled: '操作已取消', precondition_failed: '条件不再满足，未执行退出', quit_refused_or_timed_out: '退出未获确认', quit_confirmed: '已确认应用退出' })[receipt.outcome]);
      text('receipt-time', `${time(receipt.started_at)} → ${time(receipt.completed_at)}`);
      text('receipt-approval', receipt.local_approval_at ? `本地批准：${time(receipt.local_approval_at)}` : '本地批准：无');
      text('receipt-facts', `已发出退出请求：${receipt.quit_requested ? '是' : '否'} · 已确认进程退出：${receipt.process_exit_confirmed ? '是' : '否'}${receipt.after ? '' : ' · 没有后续观测读数'}`);
      const before = receipt.before, after = receipt.after;
      const values: Array<[string, (s: RealSnapshot) => string]> = [['整机 CPU', s => formatCPU(s.host_cpu_basis_points)], ['内存压力', s => formatPressure(s.memory_pressure)], ['交换空间', s => formatBytes(s.swap_used_bytes)], ['磁盘可用', s => formatBytes(s.disk_free_bytes)], ['磁盘读取', s => rate(s.disk_read_bytes_per_second)], ['磁盘写入', s => rate(s.disk_write_bytes_per_second)]];
      const comparison = values.map(([label, format]) => [label, format(before.snapshot), after ? format(after.snapshot) : '不可用']);
      if (before.candidate) {
        comparison.push(['目标进程 CPU', formatCPU(before.candidate.cpu_basis_points), after?.candidate ? formatCPU(after.candidate.cpu_basis_points) : '不可用']);
        comparison.push(['目标进程内存', formatBytes(before.candidate.resident_bytes), after?.candidate ? formatBytes(after.candidate.resident_bytes) : '不可用']);
      }
      rows('receipt-rows', comparison);
      text('before-time', time(before.observed_at)); text('after-time', after ? time(after.observed_at) : '没有后续样本');
      text('receipt-caveat', '前后读数只反映两个采样时点的变化，不能证明变化由本次操作造成。不可用的读数不会记为零；进程退出后的目标读数通常不可用。');
    }
    // Response text is always inert. Technical provenance is available only in collapsed details.
    text('global-instance', initial?.connection.instance_id ?? '等待验证'); text('global-lease', initial?.connection.expires_at ?? '等待验证');
    text('intent-id', result?.intent.intent_id ?? '尚未创建'); text('intent-hash', result?.intent_hash ?? '尚未创建');
    text('global-request-id', result?.data?.request.request_id ?? '尚未采集'); text('global-request-hash', result?.data?.request_hash ?? '尚未采集');
    text('global-proposal-hash', result?.data?.proposal_hash ?? result?.result_bundle?.proposal_hash ?? '尚未返回');
    text('global-receipt-hash', result?.data?.receipt_hash ?? '尚未返回');
  };
  const controller = new RealPanelController({ callTool: (name, args) => app.callServerTool({ name, arguments: args }, { timeout: 15000 }), render });
  let disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; controller.dispose(); } };
  app.ontoolresult = reply => { if (!disposed) controller.receiveInitial(reply); };
  app.onteardown = async () => { dispose(); return {}; };
  app.onerror = () => { if (!disposed) controller.offline('sdk_error'); };
  refresh.onclick = event => { if (event.isTrusted && !refresh.disabled) void controller.refresh(); };
  create.onclick = event => { if (event.isTrusted && !create.disabled) void controller.create(); };
  retry.onclick = event => { if (event.isTrusted && !retry.disabled) void controller.retry(); };
  cancel.onclick = event => { if (event.isTrusted && !cancel.disabled) void controller.cancel(); };
  win.addEventListener('pagehide', () => { dispose(); void app.close?.().catch(() => {}); }, { once: true });
  const ready = win.parent === win ? Promise.resolve().then(() => controller.offline('standalone_page'))
    : app.connect(undefined, { timeout: 15000 }).then(() => { if (!disposed) { if (!app.getHostCapabilities()?.serverTools) controller.offline('server_tools_unavailable'); else controller.connected(); } })
      .catch(() => { if (!disposed) controller.offline('host_connection_failed'); });
  return { controller, ready };
}
