import type { TableOf } from '../config';
import { qualified, q, selectList } from '../db/identifiers';
import { observe, pkOf, pkParamType } from './common';
import type { InitResult, PollContext, PollResult, Strategy } from './types';

interface State extends Record<string, unknown> {
  /** Última PK leída en el barrido en curso (null = inicio). */
  cursor: string | null;
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

    const pk = q(table.primaryKey);
    const head = `SELECT TOP (@n) ${selectList(table.columns)} FROM ${qualified(table)}`;
    const firstSql = `${head} ORDER BY ${pk} ASC`;
    const nextSql = `${head} WHERE ${pk} > @c ORDER BY ${pk} ASC`;

    let cursor = state.cursor;
    const observations = [];
    let total = 0;
    let completed = false;
    let capped = false;

    for (;;) {
      const n = Math.min(ctx.pageRows, ctx.maxRows - total);
      const rows =
        cursor === null
          ? await ctx.client.query(firstSql, { n: { type: 'int', value: n } })
          : await ctx.client.query(nextSql, {
              n: { type: 'int', value: n },
              c: { type: pkParamType(table), value: cursor }
            });
      for (const r of rows) {
        cursor = pkOf(r, table);
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
      : { cursor, sweep: state.sweep, lastSweepEndedAt: state.lastSweepEndedAt };
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
