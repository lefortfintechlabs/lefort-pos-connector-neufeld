# Lefort POS Connector

## Software Design Document (SDD) y plan de trabajo

-   **Estado:** Borrador para revisión técnica
-   **Versión del documento:** 0.2
-   **Fecha:** 2026-10-28
-   **Producto:** Lefort POS Connector
-   **Plataforma objetivo:** Windows 10 Home 22H2 (x64) con Microsoft SQL Server 2022 Express local
-   **Stack propuesto:** Node.js + TypeScript
-   **Distribución:** Instalador de Windows y servicio en segundo plano

> **Cambios principales respecto a v0.1:** el motor de base de datos pasa de MySQL a SQL Server 2022 Express. Dado que no se puede modificar nada en el POS ni en su base de datos, la captura de cambios se rediseña como **lectura incremental (polling) de solo lectura**. Se descartan CDC nativo, Change Tracking, triggers y cualquier objeto creado en el servidor. Ver sección 5 y el Apéndice B.

------------------------------------------------------------------------

## 1. Resumen ejecutivo

Lefort POS Connector será un agente instalable en equipos Windows que alojan software de punto de venta (POS) y una base de datos SQL Server Express. Su función es detectar cambios relevantes en órdenes e inventario y transmitir eventos a un webhook remoto con baja latencia.

El conector debe funcionar sin intervención diaria, sobrevivir a cortes de red y reinicios, conservar los eventos pendientes, ofrecer información útil para soporte y permitir actualizaciones controladas.

### Principio de seguridad no negociable

**El conector nunca debe escribir, modificar ni eliminar datos, esquema, configuración ni objetos en la base de datos del POS ni en la instancia de SQL Server.**

Este principio se aplica por defensa en profundidad:

1.  El inicio de sesión de SQL Server del conector tendrá permisos mínimos: solo `SELECT` sobre las tablas configuradas. No tendrá `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `CREATE`, `DROP`, `EXECUTE` ni pertenencia a roles de servidor.
2.  Como control adicional, el usuario de base de datos se agregará a los roles `db_denydatawriter` y `db_denyddladmin`, de modo que las escrituras queden denegadas explícitamente.
3.  El código de acceso a la base de datos solo emitirá sentencias `SELECT` desde una lista cerrada de consultas parametrizadas. No hay SQL arbitrario desde configuración ni desde comandos remotos.
4.  No se crean tablas temporales, tipos, vistas, índices, procedimientos, triggers, sesiones de Extended Events ni ningún otro objeto en el servidor.
5.  La cola, los checkpoints, el estado de comparación, los logs y la configuración se guardan en almacenamiento local separado (SQLite en `C:\ProgramData`); nunca en SQL Server.
6.  El conector no ejecuta migraciones ni cambios de esquema en la base del POS.
7.  El mecanismo de actualizaciones no recibe ni usa credenciales de SQL Server.
8.  Las pruebas de aceptación verifican los permisos efectivos y que el conector no emite operaciones de escritura.

La garantía de solo lectura se refiere a SQL Server y al POS. El conector sí escribe en su propia cola local, logs y archivos de configuración protegidos.

### Única acción administrativa requerida

Crear el acceso de solo lectura (inicio de sesión, usuario de base de datos y los `GRANT SELECT`/roles de denegación descritos en 6.1) es una acción **de seguridad, no de datos ni de esquema**, que debe realizar una sola vez el administrador del POS. Si ni siquiera esto está permitido, el conector tendría que usar una credencial existente con permisos mayores, lo que viola el principio de mínimo privilegio. Ese caso solo se aceptaría con aprobación explícita y registrada (ver riesgo R1 en la sección 14).

------------------------------------------------------------------------

## 2. Objetivos

### 2.1 Objetivos funcionales

-   Detectar altas y modificaciones de las tablas configuradas de órdenes e inventario mediante lectura incremental.
-   Transformar los cambios observados en eventos JSON versionados.
-   Enviar eventos a un webhook remoto por HTTPS.
-   Mantener una cola local persistente para tolerar fallos de red o del receptor.
-   Reintentar transmisiones sin perder eventos.
-   Evitar efectos duplicados mediante identificadores estables derivados del contenido e idempotencia en el receptor.
-   Exponer estado, métricas y diagnóstico local.
-   Instalarse y ejecutarse como servicio de Windows.
-   Permitir actualización y rollback del conector sin borrar eventos pendientes.
-   Producir un paquete de diagnóstico para soporte que no exponga secretos.

### 2.2 Objetivos no funcionales

-   Operación desatendida tras la instalación.
-   Latencia objetivo configurable. Valor inicial sugerido: de 2 a 10 segundos para tablas con marca de cambio fiable (estrategias S1 y S2) y de minutos para tablas que solo admiten comparación por hash (S4). Sujeto a validación con el esquema y la carga reales.
-   Recuperación automática tras reinicios y desconexiones.
-   Trazabilidad por instalación y por evento.
-   Impacto mínimo sobre el rendimiento del POS. Esto es crítico porque SQL Server Express limita el motor a 1 GB de RAM y 4 núcleos, compartidos con el POS.
-   Instalación, actualización y desinstalación reproducibles.

### 2.3 Fuera de alcance de la primera versión

-   Escribir datos en el POS o ejecutar comandos SQL de negocio.
-   Modificar la instancia, la base de datos o el software del POS.
-   Capturar **cada** cambio intermedio de una fila. La lectura incremental observa el estado de la fila en el momento de cada consulta (ver 5.4).
-   Replicar eliminaciones, salvo detección opcional por comparación (S4) si se aprueba explícitamente.
-   Soportar automáticamente cualquier esquema de POS sin configuración o adaptadores.
-   Una plataforma web de administración avanzada, salvo que se apruebe como fase posterior.

------------------------------------------------------------------------

## 3. Entorno de referencia, supuestos y decisiones pendientes

### 3.1 Entorno de referencia confirmado

| Elemento | Valor |
|---|---|
| Sistema operativo | Windows 10 Home Single Language, versión 22H2 (build 19045), x64 |
| RAM | 12 GB |
| Base de datos | Microsoft SQL Server 2022 Express (64 bits), 16.0.1000.6 (RTM, octubre de 2022) |
| Instancia | Local, en el mismo equipo del POS |

Implicaciones:

-   Windows 10 Home admite servicios de Windows e instaladores Inno Setup sin restricciones relevantes. No dispone de directivas de grupo; la configuración debe ser local.
-   Windows 10 ya no recibe soporte regular de seguridad. El manual de instalación debe advertirlo al cliente. No es un bloqueo técnico del conector.
-   SQL Server 2022 RTM es la versión inicial sin actualizaciones acumulativas. Se recomienda que el administrador aplique la última CU, pero el conector no debe depender de ello.
-   SQL Server Express limita cada base de datos a 10 GB, el motor a 1 GB de RAM y a 4 núcleos. Las consultas del conector deben ser pequeñas, indexadas y espaciadas.
-   Express no incluye SQL Server Agent y no soporta CDC nativo.

### 3.2 Supuestos y decisiones pendientes

| Tema | Supuesto inicial | Decisión pendiente |
|---|---|---|
| POS | Producto de terceros con SQL Server Express | Identificar producto y versión |
| Modificaciones | **Ninguna permitida** en base, esquema ni instancia | Confirmar si el administrador puede crear un acceso de solo lectura (sección 1) |
| Tablas | Existen tablas de órdenes e inventario | Obtener esquema, claves, índices y relaciones relevantes |
| Marcas de cambio | Algunas tablas pueden tener `rowversion` o fecha de modificación | Inventariar por tabla qué columnas existen, si se actualizan siempre y si están indexadas |
| Cambios | Altas y modificaciones | Confirmar si se publican cambios por fila o eventos de negocio agregados |
| Conectividad | Conexión local a la instancia (probablemente `SQLEXPRESS`) | Determinar protocolos habilitados (Shared Memory, Named Pipes, TCP/IP) y modo de autenticación (Windows o mixto) |
| Destino | API REST/webhook propio | Definir URL, autenticación, límites y formato de ACK |
| Volumen | Entre 10 mil y 1 millón de registros | Medir cambios por segundo, tamaño de filas y picos |
| Instalación | Un servicio por punto de venta | Confirmar versión mínima de Windows y arquitectura |
| Actualizaciones | Automáticas y controladas | Definir canal, ventanas, despliegue gradual y rollback |
| Identidad | Un `connectorId` por instalación | Definir registro, revocación y asociación con comercio/sucursal |

No se debe asumir que el volumen total de filas determina por sí solo la capacidad necesaria. El dimensionamiento dependerá del número de cambios por segundo, el tamaño de los payloads y la duración máxima de desconexión.

------------------------------------------------------------------------

## 4. Arquitectura propuesta

### 4.1 Componentes

1.  **Windows Service**
    -   Orquesta los componentes.
    -   Maneja ciclo de vida, apagado ordenado y señales de salud.
2.  **SQL Server Change Reader** (lector incremental)
    -   Ejecuta consultas `SELECT` parametrizadas, de solo lectura, sobre las tablas configuradas.
    -   Aplica por tabla una estrategia de detección (S1 a S4, sección 5).
    -   Persiste los puntos de avance (watermarks) y el estado de comparación en la cola local, nunca en SQL Server.
    -   Aplica límites de carga: lotes pequeños, intervalos configurables, tiempo máximo de espera de bloqueos y prioridad baja ante interbloqueos.
3.  **Event Mapper**
    -   Convierte filas observadas en un contrato de evento estable.
    -   Separa el formato interno de las tablas del contrato externo.
    -   Permite adaptadores por versión de POS/esquema.
4.  **Local Durable Queue**
    -   SQLite local, almacenado bajo `C:\ProgramData\Lefort\POS Connector\`.
    -   Guarda eventos pendientes, intentos, estado y errores resumidos.
    -   Almacena watermarks y el estado de hashes por fila (para S4).
    -   Aplica límites, alertas y retención de eventos confirmados.
5.  **Webhook Dispatcher**
    -   Envía lotes por HTTPS.
    -   Aplica timeout, backoff exponencial con jitter y límites de concurrencia.
    -   Interpreta confirmaciones por evento y errores transitorios/permanentes.
    -   No elimina eventos hasta tener ACK válido.
6.  **Diagnostics**
    -   Estado del servicio, conexión a SQL Server, webhook, latencia, cola pendiente y última sincronización.
    -   Logs estructurados con rotación.
    -   Exportación de un paquete de soporte con secretos redactados.
7.  **Updater**
    -   Descarga y valida paquetes firmados.
    -   Aplica actualizaciones fuera del proceso principal.
    -   Conserva datos locales y permite rollback de binarios.
    -   No ejecuta comandos de negocio ni accede a SQL Server.
8.  **Installer**
    -   Instala el servicio, archivos y configuración inicial.
    -   Crea directorios con permisos mínimos.
    -   Configura arranque y recuperación del servicio.
    -   Instala el controlador ODBC de SQL Server si la estrategia de conexión lo requiere (ver 5.6).
    -   Permite desinstalación sin borrar silenciosamente eventos pendientes.

### 4.2 Diagrama lógico

``` mermaid
flowchart TD
    DB[(SQL Server Express POS)]
    RDR[SQL Server Change Reader]
    MAP[Event Mapper]
    Q[(SQLite Durable Queue y estado)]
    TX[Webhook Dispatcher]
    API[Webhook / API remota]
    DIAG[Diagnostics y logs]
    UPD[Updater]
    INST[Instalador Windows]

    DB -->|SELECT solamente| RDR
    RDR --> MAP
    MAP --> Q
    Q --> TX
    TX -->|HTTPS| API
    RDR --> DIAG
    Q --> DIAG
    TX --> DIAG
    UPD --> DIAG
    INST --> UPD
```

### 4.3 Principio de separación

La captura y la transmisión deben ser procesos lógicos independientes. Si la API remota no está disponible, la captura puede continuar mientras exista capacidad de almacenamiento local. Si la cola llega a su límite, el servicio debe aplicar una política segura y visible; nunca descartar silenciosamente eventos ni afectar la operación del POS.

------------------------------------------------------------------------

## 5. Estrategia de captura de cambios

### 5.1 Restricciones que determinan el diseño

Con la restricción de no modificar nada, **quedan descartados**:

-   **CDC nativo de SQL Server:** no está disponible en Express y requiere SQL Server Agent.
-   **Change Tracking:** disponible en Express, pero se habilita con `ALTER DATABASE` y `ALTER TABLE`, que modifican la base del POS.
-   **Triggers, tablas outbox, vistas, índices o procedimientos propios:** escriben en la base del POS.
-   **Extended Events, SQL Trace o auditorías:** crean objetos o configuración en el servidor, y no entregan los valores de las filas.
-   **Lectura del registro de transacciones** (por ejemplo `fn_dblog`): no está soportada y exige privilegios de administrador.

Queda como única vía la **lectura incremental de solo lectura**, que se describe a continuación.

### 5.2 Estrategias de detección por tabla

Cada tabla configurada usa una estrategia según lo que su esquema permita. Se decide en la Fase 0 y se valida en la Fase 1.

| Estrategia | Requisito en la tabla | Detecta altas | Detecta modificaciones | Observaciones |
|---|---|---|---|---|
| **S1. `rowversion` existente** | Columna `rowversion`/`timestamp` | Sí | Sí | Mejor opción. Se avanza solo hasta `MIN_ACTIVE_ROWVERSION()` para no saltar transacciones aún no confirmadas. |
| **S2. Fecha de modificación + PK** | Columna `datetime`/`datetime2` que el POS actualice en cada cambio | Sí | Sí, si la aplicación la mantiene | Watermark compuesto (fecha, PK) con ventana de traslape para absorber confirmaciones tardías, redondeo de `datetime` y desfases de zona horaria. |
| **S3. PK creciente + ventana caliente** | PK identity o creciente | Sí | Parcial: solo filas recientes | Lee las filas nuevas y relee las últimas N por PK. No detecta cambios en filas antiguas. Apta para órdenes recientes, **no** para inventario. |
| **S4. Comparación por hash** | PK estable | Sí | Sí | Calcula un hash de cada fila y lo compara con el estado local en SQLite. Costoso en lectura. Se hace por rangos de PK, con barridos espaciados. Puede detectar ausencia de claves (posibles eliminaciones). |

Combinaciones recomendadas:

-   **Ruta rápida:** S1, S2 o S3 con intervalo de 2 a 10 segundos.
-   **Red de seguridad:** barrido S4 periódico, y más espaciado en tablas grandes, para conciliar cualquier cambio que la ruta rápida no haya visto. Se activa por tabla según costo medido.
-   Si una tabla no ofrece ninguna marca fiable y S4 resulta demasiado costoso, **se documenta la limitación y no se promete captura completa** para esa tabla.

### 5.3 Reglas de lectura segura

-   Todas las consultas usan predicados sobre columnas indexadas (PK, índices existentes). La Fase 1 verifica con planes de ejecución que no haya escaneos completos repetidos. **No se pueden crear índices.** Si la columna de marca de cambio no está indexada, cada consulta puede escanear la tabla; en ese caso se aumenta el intervalo o se usa S3/S4 por rangos.
-   Lotes pequeños (por ejemplo, de cientos de filas) con `ORDER BY` sobre la clave del watermark.
-   Nivel de aislamiento: `READ COMMITTED` con `SET LOCK_TIMEOUT` corto y `SET DEADLOCK_PRIORITY LOW`, de modo que el conector ceda ante el POS. Si la base ya tiene habilitado `ALLOW_SNAPSHOT_ISOLATION` (se comprueba leyendo `sys.databases`, sin modificarlo), se usa `SNAPSHOT` para no bloquear escritores. **No se usa `NOLOCK` por defecto**, porque puede devolver filas duplicadas, omitidas o no confirmadas. Cualquier excepción requiere decisión documentada.
-   Si una consulta expira por bloqueo, se registra, se reintenta con backoff y no se avanza el watermark.
-   El watermark solo avanza después de persistir en SQLite los eventos del lote.
-   Presupuesto de carga configurable: máximo de consultas por minuto y de filas leídas por ciclo. El conector se auto-limita si detecta latencia alta en SQL Server.
-   Sin tablas temporales ni objetos: los rangos se consultan con parámetros simples (no con parámetros de tabla ni `#temp`).

### 5.4 Semántica de los eventos: observación de estado

La lectura incremental **observa el estado de las filas en cada consulta**. Por tanto:

-   Si una fila cambia dos veces entre dos consultas, se emite un único evento con el estado más reciente. Los estados intermedios no se capturan.
-   Los eventos representan "cambio observado", no un historial exacto de transacciones.
-   No hay garantía de orden de commit entre tablas. Se garantiza orden de observación por entidad.
-   Las eliminaciones solo se detectan con S4 y si se aprueban en el alcance.

Estas diferencias deben aceptarse por el consumidor del webhook antes de la implementación. Si el negocio exige historial completo de cada transición (por ejemplo, auditoría de estados de una orden), esta arquitectura no puede garantizarlo sin modificar el POS.

### 5.5 Carga inicial (baseline)

Al instalar, cada tabla requiere un estado inicial:

-   **Modo "solo cambios futuros" (por defecto):** el conector lee las tablas, registra watermarks y hashes iniciales **sin emitir eventos** y desde ese momento detecta cambios.
-   **Modo "snapshot inicial":** emite un evento por cada fila existente. Debe ser explícito y configurable, y limitado por lotes y ritmo, dado el volumen posible (hasta 1 millón de registros).

### 5.6 Conectividad con la instancia

-   SQL Server Express suele instalarse como instancia nombrada (`SQLEXPRESS`) con TCP/IP deshabilitado. **Habilitarlo sería un cambio de configuración del servidor**, que está fuera de lo permitido.
-   El controlador `tedious` (usado por el paquete `mssql`) solo se conecta por TCP/IP. Por eso la opción preferida es **`msnodesqlv8`** (módulo nativo sobre ODBC), que puede conectarse por **Shared Memory** o **Named Pipes**, normalmente habilitados para conexiones locales. Esto requiere el controlador ODBC de Microsoft para SQL Server, que el instalador puede incluir. Es un componente del equipo, no una modificación de la base.
-   La autenticación depende de lo que tenga la instancia: Windows (cuenta de servicio dedicada) o SQL (inicio de sesión dedicado, solo si el modo mixto ya está habilitado). Se valida en la Fase 0.
-   La Fase 1 prueba esta ruta en el entorno real. Si `msnodesqlv8` no es viable (empaquetado, dependencias nativas), la alternativa es `tedious` con TCP/IP, lo que requeriría autorización expresa.

------------------------------------------------------------------------

## 6. Requisito de solo lectura en SQL Server

### 6.1 Controles obligatorios

-   Crear o solicitar un inicio de sesión exclusivo para el conector (cuenta Windows dedicada o inicio de sesión SQL), con usuario asociado únicamente a la base del POS.
-   Otorgar `CONNECT` y `SELECT` **solo** sobre las tablas configuradas (no `db_datareader` completo, salvo aprobación documentada).
-   Agregar el usuario a `db_denydatawriter` y `db_denyddladmin`.
-   Sin pertenencia a roles de servidor, ni permisos `EXECUTE`, `ALTER`, `CREATE`, `CONTROL` o `VIEW SERVER STATE`.
-   Opcionalmente, `VIEW DEFINITION` si se necesita leer metadatos de columnas. Si no se concede, la configuración de columnas se define manualmente por adaptador.
-   No guardar estado, checkpoints ni colas en SQL Server.
-   No incluir en el código operaciones de escritura ni DDL.
-   Prohibir la ejecución arbitraria de SQL desde configuración o desde comandos remotos. Las consultas se generan a partir de una plantilla fija validada con una lista de tablas y columnas permitidas.
-   Validar la cuenta efectiva y los permisos en las pruebas de instalación (`test-sqlserver`).

### 6.2 Límite técnico importante

La garantía se basa en permisos de base de datos, diseño de código, revisión y pruebas. No debe describirse como una garantía matemática si la cuenta de servicio o las credenciales administrativas del POS permiten eludir esos controles. Además, un `SELECT` bajo `READ COMMITTED` toma bloqueos compartidos de corta duración; no modifica datos, pero puede competir con escrituras del POS. Los controles de 5.3 mitigan ese efecto y la Fase 7 lo mide.

### 6.3 Pruebas de aceptación de solo lectura

-   La cuenta del conector no puede ejecutar `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE`, `ALTER`, `DROP` ni `TRUNCATE` sobre el esquema del POS.
-   La cuenta no puede crear objetos, tablas temporales visibles para el POS, ni modificar configuración de la instancia.
-   Una prueba automatizada verifica que todas las sentencias SQL de la aplicación son `SELECT` de la lista cerrada.
-   Una prueba de instalación confirma los permisos efectivos (por ejemplo, con `HAS_PERMS_BY_NAME` y `sys.fn_my_permissions`, que solo leen).
-   El código de actualización no recibe ni utiliza credenciales de SQL Server.
-   La inspección de logs y de la traza de pruebas confirma que no se intentan operaciones de escritura.
-   Las pruebas no deben realizar escrituras en una base real de un comercio; se usan una instancia y datos de prueba.

------------------------------------------------------------------------

## 7. Contrato de eventos

El formato externo debe ser independiente de las tablas del POS y estar versionado. Ejemplo ilustrativo:

``` json
{
  "eventId": "sha256-derived-stable-id",
  "eventType": "order.updated",
  "schemaVersion": 1,
  "observedAt": "2026-10-28T16:00:00Z",
  "sourceModifiedAt": "2026-10-28T15:59:58Z",
  "connector": {
    "connectorId": "store-001",
    "version": "1.0.0"
  },
  "source": {
    "system": "pos",
    "table": "orders",
    "captureMethod": "rowversion"
  },
  "entity": {
    "type": "order",
    "id": "10482"
  },
  "operation": "UPSERT",
  "data": {
    "status": "completed"
  }
}
```

Este ejemplo no define el esquema final. El mapeo debe ajustarse al POS real.

### Requisitos del contrato

-   `eventId` estable y deduplicable. Se deriva de forma determinista de `connectorId`, tabla, clave primaria y versión de la fila (valor de `rowversion`, fecha de modificación o hash del contenido). Así, una relectura tras un reinicio produce el mismo `eventId`.
-   `operation` pasa a ser `UPSERT` (alta o modificación observada), porque la lectura incremental no distingue siempre entre ambas. Se puede emitir `INSERT` cuando la fila no existía en el estado local (S4) o por PK nueva (S3).
-   `observedAt` es el momento de captura. `sourceModifiedAt` se incluye solo si existe una columna de fecha confiable.
-   `source.captureMethod` indica la estrategia (`rowversion`, `modified_at`, `pk_window`, `hash_diff`) para que el consumidor conozca las garantías.
-   `connectorId` único por instalación.
-   Timestamp en UTC. Si el POS guarda fechas locales sin zona, se convierte con la zona configurada y se documenta.
-   Datos mínimos necesarios para el consumidor.
-   Tratamiento definido para datos sensibles.
-   Límite de tamaño de evento y lote.
-   Política explícita para valores nulos.

### ACK de la API

El receptor debe confirmar qué eventos persistió. Si acepta lotes parcialmente, la respuesta debe enumerar aceptados, reintentables y rechazados. El conector solo marca como enviados los eventos confirmados de forma válida.

La semántica será **entrega al menos una vez**. La API receptora debe ser idempotente, porque un timeout puede ocurrir después de que el servidor haya guardado el evento.

### Órdenes e inventario

Se debe decidir si el consumidor necesita:

-   Eventos por cada fila modificada; o
-   Eventos de negocio normalizados como `order.created`, `order.completed` o `inventory.changed`.

Una modificación en una orden puede afectar varias filas relacionadas (encabezado y partidas). Con lectura incremental, esas filas pueden observarse en ciclos distintos. Agregar eventos de negocio exige conocer las relaciones y reglas del POS y definir una ventana de consolidación. No se debe inferir que una fila individual representa una orden completa.

------------------------------------------------------------------------

## 8. Cola local, checkpoint y reintentos

### 8.1 Persistencia

SQLite se utilizará únicamente para el estado del conector. Ubicación sugerida:

`C:\ProgramData\Lefort\POS Connector\data\connector.db`

Contenido orientativo:

-   **Cola de eventos:** `event_id`, tabla, clave de entidad, estrategia de captura, payload versionado, fecha de observación, número de intentos, estado, última categoría de error, fecha de próximo intento.
-   **Watermarks por tabla:** último valor de `rowversion`, o (fecha, PK), o PK máxima, junto con la ventana de traslape.
-   **Estado de hashes por fila (S4):** PK y hash. Para 1 millón de filas se estima del orden de cientos de MB como máximo; se mide en la Fase 2.

El esquema definitivo debe contemplar eventos grandes, migraciones de la propia SQLite y retención.

### 8.2 Consistencia

-   Guardar eventos y watermark en la misma transacción de SQLite, de modo que la posición no avance más allá de eventos que no sean recuperables.
-   Si el proceso se interrumpe, aceptar releer filas y deduplicarlas por `eventId` determinista.
-   No emitir un evento si la fila no cambió respecto al hash o versión ya registrados (evita duplicados por la ventana de traslape).
-   No borrar eventos pendientes por límite de disco.
-   No considerar que un timeout significa que el servidor no recibió el evento.
-   Conservar los identificadores de evento en todos los reintentos.
-   Aplicar límites de concurrencia y preservar orden por entidad cuando el contrato lo requiera.

### 8.3 Reintentos y fallos

-   Reintentos con backoff exponencial y jitter para errores de red, `429` y `5xx`.
-   Respetar `Retry-After` cuando exista.
-   Errores de autenticación y esquema deben generar alertas y una política específica, evitando reintentos agresivos.
-   Los eventos rechazados permanentemente deben conservarse para diagnóstico y corrección; no descartarse silenciosamente.
-   Alertar por cola creciente, evento más antiguo, disco bajo, bloqueos o timeouts repetidos en SQL Server, y watermark sin avance.

### 8.4 Límites y capacidad

Definir valores iniciales configurables para tamaño de lote, timeout, concurrencia, retención, límite de disco, intervalo de consulta, tamaño de la ventana de traslape y frecuencia de salud. Dimensionar después de medir cambios por segundo, tamaño promedio de payload, costo de las consultas sobre Express y duración máxima de una interrupción.

------------------------------------------------------------------------

## 9. Seguridad

-   HTTPS con validación normal de certificados.
-   Credencial exclusiva por instalación; revocable de manera independiente.
-   Secretos (incluida la credencial de SQL Server, si es autenticación SQL) protegidos mediante Windows Credential Manager o DPAPI, no en texto plano. Con autenticación Windows no se almacena contraseña de base de datos.
-   Servicio ejecutado con una cuenta dedicada de privilegios mínimos.
-   Directorios y archivos con ACL restrictivas.
-   Paquetes de actualización firmados y verificados.
-   No ejecutar comandos arbitrarios recibidos desde el webhook.
-   Logs sin contraseñas, tokens, datos de tarjetas ni payloads sensibles por defecto.
-   Redacción de secretos en el paquete de diagnóstico.
-   Validación estricta de configuración y endpoint permitido.
-   Control de tamaño de petición, timeout y certificados.
-   Rotación y revocación de credenciales.

El webhook de negocio y el canal de actualización deben estar separados lógica y criptográficamente.

------------------------------------------------------------------------

## 10. Servicio Windows, instalador y actualización

### 10.1 Distribución propuesta

-   `LefortConnectorService.exe`: ejecutable principal empaquetado con el runtime de Node.js.
-   `LefortConnectorUpdater.exe`: componente separado para validar y aplicar actualizaciones.
-   Wrapper de servicio, por ejemplo WinSW, o servicio nativo si se decide invertir en ello.
-   Instalador `LefortPOSConnectorSetup.exe`, por ejemplo generado con Inno Setup.
-   Controlador ODBC de SQL Server incluido o verificado por el instalador, si se usa `msnodesqlv8`.
-   Firma Authenticode de binarios e instalador.

La elección final de empaquetador de Node.js debe validarse con `msnodesqlv8` (módulo nativo) y SQLite. Los módulos nativos pueden requerir tratamiento especial en el empaquetado.

### 10.2 Directorios

``` text
C:\Program Files\Lefort\POS Connector\
    updater.exe
    service-wrapper.exe
    versions\
        1.0.0\
            LefortConnector.exe

C:\ProgramData\Lefort\POS Connector\
    config\
    data\
        connector.db
    logs\
    updates\
```

### 10.3 Ciclo de actualización

1.  Consultar manifiesto de versiones por HTTPS.
2.  Validar firma del manifiesto, canal, versión y compatibilidad.
3.  Descargar el paquete a un directorio temporal.
4.  Verificar firma, hash y tamaño.
5.  Preparar una versión en una carpeta separada.
6.  Detener solo el servicio del conector.
7.  Activar la nueva versión.
8.  Iniciar y ejecutar comprobaciones de salud.
9.  Confirmar el éxito o volver a la versión anterior.
10. Registrar el resultado para soporte.

La cola, configuración, watermarks y estado de hashes se conservan fuera de las carpetas versionadas. Las migraciones locales deben ser compatibles y respaldadas; una reversión del binario no debe borrar eventos ni afectar datos del POS.

### 10.4 Despliegue gradual

-   Canal interno.
-   Grupo piloto.
-   Despliegue general.
-   Pausa central del despliegue si aumenta la tasa de fallos.
-   Versión mínima soportada y política para equipos que permanecen desconectados.
-   Ventana de mantenimiento configurable.
-   Opción de aplazar una actualización cuando el comercio está operando.

------------------------------------------------------------------------

## 11. Diagnóstico y soporte

### 11.1 Datos visibles

-   Versión del conector y versión del esquema de configuración.
-   `connectorId`, sin secretos.
-   Estado del servicio.
-   Estado y versión de SQL Server, protocolo de conexión usado y permisos efectivos.
-   Estrategia de captura por tabla, watermark actual y antigüedad.
-   Duración y frecuencia de las consultas; timeouts de bloqueo.
-   Último evento capturado y último evento confirmado.
-   Cantidad de eventos pendientes y edad del más antiguo.
-   Último HTTP status, latencia y categoría de error.
-   Último éxito de conexión con SQL Server y webhook.
-   Uso del disco y estado de actualización.

### 11.2 Logs

Formato JSON estructurado con:

-   timestamp UTC
-   nivel
-   componente
-   `connectorId`
-   `eventId` / `batchId` cuando corresponda
-   operación y duración
-   categoría de error y código
-   versión del conector

Aplicar rotación, retención configurable y límites de tamaño. Evitar registrar payloads completos por defecto.

### 11.3 Comandos de administración

Interfaz propuesta, pendiente de implementación:

``` powershell
LefortConnector.exe status
LefortConnector.exe test-sqlserver
LefortConnector.exe test-webhook
LefortConnector.exe queue
LefortConnector.exe diagnostics --output support.zip
LefortConnector.exe update --check
```

`test-sqlserver` debe comprobar conexión, protocolo, permisos efectivos y que las consultas configuradas usan índices, sin modificar nada. `diagnostics` debe redactar credenciales y datos sensibles. Los comandos de actualización deben requerir los permisos apropiados.

### 11.4 Paquete de soporte

Incluir:

-   logs recientes redactados
-   versión de Windows y arquitectura
-   versión del conector
-   estado resumido de SQL Server y de la estrategia de captura por tabla
-   métricas de cola
-   resultado de conectividad al webhook
-   configuración no secreta
-   estado de la última actualización

No incluir por defecto payloads completos ni credenciales.

------------------------------------------------------------------------

## 12. Plan de trabajo

Las duraciones son estimaciones iniciales y dependen del acceso al POS real y de su esquema.

### Fase 0 --- Descubrimiento y validación técnica

**Estimación:** 3--5 días

Tareas:

-   Confirmar versión de Windows y SQL Server (ya identificadas; verificar en el equipo real).
-   Obtener esquema de tablas de órdenes, partidas e inventario, con claves e índices.
-   Inventariar por tabla columnas `rowversion` y de fecha de modificación, y si la aplicación las actualiza siempre.
-   Determinar protocolos habilitados y modo de autenticación de la instancia.
-   Confirmar con el responsable del POS la creación del acceso de solo lectura (sección 1).
-   Identificar cambios de negocio y tablas relacionadas.
-   Definir el webhook, autenticación y ACK.
-   Medir volumen esperado y picos.
-   Confirmar con el consumidor del webhook la semántica de observación de estado (5.4).

Entregables:

-   Matriz de compatibilidad.
-   Inventario de tablas, campos, índices y estrategia propuesta (S1 a S4) por tabla.
-   Decisión documentada del mecanismo de captura.
-   Contrato inicial del webhook.
-   Lista de riesgos y decisiones pendientes.

Criterio de salida:

-   Existe una estrategia viable para cada tabla requerida que no escribe en el POS, o las limitaciones están documentadas y aceptadas.

### Fase 1 --- Prueba de concepto del lector incremental

**Estimación:** 5--8 días

Tareas:

-   Probar la conexión por Shared Memory/Named Pipes con `msnodesqlv8` en el entorno real o equivalente.
-   Implementar S1 a S4 sobre tablas de prueba y reales de solo lectura.
-   Verificar planes de ejecución (uso de índices) y costo de cada consulta.
-   Probar confirmaciones tardías, relectura tras reinicio y ventanas de traslape.
-   Medir bloqueos y efecto sobre el POS bajo carga.
-   Validar permisos mínimos y las denegaciones explícitas.
-   Medir latencia de detección por estrategia.

Entregables:

-   Prototipo del lector.
-   Pruebas automatizadas básicas.
-   Decisión de driver y estrategia por tabla.
-   Evidencia de solo lectura.

Criterio de salida:

-   Detección fiable demostrada sin operaciones de escritura y con impacto aceptable en el POS.

### Fase 2 --- Cola persistente y checkpoints

**Estimación:** 3--5 días

Tareas:

-   Diseñar esquema SQLite local (cola, watermarks, hashes).
-   Implementar almacenamiento transaccional de eventos y watermark.
-   Implementar recuperación después de apagado abrupto.
-   Implementar deduplicación por `eventId` determinista y retención.
-   Probar disco lleno y crecimiento de cola y del estado de hashes.

Entregables:

-   Módulo de persistencia.
-   Migraciones de SQLite.
-   Pruebas de recuperación.

Criterio de salida:

-   No se pierden eventos confirmados como capturados durante las pruebas de reinicio y recuperación.

### Fase 3 --- Webhook y entrega fiable

**Estimación:** 3--5 días

Tareas:

-   Implementar contrato de eventos.
-   Implementar envío por lotes y autenticación.
-   Implementar ACK por evento, timeout y backoff.
-   Clasificar errores transitorios y permanentes.
-   Probar duplicados, respuestas parciales y timeouts ambiguos.

Entregables:

-   Dispatcher.
-   Especificación de API.
-   Pruebas de idempotencia y reintentos.

Criterio de salida:

-   Un evento confirmado no se pierde localmente antes del ACK válido y los reintentos no duplican efectos en el receptor.

### Fase 4 --- Configuración, diagnóstico y soporte

**Estimación:** 3--4 días

Tareas:

-   Crear configuración validada.
-   Proteger secretos.
-   Implementar logs estructurados y rotación.
-   Implementar comandos de estado, pruebas de conectividad y exportación de soporte.
-   Redactar datos sensibles.

Entregables:

-   CLI de diagnóstico.
-   Formato de logs.
-   Guía de soporte.

Criterio de salida:

-   Soporte puede identificar por qué no se transmiten eventos sin acceso administrativo a la base del comercio.

### Fase 5 --- Instalador y servicio Windows

**Estimación:** 3--5 días

Tareas:

-   Empaquetar Node.js/TypeScript.
-   Validar dependencias nativas (`msnodesqlv8`, SQLite) y el controlador ODBC.
-   Crear servicio con arranque automático y recuperación.
-   Crear instalador y desinstalador.
-   Definir ACL de directorios y cuenta de servicio.
-   Probar instalación limpia, reparación y actualización en Windows 10 Home 22H2.

Entregables:

-   Instalador de prueba.
-   Servicio Windows.
-   Manual de instalación y desinstalación.

Criterio de salida:

-   Instalación reproducible en una máquina limpia sin exigir Node.js al cliente.

### Fase 6 --- Actualizador y rollback

**Estimación:** 3--5 días

Tareas:

-   Implementar manifiesto firmado.
-   Descargar y verificar paquetes.
-   Aplicar actualización fuera del proceso principal.
-   Validar salud después de actualizar.
-   Implementar rollback y conservación de cola.
-   Probar paquetes corruptos, firma inválida y cortes durante actualización.

Entregables:

-   Actualizador.
-   Pipeline de publicación.
-   Procedimiento de despliegue gradual.

Criterio de salida:

-   Una actualización fallida no borra la cola y permite volver a una versión compatible.

### Fase 7 --- QA, carga y piloto

**Estimación:** 4--7 días

Tareas:

-   Pruebas de carga con datos sintéticos representativos.
-   Pruebas de red desconectada y restaurada.
-   Pruebas de reinicio y corte de energía.
-   Pruebas de permisos de solo lectura.
-   Pruebas de impacto sobre el POS (bloqueos, CPU y RAM de la instancia Express).
-   Pruebas de actualización/rollback.
-   Piloto en un punto de venta no crítico.
-   Medición de latencia, uso de CPU, RAM y disco.

Entregables:

-   Informe de pruebas.
-   Lista de defectos y riesgos residuales.
-   Checklist de lanzamiento.
-   Procedimiento de soporte y rollback.

Criterio de salida:

-   Se cumplen los SLO acordados y todos los criterios de solo lectura y recuperación.

**Estimación total inicial:** aproximadamente 27--44 días laborables, sin contar esperas por acceso al POS, cambios de alcance o desarrollo de adaptadores para varios esquemas. Es una estimación de planificación, no una promesa de entrega. El aumento respecto a v0.1 se debe a la validación de varias estrategias de lectura incremental y del impacto sobre una instancia Express.

------------------------------------------------------------------------

## 13. Plan de pruebas

### 13.1 Solo lectura

-   Verificar permisos efectivos del inicio de sesión en SQL Server.
-   Probar que la cuenta no puede escribir en las tablas del POS ni crear objetos.
-   Revisar las sentencias SQL ejecutadas en pruebas y confirmar que son solo `SELECT`.
-   Confirmar que instalación, actualización y diagnóstico no escriben en SQL Server.
-   Confirmar que todo estado persistente se guarda fuera de la base del POS.

### 13.2 Integridad de eventos

-   Alta y modificación consecutivas sobre una misma entidad entre dos consultas (debe emitirse el estado final).
-   Transacciones con múltiples filas y confirmaciones tardías de transacciones largas.
-   Relectura de filas tras reinicio sin duplicar efectos (mismo `eventId`).
-   Redondeo de `datetime`, cambios de hora (horario de verano) y desfase de reloj.
-   Filas con la misma fecha de modificación.
-   Actualización de clave primaria, si el POS la permite.
-   Cambios de esquema y tipos no esperados.
-   Detección de ausencias de clave con S4, si está en alcance.
-   Tablas sin índice en la columna de marca de cambio (impacto y comportamiento).

### 13.3 Red y API

-   DNS fallido, timeout, TLS inválido y conexión rechazada.
-   Respuestas 401/403, 429, 5xx y respuesta malformada.
-   ACK parcial.
-   Servidor persiste evento y se pierde la respuesta.
-   Webhook fuera de servicio durante varias horas.

### 13.4 SQL Server y conectividad

-   Instancia detenida o reiniciando mientras el conector corre.
-   Timeouts de bloqueo y de consulta.
-   Conexión por Shared Memory y Named Pipes sin TCP/IP habilitado.
-   Credenciales revocadas o permisos retirados.
-   Base cercana al límite de 10 GB y memoria de la instancia bajo presión.

### 13.5 Sistema operativo y actualizaciones

-   Reinicio de Windows.
-   Servicio detenido por error.
-   Instalación sin Node.js.
-   Usuario sin permisos administrativos.
-   Disco casi lleno.
-   Paquete corrupto o firma inválida.
-   Corte durante actualización.
-   Rollback con eventos pendientes.
-   Desinstalación con cola no vacía.

### 13.6 Carga y rendimiento

Medir:

-   cambios por segundo sostenidos y pico
-   latencia de detección y de captura a ACK
-   CPU y RAM del conector y de la instancia SQL Server
-   bloqueos y esperas causados al POS
-   I/O de disco
-   crecimiento de cola durante desconexión
-   tiempo de recuperación y drenado de cola
-   costo de los barridos S4

No fijar umbrales definitivos hasta tener una línea base y conocer el hardware típico de los POS.

------------------------------------------------------------------------

## 14. Riesgos y mitigaciones

| ID | Riesgo | Mitigación |
|---|---|---|
| R1 | No se permite crear un acceso de solo lectura | No usar credenciales con mayores privilegios sin aprobación explícita y registrada. Documentar el riesgo residual. Evaluar autenticación Windows con cuenta dedicada. |
| R2 | Tablas sin `rowversion` ni fecha de modificación fiable | Usar S3 (solo si basta con filas recientes) o S4. Si es inviable, documentar que no se garantiza captura completa en esa tabla. |
| R3 | Estados intermedios no capturados | Aceptación documentada con el consumidor (5.4). Si se exige historial completo, requiere modificar el POS, lo cual está fuera del alcance. |
| R4 | Confirmaciones tardías que quedan por detrás del watermark | Uso de `MIN_ACTIVE_ROWVERSION()` (S1), ventana de traslape (S2), deduplicación por contenido y barrido S4 de conciliación. |
| R5 | Consultas sin índice causan escaneos y degradan el POS | Verificar planes en la Fase 1, ampliar intervalos, limitar filas por ciclo y autolimitarse ante latencia alta. No se pueden crear índices. |
| R6 | Bloqueos del conector afectan al POS | `READ COMMITTED` con `LOCK_TIMEOUT` corto y prioridad de interbloqueo baja. Usar `SNAPSHOT` solo si ya está habilitado. Medir en el piloto. |
| R7 | TCP/IP deshabilitado y el driver no conecta | Preferir `msnodesqlv8` con Shared Memory o Named Pipes. TCP/IP solo con autorización expresa. |
| R8 | Límites de Express (1 GB de RAM, 10 GB por base) agravan el impacto | Lotes pequeños, intervalos espaciados, medición en hardware real. |
| R9 | La cola local se llena | Límite y alertas; no descartar silenciosamente; definir backpressure seguro. |
| R10 | Eventos duplicados | `eventId` determinista e idempotencia en la API receptora. |
| R11 | Cambios de esquema del POS | Adaptadores versionados y pruebas de compatibilidad. |
| R12 | Actualización corrupta | Firma, hash, instalación por versión y rollback. |
| R13 | Se filtran datos sensibles en logs | Redacción, acceso restringido y payloads mínimos. |
| R14 | Credenciales excesivas | Usuario dedicado, permisos mínimos y pruebas automatizadas. |
| R15 | Orden incorrecto de eventos | Orden por entidad según observación; el consumidor no debe asumir orden de commit global. |
| R16 | Windows 10 sin soporte regular de seguridad | Advertirlo en el manual; no depender de funciones recientes del sistema operativo. |
| R17 | Módulos nativos (`msnodesqlv8`, SQLite) complican el empaquetado | Validar en la Fase 5 con una máquina limpia. |

------------------------------------------------------------------------

## 15. Criterios generales de aceptación

La primera versión no se considera lista para producción hasta que:

1.  Instala y desinstala en Windows mediante un instalador reproducible.
2.  Funciona como servicio sin sesión interactiva.
3.  Solo puede leer del esquema del POS; no tiene permisos de escritura ni crea objetos en SQL Server.
4.  Detecta las altas y modificaciones acordadas mediante una estrategia validada por tabla, con las limitaciones documentadas.
5.  Persiste eventos antes de avanzar el watermark de forma irrecuperable.
6.  Tolera cortes de red y reinicios sin descartar eventos silenciosamente.
7.  Reintenta con idempotencia y conserva los eventos no confirmados.
8.  Proporciona diagnóstico útil sin exponer secretos.
9.  Puede actualizarse y volver a una versión compatible sin perder cola.
10. Su impacto sobre el POS y la instancia Express es aceptable en pruebas de carga representativas y en el piloto controlado.

------------------------------------------------------------------------

## 16. Decisiones técnicas recomendadas

-   **Lenguaje:** TypeScript.
-   **Runtime:** Node.js empaquetado para Windows.
-   **Captura:** lectura incremental de solo lectura con estrategias por tabla (S1 a S4), sujeta a prueba de concepto.
-   **Acceso a SQL Server:** `msnodesqlv8` (ODBC, Shared Memory/Named Pipes); `tedious`/`mssql` solo si se autoriza TCP/IP.
-   **Cola local y estado:** SQLite.
-   **Transporte:** HTTPS a webhook REST.
-   **Entrega:** al menos una vez, con idempotencia del receptor y `eventId` determinista.
-   **Servicio:** Windows Service mediante wrapper probado o implementación nativa.
-   **Instalador:** Inno Setup.
-   **Actualizaciones:** manifiesto y paquetes firmados, actualización por versiones y rollback.
-   **Observabilidad:** logs JSON, CLI y paquete de diagnóstico.
-   **Seguridad principal:** inicio de sesión de solo lectura con `SELECT` por tabla y denegación explícita de escritura, secretos protegidos y no ejecución de comandos remotos.

Estas decisiones deben revisarse tras la prueba de concepto y la identificación del POS real.

------------------------------------------------------------------------

## 17. Próximos pasos inmediatos

1.  Verificar en el equipo real la versión de SQL Server, los protocolos habilitados y el modo de autenticación.
2.  Obtener el esquema de las tablas de órdenes, partidas e inventario, con claves, índices y columnas `rowversion`/fecha de modificación.
3.  Confirmar con el administrador del POS la creación del acceso de solo lectura (sección 1) o la alternativa aprobada.
4.  Definir si se transmiten cambios por fila o eventos de negocio agregados, y validar con el consumidor la semántica de observación de estado.
5.  Definir el contrato del webhook, autenticación y ACK.
6.  Construir una prueba de concepto que demuestre detección, relectura tras reinicio, impacto bajo sobre el POS y solo lectura.
7.  Revisar y aprobar este SDD antes de implementar el servicio completo.

------------------------------------------------------------------------

## Apéndice A --- Glosario

-   **Polling / lectura incremental:** consulta periódica de solo lectura que detecta filas nuevas o modificadas a partir de un punto de avance.
-   **Watermark:** valor (por ejemplo `rowversion`, fecha y PK) hasta el cual el conector ha procesado cambios de forma recuperable.
-   **`rowversion`:** tipo de columna de SQL Server que se actualiza automáticamente en cada inserción o modificación de la fila.
-   **CDC (Change Data Capture):** captura de cambios nativa de SQL Server, no disponible en Express.
-   **Change Tracking:** mecanismo nativo que requiere habilitarse en la base de datos; descartado por exigir modificaciones.
-   **Checkpoint:** posición confirmada hasta la cual el conector ha procesado de manera recuperable los cambios.
-   **Hash de fila:** resumen criptográfico del contenido de una fila, usado para detectar modificaciones por comparación.
-   **ACK:** confirmación de que el receptor persistió uno o más eventos.
-   **Idempotencia:** propiedad que permite repetir una operación sin duplicar sus efectos.
-   **Backpressure:** mecanismo para limitar o detener el consumo cuando el sistema receptor no puede seguir el ritmo.
-   **Rollback:** volver a una versión anterior del software tras detectar un fallo.

## Apéndice B --- Registro de cambios

**v0.2 (2026-10-28)**

-   Motor de base de datos: de MySQL a SQL Server 2022 Express (Windows 10 Home 22H2).
-   Restricción nueva: no se modifica nada en el POS, su base de datos ni la instancia.
-   Captura: se reemplaza CDC por binlog con lectura incremental de solo lectura (estrategias S1 a S4). Se descartan CDC nativo, Change Tracking, triggers y objetos en el servidor.
-   Eventos: `eventId` determinista, operación `UPSERT`, campos `observedAt`, `sourceModifiedAt` y `captureMethod`. Se documenta la semántica de observación de estado.
-   Conectividad: se prefiere `msnodesqlv8` por Shared Memory/Named Pipes para evitar habilitar TCP/IP.
-   Permisos: `SELECT` por tabla y roles de denegación de escritura.
-   Riesgos, pruebas y plan de trabajo actualizados; estimación total de 27--44 días laborables.
-   Comando `test-mysql` renombrado a `test-sqlserver`.

**v0.1 (2026-10-28)**

-   Borrador inicial para MySQL con CDC por binlog.
