import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { loadConfig, resolveSecrets, type ConnectorConfig } from './config';
import { resolveTables } from './capture/discover';
import { MssqlReadOnlyClient } from './db/sqlClient';
import { checkSqlServer } from './diagnostics/sqlCheck';
import { Dispatcher } from './dispatcher';
import { createLogger, nullLogger, redact } from './logger';
import { DurableQueue } from './queue/queue';
import { ConnectorService, STATUS_FILE } from './service';
import { VERSION } from './version';
import { randomUUID } from 'node:crypto';

export interface Args {
  command: string;
  config: string;
  output?: string;
  limit: number;
}

export function defaultConfigPath(): string {
  return process.platform === 'win32'
    ? 'C:\\ProgramData\\Lefort\\POS Connector\\config\\connector.json'
    : path.resolve('config', 'connector.json');
}

export function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const args: Args = { command, config: defaultConfigPath(), limit: 20 };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--config') args.config = rest[++i] ?? args.config;
    else if (a === '--output') args.output = rest[++i];
    else if (a === '--limit') args.limit = Number(rest[++i] ?? 20) || 20;
  }
  return args;
}

export const HELP = `Lefort POS Connector ${VERSION}

Uso: LefortConnector <comando> [--config ruta]

  run                       Inicia el conector (modo servicio o primer plano)
  status                    Estado del servicio, captura y cola
  queue [--limit N]         Eventos pendientes y rechazados
  config-check              Valida el archivo de configuración
  test-sqlserver            Comprueba conexión, permisos de solo lectura e índices
  test-webhook              Envía un lote vacío al webhook configurado
  diagnostics --output zip  Paquete de soporte con secretos redactados
  version                   Versión del conector
`;

function openLogger(cfg: ConnectorConfig, console: boolean) {
  return createLogger({ ...cfg.logging, console, connectorId: cfg.connectorId, version: VERSION });
}

export async function run(args: Args): Promise<number> {
  let service: ConnectorService | undefined;

  try {
    console.log('[RUN] Cargando configuración:', args.config);

    const cfg = loadConfig(args.config);
    const log = openLogger(cfg, true);

    console.log('[RUN] Data directory:', path.resolve(cfg.queue.dataDir));

    service = new ConnectorService(cfg, log);

    console.log('[RUN] Iniciando servicio');
    await service.start();

    console.log('[RUN] Servicio activo. PID:', process.pid);

    await new Promise<void>((resolve) => {
      const stop = () => resolve();

      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);

      if (process.platform === 'win32') {
        process.once('SIGBREAK', stop);
      }
    });

    return 0;
  } catch (error) {
    console.error('[RUN] Error fatal:', error);
    return 1;
  } finally {
    if (service) {
      console.log('[RUN] Deteniendo servicio');

      try {
        await service.stop();
      } catch (error) {
        console.error('[RUN] Error al detener servicio:', error);
      }
    }
  }
}

export function configCheck(args: Args): number {
  const cfg = loadConfig(args.config);
  console.log(`Configuración válida. connectorId=${cfg.connectorId}, tablas=${cfg.capture.tables.length}`);
  for (const t of cfg.capture.tables) console.log(`  - ${t.name}: ${t.strategy}${t.enabled ? '' : ' (deshabilitada)'}`);
  return 0;
}

export async function testSqlServer(args: Args): Promise<number> {
  const cfg = loadConfig(args.config);
  const client = await MssqlReadOnlyClient.connect(cfg.sql, resolveSecrets(cfg), nullLogger).catch((e: Error) => {
    console.log(`FAIL conexion: ${e.message}`);
    return undefined;
  });
  if (!client) return 1;
  try {
    let resolved;
    try {
      resolved = await resolveTables(client, cfg, nullLogger);
    } catch (e) {
      console.log(`FAIL tablas: ${(e as Error).message}`);
      return 1;
    }
    for (const t of resolved.capture.tables) {
      console.log(`INFO ${t.name}: ${t.strategy}, llave ${(t.keyColumns ?? [t.primaryKey]).join('+')}, ${t.columns.length} columnas`);
    }
    const results = await checkSqlServer(client, resolved);
    for (const r of results) console.log(`${r.level.toUpperCase().padEnd(4)} ${r.check}: ${r.detail}`);
    console.log(`Aislamiento: ${client.isolation}`);
    return results.some((r) => r.level === 'fail') ? 1 : 0;
  } finally {
    await client.close();
  }
}

export async function testWebhook(args: Args): Promise<number> {
  const cfg = loadConfig(args.config);
  const secrets = resolveSecrets(cfg);
  if (cfg.webhook.url.startsWith('http://') && !cfg.webhook.allowInsecureHttp) {
    console.log('FAIL: el webhook debe usar https://');
    return 1;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.webhook.timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(cfg.webhook.url, {
      method: 'POST',
      redirect: 'error',
      signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        'x-lefort-connector-id': cfg.connectorId,
        ...(secrets.webhookToken ? { authorization: `Bearer ${secrets.webhookToken}` } : {})
      },
      body: JSON.stringify({ schemaVersion: 1, connectorId: cfg.connectorId, batchId: randomUUID(), test: true, events: [] })
    });
    console.log(`${res.ok ? 'OK' : 'FAIL'} HTTP ${res.status} en ${Date.now() - started} ms`);
    return res.ok ? 0 : 1;
  } catch (e) {
    console.log(`FAIL: ${(e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message}`);
    return 1;
  } finally {
    clearTimeout(timer);
  }
}

function readStatusFile(cfg: ConnectorConfig): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(cfg.queue.dataDir, STATUS_FILE), 'utf8'));
  } catch {
    return undefined;
  }
}

export function status(args: Args): number {
  const cfg = loadConfig(args.config);
  const file = readStatusFile(cfg) as { updatedAt?: string } | undefined;
  if (!file) {
    console.log('No hay status.json: el servicio no ha corrido todavía o dataDir es otro.');
    return 1;
  }
  const ageSec = file.updatedAt ? Math.round((Date.now() - Date.parse(file.updatedAt)) / 1000) : undefined;
  console.log(JSON.stringify(file, null, 2));
  if (ageSec !== undefined && ageSec > 60) console.log(`\nAVISO: el estado tiene ${ageSec}s; el servicio podría estar detenido.`);
  return 0;
}

export function queue(args: Args): number {
  const cfg = loadConfig(args.config);
  const q = DurableQueue.openReadOnly(cfg.queue.dataDir);
  try {
    console.log(JSON.stringify(q.stats(), null, 2));
    console.log('\nPendientes:');
    console.table(q.listEvents('pending', args.limit));
    const rejected = q.listEvents('rejected', args.limit);
    if (rejected.length) {
      console.log('Rechazados (conservados para diagnóstico):');
      console.table(rejected);
    }
  } finally {
    q.close();
  }
  return 0;
}

function tailLog(dir: string, maxBytes = 512 * 1024): string {
  const file = path.join(dir, 'connector.log');
  if (!fs.existsSync(file)) return '';
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function diagnostics(args: Args): number {
  const cfg = loadConfig(args.config);
  const out = args.output ?? `support-${cfg.connectorId}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
  const files: Record<string, Uint8Array> = {
    'info.json': strToU8(
      JSON.stringify(
        {
          version: VERSION,
          node: process.version,
          platform: `${os.type()} ${os.release()} ${os.arch()}`,
          totalMemMB: Math.round(os.totalmem() / 1048576),
          generatedAt: new Date().toISOString()
        },
        null,
        2
      )
    ),
    // La configuración solo contiene nombres de variables de entorno, no secretos; aun así se redacta.
    'config.redacted.json': strToU8(JSON.stringify(redact(cfg), null, 2)),
    'connector.log.tail': strToU8(tailLog(cfg.logging.dir))
  };
  const st = readStatusFile(cfg);
  if (st) files['status.json'] = strToU8(JSON.stringify(redact(st), null, 2));
  try {
    const q = DurableQueue.openReadOnly(cfg.queue.dataDir);
    files['queue.json'] = strToU8(
      JSON.stringify({ stats: q.stats(), watermarks: q.watermarks(), pending: q.listEvents('pending', 50), rejected: q.listEvents('rejected', 50) }, null, 2)
    );
    q.close();
  } catch (e) {
    files['queue.error.txt'] = strToU8((e as Error).message);
  }
  fs.writeFileSync(out, zipSync(files));
  console.log(`Paquete de soporte generado: ${out}`);
  return 0;
}

