import type { StartMode, TableConfig } from '../config';
import type { SqlClient } from '../db/sqlClient';
import type { Row } from '../util/hash';

/** Una fila observada en SQL Server (nunca un "cambio" exacto: ver SDD §5.4). */
export interface Observation {
  pk: string;
  row: Row;
  hash: string;
  /** rowversion en hex, o el hash del contenido cuando no hay versión nativa. */
  version: string;
  sourceModifiedAt?: string;
  operation?: 'INSERT' | 'UPSERT';
}

export interface PollContext {
  client: SqlClient;
  table: TableConfig;
  state: Record<string, unknown>;
  pageRows: number;
  maxRows: number;
  now: number;
  sourceTimeZone: string;
}

export interface PollResult {
  observations: Observation[];
  nextState: Record<string, unknown>;
  /** Hay más filas pendientes: conviene volver a consultar pronto. */
  more: boolean;
  /** Si el estado era "baseline", indica que ya terminó. */
  baselineComplete: boolean;
  /** hashDiff: número de barrido al que pertenecen las observaciones (para last_seen). */
  seenSweep?: number;
  /** hashDiff: barrido que acaba de completarse (permite detectar ausencias). */
  sweepCompleted?: number;
}

export interface InitResult {
  state: Record<string, unknown>;
  /** true si la primera consulta solo debe registrar hashes sin emitir eventos. */
  needsBaselinePoll: boolean;
}

export interface Strategy {
  init(client: SqlClient, table: TableConfig, mode: StartMode): Promise<InitResult>;
  poll(ctx: PollContext): Promise<PollResult>;
}
