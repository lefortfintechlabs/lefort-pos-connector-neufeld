import { createHash } from 'node:crypto';

export type Row = Record<string, unknown>;

/** Convierte valores del driver SQL a JSON estable (fechas ISO, binarios hex, bigint string). */
export function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) out[k] = toJsonSafe((value as Row)[k]);
    return out;
  }
  return value;
}

/** Subconjunto de columnas configuradas, con claves ordenadas, listo para serializar. */
export function canonicalRow(row: Row, columns: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of [...columns].sort()) out[c] = toJsonSafe(row[c]);
  return out;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function rowHash(row: Row, columns: readonly string[]): string {
  return sha256Hex(JSON.stringify(canonicalRow(row, columns)));
}

/** Identificador determinista: el mismo cambio releído produce el mismo eventId. */
export function makeEventId(parts: readonly string[]): string {
  return sha256Hex(parts.join('\u001f'));
}
