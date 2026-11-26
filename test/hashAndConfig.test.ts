import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { makeEventId, rowHash } from '../src/util/hash';
import { wallClockToUtcIso } from '../src/util/time';
import { makeConfig } from './helpers';

describe('hash y eventId', () => {
  it('el hash no depende del orden de columnas ni del tipo de binario', () => {
    const a = rowHash({ Id: 1, Name: 'x', D: new Date('2026-01-01T00:00:00Z'), B: Buffer.from('ab', 'hex') }, ['Id', 'Name', 'D', 'B']);
    const b = rowHash({ B: Buffer.from('ab', 'hex'), D: new Date('2026-01-01T00:00:00Z'), Name: 'x', Id: 1 }, ['B', 'D', 'Name', 'Id']);
    expect(a).toBe(b);
  });
  it('cambia cuando cambia una columna configurada y no cuando cambia una no configurada', () => {
    expect(rowHash({ Id: 1, S: 'a', X: 1 }, ['Id', 'S'])).toBe(rowHash({ Id: 1, S: 'a', X: 2 }, ['Id', 'S']));
    expect(rowHash({ Id: 1, S: 'a' }, ['Id', 'S'])).not.toBe(rowHash({ Id: 1, S: 'b' }, ['Id', 'S']));
  });
  it('eventId es determinista', () => {
    expect(makeEventId(['s', 't', '1', 'v'])).toBe(makeEventId(['s', 't', '1', 'v']));
    expect(makeEventId(['s', 't', '1', 'v'])).not.toBe(makeEventId(['s', 't', '1', 'w']));
  });
  it('convierte el reloj de pared del POS a UTC con su zona', () => {
    // 10:00 en Guadalajara (UTC-6, sin horario de verano desde 2022) = 16:00Z
    expect(wallClockToUtcIso(new Date('2026-10-28T10:00:00Z'), 'America/Mexico_City')).toBe('2026-10-28T16:00:00.000Z');
  });
});

describe('configuración', () => {
  const table = { name: 'orders', table: 'Orders', entityType: 'order', primaryKey: 'Id', columns: ['Status'], strategy: 'hashDiff' };

  it('agrega la clave primaria a las columnas', () => {
    const cfg = makeConfig('/tmp/x', [table]);
    expect(cfg.capture.tables[0]!.columns).toEqual(['Id', 'Status']);
  });
  it('exige https salvo allowInsecureHttp', () => {
    expect(() => makeConfig('/tmp/x', [table], { url: 'http://example.test' })).toThrow(/https/);
    expect(() => makeConfig('/tmp/x', [table], { url: 'http://localhost:9', allowInsecureHttp: true })).not.toThrow();
  });
  it('rechaza identificadores peligrosos y nombres duplicados', () => {
    expect(() => makeConfig('/tmp/x', [{ ...table, table: 'Orders]; DROP TABLE x;--' }])).toThrow();
    expect(() => makeConfig('/tmp/x', [table, table])).toThrow(/duplicado/);
  });
  it('rowversion exige rowversionColumn', () => {
    expect(() => makeConfig('/tmp/x', [{ ...table, strategy: 'rowversion' }])).toThrow();
  });
  it('parseConfig valida el ejemplo del repositorio', async () => {
    const fs = await import('node:fs');
    const raw = JSON.parse(fs.readFileSync('config/connector.example.json', 'utf8'));
    expect(() => parseConfig(raw)).not.toThrow();
  });
});
