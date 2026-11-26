import { describe, expect, it, vi } from 'vitest';
import { nullLogger } from '../src/logger';
import { ConnectorService } from '../src/service';
import { DurableQueue } from '../src/queue/queue';
import { makeConfig, ScriptedClient, tmpDir } from './helpers';
import { sleep } from '../src/util/time';

describe('servicio de extremo a extremo (SQL simulado + webhook simulado)', () => {
  it('captura un cambio, lo entrega y deja el estado visible para la CLI', async () => {
    const dir = tmpDir();
    const rows = [{ Id: 1, Status: 'open' }];
    const client = new ScriptedClient((sql) => {
      if (sql.startsWith('SELECT MAX(')) return [{ m: 1 }];
      if (sql.includes('[Id] > @maxPk')) return rows.filter((r) => r.Id > 1).map((r) => ({ ...r }));
      if (sql.includes('ORDER BY [Id] DESC')) return rows.map((r) => ({ ...r }));
      throw new Error('SQL inesperado');
    });
    const delivered: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_u, init) => {
      const body = JSON.parse(init!.body as string);
      for (const e of body.events) delivered.push(e.eventId);
      return new Response(JSON.stringify({ accepted: body.events.map((e: { eventId: string }) => e.eventId) }), { status: 200 });
    });
    const cfg = makeConfig(dir, [{ name: 'items', table: 'Items', entityType: 'item', primaryKey: 'Id', pkType: 'int', columns: ['Id', 'Status'], strategy: 'pkWindow', hotWindowRows: 5 }]);
    const svc = new ConnectorService(cfg, nullLogger, { client, fetchImpl });
    await svc.start();
    await sleep(700); // baseline
    rows.push({ Id: 2, Status: 'open' });
    await sleep(2800); // captura (500 ms) + entrega (ciclo de 1 s)
    await svc.stop();

    expect(delivered).toHaveLength(1);
    const q = DurableQueue.openReadOnly(dir);
    expect(q.stats()).toMatchObject({ pending: 0, sent: 1 });
    q.close();
  }, 15000);
});
