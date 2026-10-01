import { InvalidPanelData, readInitial, readResult, UUID, type Binding, type Data, type Initial } from './panel-contract.mts';

export type Phase = 'booting' | 'ready' | 'creating' | 'waiting' | 'cancelling' | 'proposed' | 'cancelled' | 'expired' | 'unconfirmed' | 'offline' | 'invalid' | 'disposed';
type Operation = { kind: 'create'; key: string } | { kind: 'get' | 'cancel'; binding: Binding };
type ToolReply = { isError?: boolean; structuredContent?: unknown };
export type PanelState = { phase: Phase; initial: Initial | null; data: Data | null; connected: boolean; canCreate: boolean; canRetry: boolean; canCancel: boolean; reason: string };
export type PanelOptions = {
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolReply>;
  render: (state: PanelState) => void;
  now?: () => number; uuid?: () => string;
  setTimer?: (fn: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

export class PanelController {
  state: PanelState = { phase: 'booting', initial: null, data: null, connected: false, canCreate: false, canRetry: false, canCancel: false, reason: '' };
  private options: PanelOptions;
  private now: () => number;
  private setTimer: NonNullable<PanelOptions['setTimer']>;
  private clearTimer: NonNullable<PanelOptions['clearTimer']>;
  private generation = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private binding: Binding | null = null;
  private retryOperation: Operation | null = null;
  constructor(options: PanelOptions) {
    this.options = options; this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout; this.clearTimer = options.clearTimer ?? clearTimeout;
    this.expiryTimer = this.setTimer(() => {
      if (!this.state.initial && this.state.phase === 'booting') this.offline('initial_result_unavailable');
    }, 15000);
    this.render();
  }
  private render() {
    const live = this.state.connected && !!this.state.initial && this.deadline() > this.now();
    this.state.canCreate = live && this.state.initial!.subscription_ready && ['ready', 'proposed', 'cancelled', 'expired'].includes(this.state.phase);
    this.state.canRetry = live && this.state.phase === 'unconfirmed' && this.retryOperation !== null;
    this.state.canCancel = live && this.binding !== null && (this.state.phase === 'waiting' || (this.state.phase === 'unconfirmed' && this.retryOperation?.kind === 'get'));
    this.options.render({ ...this.state });
  }
  private deadline() {
    return Math.min(this.state.initial ? Date.parse(this.state.initial.connection.expires_at) : Infinity,
      this.state.data && !['cancelled', 'expired'].includes(this.state.phase) ? Date.parse(this.state.data.request.expires_at) : Infinity,
      this.state.phase === 'proposed' && this.state.data?.proposal ? Date.parse(this.state.data.proposal.expires_at) : Infinity);
  }
  private stopPoll() { if (this.pollTimer !== undefined) this.clearTimer(this.pollTimer); this.pollTimer = undefined; }
  private stopTimers() { this.stopPoll(); if (this.expiryTimer !== undefined) this.clearTimer(this.expiryTimer); this.expiryTimer = undefined; }
  private watchExpiry() {
    if (this.expiryTimer !== undefined) this.clearTimer(this.expiryTimer);
    const delay = this.deadline() - this.now();
    if (!Number.isFinite(delay)) return;
    this.expiryTimer = this.setTimer(() => {
      this.expiryTimer = undefined;
      if (this.state.phase === 'disposed') return;
      if (this.deadline() > this.now()) { this.watchExpiry(); return; }
      this.generation++; this.stopTimers(); this.retryOperation = null;
      if (this.state.initial && Date.parse(this.state.initial.connection.expires_at) <= this.now()) {
        this.state.phase = 'offline'; this.state.reason = 'lease_expired';
      } else { this.state.phase = 'expired'; this.state.reason = 'request_expired'; }
      if (this.state.data) this.state.data = { ...this.state.data, status: 'expired', proposal: null, proposal_hash: null };
      this.render(); if (this.state.phase === 'expired') this.watchExpiry();
    }, Math.max(1, Math.min(delay, 2_147_483_647)));
  }
  receiveInitial(reply: ToolReply) {
    if (['disposed', 'invalid', 'offline'].includes(this.state.phase)) return;
    try {
      if (reply.isError) throw new InvalidPanelData('initial_tool_error');
      const initial = readInitial(reply.structuredContent, this.now());
      if (this.state.initial) {
        if (initial.connection.instance_id !== this.state.initial.connection.instance_id
          || initial.connection.expires_at !== this.state.initial.connection.expires_at) throw new InvalidPanelData('runtime_changed');
        return; // A repeated host notification cannot replace the active request or lease.
      }
      this.state.initial = initial;
      if (this.state.connected) this.state.phase = 'ready';
      this.watchExpiry(); this.render();
    } catch { this.fail('invalid', 'invalid_initial'); }
  }
  connected() {
    if (this.state.phase !== 'booting') return;
    this.state.connected = true; if (this.state.initial) this.state.phase = 'ready'; this.render();
  }
  offline(reason = 'host_disconnected') { if (this.state.phase !== 'disposed') this.fail('offline', reason); }
  private fail(phase: 'offline' | 'invalid', reason: string) {
    this.generation++; this.stopTimers(); this.retryOperation = null; this.state.phase = phase; this.state.reason = reason; this.render();
  }
  async create() {
    this.render(); if (!this.state.canCreate) return;
    const key = (this.options.uuid ?? (() => crypto.randomUUID()))();
    if (!UUID.test(key)) { this.fail('invalid', 'invalid_idempotency_key'); return; }
    this.binding = null; this.state.data = null; await this.run({ kind: 'create', key });
  }
  async retry() { this.render(); if (this.state.canRetry && this.retryOperation) await this.run(this.retryOperation); }
  async cancel() {
    this.render(); if (!this.state.canCancel || !this.binding) return;
    await this.run({ kind: 'cancel', binding: { ...this.binding } });
  }
  private async run(operation: Operation) {
    if (!this.state.initial || !this.state.connected || this.deadline() <= this.now() || this.state.phase === 'disposed') return;
    const generation = ++this.generation, instance = this.state.initial.connection.instance_id;
    this.stopPoll(); this.retryOperation = null;
    this.state.phase = operation.kind === 'create' ? 'creating' : operation.kind === 'cancel' ? 'cancelling' : 'waiting';
    this.state.reason = ''; this.watchExpiry(); this.render();
    try {
      const name = operation.kind === 'create' ? 'panel_create_synthetic_request' : operation.kind === 'get' ? 'panel_get_synthetic_result' : 'panel_cancel_synthetic_request';
      const args = operation.kind === 'create' ? { expected_instance_id: instance, idempotency_key: operation.key } : { expected_instance_id: instance, ...operation.binding };
      const reply = await this.options.callTool(name, args);
      if (generation !== this.generation) return;
      if (reply.isError) throw new Error('tool_result_unconfirmed');
      const result = await readResult(reply.structuredContent, this.now(), this.state.initial.connection, operation.kind === 'create' ? null : operation.binding);
      if (generation !== this.generation) return;
      if (this.deadline() <= this.now()) { this.offline('response_after_expiry'); return; }
      if (Date.parse(result.connection.expires_at) <= this.now()
        || (['requested', 'proposed'].includes(result.data.status) && Date.parse(result.data.request.expires_at) <= this.now())
        || (result.data.proposal && Date.parse(result.data.proposal.expires_at) <= this.now())) {
        this.offline('response_after_expiry'); return;
      }
      // Cancellation must be confirmed by the server, never inferred from a click.
      if (operation.kind === 'cancel' && result.data.status !== 'cancelled') throw new InvalidPanelData('cancel_not_confirmed');
      this.binding = { request_id: result.data.request.request_id, request_hash: result.data.request_hash };
      this.state.initial = { ...this.state.initial, connection: result.connection };
      this.state.data = result.data; this.state.phase = result.data.status === 'requested' ? 'waiting' : result.data.status;
      this.watchExpiry(); this.render();
      if (this.state.phase === 'waiting') this.pollTimer = this.setTimer(() => {
        this.pollTimer = undefined;
        if (generation === this.generation && this.binding && this.state.phase === 'waiting') void this.run({ kind: 'get', binding: { ...this.binding } });
      }, 5000);
    } catch (error) {
      if (generation !== this.generation) return;
      this.stopPoll();
      if (error instanceof InvalidPanelData) this.fail('invalid', 'result_validation_failed');
      else { this.retryOperation = operation; this.state.phase = 'unconfirmed'; this.state.reason = 'network_unconfirmed'; this.watchExpiry(); this.render(); }
    }
  }
  dispose() {
    this.generation++; this.stopTimers(); this.retryOperation = null; this.state.phase = 'disposed'; this.state.connected = false; this.render();
  }
}
