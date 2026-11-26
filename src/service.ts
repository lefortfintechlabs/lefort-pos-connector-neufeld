import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveTables } from './capture/discover';
import { CaptureReader } from './capture/reader';
import { resolveSecrets, type ConnectorConfig } from './config';
import { MssqlReadOnlyClient, type SqlClient } from './db/sqlClient';
import { Dispatcher } from './dispatcher';
import type { Logger } from './logger';
import { DurableQueue } from './queue/queue';
import { sleep } from './util/time';
import { VERSION } from './version';

export interface ServiceStatus {
  connectorId: string;
  version: string;
  pid: number;
  startedAt: string;
  updatedAt: string;
  host: string;
  sql: { connected: boolean; isolation?: string; lastError?: string };
  capture: { backpressure: boolean; tables: Record<string, unknown> };
  dispatcher: Record<string, unknown>;
  queue: ReturnType<DurableQueue['stats']>;
}

export const STATUS_FILE = 'status.json';

export class ConnectorService {
  private readonly abort = new AbortController();
  private queue?: DurableQueue;
  private client?: SqlClient;
  private reader?: CaptureReader;
  private dispatcher?: Dispatcher;
  private loops: Promise<void>[] = [];
  private readonly startedAt = new Date().toISOString();
  private sqlError?: string;

  constructor(
    private readonly config: ConnectorConfig,
    private readonly log: Logger,
    private readonly injected: { client?: SqlClient; fetchImpl?: typeof fetch } = {}
  ) {}

  async start(): Promise<void> {
  const cfg = this.config;

  this.log.info('service_initializing', {
    dataDir: cfg.queue.dataDir,
    connectorId: cfg.connectorId
  });

  console.log('[SERVICE] Resolviendo secretos');
  const secrets = resolveSecrets(cfg);

  console.log('[SERVICE] Inicializando SQLite');
  this.queue = DurableQueue.open(cfg.queue.dataDir);

  console.log('[SERVICE] SQLite inicializado');

  this.dispatcher = new Dispatcher({
    queue: this.queue,
    config: cfg.webhook,
    connectorId: cfg.connectorId,
    getToken: () => secrets.webhookToken,
    log: this.log,
    fetchImpl: this.injected.fetchImpl
  });

  console.log('[SERVICE] Iniciando dispatcher');
  this.dispatcher.start();

  console.log('[SERVICE] Iniciando loops');

  this.loops.push(
    this.captureLoop(secrets),
    this.housekeepingLoop()
  );

  this.log.info('service_started', {
    version: VERSION,
    tables: cfg.capture.tables.map(t => t.name)
  });

  console.log('[SERVICE] Servicio iniciado correctamente');
}

  async stop(): Promise<void> {
    this.log.info('service_stopping');
    this.abort.abort();
    await this.dispatcher?.stop();
    await Promise.allSettled(this.loops);
    await this.client?.close().catch(() => undefined);
    this.writeStatus();
    this.queue?.close();
    this.log.info('service_stopped');
  }

  /** SQL Server puede arrancar después que el conector: se reintenta la conexión sin tumbar el servicio. */
  private async captureLoop(secrets: ReturnType<typeof resolveSecrets>): Promise<void> {
    const cfg = this.config;
    let failures = 0;
    while (!this.abort.signal.aborted) {
      try {
        if (!this.client) {
          this.client = this.injected.client ?? (await MssqlReadOnlyClient.connect(cfg.sql, secrets, this.log));
          const resolved = await resolveTables(this.client, cfg, this.log);
          this.reader = new CaptureReader({
            config: resolved,
            client: this.client,
            queue: this.queue!,
            log: this.log,
            connectorVersion: VERSION
          });
          this.sqlError = undefined;
          failures = 0;
          this.log.info('sql_connected', { server: cfg.sql.server, database: cfg.sql.database });
        }
        const { more } = await this.reader!.runCycle();
        await sleep(more ? 100 : cfg.capture.pollIntervalMs, this.abort.signal);
      } catch (e) {
        failures++;
        this.sqlError = (e as Error).message;
        this.log.error('sql_connection_error', { error: this.sqlError, attempt: failures });
        await this.client?.close().catch(() => undefined);
        this.client = undefined;
        await sleep(Math.min(60_000, 2000 * 2 ** Math.min(failures, 5)), this.abort.signal);
      }
    }
  }

  private async housekeepingLoop(): Promise<void> {
    let ticks = 0;
    while (!this.abort.signal.aborted) {
      this.writeStatus();
      if (ticks++ % 360 === 0) {
        const cutoff = Date.now() - this.config.queue.sentRetentionHours * 3_600_000;
        const purged = this.queue?.purgeSent(cutoff) ?? 0;
        if (purged) this.log.info('sent_events_purged', { purged });
      }
      await sleep(10_000, this.abort.signal);
    }
  }

  private writeStatus(): void {
    if (!this.queue) return;
    const status: ServiceStatus = {
      connectorId: this.config.connectorId,
      version: VERSION,
      pid: process.pid,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      host: os.hostname(),
      sql: {
        connected: !!this.client,
        isolation: (this.client as { isolation?: string } | undefined)?.isolation,
        lastError: this.sqlError
      },
      capture: { backpressure: this.reader?.backpressure ?? false, tables: this.reader?.tableStatus ?? {} },
      dispatcher: { ...(this.dispatcher?.status ?? {}) },
      queue: this.queue.stats()
    };
    try {
      const file = path.join(this.config.queue.dataDir, STATUS_FILE);
      fs.writeFileSync(file + '.tmp', JSON.stringify(status, null, 2));
      fs.renameSync(file + '.tmp', file);
    } catch (e) {
      this.log.warn('status_write_failed', { error: (e as Error).message });
    }
  }
}
