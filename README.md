# Lefort POS Connector

Agente de Windows (Node.js + TypeScript) que detecta cambios en órdenes e inventario de un POS con
**SQL Server Express** y los envía a un webhook HTTPS. Implementa el diseño de
[`docs/SDD-Lefort-POS-Connector.md`](docs/SDD-Lefort-POS-Connector.md) (v0.2).

> **Principio central:** el conector **nunca** escribe en la base del POS ni en la instancia. Toda consulta
> pasa por un guardia que solo admite un `SELECT` (sin `INTO`, `EXEC`, DML/DDL ni comentarios), y la cuenta
> de SQL Server solo tiene `SELECT` por tabla más `db_denydatawriter`/`db_denyddladmin`.
> Todo el estado (cola, watermarks, hashes) vive en SQLite local.

## Estado del proyecto

| Pieza | Estado |
|---|---|
| Guardia de solo lectura, cliente SQL (`msnodesqlv8` / `tedious`) | Implementado; **driver sin probar contra un SQL Server real** |
| Estrategias S1 `rowversion`, S2 `modifiedAt`, S3 `pkWindow`, S4 `hashDiff` | Implementadas y probadas con tablas simuladas |
| Cola durable SQLite, watermarks transaccionales, contrapresión | Implementado y probado |
| Dispatcher (ACK por evento, backoff, 401/413/429/5xx) | Implementado y probado |
| CLI: `run status queue config-check test-sqlserver test-webhook diagnostics` | Implementada (`test-sqlserver` requiere SQL Server) |
| Plantilla WinSW, Inno Setup, script de release, SQL para el DBA | **Escritas, sin probar** (requieren Windows) |
| Actualizador firmado con rollback (SDD §10.3), secretos con DPAPI | **Pendiente** |

## Inicio rápido (desarrollo)

```bash
npm install
npm test                 # 50 pruebas, no requieren SQL Server
npm run build
node dist/index.js config-check --config config/connector.example.json
```

En Windows, con el POS real:

1. Pedir al administrador que ejecute `installer/sql/01-create-readonly-access.sql` (una sola vez).
2. Copiar `config/connector.example.json` a `connector.json` y ajustar servidor, base de datos y tablas.
3. `set LEFORT_WEBHOOK_TOKEN=...` y ejecutar `node dist/index.js test-sqlserver` (permisos, columnas, índices).
4. `node dist/index.js test-webhook`, luego `node dist/index.js run`.

## Probar sin Windows ni POS real

`npm run demo` (POS simulado en memoria + webhook local, sin dependencias) y un SQL Server Express en Docker
para validar el T-SQL real. Guía completa en [`docs/PROBAR-EN-MAC.md`](docs/PROBAR-EN-MAC.md).

## Cómo elegir la estrategia por tabla

| Estrategia | Úsela cuando | Límite |
|---|---|---|
| `rowversion` | La tabla ya tiene columna `rowversion`/`timestamp` | Ninguno relevante; la mejor |
| `modifiedAt` | Hay fecha de modificación que el POS actualiza siempre | Filas con fecha NULL son invisibles |
| `pkWindow` | Órdenes con PK creciente | No ve cambios en filas antiguas (no usar en inventario) |
| `hashDiff` | No hay ninguna marca de cambio | Barrido completo periódico; latencia de minutos |

Semántica (SDD §5.4): se **observa el estado** de las filas; si cambian dos veces entre consultas se envía
solo el último estado. No hay historial exacto de transiciones. Entrega al menos una vez: el receptor
debe deduplicar por `eventId` (determinista).

### Descubrimiento automático

Basta `{ "table": "@SO1_01VENTA" }`: el conector lee columnas, llave y `rowversion` desde `sys.*` y elige
`rowversion` o `hashDiff` (con detección de borrados). Opcional: `columns`, `excludeColumns`, `primaryKey`.
Ejemplo en `config/connector.auto.example.json`. Limitaciones: `rowversion` no ve borrados; llave compuesta sin
`rowversion` exige configuración manual.

## Contrato del webhook

`POST` con `Authorization: Bearer <token>` y cuerpo
`{ schemaVersion, connectorId, batchId, sentAt, events: [...] }`. Respuesta `2xx` con
`{ "accepted": ["eventId"...], "retry": ["eventId"...], "rejected": [{ "eventId", "reason" }] }`.
Lo que no aparezca como `accepted` o `rejected` permanece en la cola y se reintenta. Una respuesta `2xx`
sin ese cuerpo **no** se interpreta como confirmación.

## Estructura

```
src/db/        guardia de solo lectura, cliente SQL, identificadores
src/capture/   estrategias S1-S4 y lector (reader.ts)
src/queue/     cola durable y estado en SQLite
src/           config, mapper, dispatcher, service, commands (CLI)
installer/     WinSW, Inno Setup, SQL de acceso de solo lectura
scripts/       build-release.ps1 (ejecutar en Windows)
test/          pruebas con SQL y webhook simulados
```

## Pendientes antes de producción

- Probar `msnodesqlv8` por Shared Memory/Named Pipes con el SQL Server Express real (Fase 1) y comprobar
  cómo devuelve las fechas (`sourceTimeZone`).
- Medir planes de ejecución y bloqueos con carga del POS; verificar índices (`test-sqlserver` avisa).
- Secretos con DPAPI/Credential Manager en lugar de variables de entorno.
- Actualizador con manifiesto firmado y rollback; firma Authenticode.
- Empaquetado y servicio en Windows 10 Home 22H2 limpio.
