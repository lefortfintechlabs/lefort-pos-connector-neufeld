import type { ResolvedConfig, TableConfig } from '../config';
import type { SqlClient } from '../db/sqlClient';
import type { Logger } from '../logger';
import { buildDeleteEvent, buildEvent, type MapperContext, type Operation } from '../mapper';
import type { NewEvent, RowUpdate, StoredState, DurableQueue } from '../queue/queue';
import { strategies } from './strategies';

export interface TableStatus {
  strategy: string;
  phase: StoredState['phase'] | 'unknown';
  lastPollAt?: string;
  lastOkAt?: string;
  lastError?: string;
  eventsEmitted: number;
  rowsObserved: number;
}

export interface ReaderDeps {
  config: ResolvedConfig;
  client: SqlClient;
  queue: DurableQueue;
  log: Logger;
  connectorVersion: string;
  now?: () => number;
}

/** Lee SQL Server (solo SELECT), compara con el estado local y encola eventos. */
export class CaptureReader {
  readonly tableStatus: Record<string, TableStatus> = {};
  backpressure = false;
  private readonly now: () => number;

  constructor(private readonly deps: ReaderDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Un ciclo sobre todas las tablas. `more` = hay trabajo inmediato (límite de filas alcanzado). */
  async runCycle(): Promise<{ more: boolean }> {
    const { config, queue, log } = this.deps;
    const pending = queue.pendingCount();
    if (pending >= config.queue.maxPendingEvents) {
      // Contrapresión segura: dejamos de leer, no se avanza ningún watermark, no se pierde nada.
      if (!this.backpressure) log.warn('queue_full_capture_paused', { pending, limit: config.queue.maxPendingEvents });
      this.backpressure = true;
      return { more: false };
    }
    this.backpressure = false;

    let more = false;
    for (const table of config.capture.tables) {
      if (!table.enabled) continue;
      const st = (this.tableStatus[table.name] ??= {
        strategy: table.strategy,
        phase: 'unknown',
        eventsEmitted: 0,
        rowsObserved: 0
      });
      st.lastPollAt = new Date(this.now()).toISOString();
      try {
        const r = await this.pollTable(table, st);
        more ||= r.more;
        st.lastOkAt = new Date(this.now()).toISOString();
        st.lastError = undefined;
      } catch (e) {
        st.lastError = (e as Error).message;
        log.error('capture_error', { table: table.name, strategy: table.strategy, error: (e as Error).message });
      }
    }
    return { more };
  }

  private async pollTable(table: TableConfig, st: TableStatus): Promise<{ more: boolean }> {
    const { config, client, queue, log } = this.deps;
    const strategy = strategies[table.strategy];

    let stored = queue.getState(table.name);
    if (!stored) {
      const init = await strategy.init(client, table, config.capture.startMode);
      stored = { phase: init.needsBaselinePoll ? 'baseline' : 'running', data: init.state };
      queue.saveState(table.name, stored);
      log.info('capture_initialized', { table: table.name, strategy: table.strategy, phase: stored.phase });
    }
    const observeOnly = stored.phase === 'baseline';
    st.phase = stored.phase;

    const res = await strategy.poll({
      client,
      table,
      state: stored.data,
      pageRows: config.capture.pageRows,
      maxRows: config.capture.maxRowsPerCycle,
      now: this.now(),
      sourceTimeZone: config.capture.sourceTimeZone
    });

    const ctx = this.mapperContext();
    const known = queue.getRowHashes(table.name, res.observations.map((o) => o.pk));
    const events: NewEvent[] = [];
    const rowUpdates: RowUpdate[] = [];

    for (const o of res.observations) {
      const prev = known.get(o.pk);
      rowUpdates.push({ pk: o.pk, hash: o.hash, sweep: res.seenSweep });
      if (prev === o.hash) continue; // sin cambios en las columnas configuradas
      if (observeOnly) continue; // baseline: se registra el hash, no se emite
      const op: Operation = o.operation ?? (table.strategy === 'hashDiff' && prev === undefined ? 'INSERT' : 'UPSERT');
      const ev = buildEvent(table, o, op, ctx);
      events.push(toNewEvent(ev, table.name));
    }

    const nextPhase: StoredState['phase'] = observeOnly && !res.baselineComplete ? 'baseline' : 'running';
    queue.commitCapture({ table: table.name, state: { phase: nextPhase, data: res.nextState }, events, rowUpdates });

    st.phase = nextPhase;
    st.rowsObserved += res.observations.length;
    st.eventsEmitted += events.length;
    if (events.length > 0) log.debug('events_enqueued', { table: table.name, count: events.length });

    if (res.sweepCompleted !== undefined && table.strategy === 'hashDiff' && table.detectDeletes && !observeOnly) {
      this.emitDeletes(table, res.sweepCompleted, st);
    }
    return { more: res.more };
  }

  /** Filas conocidas que no aparecieron en el barrido completo => posibles eliminaciones. */
  private emitDeletes(table: TableConfig, sweep: number, st: TableStatus): void {
    const { queue, log } = this.deps;
    const gone = queue.keysNotSeenSince(table.name, sweep);
    if (gone.length === 0) return;
    const ctx = this.mapperContext();
    const events = gone.map((pk) => toNewEvent(buildDeleteEvent(table, pk, sweep, ctx), table.name));
    const state = queue.getState(table.name);
    if (!state) return;
    queue.commitCapture({
      table: table.name,
      state,
      events,
      rowUpdates: gone.map((pk) => ({ pk, hash: '', remove: true }))
    });
    st.eventsEmitted += events.length;
    log.info('deletes_detected', { table: table.name, count: events.length, sweep });
  }

  private mapperContext(): MapperContext {
    return {
      connectorId: this.deps.config.connectorId,
      connectorVersion: this.deps.connectorVersion,
      observedAt: new Date(this.now())
    };
  }
}

function toNewEvent(ev: ReturnType<typeof buildEvent>, tableName: string): NewEvent {
  return {
    eventId: ev.eventId,
    tableName,
    entityKey: ev.entity.id,
    operation: ev.operation,
    payload: JSON.stringify(ev),
    observedAt: ev.observedAt
  };
}
