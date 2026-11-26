import { randomUUID } from 'node:crypto';
import type { WebhookConfig } from './config';
import type { Logger } from './logger';
import type { DurableQueue, QueuedEvent } from './queue/queue';
import { sleep } from './util/time';

export interface DispatcherDeps {
  queue: DurableQueue;
  config: WebhookConfig;
  connectorId: string;
  getToken: () => string | undefined;
  log: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  random?: () => number;
}

export interface DispatchStatus {
  lastHttpStatus?: number;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
  lastErrorCategory?: string;
  authFailed: boolean;
  currentBatchMax: number;
}

export interface RunResult {
  sent: number;
  retried: number;
  rejected: number;
  idle: boolean;
  nextDelayMs: number;
}

interface Ack {
  accepted?: string[];
  retry?: string[];
  rejected?: { eventId: string; reason?: string }[];
}

/**
 * Entrega al menos una vez. Un evento solo sale de la cola con un ACK válido por evento (SDD §7):
 * ante timeout, error de red o ACK ilegible se conserva y se reintenta con el mismo eventId.
 */
export class Dispatcher {
  readonly status: DispatchStatus;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private abort = new AbortController();
  private loop?: Promise<void>;

  constructor(private readonly d: DispatcherDeps) {
    this.fetchImpl = d.fetchImpl ?? fetch;
    this.now = d.now ?? Date.now;
    this.random = d.random ?? Math.random;
    this.status = { authFailed: false, currentBatchMax: d.config.batchMaxEvents };
  }

  start(): void {
    this.abort = new AbortController();
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.abort.signal.aborted) {
      let delay: number;
      try {
        delay = (await this.runOnce()).nextDelayMs;
      } catch (e) {
        this.d.log.error('dispatcher_error', { error: (e as Error).message });
        delay = this.d.config.backoffBaseMs;
      }
      await sleep(delay, this.abort.signal);
    }
  }

  /** Backoff exponencial con jitter parcial (mitad fija, mitad aleatoria). */
  backoff(attempts: number): number {
    const { backoffBaseMs, backoffMaxMs } = this.d.config;
    const cap = Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.min(attempts, 20));
    return Math.round(cap / 2 + (this.random() * cap) / 2);
  }

  async runOnce(): Promise<RunResult> {
    const { queue, config, log } = this.d;
    const now = this.now();
    const batch = queue.claimBatch({ now, maxEvents: this.status.currentBatchMax, maxBytes: config.batchMaxBytes });
    if (batch.length === 0) return { sent: 0, retried: 0, rejected: 0, idle: true, nextDelayMs: 1000 };

    const batchId = randomUUID();
    const body = `{"schemaVersion":1,"connectorId":${JSON.stringify(this.d.connectorId)},"batchId":"${batchId}","sentAt":"${new Date(now).toISOString()}","events":[${batch.map((e) => e.payload).join(',')}]}`;
    this.status.lastAttemptAt = new Date(now).toISOString();

    let res: Response;
    try {
      res = await this.post(body);
    } catch (e) {
      const msg = (e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message;
      return this.failAll(batch, 'network', msg, undefined);
    }
    this.status.lastHttpStatus = res.status;

    if (res.status >= 200 && res.status < 300) return this.handleAck(batch, res, batchId);

    const retryAfter = parseRetryAfter(res.headers.get('retry-after'), now);
    if (res.status === 401 || res.status === 403) {
      this.status.authFailed = true;
      log.error('webhook_auth_failed', { status: res.status });
      // Sin reintentos agresivos: se espera el máximo configurado (SDD §8.3).
      return this.failAll(batch, 'auth', `http_${res.status}`, this.d.config.backoffMaxMs);
    }
    if (res.status === 413) {
      if (batch.length === 1) {
        this.d.queue.markRejected([batch[0]!.seq], 'payload_too_large');
        return { sent: 0, retried: 0, rejected: 1, idle: false, nextDelayMs: 0 };
      }
      this.status.currentBatchMax = Math.max(1, Math.floor(batch.length / 2));
      log.warn('webhook_413_batch_reduced', { batchMax: this.status.currentBatchMax });
      return this.failAll(batch, 'too_large', 'http_413', 0, false);
    }
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      return this.failAll(batch, res.status === 429 ? 'rate_limited' : 'server', `http_${res.status}`, retryAfter);
    }
    // Otros 4xx: error permanente del lote. Se conservan como "rejected" para diagnóstico.
    this.d.queue.markRejected(batch.map((e) => e.seq), `http_${res.status}`);
    this.status.lastError = `http_${res.status}`;
    this.status.lastErrorCategory = 'permanent';
    log.error('webhook_batch_rejected', { status: res.status, events: batch.length });
    return { sent: 0, retried: 0, rejected: batch.length, idle: false, nextDelayMs: 0 };
  }

  private async post(body: string): Promise<Response> {
    const { config } = this.d;
    if (!config.allowInsecureHttp && !config.url.startsWith('https://')) throw new Error('webhook sin https');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'LefortPOSConnector/1',
      'x-lefort-connector-id': this.d.connectorId
    };
    const token = this.d.getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), config.timeoutMs);
    try {
      return await this.fetchImpl(config.url, { method: 'POST', headers, body, signal: ctl.signal, redirect: 'error' });
    } finally {
      clearTimeout(timer);
    }
  }

  private async handleAck(batch: QueuedEvent[], res: Response, batchId: string): Promise<RunResult> {
    let ack: Ack;
    try {
      ack = (await res.json()) as Ack;
      if (!ack || typeof ack !== 'object') throw new Error('ack no es un objeto');
    } catch {
      if (!this.d.config.devAssumeAckOnSuccess) {
        // 2xx sin ACK legible: no se puede asumir que se persistió. Se reintenta (idempotencia en el receptor).
        return this.failAll(batch, 'bad_ack', 'ack_unreadable', undefined);
      }
      ack = {};
    }
    if (this.d.config.devAssumeAckOnSuccess && !ack.accepted && !ack.rejected) {
      this.d.log.warn('dev_assume_ack_on_success', { batchId, events: batch.length });
      ack = { accepted: batch.map((e) => e.eventId) };
    }
    this.status.authFailed = false;
    const bySeq = new Map(batch.map((e) => [e.eventId, e]));
    const accepted = new Set((ack.accepted ?? []).filter((id) => bySeq.has(id)));
    const rejected = new Map((ack.rejected ?? []).filter((r) => bySeq.has(r.eventId)).map((r) => [r.eventId, r.reason ?? 'rejected']));
    const sentSeqs: number[] = [];
    const rejectedGroups = new Map<string, number[]>();
    const retryItems: { seq: number; nextAttemptAt: number }[] = [];
    const now = this.now();

    for (const e of batch) {
      if (accepted.has(e.eventId)) sentSeqs.push(e.seq);
      else if (rejected.has(e.eventId)) {
        const reason = rejected.get(e.eventId)!;
        rejectedGroups.set(reason, [...(rejectedGroups.get(reason) ?? []), e.seq]);
      } else {
        // Ni aceptado ni rechazado (incluye "retry"): sigue pendiente.
        retryItems.push({ seq: e.seq, nextAttemptAt: now + this.backoff(e.attempts) });
      }
    }
    if (sentSeqs.length) this.d.queue.markSent(sentSeqs, now);
    for (const [reason, seqs] of rejectedGroups) this.d.queue.markRejected(seqs, reason);
    if (retryItems.length) this.d.queue.markRetry(retryItems, 'not_acknowledged');

    this.status.lastSuccessAt = new Date(now).toISOString();
    this.status.lastError = retryItems.length ? 'partial_ack' : undefined;
    this.d.log.info('batch_delivered', {
      batchId,
      sent: sentSeqs.length,
      retried: retryItems.length,
      rejected: batch.length - sentSeqs.length - retryItems.length
    });
    return {
      sent: sentSeqs.length,
      retried: retryItems.length,
      rejected: batch.length - sentSeqs.length - retryItems.length,
      idle: false,
      nextDelayMs: retryItems.length ? Math.min(...retryItems.map((r) => r.nextAttemptAt - now)) : 0
    };
  }

  private failAll(
    batch: QueuedEvent[],
    category: string,
    error: string,
    forcedDelayMs: number | undefined,
    countAttempt = true
  ): RunResult {
    const now = this.now();
    const items = batch.map((e) => ({
      seq: e.seq,
      nextAttemptAt: now + (forcedDelayMs ?? this.backoff(e.attempts))
    }));
    if (countAttempt) this.d.queue.markRetry(items, `${category}:${error}`);
    else this.d.queue.markRetry(items.map((i) => ({ ...i, nextAttemptAt: now })), `${category}:${error}`);
    this.status.lastError = error;
    this.status.lastErrorCategory = category;
    this.d.log.warn('batch_failed', { category, error, events: batch.length });
    const delay = Math.max(0, Math.min(...items.map((i) => i.nextAttemptAt - now)));
    return { sent: 0, retried: batch.length, rejected: 0, idle: false, nextDelayMs: countAttempt ? delay : 0 };
  }
}

export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}
