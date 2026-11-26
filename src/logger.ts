import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE = /pass|token|secret|authorization|connectionstring|credential/i;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

export interface LoggerOptions {
  dir?: string;
  level: LogLevel;
  maxFileBytes: number;
  maxFiles: number;
  console?: boolean;
  connectorId?: string;
  version?: string;
}

export function createLogger(opts: LoggerOptions): Logger {
  const file = opts.dir ? path.join(opts.dir, 'connector.log') : undefined;
  if (opts.dir) fs.mkdirSync(opts.dir, { recursive: true });
  let size = file && fs.existsSync(file) ? fs.statSync(file).size : 0;

  function rotate() {
    if (!file) return;
    for (let i = opts.maxFiles - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
    const overflow = `${file}.${opts.maxFiles}`;
    if (fs.existsSync(overflow)) fs.rmSync(overflow);
    size = 0;
  }

  function write(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (ORDER[level] < ORDER[opts.level]) return;
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        msg,
        connectorId: opts.connectorId,
        version: opts.version,
        ...(fields ? (redact(fields) as Record<string, unknown>) : {})
      }) + '\n';
    if (opts.console) (level === 'error' ? process.stderr : process.stdout).write(line);
    if (file) {
      try {
        if (size + line.length > opts.maxFileBytes && size > 0) rotate();
        fs.appendFileSync(file, line);
        size += line.length;
      } catch {
        /* un fallo de log nunca debe tumbar el servicio */
      }
    }
  }

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f)
  };
}

export const nullLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
