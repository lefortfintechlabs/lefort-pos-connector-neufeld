import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DurableQueue } from '../src/queue/queue';
import { enqueue, tmpDir } from './helpers';

describe('cola durable (SQLite)', () => {
  let dir: string;
  let q: DurableQueue;
  beforeEach(() => {
    dir = tmpDir();
    q = DurableQueue.open(dir);
  });
  afterEach(() => q.close());

  it('deduplica por eventId y conserva el estado en la misma transacción', () => {
    enqueue(q, 3);
    const again = enqueue(q, 3); // mismos eventId
    expect(again).toHaveLength(3);
    expect(q.pendingCount()).toBe(3);
    expect(q.getState('orders')).toEqual({ phase: 'running', data: {} });
  });

  it('si la transacción falla no avanza ni el watermark ni los eventos', () => {
    expect(() =>
      q.commitCapture({
        table: 'orders',
        state: { phase: 'running', data: { wm: 'nuevo' } },
        events: [{ eventId: 'a', tableName: 'orders', entityKey: '1', operation: 'UPSERT', payload: '{}', observedAt: 'x' }],
        // payload nulo viola NOT NULL en el segundo evento y revierte todo
        rowUpdates: [{ pk: '1', hash: null as unknown as string }]
      })
    ).toThrow();
    expect(q.pendingCount()).toBe(0);
    expect(q.getState('orders')).toBeUndefined();
  });

  it('sobrevive al reinicio (reabrir la base)', () => {
    enqueue(q, 2);
    q.close();
    q = DurableQueue.open(dir);
    expect(q.pendingCount()).toBe(2);
  });

  it('claimBatch respeta límites de eventos y bytes y un evento por entidad', () => {
    enqueue(q, 5);
    expect(q.claimBatch({ now: Date.now(), maxEvents: 2, maxBytes: 1_000_000 })).toHaveLength(2);
    const small = q.claimBatch({ now: Date.now(), maxEvents: 10, maxBytes: 70 });
    expect(small.length).toBeGreaterThanOrEqual(1);
    expect(small.length).toBeLessThan(5);
  });

  it('el reintento de un evento retiene los posteriores de la misma entidad', () => {
    const mk = (id: string) => ({ eventId: id, tableName: 'orders', entityKey: '7', operation: 'UPSERT', payload: `{"id":"${id}"}`, observedAt: 'x' });
    q.commitCapture({ table: 'orders', state: { phase: 'running', data: {} }, events: [mk('e1'), mk('e2')], rowUpdates: [] });
    const now = 1_000_000;
    const [first] = q.claimBatch({ now, maxEvents: 10, maxBytes: 10_000 });
    expect(first!.eventId).toBe('e1');
    q.markRetry([{ seq: first!.seq, nextAttemptAt: now + 60_000 }], 'server:http_500');
    expect(q.claimBatch({ now, maxEvents: 10, maxBytes: 10_000 })).toHaveLength(0); // e2 espera a e1
    expect(q.claimBatch({ now: now + 61_000, maxEvents: 10, maxBytes: 10_000 }).map((e) => e.eventId)).toEqual(['e1']);
  });

  it('rechazados se conservan; enviados se purgan por antigüedad', () => {
    enqueue(q, 3);
    const batch = q.claimBatch({ now: Date.now(), maxEvents: 10, maxBytes: 10_000 });
    q.markSent([batch[0]!.seq], 1000);
    q.markRejected([batch[1]!.seq], 'http_400');
    const s = q.stats();
    expect(s).toMatchObject({ pending: 1, sent: 1, rejected: 1 });
    expect(q.purgeSent(2000)).toBe(1);
    expect(q.listEvents('rejected', 10)).toHaveLength(1);
  });

  it('la base de solo lectura permite consultar pero no escribir', () => {
    enqueue(q, 1);
    const ro = DurableQueue.openReadOnly(dir);
    expect(ro.stats().pending).toBe(1);
    expect(() => ro.setMeta('k', 'v')).toThrow();
    ro.close();
  });
});
