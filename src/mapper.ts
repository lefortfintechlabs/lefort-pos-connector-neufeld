import type { TableConfig } from './config';
import type { Observation } from './capture/types';
import { makeEventId, toJsonSafe } from './util/hash';

export type Operation = 'INSERT' | 'UPSERT' | 'DELETE';

export interface CaptureEvent {
  eventId: string;
  eventType: string;
  schemaVersion: 1;
  observedAt: string;
  sourceModifiedAt?: string;
  connector: { connectorId: string; version: string };
  source: { system: 'pos'; table: string; captureMethod: string };
  entity: { type: string; id: string };
  operation: Operation;
  data: Record<string, unknown>;
}

const METHOD: Record<TableConfig['strategy'], string> = {
  rowversion: 'rowversion',
  modifiedAt: 'modified_at',
  pkWindow: 'pk_window',
  hashDiff: 'hash_diff'
};

export interface MapperContext {
  connectorId: string;
  connectorVersion: string;
  observedAt: Date;
}

function typeSuffix(op: Operation): string {
  return op === 'INSERT' ? 'created' : op === 'DELETE' ? 'deleted' : 'changed';
}

export function buildEvent(table: TableConfig, obs: Observation, op: Operation, ctx: MapperContext): CaptureEvent {
  return {
    // Determinista: releer la misma versión de la fila produce el mismo eventId (SDD §7).
    eventId: makeEventId([ctx.connectorId, table.name, obs.pk, obs.version]),
    eventType: `${table.entityType}.${typeSuffix(op)}`,
    schemaVersion: 1,
    observedAt: ctx.observedAt.toISOString(),
    ...(obs.sourceModifiedAt ? { sourceModifiedAt: obs.sourceModifiedAt } : {}),
    connector: { connectorId: ctx.connectorId, version: ctx.connectorVersion },
    source: { system: 'pos', table: table.name, captureMethod: METHOD[table.strategy] },
    entity: { type: table.entityType, id: obs.pk },
    operation: op,
    data: toJsonSafe(obs.row) as Record<string, unknown>
  };
}

export function buildDeleteEvent(table: TableConfig, pk: string, sweep: number, ctx: MapperContext): CaptureEvent {
  return buildEvent(table, { pk, row: {}, hash: `deleted:${sweep}`, version: `deleted:${sweep}` }, 'DELETE', ctx);
}
