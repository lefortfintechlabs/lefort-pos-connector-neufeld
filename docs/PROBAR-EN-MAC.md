# Probar el conector en macOS

Tres niveles, de menos a más realista. Los dos primeros no necesitan SQL Server.

## 0. Preparación

```bash
brew install node@22          # o nvm install 22 (msnodesqlv8 exige Node >= 22)
cd lefort-pos-connector
npm install --omit=optional   # omite msnodesqlv8 (driver ODBC de Windows, no se usa en Mac)
```

## Nivel 1: pruebas automáticas (≈6 s)

```bash
npm test
```

50 pruebas con SQL y webhook simulados: guardia de solo lectura, cola, las cuatro estrategias,
reintentos, ACK parcial, reinicios y un flujo de servicio completo.

## Nivel 2: demo de extremo a extremo, sin SQL Server (≈40 s)

```bash
npm run demo
```

Arranca un POS simulado en memoria (Orders, OrderItems, Stock, Products), un webhook local y el conector real.
Cada 2 s el "POS" crea órdenes, paga, ajusta stock, cambia precios y borra productos. A mitad de la demo el
webhook se cae (503) y luego confirma solo la mitad de cada lote. Al final imprime un resumen:

- eventos únicos por tabla y duplicados recibidos,
- cola vacía (`pendientes=0`),
- consultas SQL emitidas y **0 rechazadas por el guardia de solo lectura**.

Observe que un producto agregado y borrado antes del siguiente barrido nunca aparece como evento de `products`:
es la limitación de "observar estado" (SDD §5.4), no un fallo.

Limitación: la simulación responde a las consultas reales del conector pero **no valida la sintaxis T-SQL**.

## Nivel 3: SQL Server 2022 Express real en Docker

Es el único nivel que ejecuta el T-SQL generado contra un motor real y el driver `tedious`.

```bash
# Apple Silicon: Docker Desktop > Settings > General > "Use Rosetta for x86_64/amd64 emulation"
docker compose -f dev/docker-compose.yml up -d
sleep 30                                   # espere a que SQL Server arranque

npm run dev:sql -- dev/sql/01-seed.sql     # crea la base POS con 4 tablas (una por estrategia)
npm run dev:sql -- dev/sql/02-readonly-login.sql   # login lefort_ro: solo SELECT + denegación de escritura

export LEFORT_SQL_PASSWORD='Lefort_Ro_Passw0rd!'
export LEFORT_WEBHOOK_TOKEN=dev
npx tsx src/index.ts config-check    --config dev/connector.docker.json
npx tsx src/index.ts test-sqlserver  --config dev/connector.docker.json   # todo OK; sin FAIL
```

Terminal 2: `LEFORT_WEBHOOK_TOKEN=dev npm run dev:webhook`
Terminal 3 (conector): `npx tsx src/index.ts run --config dev/connector.docker.json`
Terminal 4 (actividad del POS): `npm run dev:sql -- dev/sql/03-mutate.sql` (repítalo varias veces)

### Escenarios que conviene probar

| Escenario | Cómo | Resultado esperado |
|---|---|---|
| Permisos mínimos | `test-sqlserver` con `lefort_ro` | Todo OK |
| Exceso de privilegios | `LEFORT_SQL_PASSWORD='Lefort_Sa_Passw0rd!'` y cambie `"user"` a `sa` en una copia del JSON | `FAIL privilegios` (sysadmin) y permisos de escritura |
| Cambios por estrategia | `03-mutate.sql` | `orders` y `order_items` casi al instante; `inventory` en ~1 s; `products` tras el barrido (≈15 s) |
| Webhook caído | `curl -X POST 'localhost:8787/__mode?mode=down'`, mutar, luego `mode=ok` | Los eventos se acumulan (`status`) y se entregan al volver |
| ACK parcial / sin ACK | `mode=partial`, `mode=noack` | Nada se pierde; sin ACK no se borra de la cola |
| Corte brusco | `kill -9` al conector durante la actividad y reiniciar | Sin eventos perdidos; los duplicados, si hay, llevan el mismo `eventId` |
| SQL Server caído | `docker stop lefort-sqlserver` / `docker start ...` | El conector reintenta y se reanuda solo |
| Bloqueos | En otra sesión: `BEGIN TRAN; UPDATE dbo.Orders SET Status='x' WHERE OrderId=1;` sin confirmar | El conector no se cuelga (LOCK_TIMEOUT) y avanza al confirmar; con `rowversion` no salta la transacción abierta |
| Estado | `npx tsx src/index.ts status --config dev/connector.docker.json` y `queue` | Watermarks, cola, último error |

Para limpiar: `docker compose -f dev/docker-compose.yml down -v` y borre `dev/data` y `dev/logs`.

## Qué NO puede validar un Mac

- `msnodesqlv8` por Shared Memory/Named Pipes (la ruta prevista en el POS real) y el controlador ODBC.
- Cómo devuelve el driver las fechas en Windows (`sourceTimeZone`).
- WinSW, Inno Setup, cuenta `NT SERVICE\LefortPOSConnector` y autenticación Windows.
- El comportamiento de SQL Server Express sobre Windows 10 Home con la base real del POS (índices, bloqueos, carga).
