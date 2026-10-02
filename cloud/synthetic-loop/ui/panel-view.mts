import { PanelController, type PanelState } from './panel-controller.mts';
import type { App } from '@modelcontextprotocol/ext-apps';

// This narrow interface also allows the host lifecycle to be exercised without a browser.
export interface PanelApp {
  ontoolresult?: (reply: { isError?: boolean; structuredContent?: unknown }) => void;
  onteardown?: App['onteardown'];
  onerror?: (error: Error) => void;
  callServerTool: (input: { name: string; arguments: Record<string, unknown> }, options: { timeout: number }) => Promise<{ isError?: boolean; structuredContent?: unknown }>;
  connect: (transport?: undefined, options?: { timeout: number }) => Promise<void>;
  getHostCapabilities: () => { serverTools?: object } | undefined;
  // The official App has Protocol.close at runtime; its extensionless base declaration
  // is not exposed by all NodeNext type-resolution configurations.
  close?: () => Promise<void>;
}
const messages: Record<PanelState['phase'], string> = {
  booting: '正在确认宿主连接和当前运行实例…',
  ready: '上次连接检查通过。点击时会重新检查，并创建一次固定模拟请求。',
  creating: '正在创建模拟请求。请勿重复提交；尚未确认请求编号，暂时无法确认取消。',
  waiting: '模拟请求已创建，正在等待方案。每 5 秒查询一次当前请求。',
  cancelling: '正在确认取消。已停止查询；取消结果尚未确认。',
  proposed: '模拟方案已返回，请求与方案的 SHA-256 均已验证。以下仅为结果，不会执行。',
  cancelled: '服务器已确认取消。已被接收的事件可能仍会处理；不会执行本地操作。',
  expired: '请求或方案已过期，已停止查询。过期方案不可使用。',
  unconfirmed: '连接或工具结果未确认，已停止自动查询。事件可能已经被接收。重试只使用同一请求，不会自动新建。',
  offline: '当前连接不可用，已停止查询。请重新打开面板确认连接；运行实例离线时，入口也可能无法打开。',
  invalid: '返回内容未通过模拟数据、实例或哈希校验，已停止。请重新打开面板。',
  disposed: '面板已关闭，已停止查询。关闭面板不代表服务器取消成功。',
};
export function installPanel(app: PanelApp, doc: Document = document, win: Window = window) {
  const element = (id: string) => {
    const found = doc.getElementById(id); if (!found) throw new Error('missing_panel_element'); return found;
  };
  const create = element('create') as HTMLButtonElement, retry = element('retry') as HTMLButtonElement, cancel = element('cancel') as HTMLButtonElement;
  const render = (state: PanelState) => {
    create.disabled = !state.canCreate; retry.disabled = !state.canRetry; cancel.disabled = !state.canCancel;
    retry.hidden = state.phase !== 'unconfirmed'; create.textContent = state.data ? '新建模拟请求' : '创建模拟请求';
    element('status').textContent = state.phase === 'ready' && !state.initial?.subscription_ready
      ? '上次连接检查通过，但模拟事件订阅尚未就绪。请完成订阅后重新打开面板。'
      : state.reason === 'lease_expired' ? '运行实例连接已过期，已停止查询。请重新打开面板；离线时入口可能无法打开。' : messages[state.phase];
    const live = state.initial && !['booting', 'offline', 'invalid', 'disposed', 'unconfirmed'].includes(state.phase);
    element('connection').textContent = live ? '上次连接检查通过；下次操作会重新检查'
      : state.phase === 'unconfirmed' ? '连接状态未确认'
      : state.phase === 'offline' ? '连接不可用'
      : state.phase === 'invalid' ? '数据验证未通过'
      : state.phase === 'disposed' ? '面板已关闭' : '等待有效连接';
    element('connection').setAttribute('data-live', live ? 'true' : 'false');
    element('instance').textContent = state.initial?.connection.instance_id ?? '等待验证';
    element('lease').textContent = state.initial?.connection.expires_at ?? '等待验证';
    element('request-section').hidden = !state.data;
    element('request-id').textContent = state.data?.request.request_id ?? '';
    element('request-hash').textContent = state.data?.request_hash ?? '';
    element('request-expiry').textContent = state.data?.request.expires_at ?? '';
    // Everything from a server response is inert text. No links, HTML or executable action controls.
    const proposal = state.phase === 'proposed' ? state.data?.proposal : null;
    element('proposal-section').hidden = !proposal;
    element('proposal').textContent = proposal ? JSON.stringify(proposal, null, 2) : '';
    element('proposal-hash').textContent = proposal ? state.data?.proposal_hash ?? '' : '';
    element('receipt').textContent = '执行：不支持 · 回执：null（没有本地执行，也没有执行回执）';
  };
  const controller = new PanelController({ callTool: (name, args) => app.callServerTool({ name, arguments: args }, { timeout: 15000 }), render });
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; controller.dispose(); };
  // Register the initial result before connecting: hosts may deliver it during the handshake.
  app.ontoolresult = reply => { if (!disposed) controller.receiveInitial(reply); };
  app.onteardown = async () => { dispose(); return {}; };
  app.onerror = () => { if (!disposed) controller.offline('sdk_error'); };
  create.onclick = event => { if (event.isTrusted && !create.disabled) void controller.create(); };
  retry.onclick = event => { if (event.isTrusted && !retry.disabled) void controller.retry(); };
  cancel.onclick = event => { if (event.isTrusted && !cancel.disabled) void controller.cancel(); };
  win.addEventListener('pagehide', () => { dispose(); void app.close?.().catch(() => {}); }, { once: true });
  const ready = win.parent === win
    ? Promise.resolve().then(() => { controller.offline('standalone_page'); })
    : app.connect(undefined, { timeout: 15000 }).then(() => {
      if (disposed) return;
      if (!app.getHostCapabilities()?.serverTools) { controller.offline('server_tools_unavailable'); return; }
      controller.connected();
    }).catch(() => { if (!disposed) controller.offline('host_connection_failed'); });
  return { controller, ready };
}
