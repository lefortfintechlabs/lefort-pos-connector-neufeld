import type { TableConfig } from '../config';

/** Entrecomilla un identificador T-SQL. La configuración ya valida el patrón permitido. */
export function q(ident: string): string {
  return '[' + ident.replace(/]/g, ']]') + ']';
}

export function qualified(t: Pick<TableConfig, 'schema' | 'table'>): string {
  return `${q(t.schema)}.${q(t.table)}`;
}

/** Cada columna se devuelve con el alias exacto de la configuración, sin depender de mayúsculas del esquema. */
export function selectList(columns: readonly string[]): string {
  return columns.map((c) => `${q(c)} AS ${q(c)}`).join(', ');
}
