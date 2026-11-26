import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface StoredState {
  phase: 'baseline' | 'running';
  data: Record<string, unknown>;
}

export interface NewEvent {
  eventId: string;
  tableName: string;
  entityKey: string;
  operation: string;
  payload: string;
  observedAt: string;
}

export interface RowUpdate {
  pk: string;
  hash: string;
  sweep?: number;
  remove?: boolean;
}

export interface QueuedEvent {
  seq: number;
  eventId: string;
  tableName: string;
  entityKey: string;
  payload: string;
  attempts: number;
}

export interface QueueStats {
  pending: number;
  sent: number;
  rejected: number;
  oldestPendingAt: string | null;
  nextAttemptAt: number | null;
  maxAttempts: number;
}

const SCHEMA_VERSION = 1;

/**
 * Cola durable y estado del conector. Vive SOLO en SQLite local (SDD §8): nunca en SQL Server.
 * Eventos, row_state y watermark se confirman en una única transacción, de modo que la posición
 * no avanza más allá de eventos que no sean recuperables.
 */
export class DurableQueue {
  private constructor(private readonly db: Database.Database, readonly readonly: boolean) {}

  static open(dir: string): DurableQueue {
  console.log('[QUEUE] Iniciando apertura de SQLite');
  console.log('[QUEUE] Directorio recibido:', dir);

  const resolvedDir = path.resolve(dir);
  const dbPath = path.join(resolvedDir, 'connector.db');

  try {
    fs.mkdirSync(resolvedDir, { recursive: true });
    console.log('[QUEUE] Directorio creado/verificado:', resolvedDir);

    console.log('[QUEUE] Abriendo base:', dbPath);
    console.log('[QUEUE] Ruta absoluta de la base:', path.resolve(dbPath));

    const db = new Database(dbPath);

    console.log('[QUEUE] SQLite abierto correctamente');

    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('busy_timeout = 5000');

    console.log('[QUEUE] PRAGMA configurados');

    const q = new DurableQueue(db, false);

    q.migrate();

    console.log('[QUEUE] Migraciones ejecutadas');
    console.log('[QUEUE] Tablas:', db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all());

    return q;
  } catch (error) {
    console.error('[QUEUE] ERROR AL INICIALIZAR SQLITE:', error);
    console.error('[QUEUE] Ruta:', dbPath);
    throw error;
  }
}

  /** Para la CLI (status, queue, diagnostics) mientras el servicio está corriendo. */
  static openReadOnly(dir: string): DurableQueue {
    const file = path.join(dir, 'connector.db');
    if (!fs.existsSync(file)) throw new Error(`No existe la base local ${file}`);
    const db = new Database(file, { readonly: true });
    db.pragma('busy_timeout = 5000');
    return new DurableQueue(db, true);
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version >= SCHEMA_VERSION) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id        TEXT NOT NULL UNIQUE,
        table_name      TEXT NOT NULL,
        entity_key      TEXT NOT NULL,
        operation       TEXT NOT NULL,
        payload         TEXT NOT NULL,
        observed_at     TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error      TEXT,
        sent_at         INTEGER
      );
      CREATE INDEX IF NOT EXISTS ix_events_pending ON events(status, next_attempt_at, seq);
      CREATE INDEX IF NOT EXISTS ix_events_entity  ON events(table_name, entity_key, seq);
      CREATE TABLE IF NOT EXISTS capture_state (
        table_name TEXT PRIMARY KEY,
        state      TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS row_state (
        table_name     TEXT NOT NULL,
        pk             TEXT NOT NULL,
        hash           TEXT NOT NULL,
        last_seen_sweep INTEGER,
        PRIMARY KEY (table_name, pk)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  // ---------- captura ----------

  getState(table: string): StoredState | undefined {
    const row = this.db.prepare('SELECT state FROM capture_state WHERE table_name = ?').get(table) as
      | { state: string }
      | undefined;
    return row ? (JSON.parse(row.state) as StoredState) : undefined;
  }

  saveState(table: string, state: StoredState): void {
    this.db
      .prepare(
        'INSERT INTO capture_state(table_name, state) VALUES(?, ?) ON CONFLICT(table_name) DO UPDATE SET state = excluded.state'
      )
      .run(table, JSON.stringify(state));
  }

  getRowHashes(table: string, pks: string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (let i = 0; i < pks.length; i += 500) {
      const chunk = pks.slice(i, i + 500);
      const marks = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT pk, hash FROM row_state WHERE table_name = ? AND pk IN (${marks})`)
        .all(table, ...chunk) as { pk: string; hash: string }[];
      for (const r of rows) out.set(r.pk, r.hash);
    }
    return out;
  }

  keysNotSeenSince(table: string, sweep: number): string[] {
    const rows = this.db
      .prepare('SELECT pk FROM row_state WHERE table_name = ? AND (last_seen_sweep IS NULL OR last_seen_sweep < ?)')
      .all(table, sweep) as { pk: string }[];
    return rows.map((r) => r.pk);
  }

  /** Transacción única: eventos + hashes de fila + watermark. */
  commitCapture(c: { table: string; state: StoredState; events: NewEvent[]; rowUpdates: RowUpdate[] }): number {
    const insertEvent = this.db.prepare(
      `INSERT OR IGNORE INTO events(event_id, table_name, entity_key, operation, payload, observed_at)
       VALUES (@eventId, @tableName, @entityKey, @operation, @payload, @observedAt)`
    );
    const upsertRow = this.db.prepare(
      `INSERT INTO row_state(table_name, pk, hash, last_seen_sweep) VALUES (?, ?, ?, ?)
       ON CONFLICT(table_name, pk) DO UPDATE SET hash = excluded.hash, last_seen_sweep = excluded.last_seen_sweep`
    );
    const deleteRow = this.db.prepare('DELETE FROM row_state WHERE table_name = ? AND pk = ?');
    const tx = this.db.transaction(() => {
      let inserted = 0;
      for (const e of c.events) inserted += insertEvent.run(e).changes;
      for (const r of c.rowUpdates) {
        if (r.remove) deleteRow.run(c.table, r.pk);
        else upsertRow.run(c.table, r.pk, r.hash, r.sweep ?? null);
      }
      this.saveState(c.table, c.state);
      return inserted;
    });
    return tx();
  }

  // ---------- entrega ----------

  pendingCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE status = 'pending'").get() as { n: number }).n;
  }

  /**
   * Eventos vencidos en orden de captura. Si una entidad tiene un evento anterior esperando un
   * reintento, sus eventos posteriores esperan también (orden por entidad).
   */
  claimBatch(opts: { now: number; maxEvents: number; maxBytes: number }): QueuedEvent[] {
    const rows = this.db
      .prepare(
        `SELECT e.seq, e.event_id AS eventId, e.table_name AS tableName, e.entity_key AS entityKey,
                e.payload, e.attempts
           FROM events e
          WHERE e.status = 'pending' AND e.next_attempt_at <= @now
            AND NOT EXISTS (
              SELECT 1 FROM events p
               WHERE p.status = 'pending' AND p.table_name = e.table_name
                 AND p.entity_key = e.entity_key AND p.seq < e.seq AND p.next_attempt_at > @now)
          ORDER BY e.seq ASC
          LIMIT @limit`
      )
      .all({ now: opts.now, limit: opts.maxEvents }) as QueuedEvent[];
    const out: QueuedEvent[] = [];
    let bytes = 0;
    const entitiesInBatch = new Set<string>();
    for (const r of rows) {
      const size = Buffer.byteLength(r.payload) + 1;
      if (out.length > 0 && bytes + size > opts.maxBytes) break;
      // Un solo evento por entidad en cada lote conserva el orden aunque el ACK sea parcial.
      const key = `${r.tableName}\u0000${r.entityKey}`;
      if (entitiesInBatch.has(key)) continue;
      entitiesInBatch.add(key);
      bytes += size;
      out.push(r);
    }
    return out;
  }

  markSent(seqs: number[], now: number): void {
    const st = this.db.prepare("UPDATE events SET status = 'sent', sent_at = ?, last_error = NULL WHERE seq = ?");
    this.db.transaction(() => seqs.forEach((s) => st.run(now, s)))();
  }

  markRetry(items: { seq: number; nextAttemptAt: number }[], error: string): void {
    const st = this.db.prepare(
      "UPDATE events SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE seq = ? AND status = 'pending'"
    );
    this.db.transaction(() => items.forEach((i) => st.run(i.nextAttemptAt, error, i.seq)))();
  }

  /** Rechazo permanente: el evento se conserva para diagnóstico (SDD §8.3), no se borra. */
  markRejected(seqs: number[], reason: string): void {
    const st = this.db.prepare("UPDATE events SET status = 'rejected', last_error = ? WHERE seq = ?");
    this.db.transaction(() => seqs.forEach((s) => st.run(reason, s)))();
  }

  purgeSent(olderThanMs: number): number {
    return this.db.prepare("DELETE FROM events WHERE status = 'sent' AND sent_at < ?").run(olderThanMs).changes;
  }

  stats(): QueueStats {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number | null }).n ?? 0;
    const oldest = this.db
      .prepare("SELECT observed_at AS o FROM events WHERE status = 'pending' ORDER BY seq ASC LIMIT 1")
      .get() as { o: string } | undefined;
    const next = this.db
      .prepare("SELECT MIN(next_attempt_at) AS n FROM events WHERE status = 'pending'")
      .get() as { n: number | null };
    return {
      pending: one("SELECT COUNT(*) AS n FROM events WHERE status = 'pending'"),
      sent: one("SELECT COUNT(*) AS n FROM events WHERE status = 'sent'"),
      rejected: one("SELECT COUNT(*) AS n FROM events WHERE status = 'rejected'"),
      oldestPendingAt: oldest?.o ?? null,
      nextAttemptAt: next.n,
      maxAttempts: one("SELECT MAX(attempts) AS n FROM events WHERE status = 'pending'")
    };
  }

  listEvents(status: 'pending' | 'rejected', limit: number) {
    return this.db
      .prepare(
        `SELECT seq, event_id AS eventId, table_name AS tableName, entity_key AS entityKey, operation,
                observed_at AS observedAt, attempts, last_error AS lastError
           FROM events WHERE status = ? ORDER BY seq ASC LIMIT ?`
      )
      .all(status, limit);
  }

  watermarks(): Record<string, StoredState> {
    const rows = this.db.prepare('SELECT table_name, state FROM capture_state').all() as {
      table_name: string;
      state: string;
    }[];
    return Object.fromEntries(rows.map((r) => [r.table_name, JSON.parse(r.state) as StoredState]));
  }

  getMeta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
