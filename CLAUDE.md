# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Windows agent (Node >= 22, TypeScript) that detects order/inventory changes in a POS backed by **SQL Server Express** and ships them to an HTTPS webhook. Design source of truth: `docs/SDD-Lefort-POS-Connector.md` (code comments cite SDD sections, e.g. "SDD §5.4"). README and docs are in Spanish.

## Commands

```bash
npm install --omit=optional   # skip msnodesqlv8 (Windows-only ODBC driver) on Mac/Linux
npm test                      # vitest, no SQL Server needed (SQL + webhook are simulated)
npx vitest run test/queue.test.ts            # single file
npx vitest run -t "name substring"           # single test
npm run typecheck             # tsc --noEmit
npm run build                 # tsc -p tsconfig.build.json -> dist/
npm run demo                  # end-to-end with in-memory simulated POS + local webhook (~40s)
npm run dev                   # tsx src/index.ts run --config config/connector.json (copy config/connector.example.json first; connector.json is gitignored)
npm run dev:webhook           # fake webhook server (needs LEFORT_WEBHOOK_TOKEN)
npm run dev:sql -- dev/sql/01-seed.sql       # run a .sql file against the Docker SQL Server
```

CLI (`src/index.ts` -> `src/commands.ts`): `run status queue config-check test-sqlserver test-webhook diagnostics version`, all taking `--config <path>`.

Real T-SQL validation requires the Docker SQL Server 2022 Express (`dev/docker-compose.yml`, `dev/connector.docker.json`); step-by-step and test scenarios in `docs/PROBAR-EN-MAC.md`. Secrets come from env vars (`LEFORT_WEBHOOK_TOKEN`, `LEFORT_SQL_PASSWORD`).

## Architecture

Pipeline: `ConnectorService` (`src/service.ts`) runs two loops — capture and dispatch — around a durable SQLite queue.

1. **Capture** (`src/capture/reader.ts` `CaptureReader.runCycle`): per configured table, picks a strategy from `src/capture/strategies.ts` — `rowversion` (S1), `modifiedAt` (S2), `pkWindow` (S3), `hashDiff` (S4) — queries SQL Server, compares with locally stored state, and enqueues events. Applies backpressure when the queue is too full.
2. **Mapper** (`src/mapper.ts`): turns rows into events with a deterministic `eventId` (receiver dedups on it; delivery is at-least-once).
3. **Queue** (`src/queue/queue.ts`, `DurableQueue`, better-sqlite3): holds events, per-table watermarks and hashes. Watermark updates and event inserts are done in the same transaction so a crash never loses events.
4. **Dispatcher** (`src/dispatcher.ts`): POSTs batches; the webhook must reply 2xx with `{accepted, retry, rejected}` — anything not listed as accepted/rejected stays queued; a 2xx without that body is NOT an ACK. Handles backoff and 401/413/429/5xx.
5. `status.json` in the data dir is written by the service and read by the `status` command.

Tables may be declared with only `"table": "X"` (strategy `auto`, columns `*`). `src/capture/discover.ts` `resolveTables` runs after connecting (service, `test-sqlserver`), reads `sys.*` and turns each into a concrete `rowversion` (if a `timestamp` column exists) or `hashDiff` (single-column key) table; composite keys without rowversion fail with an explicit error. Downstream code only sees `ResolvedConfig`/`TableConfig` (no `auto`); `requireResolved` is for tests. See `config/connector.auto.example.json`.

### Hard invariant: read-only against the POS

The connector must never write to the POS database. Every query goes through `assertReadOnlySelect` in `src/db/sqlGuard.ts` (single `SELECT`; no comments, `;`, `INTO`, `EXEC`, DML/DDL, `SET`, `DECLARE`, etc.). When adding queries, make them comply with the guard rather than loosening it — note it also bans `SET`/`USE`/`DECLARE`, so session options must be set at the client/driver level (`src/db/sqlClient.ts`). Identifiers must be quoted via `src/db/identifiers.ts`. All connector state lives in local SQLite, never in SQL Server. The SQL account is also restricted server-side (`installer/sql/01-create-readonly-access.sql`).

### Semantics to preserve

Events reflect *observed state*, not a transition history: if a row changes twice between polls only the last state is emitted (SDD §5.4). Config is validated with zod in `src/config.ts`.

### Windows packaging (untested on this Mac)

`installer/` (WinSW service XML, Inno Setup `lefort.iss`, read-only SQL script) and `scripts/build-release.ps1` need Windows. Not yet implemented: signed auto-updater with rollback, DPAPI secrets. `msnodesqlv8` (Shared Memory/Named Pipes) is unverified against a real POS; Docker tests use `tedious`.

## Notes

- Tests use simulated SQL clients/webhooks (`test/helpers.ts`, `scripts/lib/simulatedPos.ts`, `scripts/lib/fakeWebhook.ts`); the simulation does not validate T-SQL syntax.
- `src/service.ts` currently contains ad-hoc `console.log('[SERVICE] ...')` debug lines alongside the structured logger.
- `dev/data`, `dev/logs`, `*.db*`, `dist/`, `release/`, `config/connector.json` are gitignored.
