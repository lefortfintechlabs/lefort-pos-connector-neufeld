import type { TableOf } from '../config';
import { qualified, q, selectList } from '../db/identifiers';
import { maxBigIntString, observe, pkOf, pkParamType } from './common';
import type { InitResult, PollContext, PollResult, Strategy } from './types';

interface State extends Record<string, unknown> {
  maxPk: string;
}

/**
 * S3: PK creciente + "ventana caliente". Detecta filas nuevas (pk > maxPk) y relee las últimas N por PK
 * para ver cambios en registros recientes. NO detecta cambios en filas antiguas (SDD §5.2):
 * apta para órdenes recientes, no para inventario.
 */
export const pkWindowStrategy: Strategy = {
  async init(client, tableCfg, mode): Promise<InitResult> {
    const table = tableCfg as TableOf<'pkWindow'>;
    if (mode === 'initialSnapshot') return { state: { maxPk: '0' } satisfies State, needsBaselinePoll: false };
    const rows = await client.query(`SELECT MAX(${q(table.primaryKey)}) AS m FROM ${qualified(table)}`);
    const m = rows[0]?.m;
    return { state: { maxPk: m === null || m === undefined ? '0' : String(m) } satisfies State, needsBaselinePoll: true };
  },

  async poll(ctx: PollContext): Promise<PollResult> {
    const table = ctx.table as TableOf<'pkWindow'>;
    const pk = q(table.primaryKey);
    const newRowsSql = `SELECT TOP (@n) ${selectList(table.columns)} FROM ${qualified(table)} WHERE ${pk} > @maxPk ORDER BY ${pk} ASC`;
    const hotSql = `SELECT TOP (@n) ${selectList(table.columns)} FROM ${qualified(table)} ORDER BY ${pk} DESC`;

    let maxPk = (ctx.state as State).maxPk;
    const seen = new Set<string>();
    const observations = [];
    let total = 0;
    let capped = false;

    for (;;) {
      const n = Math.min(ctx.pageRows, ctx.maxRows - total);
      const rows = await ctx.client.query(newRowsSql, {
        n: { type: 'int', value: n },
        maxPk: { type: pkParamType(table), value: maxPk }
      });
      for (const r of rows) {
        const key = pkOf(r, table);
        maxPk = maxBigIntString(maxPk, key);
        seen.add(key);
        observations.push(observe(r, table, { operation: 'INSERT' }));
      }
      total += rows.length;
      if (rows.length < n) break;
      if (total >= ctx.maxRows) {
        capped = true;
        break;
      }
    }

    // La ventana caliente solo se consulta cuando ya estamos al día con las filas nuevas.
    if (!capped) {
      const rows = await ctx.client.query(hotSql, { n: { type: 'int', value: table.hotWindowRows } });
      for (const r of rows) {
        const key = pkOf(r, table);
        if (seen.has(key)) continue;
        maxPk = maxBigIntString(maxPk, key);
        observations.push(observe(r, table, { operation: 'UPSERT' }));
      }
    }
    return { observations, nextState: { maxPk } satisfies State, more: capped, baselineComplete: true };
  }
};
