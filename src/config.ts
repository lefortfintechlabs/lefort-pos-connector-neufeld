import fs from 'node:fs';
import { z } from 'zod';
import { isValidZone } from './util/time';

const ident = z
  .string()
  .regex(/^[A-Za-z_@][A-Za-z0-9_$ ]{0,127}$/, 'identificador SQL no válido');

const tableBase = {
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'name: solo letras, números y _'),
  schema: ident.default('dbo'),
  table: ident,
  entityType: z.string().min(1),
  primaryKey: ident,
  pkType: z.enum(['int', 'bigint', 'string']).default('bigint'),
  /** Llave compuesta: el id de la entidad se arma con todas estas columnas (primaryKey es la primera). */
  keyColumns: z.array(ident).min(1).optional(),
  columns: z.array(ident).min(1),
  enabled: z.boolean().default(true)
};

/** Solo `table` es obligatorio: columnas, llave y estrategia se descubren al conectar (src/capture/discover.ts). */
const autoTable = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'name: solo letras, números y _'),
  schema: ident.default('dbo'),
  table: ident,
  entityType: z.string().min(1),
  strategy: z.literal('auto'),
  columns: z.union([z.literal('*'), z.array(ident).min(1)]).default('*'),
  excludeColumns: z.array(ident).default([]),
  primaryKey: ident.optional(),
  sweepIntervalSeconds: z.number().int().min(10).default(300),
  detectDeletes: z.boolean().default(true),
  enabled: z.boolean().default(true)
});

/** "@SO1_01VENTA" -> "SO1_01VENTA" (name debe empezar con letra). */
function deriveName(table: string): string {
  const n = table.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]+/, '');
  return n || 'tabla';
}

const tableUnion = z.discriminatedUnion('strategy', [
  autoTable,
  z.object({ ...tableBase, strategy: z.literal('rowversion'), rowversionColumn: ident }),
  z.object({
    ...tableBase,
    strategy: z.literal('modifiedAt'),
    modifiedAtColumn: ident,
    modifiedAtType: z.enum(['datetime', 'datetime2']).default('datetime'),
    overlapSeconds: z.number().int().min(0).default(120)
  }),
  z.object({
    ...tableBase,
    strategy: z.literal('pkWindow'),
    hotWindowRows: z.number().int().min(1).max(5000).default(200)
  }),
  z.object({
    ...tableBase,
    strategy: z.literal('hashDiff'),
    sweepIntervalSeconds: z.number().int().min(10).default(300),
    detectDeletes: z.boolean().default(false)
  })
]);

const tableSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object') return raw;
  const t: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  t.strategy ??= 'auto';
  if (t.strategy === 'auto' && typeof t.table === 'string') {
    t.name ??= deriveName(t.table);
    t.entityType ??= t.name;
  }
  return t;
}, tableUnion);

const sqlSchema = z.object({
  /** Ej.: "localhost\\SQLEXPRESS", "lpc:localhost\\SQLEXPRESS" (Shared Memory) o "np:localhost\\SQLEXPRESS" (Named Pipes). */
  server: z.string().min(1),
  database: z.string().min(1),
  /** Solo para TCP (tedious). Con instancia nombrada se resuelve por SQL Browser si se omite. */
  port: z.number().int().min(1).max(65535).optional(),
  driver: z.enum(['msnodesqlv8', 'tedious']).default('msnodesqlv8'),
  odbcDriver: z.string().default('ODBC Driver 18 for SQL Server'),
  auth: z.discriminatedUnion('type', [
    z.object({ type: z.literal('windows') }),
    z.object({
      type: z.literal('sql'),
      user: z.string().min(1),
      passwordEnv: z.string().default('LEFORT_SQL_PASSWORD')
    })
  ]),
  encrypt: z.boolean().default(false),
  trustServerCertificate: z.boolean().default(true),
  connectTimeoutMs: z.number().int().min(1000).default(15000),
  requestTimeoutMs: z.number().int().min(1000).default(15000),
  lockTimeoutMs: z.number().int().min(100).default(2000),
  isolation: z.enum(['auto', 'readCommitted']).default('auto')
});

const webhookSchema = z.object({
  url: z.string().url(),
  tokenEnv: z.string().default('LEFORT_WEBHOOK_TOKEN'),
  timeoutMs: z.number().int().min(1000).default(15000),
  batchMaxEvents: z.number().int().min(1).max(1000).default(100),
  batchMaxBytes: z.number().int().min(1024).default(1_000_000),
  backoffBaseMs: z.number().int().min(100).default(2000),
  backoffMaxMs: z.number().int().min(1000).default(300_000),
  /** Solo para pruebas locales. En producción debe ser false. */
  allowInsecureHttp: z.boolean().default(false),
  /** SOLO DESARROLLO: cualquier 2xx sin ACK legible cuenta como entregado (p. ej. webhook.site). Se pierde la garantía de entrega. */
  devAssumeAckOnSuccess: z.boolean().default(false)
});

const configSchema = z
  .object({
    connectorId: z.string().min(1),
    sql: sqlSchema,
    webhook: webhookSchema,
    capture: z.object({
      /** changesOnly: baseline sin emitir; initialSnapshot: emite todas las filas existentes. */
      startMode: z.enum(['changesOnly', 'initialSnapshot']).default('changesOnly'),
      pollIntervalMs: z.number().int().min(500).default(5000),
      pageRows: z.number().int().min(1).max(5000).default(500),
      maxRowsPerCycle: z.number().int().min(1).default(2000),
      sourceTimeZone: z.string().default('UTC').refine(isValidZone, 'zona horaria IANA no válida'),
      tables: z.array(tableSchema).min(1)
    }),
    queue: z
      .object({
        dataDir: z.string().default('C:\\ProgramData\\Lefort\\POS Connector\\data'),
        maxPendingEvents: z.number().int().min(100).default(200_000),
        sentRetentionHours: z.number().min(0).default(24)
      })
      .default({}),
    logging: z
      .object({
        dir: z.string().default('C:\\ProgramData\\Lefort\\POS Connector\\logs'),
        level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
        maxFileBytes: z.number().int().min(10_000).default(5_000_000),
        maxFiles: z.number().int().min(1).default(10)
      })
      .default({})
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.webhook.allowInsecureHttp && !cfg.webhook.url.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['webhook', 'url'], message: 'el webhook debe usar https://' });
    }
    const names = new Set<string>();
    cfg.capture.tables.forEach((t, i) => {
      if (names.has(t.name)) {
        ctx.addIssue({ code: 'custom', path: ['capture', 'tables', i, 'name'], message: 'nombre de tabla duplicado' });
      }
      names.add(t.name);
    });
  });

export type ConnectorConfig = z.infer<typeof configSchema>;
export type RawTableConfig = ConnectorConfig['capture']['tables'][number];
/** Tabla ya resuelta: estrategia concreta y columnas explícitas. */
export type TableConfig = Exclude<RawTableConfig, { strategy: 'auto' }>;
export type ResolvedConfig = Omit<ConnectorConfig, 'capture'> & {
  capture: Omit<ConnectorConfig['capture'], 'tables'> & { tables: TableConfig[] };
};
export type SqlConfig = ConnectorConfig['sql'];
export type WebhookConfig = ConnectorConfig['webhook'];
export type StartMode = ConnectorConfig['capture']['startMode'];
export type TableOf<S extends TableConfig['strategy']> = Extract<TableConfig, { strategy: S }>;

export function parseConfig(raw: unknown): ConnectorConfig {
  const cfg = configSchema.parse(raw);
  // La clave primaria siempre se lee, aunque no esté en la lista de columnas.
  for (const t of cfg.capture.tables) {
    if (t.strategy === 'auto') {
      if (Array.isArray(t.columns) && t.primaryKey && !t.columns.includes(t.primaryKey)) t.columns.unshift(t.primaryKey);
    } else if (!t.columns.includes(t.primaryKey)) t.columns.unshift(t.primaryKey);
  }
  return cfg;
}

/** Falla si queda alguna tabla `auto` sin resolver. */
export function requireResolved(cfg: ConnectorConfig): ResolvedConfig {
  const auto = cfg.capture.tables.find((t) => t.strategy === 'auto');
  if (auto) throw new Error(`La tabla ${auto.name} usa strategy "auto" y aún no se resolvió contra SQL Server`);
  return cfg as ResolvedConfig;
}

export function loadConfig(file: string): ConnectorConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`No se pudo leer la configuración ${file}: ${(e as Error).message}`);
  }
  try {
    return parseConfig(raw);
  } catch (e) {
    if (e instanceof z.ZodError) {
      const lines = e.issues.map((i) => `  - ${i.path.join('.') || '(raíz)'}: ${i.message}`);
      throw new Error(`Configuración inválida en ${file}:\n${lines.join('\n')}`);
    }
    throw e;
  }
}

export interface Secrets {
  sqlPassword?: string;
  webhookToken?: string;
}

/** MVP: secretos desde variables de entorno. Siguiente paso: DPAPI / Credential Manager (SDD §9). */
export function resolveSecrets(cfg: ConnectorConfig, env: NodeJS.ProcessEnv = process.env): Secrets {
  return {
    sqlPassword: cfg.sql.auth.type === 'sql' ? env[cfg.sql.auth.passwordEnv] : undefined,
    webhookToken: env[cfg.webhook.tokenEnv]
  };
}
