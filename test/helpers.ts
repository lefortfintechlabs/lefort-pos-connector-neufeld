import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig, requireResolved, type ResolvedConfig } from '../src/config';
import { assertReadOnlySelect } from '../src/db/sqlGuard';
import type { SqlClient, SqlParams } from '../src/db/sqlClient';
import type { Row } from '../src/util/hash';
import { DurableQueue, type NewEvent } from '../src/queue/queue';

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lefort-test-'));
}

export function makeConfig(dataDir: string, tables: unknown[], webhook: Record<string, unknown> = {}): ResolvedConfig {
  return requireResolved(parseConfig({
    connectorId: 'store-001',
    sql: { server: 'localhost\\SQLEXPRESS', database: 'POS', auth: { type: 'windows' } },
    webhook: { url: 'https://example.test/hook', backoffBaseMs: 1000, backoffMaxMs: 60_000, ...webhook },
    capture: { pollIntervalMs: 500, pageRows: 3, maxRowsPerCycle: 100, tables },
    queue: { dataDir },
    logging: { dir: path.join(dataDir, 'logs') }
  }));
}

/** Cliente simulado: valida con el guardia CADA consulta, igual que el cliente real. */
export class ScriptedClient implements SqlClient {
  calls: { sql: string; params: SqlParams }[] = [];
  constructor(private readonly handler: (sql: string, params: SqlParams) => Row[]) {}
  async query(sql: string, params: SqlParams = {}): Promise<Row[]> {
    assertReadOnlySelect(sql);
    this.calls.push({ sql, params });
    return this.handler(sql, params);
  }
  async close(): Promise<void> {}
}

export const buf = (n: bigint): Buffer => Buffer.from(n.toString(16).padStart(16, '0'), 'hex');
export const big = (b: unknown): bigint => BigInt('0x' + (b as Buffer).toString('hex'));

export function enqueue(queue: DurableQueue, count: number, prefix = 'ev'): NewEvent[] {
  const events: NewEvent[] = [];
  for (let i = 1; i <= count; i++) {
    const id = `${prefix}-${i}`;
    events.push({
      eventId: id,
      tableName: 'orders',
      entityKey: String(i),
      operation: 'UPSERT',
      payload: JSON.stringify({ eventId: id, entity: { id: String(i) } }),
      observedAt: new Date().toISOString()
    });
  }
  queue.commitCapture({ table: 'orders', state: { phase: 'running', data: {} }, events, rowUpdates: [] });
  return events;
}
