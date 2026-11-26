import http from 'node:http';

export type Mode = 'ok' | 'down' | 'flaky' | 'partial' | 'noack' | 'unauthorized';

export interface FakeWebhook {
  port: number;
  setMode(m: Mode): void;
  getMode(): Mode;
  /** eventId -> veces recibido */
  received: Map<string, number>;
  byTable: Record<string, number>;
  stats(): { batches: number; unique: number; duplicates: number; byTable: Record<string, number>; mode: Mode };
  close(): Promise<void>;
}

/**
 * Webhook de pruebas. Cambiar el comportamiento en caliente:
 *   curl -X POST 'http://localhost:8787/__mode?mode=down'     (ok | down | flaky | partial | noack | unauthorized)
 *   curl http://localhost:8787/__stats
 */
export async function startFakeWebhook(opts: { port?: number; token?: string; print?: boolean } = {}): Promise<FakeWebhook> {
  let mode: Mode = 'ok';
  let batches = 0;
  let duplicates = 0;
  const received = new Map<string, number>();
  const byTable: Record<string, number> = {};
  const print = opts.print ?? true;
  const stats = () => ({ batches, unique: received.size, duplicates, byTable: { ...byTable }, mode });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, body: unknown, raw = false) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(raw ? String(body) : JSON.stringify(body));
    };
    if (url.pathname === '/__mode' && req.method === 'POST') {
      mode = (url.searchParams.get('mode') ?? 'ok') as Mode;
      if (print) console.log(`[webhook] modo -> ${mode}`);
      return send(200, { mode });
    }
    if (url.pathname === '/__stats') return send(200, stats());

    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) return send(401, { error: 'token' });
      if (mode === 'unauthorized') return send(401, { error: 'unauthorized' });
      if (mode === 'down') return send(503, { error: 'down' });
      if (mode === 'flaky' && Math.random() < 0.5) return send(500, { error: 'flaky' });

      let body: { events?: any[]; test?: boolean };
      try {
        body = JSON.parse(data);
      } catch {
        return send(400, { error: 'json' });
      }
      const events = body.events ?? [];
      if (mode === 'noack') return send(200, 'ok', true);
      batches++;
      const toAccept = mode === 'partial' ? events.slice(0, Math.ceil(events.length / 2)) : events;
      for (const e of toAccept) {
        const n = (received.get(e.eventId) ?? 0) + 1;
        received.set(e.eventId, n);
        if (n > 1) duplicates++;
        byTable[e.source.table] = (byTable[e.source.table] ?? 0) + (n === 1 ? 1 : 0);
        if (print) {
          console.log(
            `[webhook] ${n > 1 ? 'DUPLICADO ' : ''}${e.eventType.padEnd(16)} ${e.source.table}#${e.entity.id} (${e.source.captureMethod}) ${JSON.stringify(e.data)}`
          );
        }
      }
      send(200, { accepted: toAccept.map((e: { eventId: string }) => e.eventId) });
    });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    setMode: (m) => void (mode = m),
    getMode: () => mode,
    received,
    byTable,
    stats,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
