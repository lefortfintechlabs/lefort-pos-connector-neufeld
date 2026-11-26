import type { TableOf } from '../config';
import { qualified, q, selectList } from '../db/identifiers';
import { observe } from './common';
import type { InitResult, PollContext, PollResult, Strategy } from './types';

const ZERO = '0000000000000000';

export const hexToBuf = (hex: string): Buffer => Buffer.from(hex, 'hex');
export const bufToHex = (b: Buffer): string => b.toString('hex');
const bufToBig = (b: Buffer): bigint => BigInt('0x' + (b.toString('hex') || '0'));
const bigToHex = (n: bigint): string => n.toString(16).padStart(16, '0');

interface State extends Record<string, unknown> {
  /** Último rowversion procesado (hex de 8 bytes). */
  wm: string;
}

/**
 * S1: rowversion existente. Solo se leen filas con rowversion < MIN_ACTIVE_ROWVERSION(), es decir,
 * confirmadas: así no se salta una transacción larga que confirme más tarde (SDD §5.2, riesgo R4).
 */
export const rowversionStrategy: Strategy = {
  async init(client, table, mode): Promise<InitResult> {
    if (mode === 'initialSnapshot') return { state: { wm: ZERO } satisfies State, needsBaselinePoll: false };
    const rows = await client.query('SELECT MIN_ACTIVE_ROWVERSION() AS v');
    const v = rows[0]?.v;
    if (!Buffer.isBuffer(v)) throw new Error(`No se pudo leer MIN_ACTIVE_ROWVERSION() para ${table.name}`);
    const n = bufToBig(v);
    return { state: { wm: bigToHex(n > 0n ? n - 1n : 0n) } satisfies State, needsBaselinePoll: false };
  },

  async poll(ctx: PollContext): Promise<PollResult> {
    const table = ctx.table as TableOf<'rowversion'>;
    const rv = q(table.rowversionColumn);
    const sql =
      `SELECT TOP (@n) ${selectList(table.columns)}, ${rv} AS [__rv] FROM ${qualified(table)} ` +
      `WHERE ${rv} > @wm AND ${rv} < MIN_ACTIVE_ROWVERSION() ORDER BY ${rv} ASC`;

    let wm = (ctx.state as State).wm;
    const observations = [];
    let total = 0;
    let capped = false;
    for (;;) {
      const n = Math.min(ctx.pageRows, ctx.maxRows - total);
      const rows = await ctx.client.query(sql, {
        n: { type: 'int', value: n },
        wm: { type: 'varbinary8', value: hexToBuf(wm) }
      });
      for (const r of rows) {
        const rvBuf = r.__rv;
        if (!Buffer.isBuffer(rvBuf)) throw new Error(`rowversion inválido en ${table.name}`);
        wm = bufToHex(rvBuf);
        observations.push(observe(r, table, { version: wm, operation: 'UPSERT' }));
      }
      total += rows.length;
      if (rows.length < n) break;
      if (total >= ctx.maxRows) {
        capped = true;
        break;
      }
    }
    return { observations, nextState: { wm } satisfies State, more: capped, baselineComplete: true };
  }
};
