import { InvalidPanelData, UUID, type Binding } from './panel-contract.mts';
import { readRealInitial, readRealResult, type IntentBinding, type RealInitial, type RealResult } from './real-panel-contract.mts';

export type RealPhase = 'booting' | 'ready' | 'creating' | 'awaiting_native' | 'awaiting_consent' | 'waiting' | 'proposed' | 'cancelling' | 'cancelled' | 'declined' | 'expired' | 'complete' | 'unconfirmed' | 'offline' | 'invalid' | 'disposed';
type Operation = { kind: 'create'; key: string } | { kind: 'get' | 'cancel'; binding: IntentBinding };
type Reply = { isError?: boolean; structuredContent?: unknown };
export type RealPanelState = { phase: RealPhase; initial: RealInitial | null; result: RealResult | null; connected: boolean; refreshing: boolean; canRefresh: boolean; canCreate: boolean; canRetry: boolean; canCancel: boolean; reason: string };
export type RealPanelOptions = {
  callTool: (name: string, args: Record<string, unknown>) => Promise<Reply>;
  render: (state: RealPanelState) => void;
  now?: () => number; uuid?: () => string;
  setTimer?: (fn: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};
const ACTIVE = ['awaiting_native', 'awaiting_consent', 'waiting', 'proposed'];
const TERMINAL = ['cancelled', 'declined', 'expired', 'complete'];

export class RealPanelController {
  state: RealPanelState = { phase: 'booting', initial: null, result: null, connected: false, refreshing: false, canRefresh: false, canCreate: false, canRetry: false, canCancel: false, reason: '' };
  private options: RealPanelOptions;
  private now: () => number;
  private setTimer: NonNullable<RealPanelOptions['setTimer']>;
  private clearTimer: NonNullable<RealPanelOptions['clearTimer']>;
  private generation = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private binding: IntentBinding | null = null;
  private requestBinding: Binding | null = null;
  private proposalHash: string | null = null;
  private retryOperation: Operation | null = null;
  constructor(options: RealPanelOptions) {
    this.options = options; this.now = options.now ?? Date.now;
    // Keep Window as the receiver for browser timers (SDK panel startup regression).
    this.setTimer = options.setTimer ?? ((fn, delay) => globalThis.setTimeout(fn, delay));
    this.clearTimer = options.clearTimer ?? (timer => globalThis.clearTimeout(timer));
    this.expiryTimer = this.setTimer(() => { if (!this.state.initial) this.offline('initial_result_unavailable'); }, 15_000);
    this.render();
  }
  private render() {
    const initial = this.state.initial;
    const live = this.state.connected && !!initial && Date.parse(initial.connection.expires_at) > this.now();
    this.state.canRefresh = live && !this.state.refreshing && (this.state.phase === 'ready' || TERMINAL.includes(this.state.phase) || (this.state.phase === 'unconfirmed' && !this.retryOperation));
    this.state.canCreate = live && !this.state.refreshing && initial!.real_enabled && initial!.real_subscription_ready && initial!.native_collection_available
      && (this.state.phase === 'ready' || TERMINAL.includes(this.state.phase));
    this.state.canRetry = live && this.deadline() > this.now() && this.state.phase === 'unconfirmed' && this.retryOperation !== null;
    this.state.canCancel = live && this.binding !== null && this.deadline() > this.now()
      && !['cancelled', 'expired'].includes(this.state.result?.status ?? '')
      && (ACTIVE.includes(this.state.phase) || (this.state.phase === 'unconfirmed' && this.retryOperation?.kind === 'get'));
    this.options.render({ ...this.state });
  }
  private deadline() {
    const lease = this.state.initial ? Date.parse(this.state.initial.connection.expires_at) : Infinity;
    const result = this.state.result;
    if (!result || TERMINAL.includes(this.state.phase)) return lease;
    // Collection consent is bounded by the intent; a received request gets its own lifetime.
    // A verified historical plan permits a short final receipt window, never remote approval.
    const work = result.parsedPlan ? Date.parse(result.parsedPlan.expires_at) + 180_000
      : result.data ? Date.parse(result.data.request.expires_at) : Date.parse(result.intent.expires_at);
    return Math.min(lease, work);
  }
  private stopPoll() { if (this.pollTimer !== undefined) this.clearTimer(this.pollTimer); this.pollTimer = undefined; }
  private stopTimers() { this.stopPoll(); if (this.expiryTimer !== undefined) this.clearTimer(this.expiryTimer); this.expiryTimer = undefined; }
  private watchExpiry() {
    if (this.expiryTimer !== undefined) this.clearTimer(this.expiryTimer);
    const remaining = this.deadline() - this.now();
    if (!Number.isFinite(remaining)) return;
    this.expiryTimer = this.setTimer(() => {
      this.expiryTimer = undefined;
      if (this.state.phase === 'disposed') return;
      if (this.deadline() > this.now()) { this.watchExpiry(); return; }
      this.generation++; this.stopTimers(); this.retryOperation = null;
      const leaseExpired = this.state.initial && Date.parse(this.state.initial.connection.expires_at) <= this.now();
      this.state.phase = leaseExpired ? 'offline' : 'expired';
      this.state.reason = leaseExpired ? 'lease_expired' : this.state.result?.parsedPlan ? 'receipt_window_expired' : 'request_expired';
      this.render(); if (!leaseExpired) this.watchExpiry();
    }, Math.max(1, Math.min(remaining, 2_147_483_647)));
  }
  receiveInitial(reply: Reply) {
    if (['disposed', 'invalid', 'offline'].includes(this.state.phase)) return;
    try {
      if (reply.isError) throw new InvalidPanelData('initial_tool_error');
      const initial = readRealInitial(reply.structuredContent, this.now());
      if (this.state.initial) {
        if (initial.connection.instance_id !== this.state.initial.connection.instance_id
          || initial.connection.expires_at !== this.state.initial.connection.expires_at) throw new InvalidPanelData('runtime_changed');
        return;
      }
      this.state.initial = initial; if (this.state.connected) this.state.phase = 'ready';
      this.watchExpiry(); this.render();
    } catch { this.fail('invalid', 'invalid_initial'); }
  }
  connected() { if (this.state.phase === 'booting') { this.state.connected = true; if (this.state.initial) this.state.phase = 'ready'; this.render(); } }
  offline(reason = 'host_disconnected') { if (this.state.phase !== 'disposed') this.fail('offline', reason); }
  private fail(phase: 'offline' | 'invalid', reason: string) { this.generation++; this.stopTimers(); this.retryOperation = null; this.state.phase = phase; this.state.reason = reason; this.render(); }
  async refresh() {
    this.render(); if (!this.state.canRefresh || !this.state.initial) return;
    const generation = ++this.generation, expected = this.state.initial.connection;
    this.state.refreshing = true; this.render();
    try {
      const reply = await this.options.callTool('open_diagnostic_panel', {});
      if (generation !== this.generation) return;
      if (reply.isError) throw new Error('refresh_unconfirmed');
      const initial = readRealInitial(reply.structuredContent, this.now());
      if (initial.connection.instance_id !== expected.instance_id || initial.connection.expires_at !== expected.expires_at) throw new InvalidPanelData('runtime_changed');
      this.state.initial = initial;
      if (this.state.phase === 'unconfirmed') this.state.phase = 'ready';
      this.state.reason = ''; this.watchExpiry();
    } catch (error) {
      if (generation !== this.generation) return;
      if (error instanceof InvalidPanelData) this.fail('invalid', 'invalid_initial');
      else { this.state.phase = 'unconfirmed'; this.state.reason = 'refresh_unconfirmed'; }
    } finally {
      this.state.refreshing = false; this.render();
    }
  }
  async create() {
    this.render(); if (!this.state.canCreate) return;
    const key = (this.options.uuid ?? (() => crypto.randomUUID()))();
    if (!UUID.test(key)) { this.fail('invalid', 'invalid_idempotency_key'); return; }
    this.binding = null; this.requestBinding = null; this.proposalHash = null; this.state.result = null;
    await this.run({ kind: 'create', key });
  }
  async retry() { this.render(); if (this.state.canRetry && this.retryOperation) await this.run(this.retryOperation); }
  async cancel() { this.render(); if (this.state.canCancel && this.binding) await this.run({ kind: 'cancel', binding: { ...this.binding } }); }
  private async run(operation: Operation) {
    if (!this.state.initial || !this.state.connected || this.deadline() <= this.now() || this.state.phase === 'disposed') return;
    const generation = ++this.generation, initial = this.state.initial;
    this.stopPoll(); this.retryOperation = null;
    if (operation.kind === 'create') this.state.phase = 'creating';
    else if (operation.kind === 'cancel') this.state.phase = 'cancelling';
    // A read keeps the current evidence visible, including during native approval.
    this.state.reason = ''; this.watchExpiry(); this.render();
    try {
      const name = operation.kind === 'create' ? 'panel_request_global_diagnostic' : operation.kind === 'get' ? 'panel_get_global_diagnostic' : 'panel_cancel_global_diagnostic';
      const args = operation.kind === 'create' ? { expected_instance_id: initial.connection.instance_id, idempotency_key: operation.key }
        : { expected_instance_id: initial.connection.instance_id, ...operation.binding };
      const reply = await this.options.callTool(name, args);
      if (generation !== this.generation) return;
      if (reply.isError) throw new Error('tool_result_unconfirmed');
      const result = await readRealResult(reply.structuredContent, this.now(), initial.connection,
        operation.kind === 'create' ? null : operation.binding, this.requestBinding, this.proposalHash);
      if (generation !== this.generation) return;
      if (this.deadline() <= this.now()) { this.offline('response_after_expiry'); return; }
      if (operation.kind === 'cancel' && result.status !== 'cancelled') throw new InvalidPanelData('cancel_not_confirmed');
      // Once observed, request and proposal identities cannot be replaced or omitted.
      if (this.requestBinding && !result.data) throw new InvalidPanelData('request_removed');
      if (this.proposalHash && !result.parsedPlan) throw new InvalidPanelData('proposal_removed');
      this.binding = { intent_id: result.intent.intent_id, intent_hash: result.intent_hash };
      if (result.data) this.requestBinding = { request_id: result.data.request.request_id, request_hash: result.data.request_hash };
      this.proposalHash = result.data?.proposal_hash ?? result.result_bundle?.proposal_hash ?? this.proposalHash;
      this.state.result = result;
      this.state.phase = result.parsedReceipt ? 'complete' : result.parsedPlan && ['expired', 'cancelled'].includes(result.status) ? 'proposed'
        : result.status === 'requested' ? 'waiting' : result.status;
      this.watchExpiry(); this.render();
      if (ACTIVE.includes(this.state.phase)) this.pollTimer = this.setTimer(() => {
        this.pollTimer = undefined;
        if (generation === this.generation && this.binding && ACTIVE.includes(this.state.phase)) void this.run({ kind: 'get', binding: { ...this.binding } });
      }, 5000);
    } catch (error) {
      if (generation !== this.generation) return;
      this.stopPoll();
      if (error instanceof InvalidPanelData) this.fail('invalid', 'result_validation_failed');
      else { this.retryOperation = operation; this.state.phase = 'unconfirmed'; this.state.reason = 'network_unconfirmed'; this.watchExpiry(); this.render(); }
    }
  }
  dispose() { this.generation++; this.stopTimers(); this.retryOperation = null; this.state.phase = 'disposed'; this.state.connected = false; this.render(); }
}
