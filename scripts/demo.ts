/**
 * Demo de extremo a extremo SIN SQL Server: POS simulado en memoria + webhook local + conector real.
 *   npm run demo            (≈40 s)      npm run demo -- --seconds 90
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config';
import { createLogger } from '../src/logger';
import { DurableQueue } from '../src/queue/queue';
import { ConnectorService } from '../src/service';
import { sleep } from '../src/util/time';
import { startFakeWebhook } from './lib/fakeWebhook';
import { SimulatedPos } from './lib/simulatedPos';

const seconds = Number(process.argv[process.argv.indexOf('--seconds') + 1]) || 40;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lefort-demo-'));
const say = (m: string) => console.log(`\x1b[36m[POS]\x1b[0m ${m}`);

async function main() {
  const webhook = await startFakeWebhook({ token: 'demo-token' });
  process.env.LEFORT_WEBHOOK_TOKEN = 'demo-token';
  const pos = new SimulatedPos();

  const cfg = parseConfig({
    connectorId: 'demo-store',
    sql: { server: 'simulado', database: 'POS', auth: { type: 'windows' } },
    webhook: { url: `http://127.0.0.1:${webhook.port}/events`, allowInsecureHttp: true, timeoutMs: 3000, backoffBaseMs: 500, backoffMaxMs: 4000 },
    capture: {
      pollIntervalMs: 500,
      sourceTimeZone: 'UTC',
      tables: [
        { name: 'orders', table: 'Orders', entityType: 'order', primaryKey: 'OrderId', pkType: 'int', columns: ['OrderId', 'Status', 'Total'], strategy: 'rowversion', rowversionColumn: 'RowVer' },
        { name: 'order_items', table: 'OrderItems', entityType: 'order_item', primaryKey: 'ItemId', pkType: 'int', columns: ['ItemId', 'OrderId', 'Sku', 'Qty'], strategy: 'pkWindow', hotWindowRows: 50 },
        { name: 'inventory', table: 'Stock', entityType: 'inventory', primaryKey: 'ProductId', pkType: 'int', columns: ['ProductId', 'Sku', 'OnHand'], strategy: 'modifiedAt', modifiedAtColumn: 'LastModified', overlapSeconds: 5 },
        { name: 'products', table: 'Products', entityType: 'product', primaryKey: 'ProductId', pkType: 'int', columns: ['ProductId', 'Name', 'Price'], strategy: 'hashDiff', sweepIntervalSeconds: 10, detectDeletes: true }
      ]
    },
    queue: { dataDir },
    logging: { dir: path.join(dataDir, 'logs'), level: 'warn' }
  });

  const log = createLogger({ ...cfg.logging, console: true, connectorId: cfg.connectorId });
  const service = new ConnectorService(cfg, log, { client: pos.client() });
  await service.start();
  console.log(`Demo ${seconds}s. Datos del conector en ${dataDir}\n`);

  const actions: (() => string)[] = [
    () => `orden ${pos.newOrder()} creada`,
    () => { const id = pos.payRandomOrder(); return id ? `orden ${id} pagada` : 'sin órdenes abiertas'; },
    () => `stock del producto ${pos.adjustStock()} ajustado`,
    () => `precio del producto ${pos.changePrice()} cambiado`,
    () => `producto ${pos.addProduct()} agregado`,
    () => { const id = pos.deleteProduct(); return id ? `producto ${id} ELIMINADO` : 'nada que eliminar'; }
  ];

  const start = Date.now();
  let step = 0;
  const outage = { from: 12, to: 22, partialFrom: 28, partialTo: 32 };
  while ((Date.now() - start) / 1000 < seconds) {
    const t = (Date.now() - start) / 1000;
    if (t >= outage.from && t < outage.to && webhook.getMode() !== 'down') { say('*** el webhook se CAE (503) ***'); webhook.setMode('down'); }
    if (t >= outage.to && t < outage.partialFrom && webhook.getMode() === 'down') { say('*** el webhook se recupera ***'); webhook.setMode('ok'); }
    if (t >= outage.partialFrom && t < outage.partialTo && webhook.getMode() !== 'partial') { say('*** el webhook confirma solo la mitad de cada lote ***'); webhook.setMode('partial'); }
    if (t >= outage.partialTo && webhook.getMode() === 'partial') { say('*** el webhook vuelve a confirmar todo ***'); webhook.setMode('ok'); }

    say(actions[step++ % actions.length]!());
    await sleep(2000);
  }

  webhook.setMode('ok');
  console.log('\nEsperando a que la cola se vacíe...');
  for (let i = 0; i < 40; i++) {
    const q = DurableQueue.openReadOnly(dataDir);
    const pending = q.stats().pending;
    q.close();
    if (pending === 0) break;
    await sleep(500);
  }
  await service.stop();

  const q = DurableQueue.openReadOnly(dataDir);
  const stats = q.stats();
  q.close();
  const w = webhook.stats();
  console.log('\n================ RESUMEN ================');
  console.log('Eventos únicos recibidos por tabla:', w.byTable);
  console.log(`Entregas duplicadas (mismo eventId): ${w.duplicates}  <- el receptor debe deduplicar`);
  console.log(`Cola: pendientes=${stats.pending} enviados=${stats.sent} rechazados=${stats.rejected}`);
  console.log(`Consultas SQL emitidas: ${pos.queries}; rechazadas por el guardia de solo lectura: ${pos.rejected}`);
  await webhook.close();
  process.exit(stats.pending === 0 && pos.rejected === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
