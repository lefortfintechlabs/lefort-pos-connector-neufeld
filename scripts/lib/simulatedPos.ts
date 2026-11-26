import { assertReadOnlySelect } from '../../src/db/sqlGuard';
import type { SqlClient, SqlParams } from '../../src/db/sqlClient';
import type { Row } from '../../src/util/hash';

const buf = (n: bigint) => Buffer.from(n.toString(16).padStart(16, '0'), 'hex');
const big = (b: unknown) => BigInt('0x' + (b as Buffer).toString('hex'));

/**
 * POS en memoria que responde a las consultas REALES del conector (las mismas que irían a SQL Server).
 * Sirve para ver el flujo completo sin SQL Server. No valida la sintaxis T-SQL: para eso use Docker.
 */
export class SimulatedPos {
  dbts = 1000n;
  orders: { OrderId: number; Status: string; Total: number; RowVer: bigint }[] = [];
  items: { ItemId: number; OrderId: number; Sku: string; Qty: number }[] = [];
  stock: { ProductId: number; Sku: string; OnHand: number; LastModified: Date }[] = [];
  products: { ProductId: number; Name: string; Price: number }[] = [];
  queries = 0;
  rejected = 0;
  private nextOrder = 1;
  private nextItem = 1;
  private nextProduct = 1;

  constructor() {
    for (let i = 0; i < 4; i++) this.addProduct();
    for (let i = 0; i < 3; i++) this.newOrder();
  }

  // ----- acciones del "POS" (escriben en la simulación, nunca el conector) -----
  newOrder(): number {
    const id = this.nextOrder++;
    this.orders.push({ OrderId: id, Status: 'open', Total: 0, RowVer: ++this.dbts });
    const lines = 1 + Math.floor(Math.random() * 2);
    for (let i = 0; i < lines; i++) this.addItem(id);
    return id;
  }
  addItem(orderId: number): void {
    const p = this.products[Math.floor(Math.random() * this.products.length)];
    if (!p) return;
    this.items.push({ ItemId: this.nextItem++, OrderId: orderId, Sku: `SKU-${p.ProductId}`, Qty: 1 + Math.floor(Math.random() * 3) });
  }
  payRandomOrder(): number | undefined {
    const o = this.orders.filter((x) => x.Status === 'open').at(-1);
    if (!o) return undefined;
    o.Status = 'paid';
    o.Total = this.items.filter((i) => i.OrderId === o.OrderId).reduce((s, i) => s + i.Qty * 10, 0);
    o.RowVer = ++this.dbts;
    return o.OrderId;
  }
  adjustStock(): number | undefined {
    const s = this.stock[Math.floor(Math.random() * this.stock.length)];
    if (!s) return undefined;
    s.OnHand = Math.max(0, s.OnHand + (Math.random() < 0.5 ? -1 : 5));
    s.LastModified = new Date();
    return s.ProductId;
  }
  changePrice(): number | undefined {
    const p = this.products[Math.floor(Math.random() * this.products.length)];
    if (!p) return undefined;
    p.Price = Math.round((p.Price + 1) * 100) / 100;
    return p.ProductId;
  }
  addProduct(): number {
    const id = this.nextProduct++;
    this.products.push({ ProductId: id, Name: `Producto ${id}`, Price: 10 + id });
    this.stock.push({ ProductId: id, Sku: `SKU-${id}`, OnHand: 20, LastModified: new Date() });
    return id;
  }
  deleteProduct(): number | undefined {
    const p = this.products.at(-1);
    if (!p || this.products.length <= 2) return undefined;
    this.products.pop();
    this.stock = this.stock.filter((s) => s.ProductId !== p.ProductId);
    return p.ProductId;
  }

  // ----- lado SQL -----
  client(): SqlClient {
    return {
      query: async (sql: string, params: SqlParams = {}) => {
        try {
          assertReadOnlySelect(sql);
        } catch (e) {
          this.rejected++;
          throw e;
        }
        this.queries++;
        return this.answer(sql, params);
      },
      close: async () => {}
    };
  }

  private answer(sql: string, p: SqlParams): Row[] {
    if (sql.startsWith('SELECT MIN_ACTIVE_ROWVERSION()')) return [{ v: buf(this.dbts + 1n) }];
    const table = /FROM \[dbo\]\.\[(\w+)\]/.exec(sql)?.[1];
    const n = p.n?.value as number;
    const take = <T>(rows: T[]) => rows.slice(0, n).map((r) => ({ ...r }) as Row);

    switch (table) {
      case 'Orders': {
        const wm = big(p.wm!.value);
        return this.orders
          .filter((o) => o.RowVer > wm && o.RowVer < this.dbts + 1n)
          .sort((a, b) => Number(a.RowVer - b.RowVer))
          .slice(0, n)
          .map((o): Row => ({ OrderId: o.OrderId, Status: o.Status, Total: o.Total, __rv: buf(o.RowVer) }));
      }
      case 'OrderItems': {
        if (sql.startsWith('SELECT MAX(')) return [{ m: Math.max(0, ...this.items.map((i) => i.ItemId)) }];
        if (sql.includes('> @maxPk')) {
          return take(this.items.filter((i) => i.ItemId > Number(p.maxPk!.value)).sort((a, b) => a.ItemId - b.ItemId));
        }
        return take([...this.items].sort((a, b) => b.ItemId - a.ItemId)); // ventana caliente
      }
      case 'Stock': {
        const sorted = [...this.stock].sort((a, b) => a.LastModified.getTime() - b.LastModified.getTime() || a.ProductId - b.ProductId);
        if (sql.startsWith('SELECT MAX(')) return [{ m: new Date(Math.max(0, ...this.stock.map((s) => s.LastModified.getTime()))) }];
        if (p.from) return take(sorted.filter((s) => s.LastModified >= (p.from!.value as Date)));
        const m = (p.m!.value as Date).getTime();
        const pk = Number(p.p!.value);
        return take(sorted.filter((s) => s.LastModified.getTime() > m || (s.LastModified.getTime() === m && s.ProductId > pk)));
      }
      case 'Products': {
        const from = p.c ? Number(p.c.value) : -Infinity;
        return take(this.products.filter((x) => x.ProductId > from).sort((a, b) => a.ProductId - b.ProductId));
      }
      default:
        throw new Error('Consulta no soportada por la simulación: ' + sql);
    }
  }
}
