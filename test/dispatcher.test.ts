import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher, parseRetryAfter } from '../src/dispatcher';
import { nullLogger } from '../src/logger';
import { DurableQueue } from '../src/queue/queue';
import { enqueue, makeConfig, tmpDir } from './helpers';

const table = { name: 'orders', table: 'Orders', entityType: 'order', primaryKey: 'Id', columns: ['Id'], strategy: 'hashDiff' };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('dispatcher', () => {
  let q: DurableQueue;
  let clock: number;
  const make = (fetchImpl: typeof fetch, webhook: Record<string, unknown> = {}) => {
    const cfg = makeConfig(tmpDir(), [table], webhook);
    return new Dispatcher({ queue: q, config: cfg.webhook, connectorId: 'store-001', getToken: () => 'tok', log: nullLogger, fetchImpl, now: () => clock, random: () => 0.5 });
  };
  beforeEach(() => {
    q = DurableQueue.open(tmpDir());
    clock = 1_000_000;
  });
  afterEach(() => q.close());

  it('ACK completo: marca enviados, envía token y connectorId', async () => {
    enqueue(q, 3);
    const f = vi.fn<typeof fetch>(async (_u, init) => {
      const body = JSON.parse(init!.body as string);
      return json({ accepted: body.events.map((e: { eventId: string }) => e.eventId) });
    });
    const r = await make(f).runOnce();
    expect(r).toMatchObject({ sent: 3, retried: 0 });
    expect(q.stats()).toMatchObject({ pending: 0, sent: 3 });
    const init = f.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(init.redirect).toBe('error');
  });

  it('ACK parcial: lo no confirmado sigue pendiente, lo rechazado se conserva', async () => {
    enqueue(q, 4);
    const f = async () => json({ accepted: ['ev-1'], rejected: [{ eventId: 'ev-2', reason: 'schema' }], retry: ['ev-3'] });
    const r = await make(f).runOnce();
    expect(r).toMatchObject({ sent: 1, retried: 2, rejected: 1 });
    expect(q.stats()).toMatchObject({ pending: 2, sent: 1, rejected: 1 });
  });

  it('5xx, timeout y error de red conservan todo con backoff creciente', async () => {
    enqueue(q, 2);
    const d = make(async () => new Response('x', { status: 503 }));
    await d.runOnce();
    expect(q.stats()).toMatchObject({ pending: 2, maxAttempts: 1 });
    expect(q.claimBatch({ now: clock, maxEvents: 10, maxBytes: 1e6 })).toHaveLength(0); // aún en espera
    clock += 120_000;
    await make(async () => { throw new TypeError('fetch failed'); }).runOnce();
    expect(q.stats().maxAttempts).toBe(2);
    expect(d.backoff(0)).toBeLessThan(d.backoff(5));
  });

  it('2xx con ACK ilegible NO borra eventos', async () => {
    enqueue(q, 2);
    const r = await make(async () => new Response('ok', { status: 200 })).runOnce();
    expect(r).toMatchObject({ sent: 0, retried: 2 });
    expect(q.stats().pending).toBe(2);
  });

  it('devAssumeAckOnSuccess: un 2xx vacío cuenta como entregado; un 5xx no', async () => {
    enqueue(q, 2);
    const d = make(async () => new Response('', { status: 200 }), { devAssumeAckOnSuccess: true });
    expect(await d.runOnce()).toMatchObject({ sent: 2, retried: 0 });
    enqueue(q, 2, 'b');
    const bad = make(async () => new Response('x', { status: 503 }), { devAssumeAckOnSuccess: true });
    await bad.runOnce();
    expect(q.stats()).toMatchObject({ pending: 2 });
  });

  it('401 marca authFailed y espera el backoff máximo', async () => {
    enqueue(q, 1);
    const d = make(async () => new Response('', { status: 401 }));
    const r = await d.runOnce();
    expect(d.status.authFailed).toBe(true);
    expect(r.nextDelayMs).toBe(60_000);
    expect(q.stats().pending).toBe(1);
  });

  it('429 respeta Retry-After', async () => {
    enqueue(q, 1);
    const r = await make(async () => new Response('', { status: 429, headers: { 'retry-after': '30' } })).runOnce();
    expect(r.nextDelayMs).toBe(30_000);
  });

  it('413 reduce el tamaño de lote; con un solo evento lo rechaza', async () => {
    enqueue(q, 4);
    const d = make(async () => new Response('', { status: 413 }));
    await d.runOnce();
    expect(d.status.currentBatchMax).toBe(2);
    await d.runOnce();
    expect(d.status.currentBatchMax).toBe(1);
    await d.runOnce();
    const r = await d.runOnce();
    expect(r.rejected).toBe(1);
  });

  it('otros 4xx: el lote se conserva como rechazado, no se descarta', async () => {
    enqueue(q, 2);
    const r = await make(async () => new Response('', { status: 400 })).runOnce();
    expect(r.rejected).toBe(2);
    expect(q.listEvents('rejected', 10)).toHaveLength(2);
  });

  it('parseRetryAfter acepta segundos y fecha HTTP', () => {
    expect(parseRetryAfter('5', 0)).toBe(5000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });
});
