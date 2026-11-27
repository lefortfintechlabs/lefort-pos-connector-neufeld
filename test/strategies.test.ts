import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CaptureReader } from '../src/capture/reader';
import { nullLogger } from '../src/logger';
import { DurableQueue } from '../src/queue/queue';
import type { Row } from '../src/util/hash';
import { big, buf, makeConfig, ScriptedClient, tmpDir } from './helpers';

function drain(q: DurableQueue) {
  const batch = q.claimBatch({ now: Date.now() + 1e9, maxEvents: 1000, maxBytes: 1e9 });
  return batch.map((b) => JSON.parse(b.payload) as { eventType: string; operation: string; entity: { id: string }; data: Record<string, unknown>; sourceModifiedAt?: string; source: { captureMethod: string } });
}

describe('S1 rowversion', () => {
  let dir: string;
  let q: DurableQueue;
  type R = { Id: number; Status: string; Total: number; rv: bigint };
  let rows: R[];
  let dbts: bigint;
  let activeMin: bigint | null;
  const minActive = () => activeMin ?? dbts + 1n;
  const touch = (r: R) => (r.rv = ++dbts);

  const client = () =>
    new ScriptedClient((sql, p) => {
      if (sql.includes('SELECT MIN_ACTIVE_ROWVERSION() AS v')) return [{ v: buf(minActive()) }];
      if (sql.includes('[__rv]')) {
        const wm = big(p.wm!.value);
        return rows
          .filter((r) => r.rv > wm && r.rv < minActive())
          .sort((a, b) => Number(a.rv - b.rv))
          .slice(0, p.n!.value as number)
          .map((r): Row => ({ Id: r.Id, Status: r.Status, Total: r.Total, __rv: buf(r.rv) }));
      }
      throw new Error('SQL inesperado: ' + sql);
    });

  const make = (c: ScriptedClient) =>
    new CaptureReader({
      config: makeConfig(dir, [{ name: 'orders', table: 'Orders', entityType: 'order', primaryKey: 'Id', pkType: 'int', columns: ['Id', 'Status', 'Total'], strategy: 'rowversion', rowversionColumn: 'RowVer' }]),
      client: c,
      queue: q,
      log: nullLogger,
      connectorVersion: 't'
    });

  beforeEach(() => {
    dir = tmpDir();
    q = DurableQueue.open(dir);
    dbts = 1000n;
    activeMin = null;
    rows = [1, 2, 3].map((i) => ({ Id: i, Status: 'open', Total: i * 10, rv: ++dbts }));
  });
  afterEach(() => q.close());

  it('changesOnly: no emite las filas existentes, sí los cambios posteriores', async () => {
    const r = make(client());
    await r.runCycle();
    expect(q.pendingCount()).toBe(0);
    rows[1]!.Status = 'paid';
    touch(rows[1]!);
    await r.runCycle();
    const ev = drain(q);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ eventType: 'order.changed', operation: 'UPSERT', entity: { id: '2' }, data: { Status: 'paid' }, source: { captureMethod: 'rowversion' } });
  });

  it('un cambio en columnas no configuradas (rowversion nuevo, mismo contenido) no genera evento', async () => {
    const r = make(client());
    await r.runCycle();
    rows[0]!.Status = 'x';
    touch(rows[0]!);
    await r.runCycle();
    expect(q.pendingCount()).toBe(1);
    touch(rows[0]!); // solo cambia el rowversion
    await r.runCycle();
    expect(q.pendingCount()).toBe(1);
  });

  it('tras reiniciar no repite eventos ni pierde posición', async () => {
    let r = make(client());
    await r.runCycle();
    rows[0]!.Status = 'a';
    touch(rows[0]!);
    await r.runCycle();
    r = make(client()); // reinicio: nuevo lector, misma cola
    await r.runCycle();
    rows[2]!.Status = 'b';
    touch(rows[2]!);
    await r.runCycle();
    expect(drain(q).map((e) => e.entity.id)).toEqual(['1', '3']);
  });

  it('no salta transacciones largas: respeta MIN_ACTIVE_ROWVERSION()', async () => {
    const r = make(client());
    await r.runCycle();
    // La transacción A (rv 1004) sigue abierta; B (rv 1005) ya confirmó.
    activeMin = dbts + 1n; // 1004
    const a = { Id: 10, Status: 'A', Total: 1, rv: ++dbts };
    const b = { Id: 11, Status: 'B', Total: 2, rv: ++dbts };
    rows.push(b);
    await r.runCycle();
    expect(q.pendingCount()).toBe(0); // B no se lee todavía: pasaría por encima de A
    rows.push(a);
    activeMin = null; // A confirma
    await r.runCycle();
    expect(drain(q).map((e) => e.entity.id)).toEqual(['10', '11']);
  });

  it('initialSnapshot emite todo y las consultas son de solo lectura', async () => {
    const cfg = makeConfig(dir, [{ name: 'orders', table: 'Orders', entityType: 'order', primaryKey: 'Id', pkType: 'int', columns: ['Id', 'Status', 'Total'], strategy: 'rowversion', rowversionColumn: 'RowVer' }]);
    cfg.capture.startMode = 'initialSnapshot';
    const c = client();
    await new CaptureReader({ config: cfg, client: c, queue: q, log: nullLogger, connectorVersion: 't' }).runCycle();
    expect(q.pendingCount()).toBe(3);
    expect(c.calls.every((x) => /^\s*SELECT\b/i.test(x.sql))).toBe(true);
  });

  it('contrapresión: con la cola llena deja de leer y no avanza el watermark', async () => {
    const cfg = makeConfig(dir, [{ name: 'orders', table: 'Orders', entityType: 'order', primaryKey: 'Id', pkType: 'int', columns: ['Id', 'Status', 'Total'], strategy: 'rowversion', rowversionColumn: 'RowVer' }]);
    cfg.queue.maxPendingEvents = 1;
    const c = client();
    const r = new CaptureReader({ config: cfg, client: c, queue: q, log: nullLogger, connectorVersion: 't' });
    await r.runCycle();
    rows[0]!.Status = 'a';
    touch(rows[0]!);
    await r.runCycle();
    expect(q.pendingCount()).toBe(1);
    const calls = c.calls.length;
    rows[1]!.Status = 'b';
    touch(rows[1]!);
    await r.runCycle();
    expect(r.backpressure).toBe(true);
    expect(c.calls.length).toBe(calls);
  });
});

describe('S3 pkWindow', () => {
  it('detecta altas, cambios en la ventana caliente y NO cambios antiguos', async () => {
    const dir = tmpDir();
    const q = DurableQueue.open(dir);
    const rows: { Id: number; Status: string }[] = [1, 2, 3, 4, 5, 6].map((i) => ({ Id: i, Status: 'open' }));
    const client = new ScriptedClient((sql, p) => {
      if (sql.startsWith('SELECT MAX(')) return [{ m: Math.max(...rows.map((r) => r.Id)) }];
      if (sql.includes('[Id] > @maxPk')) {
        return rows.filter((r) => r.Id > Number(p.maxPk!.value)).sort((a, b) => a.Id - b.Id).slice(0, p.n!.value as number).map((r) => ({ ...r }));
      }
      if (sql.includes('ORDER BY [Id] DESC')) return [...rows].sort((a, b) => b.Id - a.Id).slice(0, p.n!.value as number).map((r) => ({ ...r }));
      throw new Error('SQL inesperado: ' + sql);
    });
    const cfg = makeConfig(dir, [{ name: 'items', table: 'Items', entityType: 'item', primaryKey: 'Id', pkType: 'int', columns: ['Id', 'Status'], strategy: 'pkWindow', hotWindowRows: 2 }]);
    const r = new CaptureReader({ config: cfg, client, queue: q, log: nullLogger, connectorVersion: 't' });
    await r.runCycle();
    expect(q.pendingCount()).toBe(0);

    rows.push({ Id: 7, Status: 'open' });
    rows.find((x) => x.Id === 6)!.Status = 'paid'; // dentro de la ventana (últimas 2)
    rows.find((x) => x.Id === 1)!.Status = 'paid'; // fuera de la ventana: limitación documentada
    await r.runCycle();
    const ev = drain(q);
    expect(ev.map((e) => `${e.operation}:${e.entity.id}`).sort()).toEqual(['INSERT:7', 'UPSERT:6']);
    q.close();
  });
});

describe('S2 modifiedAt', () => {
  it('relee la ventana de traslape sin duplicar y captura confirmaciones tardías', async () => {
    const dir = tmpDir();
    const q = DurableQueue.open(dir);
    const t0 = Date.parse('2026-10-28T10:00:00Z');
    type R = { ProductId: number; OnHand: number; LastModified: Date };
    const rows: R[] = [1, 2, 3].map((i) => ({ ProductId: i, OnHand: 5, LastModified: new Date(t0 - i * 60_000) }));
    const sorted = () => [...rows].sort((a, b) => a.LastModified.getTime() - b.LastModified.getTime() || a.ProductId - b.ProductId);
    const client = new ScriptedClient((sql, p) => {
      if (sql.startsWith('SELECT MAX(')) return [{ m: new Date(Math.max(...rows.map((r) => r.LastModified.getTime()))) }];
      const n = p.n!.value as number;
      if (p.from) return sorted().filter((r) => r.LastModified >= (p.from!.value as Date)).slice(0, n).map((r) => ({ ...r }));
      if (p.m) {
        const m = (p.m.value as Date).getTime();
        const pk = Number(p.p!.value);
        return sorted().filter((r) => r.LastModified.getTime() > m || (r.LastModified.getTime() === m && r.ProductId > pk)).slice(0, n).map((r) => ({ ...r }));
      }
      throw new Error('SQL inesperado: ' + sql);
    });
    const cfg = makeConfig(dir, [{ name: 'inventory', table: 'Stock', entityType: 'inventory', primaryKey: 'ProductId', pkType: 'int', columns: ['ProductId', 'OnHand'], strategy: 'modifiedAt', modifiedAtColumn: 'LastModified', overlapSeconds: 120 }]);
    cfg.capture.sourceTimeZone = 'UTC';
    const r = new CaptureReader({ config: cfg, client, queue: q, log: nullLogger, connectorVersion: 't' });
    await r.runCycle(); // baseline
    expect(q.pendingCount()).toBe(0);

    rows[0]!.OnHand = 4;
    rows[0]!.LastModified = new Date(t0 + 30_000);
    await r.runCycle();
    await r.runCycle(); // la ventana vuelve a leer la misma fila: no se duplica
    // confirmación tardía: fecha anterior al watermark pero dentro del traslape
    rows[1]!.OnHand = 9;
    rows[1]!.LastModified = new Date(t0 + 10_000);
    await r.runCycle();

    const ev = drain(q);
    expect(ev.map((e) => `${e.entity.id}:${e.data.OnHand}`)).toEqual(['1:4', '2:9']);
    expect(ev[0]!.sourceModifiedAt).toBe('2026-10-28T10:00:30.000Z');
    q.close();
  });

  it('con límite por ciclo continúa desde el cursor sin quedarse atascado', async () => {
    const dir = tmpDir();
    const q = DurableQueue.open(dir);
    const base = Date.parse('2026-10-28T10:00:00Z');
    const rows = Array.from({ length: 12 }, (_, i) => ({ ProductId: i + 1, OnHand: i, LastModified: new Date(base + i * 1000) }));
    const client = new ScriptedClient((sql, p) => {
      const n = p.n!.value as number;
      if (p.from) return rows.filter((r) => r.LastModified >= (p.from!.value as Date)).slice(0, n).map((r) => ({ ...r }));
      const m = (p.m!.value as Date).getTime();
      const pk = Number(p.p!.value);
      return rows.filter((r) => r.LastModified.getTime() > m || (r.LastModified.getTime() === m && r.ProductId > pk)).slice(0, n).map((r) => ({ ...r }));
    });
    const cfg = makeConfig(dir, [{ name: 'inventory', table: 'Stock', entityType: 'inventory', primaryKey: 'ProductId', pkType: 'int', columns: ['ProductId', 'OnHand'], strategy: 'modifiedAt', modifiedAtColumn: 'LastModified', overlapSeconds: 3600 }]);
    cfg.capture.startMode = 'initialSnapshot';
    cfg.capture.maxRowsPerCycle = 5;
    const r = new CaptureReader({ config: cfg, client, queue: q, log: nullLogger, connectorVersion: 't' });
    let guard = 0;
    for (;;) {
      const { more } = await r.runCycle();
      if (!more || ++guard > 10) break;
    }
    expect(q.pendingCount()).toBe(12);
    q.close();
  });
});

describe('S4 hashDiff', () => {
  it('baseline sin eventos; luego detecta cambios, altas y (opcional) ausencias', async () => {
    const dir = tmpDir();
    const q = DurableQueue.open(dir);
    let rows = [1, 2, 3, 4].map((i) => ({ ProductId: i, Name: `p${i}` }));
    const client = new ScriptedClient((sql, p) => {
      const n = p.n!.value as number;
      const from = p.c ? Number(p.c.value) : -Infinity;
      return rows.filter((r) => r.ProductId > from).sort((a, b) => a.ProductId - b.ProductId).slice(0, n).map((r) => ({ ...r }));
    });
    let clock = 1_000_000;
    const cfg = makeConfig(dir, [{ name: 'products', table: 'Products', entityType: 'product', primaryKey: 'ProductId', pkType: 'int', columns: ['ProductId', 'Name'], strategy: 'hashDiff', sweepIntervalSeconds: 60, detectDeletes: true }]);
    const r = new CaptureReader({ config: cfg, client, queue: q, log: nullLogger, connectorVersion: 't', now: () => clock });

    for (let i = 0; i < 4; i++) await r.runCycle(); // baseline completo (páginas de 3)
    expect(q.pendingCount()).toBe(0);
    expect(q.getState('products')!.phase).toBe('running');

    rows[1] = { ProductId: 2, Name: 'cambiado' };
    rows = rows.filter((x) => x.ProductId !== 3);
    rows.push({ ProductId: 5, Name: 'nuevo' });

    await r.runCycle(); // dentro del intervalo: no consulta
    const calls = client.calls.length;
    await r.runCycle();
    expect(client.calls.length).toBe(calls);

    clock += 61_000;
    for (let i = 0; i < 4; i++) await r.runCycle();
    const ev = drain(q);
    expect(ev.map((e) => `${e.operation}:${e.entity.id}`).sort()).toEqual(['DELETE:3', 'INSERT:5', 'UPSERT:2']);
    q.close();
  });
  it('llave compuesta: pagina sin saltarse filas con el mismo primer componente', async () => {
    const dir = tmpDir();
    const q = DurableQueue.open(dir);
    let rows = [['A', 1], ['A', 2], ['A', 3], ['B', 1], ['B', 2], ['C', 1], ['C', 2]].map(([Folio, Part]) => ({ Folio, Part, Qty: 1 }));
    const client = new ScriptedClient((sql, p) => {
      const n = p.n!.value as number;
      const keep = p.c0
        ? (r: { Folio: unknown; Part: unknown }) =>
            String(r.Folio) > String(p.c0!.value) || (r.Folio === p.c0!.value && Number(r.Part) > Number(p.c1!.value))
        : () => true;
      return rows.filter(keep).sort((a, b) => String(a.Folio).localeCompare(String(b.Folio)) || Number(a.Part) - Number(b.Part)).slice(0, n).map((r) => ({ ...r }));
    });
    let clock = 1_000_000;
    const cfg = makeConfig(dir, [{ name: 'det', table: 'Det', entityType: 'det', primaryKey: 'Folio', keyColumns: ['Folio', 'Part'], keyTypes: ['string', 'int'], pkType: 'string', columns: ['Folio', 'Part', 'Qty'], strategy: 'hashDiff', sweepIntervalSeconds: 60, detectDeletes: true }]);
    const r = new CaptureReader({ config: cfg, client, queue: q, log: nullLogger, connectorVersion: 't', now: () => clock });
    for (let i = 0; i < 5; i++) await r.runCycle();
    expect(q.pendingCount()).toBe(0);

    rows[2] = { Folio: 'A', Part: 3, Qty: 9 };
    rows = rows.filter((x) => !(x.Folio === 'B' && x.Part === 1));
    clock += 61_000;
    for (let i = 0; i < 5; i++) await r.runCycle();
    const ev = drain(q);
    expect(ev.map((e) => `${e.operation}:${e.entity.id}`).sort()).toEqual(['DELETE:["B","1"]', 'UPSERT:["A","3"]']);
    q.close();
  });
});
