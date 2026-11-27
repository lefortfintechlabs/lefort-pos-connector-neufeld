import type { TableOf } from '../config';
import { qualified, q, selectList } from '../db/identifiers';
import { observe, pkOf, pkParamType } from './common';
import type { InitResult, PollContext, PollResult, Strategy } from './types';

interface State extends Record<string, unknown> {
  /** Última PK leída en el barrido en curso (null = inicio). */
  cursor: string | string[] | null;
  /** Número del barrido en curso (se guarda como last_seen en cada fila). */
  sweep: number;
  /** Fin del último barrido completo (ms epoch) para respetar sweepIntervalSeconds. */
  lastSweepEndedAt: number | null;
}

/**
 * S4: comparación por hash. Recorre la tabla por rangos de PK (keyset) y el lector compara cada
 * hash contra el estado local en SQLite. Es la red de seguridad cuando no hay marca de cambio fiable.
 * Costoso: el barrido es espaciado (sweepIntervalSeconds) y limitado por ciclo (maxRowsPerCycle).
 */
export const hashDiffStrategy: Strategy = {
  async init(_client, _table, mode): Promise<InitResult> {
    const state: State = { cursor: null, sweep: 1, lastSweepEndedAt: null };
    // En changesOnly el primer barrido completo es el baseline (registra hashes sin emitir eventos).
    return { state, needsBaselinePoll: mode === 'changesOnly' };
  },

  async poll(ctx: PollContext): Promise<PollResult> {
    const table = ctx.table as TableOf<'hashDiff'>;
    const state = ctx.state as State;
    const idle: PollResult = { observations: [], nextState: state, more: false, baselineComplete: false };

    if (state.cursor === null && state.lastSweepEndedAt !== null) {
      if (ctx.now - state.lastSweepEndedAt < table.sweepIntervalSeconds * 1000) return idle;
    }

    const keys = table.keyColumns ?? [table.primaryKey];
    const types = table.keyTypes ?? [table.pkType];
    const order = keys.map((k) => `${q(k)} ASC`).join(', ');
    const head = `SELECT TOP (@n) ${selectList(table.columns)} FROM ${qualified(table)}`;
    const firstSql = `${head} ORDER BY ${order}`;
    // Paginación por llave (compuesta): (k0 > @c0) OR (k0 = @c0 AND k1 > @c1) ...
    const after =
      keys.length === 1
        ? `${q(keys[0]!)} > @c`
        : keys
            .map((_, i) => '(' + [...keys.slice(0, i).map((k, j) => `${q(k)} = @c${j}`), `${q(keys[i]!)} > @c${i}`].join(' AND ') + ')')
            .join(' OR ');
    const nextSql = `${head} WHERE ${after} ORDER BY ${order}`;
    const cursorParams = (vals: string[]) =>
      Object.fromEntries(
        vals.map((v, i) => [keys.length === 1 ? 'c' : `c${i}`, { type: pkParamType({ ...table, pkType: types[i]! }), value: v }])
      );

    let cursor: string[] | null = state.cursor === null ? null : [state.cursor].flat();
    const observations = [];
    let total = 0;
    let completed = false;
    let capped = false;

    for (;;) {
      const n = Math.min(ctx.pageRows, ctx.maxRows - total);
      const rows =
        cursor === null
          ? await ctx.client.query(firstSql, { n: { type: 'int', value: n } })
          : await ctx.client.query(nextSql, { n: { type: 'int', value: n }, ...cursorParams(cursor) });
      for (const r of rows) {
        pkOf(r, table);
        cursor = keys.map((k) => String(r[k]));
        observations.push(observe(r, table));
      }
      total += rows.length;
      if (rows.length < n) {
        completed = true;
        break;
      }
      if (total >= ctx.maxRows) {
        capped = true;
        break;
      }
    }

    const next: State = completed
      ? { cursor: null, sweep: state.sweep + 1, lastSweepEndedAt: ctx.now }
      : { cursor: cursor && cursor.length === 1 && keys.length === 1 ? cursor[0]! : cursor, sweep: state.sweep, lastSweepEndedAt: state.lastSweepEndedAt };
    return {
      observations,
      nextState: next,
      more: capped,
      baselineComplete: completed,
      seenSweep: state.sweep,
      sweepCompleted: completed ? state.sweep : undefined
    };
  }
};
