import { DateTime, IANAZone } from 'luxon';

export function isValidZone(zone: string): boolean {
  return IANAZone.isValidZone(zone);
}

/**
 * El driver (useUTC=true) entrega el reloj de pared de SQL Server como si fuera UTC.
 * Esta función reinterpreta ese reloj de pared en la zona horaria real del POS y lo pasa a UTC.
 * Validar con datos reales en la Fase 1 (sobre todo en cambios de horario de verano).
 */
export function wallClockToUtcIso(d: Date, zone: string): string {
  const dt = DateTime.fromJSDate(d, { zone: 'utc' }).setZone(zone, { keepLocalTime: true }).toUTC();
  return dt.toISO() ?? d.toISOString();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
