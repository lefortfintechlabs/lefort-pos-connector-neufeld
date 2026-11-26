import type { SqlConfig, Secrets } from '../config';
import type { Logger } from '../logger';
import type { Row } from '../util/hash';
import { assertReadOnlySelect } from './sqlGuard';

export type SqlParamType = 'int' | 'bigint' | 'datetime' | 'datetime2' | 'varbinary8' | 'nvarchar';
export interface SqlParam {
  type: SqlParamType;
  value: unknown;
}
export type SqlParams = Record<string, SqlParam>;

/** Única puerta de acceso a SQL Server. No existe ningún método de escritura. */
export interface SqlClient {
  query(select: string, params?: SqlParams): Promise<Row[]>;
  close(): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MssqlModule = any;

export class MssqlReadOnlyClient implements SqlClient {
  /** READ COMMITTED por defecto; SNAPSHOT solo si la base YA lo tiene habilitado (no se modifica nada). */
  isolation: 'READ COMMITTED' | 'SNAPSHOT' = 'READ COMMITTED';

  private constructor(
    private readonly mssql: MssqlModule,
    private readonly pool: { request(): any; close(): Promise<void> },
    private readonly cfg: SqlConfig
  ) {}

  static async connect(cfg: SqlConfig, secrets: Secrets, log: Logger): Promise<MssqlReadOnlyClient> {
    const mssql: MssqlModule = cfg.driver === 'msnodesqlv8' ? require('mssql/msnodesqlv8') : require('mssql');
    const poolConfig =
      cfg.driver === 'msnodesqlv8' ? buildOdbcConfig(cfg, secrets) : buildTediousConfig(cfg, secrets);
    const pool = new mssql.ConnectionPool(poolConfig);
    pool.on('error', (err: Error) => log.error('sql_pool_error', { error: err.message }));
    await pool.connect();
    const client = new MssqlReadOnlyClient(mssql, pool, cfg);
    if (cfg.isolation === 'auto') await client.detectSnapshot(log);
    return client;
  }

  private async detectSnapshot(log: Logger): Promise<void> {
    try {
      const rows = await this.query('SELECT snapshot_isolation_state AS s FROM sys.databases WHERE name = DB_NAME()');
      if (Number(rows[0]?.s) === 1) this.isolation = 'SNAPSHOT';
    } catch (e) {
      log.warn('snapshot_detection_failed', { error: (e as Error).message });
    }
    log.info('sql_isolation', { isolation: this.isolation });
  }

  async query(select: string, params: SqlParams = {}): Promise<Row[]> {
    assertReadOnlySelect(select);
    // Opciones de sesión (no escriben datos): ceder ante el POS y no esperar bloqueos largos.
    const prefix =
      `SET LOCK_TIMEOUT ${Math.trunc(this.cfg.lockTimeoutMs)}; SET DEADLOCK_PRIORITY LOW; ` +
      `SET TRANSACTION ISOLATION LEVEL ${this.isolation};\n`;
    const request = this.pool.request();
    for (const [name, p] of Object.entries(params)) request.input(name, this.typeOf(p.type), p.value);
    const result = await request.query(prefix + select);
    return (result.recordset ?? []) as Row[];
  }

  private typeOf(t: SqlParamType): unknown {
    const m = this.mssql;
    switch (t) {
      case 'int':
        return m.Int;
      case 'bigint':
        return m.BigInt;
      case 'datetime':
        return m.DateTime;
      case 'datetime2':
        return m.DateTime2;
      case 'varbinary8':
        return m.VarBinary(8);
      case 'nvarchar':
        return m.NVarChar(512);
    }
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}

function buildOdbcConfig(cfg: SqlConfig, secrets: Secrets) {
  const parts = [
    `Driver={${cfg.odbcDriver}}`,
    `Server=${cfg.port ? `${cfg.server},${cfg.port}` : cfg.server}`,
    `Database=${cfg.database}`,
    `Encrypt=${cfg.encrypt ? 'yes' : 'no'}`,
    `TrustServerCertificate=${cfg.trustServerCertificate ? 'yes' : 'no'}`,
    `ApplicationName=LefortPOSConnector`
  ];
  if (cfg.auth.type === 'windows') parts.push('Trusted_Connection=Yes');
  else parts.push(`UID=${cfg.auth.user}`, `PWD={${(secrets.sqlPassword ?? '').replace(/}/g, '}}')}}`);
  return {
    connectionString: parts.join(';') + ';',
    connectionTimeout: cfg.connectTimeoutMs,
    requestTimeout: cfg.requestTimeoutMs,
    options: { useUTC: true }
  };
}

function buildTediousConfig(cfg: SqlConfig, secrets: Secrets) {
  // tedious solo habla TCP/IP: requiere que la instancia lo tenga habilitado (SDD §5.6).
  const [host = 'localhost', instance] = cfg.server.replace(/^(lpc|np|tcp):/i, '').split('\\');
  return {
    server: host,
    port: instance ? undefined : cfg.port,
    database: cfg.database,
    user: cfg.auth.type === 'sql' ? cfg.auth.user : undefined,
    password: secrets.sqlPassword,
    connectionTimeout: cfg.connectTimeoutMs,
    requestTimeout: cfg.requestTimeoutMs,
    options: {
      instanceName: instance,
      encrypt: cfg.encrypt,
      trustServerCertificate: cfg.trustServerCertificate,
      useUTC: true,
      appName: 'LefortPOSConnector'
    }
  };
}
