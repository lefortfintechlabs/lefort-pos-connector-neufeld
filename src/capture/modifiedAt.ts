import type { TableOf } from '../config';
import { qualified, q, selectList } from '../db/identifiers';
import type { Row } from '../util/hash';
import { wallClockToUtcIso } from '../util/time';
import { observe, pkOf, pkParamType } from './common';
import type { InitResult, PollContext, PollResult, Strategy } from './types';

const EPOCH = '1900-01-01T00:00:00.000Z';

interface State extends Record<string, unknown> {
  /** Mayor fecha de modificación vista (reloj de pared del POS, serializado como ISO). */
  ts: string;
  /** Si el ciclo anterior se cortó por límite, desde dónde continuar sin ventana de traslape. */
  cursor?: { ts: string; pk: string };
}

/**
 * S2: fecha de modificación + PK. Cada ciclo relee una ventana de traslape (overlapSeconds) para
 * absorber confirmaciones tardías y el redondeo de datetime; los duplicados se descartan por hash.
 * Filas con fecha de modificación NULL no son visibles para esta estrategia.
 */
export const modifiedAtStrategy: Strategy = {
  async init(client, tableCfg, mode): Promise<InitResult> {
    const table = tableCfg as TableOf<'modifiedAt'>;
    if (mode === 'initialSnapshot') return { state: { ts: EPOCH } satisfies State, needsBaselinePoll: false };
    const rows = await client.query(`SELECT MAX(${q(table.modifiedAtColumn)}) AS m FROM ${qualified(table)}`);
    const m = rows[0]?.m;
    return { state: { ts: m instanceof Date ? m.toISOString() : EPOCH } satisfies State, needsBaselinePoll: true };
  },

  async poll(ctx: PollContext): Promise<PollResult> {
    const table = ctx.table as TableOf<'modifiedAt'>;
    const state = ctx.state as State;
    const col = q(table.modifiedAtColumn);
    const pk = q(table.primaryKey);
    const base = `SELECT TOP (@n) ${selectList(table.columns)} FROM ${qualified(table)}`;
    const order = ` ORDER BY ${col} ASC, ${pk} ASC`;
    const firstPageSql = `${base} WHERE ${col} >= @from${order}`;
    const nextPageSql = `${base} WHERE (${col} > @m OR (${col} = @m AND ${pk} > @p))${order}`;

    let cursor: { ts: string; pk: string } | undefined = state.cursor;
    const from = new Date(Date.parse(state.ts) - table.overlapSeconds * 1000);
    let maxTs = Date.parse(state.ts);
    const observations = [];
    let total = 0;
    let capped = false;
    let first = !cursor;

    for (;;) {
      const n = Math.min(ctx.pageRows, ctx.maxRows - total);
      const rows: Row[] = first
        ? await ctx.client.query(firstPageSql, {
            n: { type: 'int', value: n },
            from: { type: table.modifiedAtType, value: from }
          })
        : await ctx.client.query(nextPageSql, {
            n: { type: 'int', value: n },
            m: { type: table.modifiedAtType, value: new Date(cursor!.ts) },
            p: { type: pkParamType(table), value: cursor!.pk }
          });
      first = false;
      for (const r of rows) {
        const d = r[table.modifiedAtColumn];
        if (!(d instanceof Date)) continue;
        cursor = { ts: d.toISOString(), pk: pkOf(r, table) };
        maxTs = Math.max(maxTs, d.getTime());
        observations.push(
          observe(r, table, { sourceModifiedAt: wallClockToUtcIso(d, ctx.sourceTimeZone), operation: 'UPSERT' })
        );
      }
      total += rows.length;
      if (rows.length < n) break;
      if (total >= ctx.maxRows) {
        capped = true;
        break;
      }
    }
    const next: State = { ts: new Date(maxTs).toISOString() };
    if (capped && cursor) next.cursor = cursor;
    return { observations, nextState: next, more: capped, baselineComplete: true };
  }
};
