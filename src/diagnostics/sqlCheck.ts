import type { ResolvedConfig, TableConfig } from '../config';
import { q, qualified, selectList } from '../db/identifiers';
import type { SqlClient } from '../db/sqlClient';

export interface CheckResult {
  level: 'ok' | 'warn' | 'fail';
  check: string;
  detail: string;
}

const one = (v: unknown) => Number(v) === 1;

function watermarkColumn(t: TableConfig): string {
  switch (t.strategy) {
    case 'rowversion':
      return t.rowversionColumn;
    case 'modifiedAt':
      return t.modifiedAtColumn;
    default:
      return t.primaryKey;
  }
}

/**
 * `test-sqlserver`: comprueba conexión, privilegios efectivos y que las consultas tengan índice.
 * Solo emite SELECT (pasan por el guardia): no modifica nada.
 */
export async function checkSqlServer(client: SqlClient, cfg: ResolvedConfig): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const add = (level: CheckResult['level'], check: string, detail: string) => out.push({ level, check, detail });

  try {
    const [r] = await client.query(
      'SELECT @@VERSION AS v, DB_NAME() AS db, SUSER_SNAME() AS login_name, IS_SRVROLEMEMBER(\'sysadmin\') AS sa'
    );
    add('ok', 'conexion', `${String(r?.db)} como ${String(r?.login_name)}`);
    add('ok', 'version', String(r?.v).split('\n')[0] ?? '');
    if (one(r?.sa)) add('fail', 'privilegios', 'La cuenta es sysadmin: exceso de privilegios (SDD §6.1).');
    else add('ok', 'privilegios', 'La cuenta no es sysadmin.');
  } catch (e) {
    add('fail', 'conexion', (e as Error).message);
    return out;
  }

  try {
    const [d] = await client.query(
      `SELECT HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'INSERT') AS i, HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'UPDATE') AS u,
              HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'DELETE') AS d, HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE') AS c,
              HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'ALTER') AS a`
    );
    const bad = Object.entries({ INSERT: d?.i, UPDATE: d?.u, DELETE: d?.d, 'CREATE TABLE': d?.c, ALTER: d?.a })
      .filter(([, v]) => one(v))
      .map(([k]) => k);
    if (bad.length) add('fail', 'permisos_bd', `La cuenta tiene permisos de escritura en la base: ${bad.join(', ')}`);
    else add('ok', 'permisos_bd', 'Sin permisos de escritura a nivel de base de datos.');
  } catch (e) {
    add('warn', 'permisos_bd', `No se pudieron verificar: ${(e as Error).message}`);
  }

  for (const t of cfg.capture.tables.filter((x) => x.enabled)) {
    const label = `${t.name} (${t.strategy})`;
    const obj = qualified(t);
    try {
      const [p] = await client.query(
        `SELECT HAS_PERMS_BY_NAME(@o, 'OBJECT', 'SELECT') AS s, HAS_PERMS_BY_NAME(@o, 'OBJECT', 'INSERT') AS i,
                HAS_PERMS_BY_NAME(@o, 'OBJECT', 'UPDATE') AS u, HAS_PERMS_BY_NAME(@o, 'OBJECT', 'DELETE') AS d,
                HAS_PERMS_BY_NAME(@o, 'OBJECT', 'ALTER') AS a`,
        { o: { type: 'nvarchar', value: obj } }
      );
      if (!one(p?.s)) add('fail', `select:${label}`, `Sin permiso SELECT sobre ${obj}.`);
      else add('ok', `select:${label}`, `SELECT permitido sobre ${obj}.`);
      const writes = Object.entries({ INSERT: p?.i, UPDATE: p?.u, DELETE: p?.d, ALTER: p?.a })
        .filter(([, v]) => one(v))
        .map(([k]) => k);
      if (writes.length) add('fail', `escritura:${label}`, `Permisos de escritura presentes: ${writes.join(', ')}`);
      else add('ok', `escritura:${label}`, 'Sin permisos de escritura.');
    } catch (e) {
      add('fail', `permisos:${label}`, (e as Error).message);
      continue;
    }

    try {
      await client.query(`SELECT TOP (0) ${selectList(t.columns)} FROM ${obj}`);
      add('ok', `columnas:${label}`, 'Todas las columnas configuradas existen y se pueden leer.');
    } catch (e) {
      add('fail', `columnas:${label}`, (e as Error).message);
      continue;
    }

    try {
      const col = watermarkColumn(t);
      const [ix] = await client.query(
        `SELECT COUNT(*) AS n FROM sys.indexes i
           JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal = 1
           JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
          WHERE i.object_id = OBJECT_ID(@o) AND c.name = @c`,
        { o: { type: 'nvarchar', value: obj }, c: { type: 'nvarchar', value: col } }
      );
      if (Number(ix?.n) > 0) add('ok', `indice:${label}`, `${q(col)} encabeza un índice: consultas con seek.`);
      else
        add(
          'warn',
          `indice:${label}`,
          `${q(col)} no encabeza ningún índice visible: cada consulta podría escanear la tabla. No se pueden crear índices; aumente pollIntervalMs o use otra estrategia (SDD R5).`
        );
    } catch (e) {
      add('warn', `indice:${label}`, `No se pudo verificar: ${(e as Error).message}`);
    }
  }
  return out;
}
