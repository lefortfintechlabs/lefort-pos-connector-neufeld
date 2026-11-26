import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { resolveTables } from '../src/capture/discover';
import { nullLogger } from '../src/logger';
import { ScriptedClient } from './helpers';
import type { Row } from '../src/util/hash';

function cfgFor(tables: unknown[]) {
  return parseConfig({
    connectorId: 's',
    sql: { server: 'x', database: 'POS', auth: { type: 'windows' } },
    webhook: { url: 'https://example.test/h' },
    capture: { tables }
  });
}

/** Catálogo simulado: responde por el texto de la consulta de sys.columns / sys.indexes. */
function catalog(columns: Row[], keys: Row[]) {
  return new ScriptedClient((sql) => (sql.includes('FROM sys.columns') ? columns : keys));
}

describe('descubrimiento de tablas (strategy auto)', () => {
  it('con solo el nombre: acepta @ en la tabla, deriva name/entityType y trae todas las columnas', async () => {
    const cfg = cfgFor([{ table: '@SO1_01VENTA' }]);
    expect(cfg.capture.tables[0]).toMatchObject({ name: 'SO1_01VENTA', entityType: 'SO1_01VENTA', strategy: 'auto', columns: '*' });
    const client = catalog(
      [
        { name: 'Code', type_name: 'nvarchar' },
        { name: 'Total', type_name: 'numeric' },
        { name: 'RowVer', type_name: 'timestamp' }
      ],
      [{ index_id: 1, is_pk: 1, name: 'Code', type_name: 'nvarchar' }]
    );
    const r = await resolveTables(client, cfg, nullLogger);
    expect(r.capture.tables[0]).toMatchObject({
      strategy: 'rowversion',
      rowversionColumn: 'RowVer',
      primaryKey: 'Code',
      pkType: 'string',
      columns: ['Code', 'Total']
    });
    expect(client.calls[0]!.params.o!.value).toBe('[dbo].[@SO1_01VENTA]');
  });

  it('sin rowversion usa hashDiff con detección de borrados; excludeColumns quita columnas', async () => {
    const cfg = cfgFor([{ table: 'Detalle', excludeColumns: ['Secreto'] }]);
    const client = catalog(
      [
        { name: 'Id', type_name: 'int' },
        { name: 'Secreto', type_name: 'varchar' },
        { name: 'Qty', type_name: 'int' }
      ],
      [{ index_id: 1, is_pk: 1, name: 'Id', type_name: 'int' }]
    );
    const t = (await resolveTables(client, cfg, nullLogger)).capture.tables[0]!;
    expect(t).toMatchObject({ strategy: 'hashDiff', pkType: 'int', detectDeletes: true, columns: ['Id', 'Qty'] });
  });

  it('llave compuesta: ok con rowversion (id compuesto), error claro sin rowversion', async () => {
    const keys = [
      { index_id: 1, is_pk: 1, name: 'ItemCode', type_name: 'nvarchar' },
      { index_id: 1, is_pk: 1, name: 'WhsCode', type_name: 'nvarchar' }
    ];
    const withRv = catalog([{ name: 'ItemCode', type_name: 'nvarchar' }, { name: 'WhsCode', type_name: 'nvarchar' }, { name: 'v', type_name: 'timestamp' }], keys);
    const ok = (await resolveTables(withRv, cfgFor([{ table: 'OITW' }]), nullLogger)).capture.tables[0]!;
    expect(ok.keyColumns).toEqual(['ItemCode', 'WhsCode']);

    const noRv = catalog([{ name: 'ItemCode', type_name: 'nvarchar' }, { name: 'WhsCode', type_name: 'nvarchar' }], keys);
    await expect(resolveTables(noRv, cfgFor([{ table: 'OITW' }]), nullLogger)).rejects.toThrow(/llave compuesta/);
  });

  it('tabla inexistente o sin permiso falla con el nombre de la tabla', async () => {
    await expect(resolveTables(catalog([], []), cfgFor([{ table: 'Nada' }]), nullLogger)).rejects.toThrow(/\[dbo\]\.\[Nada\]/);
  });
});
