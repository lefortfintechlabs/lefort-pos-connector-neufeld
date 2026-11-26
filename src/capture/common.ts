import type { TableConfig } from '../config';
import type { SqlParamType } from '../db/sqlClient';
import type { Row } from '../util/hash';
import { rowHash } from '../util/hash';
import type { Observation } from './types';

export function pkParamType(t: TableConfig): SqlParamType {
  return t.pkType === 'string' ? 'nvarchar' : t.pkType;
}

export function pkOf(row: Row, t: TableConfig): string {
  if (t.keyColumns && t.keyColumns.length > 1) {
    const parts = t.keyColumns.map((c) => {
      const p = row[c];
      if (p === null || p === undefined) throw new Error(`La fila de ${t.name} no trae la columna de llave ${c}`);
      return String(p);
    });
    return JSON.stringify(parts);
  }
  const v = row[t.primaryKey];
  if (v === null || v === undefined) throw new Error(`La fila de ${t.name} no trae clave primaria (${t.primaryKey})`);
  return String(v);
}

/** Extrae solo las columnas configuradas (descarta alias internos como __rv). */
export function visibleRow(row: Row, t: TableConfig): Row {
  const out: Row = {};
  for (const c of t.columns) out[c] = row[c];
  return out;
}

export function observe(row: Row, t: TableConfig, extra: Partial<Observation> = {}): Observation {
  const visible = visibleRow(row, t);
  const hash = rowHash(visible, t.columns);
  return { pk: pkOf(row, t), row: visible, hash, version: extra.version ?? hash, ...extra };
}

export function maxBigIntString(a: string, b: string): string {
  return BigInt(a) >= BigInt(b) ? a : b;
}
