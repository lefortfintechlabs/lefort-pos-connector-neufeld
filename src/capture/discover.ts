import type { ConnectorConfig, RawTableConfig, ResolvedConfig, TableConfig } from '../config';
import { qualified } from '../db/identifiers';
import type { SqlClient } from '../db/sqlClient';
import type { Logger } from '../logger';

type AutoTable = Extract<RawTableConfig, { strategy: 'auto' }>;

const INT_TYPES = new Set(['tinyint', 'smallint', 'int']);
const STRING_KEY_TYPES = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'uniqueidentifier', 'decimal', 'numeric']);

function pkTypeOf(sqlType: string): TableConfig['pkType'] | undefined {
  if (INT_TYPES.has(sqlType)) return 'int';
  if (sqlType === 'bigint') return 'bigint';
  if (STRING_KEY_TYPES.has(sqlType)) return 'string';
  return undefined;
}

async function resolveOne(client: SqlClient, t: AutoTable): Promise<TableConfig> {
  const obj = { type: 'nvarchar', value: qualified(t) } as const;

  const cols = await client.query(
    `SELECT c.name AS name, ty.name AS type_name FROM sys.columns c
       JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      WHERE c.object_id = OBJECT_ID(@o) ORDER BY c.column_id`,
    { o: obj }
  );
  if (cols.length === 0) {
    throw new Error(`${qualified(t)}: no existe o la cuenta no tiene permiso para verla`);
  }
  const rowversionCol = cols.find((c) => c.type_name === 'timestamp');

  // Llave: la PK; si no hay, el primer índice único sin filtro.
  const keyRows = await client.query(
    `SELECT i.index_id AS index_id, i.is_primary_key AS is_pk, c.name AS name, ty.name AS type_name
       FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      WHERE i.object_id = OBJECT_ID(@o) AND (i.is_primary_key = 1 OR i.is_unique = 1)
        AND i.has_filter = 0 AND i.is_disabled = 0
      ORDER BY i.is_primary_key DESC, i.index_id, ic.key_ordinal`,
    { o: obj }
  );
  const firstIndex = keyRows[0]?.index_id;
  let key = keyRows.filter((r) => r.index_id === firstIndex).map((r) => ({ name: String(r.name), type: String(r.type_name) }));
  if (t.primaryKey) {
    const c = cols.find((x) => x.name === t.primaryKey);
    if (!c) throw new Error(`${qualified(t)}: primaryKey "${t.primaryKey}" no existe`);
    key = [{ name: t.primaryKey, type: String(c.type_name) }];
  }
  if (key.length === 0) {
    throw new Error(`${qualified(t)}: sin llave primaria ni índice único; indique "primaryKey" en la configuración`);
  }
  const keyNames = key.map((k) => k.name);

  let columns: string[];
  if (t.columns === '*') {
    const excluded = new Set(t.excludeColumns.map((x) => x.toLowerCase()));
    columns = cols
      .filter((c) => c.type_name !== 'timestamp' && !excluded.has(String(c.name).toLowerCase()))
      .map((c) => String(c.name));
  } else {
    columns = [...t.columns];
  }
  for (const k of [...keyNames].reverse()) if (!columns.includes(k)) columns.unshift(k);

  const first = key[0]!;
  const pkType = pkTypeOf(first.type);
  const common = {
    name: t.name,
    schema: t.schema,
    table: t.table,
    entityType: t.entityType,
    enabled: t.enabled,
    primaryKey: first.name,
    ...(key.length > 1 ? { keyColumns: keyNames } : {}),
    columns
  };

  if (rowversionCol) {
    return { ...common, pkType: pkType ?? 'string', strategy: 'rowversion', rowversionColumn: String(rowversionCol.name) };
  }

  if (key.length > 1) {
    throw new Error(
      `${qualified(t)}: llave compuesta (${keyNames.join(', ')}) y sin columna rowversion; ` +
        'configure la tabla a mano (p. ej. modifiedAt con una columna de fecha) o indique otra "primaryKey"'
    );
  }
  if (!pkType) {
    throw new Error(`${qualified(t)}: tipo de llave no soportado (${first.type}) en la columna ${first.name}`);
  }
  return {
    ...common,
    pkType,
    strategy: 'hashDiff',
    sweepIntervalSeconds: t.sweepIntervalSeconds,
    detectDeletes: t.detectDeletes
  };
}

/** Convierte las tablas `auto` en tablas concretas leyendo solo catálogos (sys.*). Falla si alguna no se puede resolver. */
export async function resolveTables(client: SqlClient, cfg: ConnectorConfig, log: Logger): Promise<ResolvedConfig> {
  const errors: string[] = [];
  const tables: TableConfig[] = [];
  for (const t of cfg.capture.tables) {
    if (t.strategy !== 'auto') {
      tables.push(t);
      continue;
    }
    if (!t.enabled) continue;
    try {
      const r = await resolveOne(client, t);
      log.info('table_resolved', {
        table: t.name,
        strategy: r.strategy,
        key: r.keyColumns ?? [r.primaryKey],
        columns: r.columns.length
      });
      tables.push(r);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (errors.length) throw new Error(`No se pudieron resolver tablas:\n  - ${errors.join('\n  - ')}`);
  return { ...cfg, capture: { ...cfg.capture, tables } };
}
