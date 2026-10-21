# POC 2 — Job Worker vs. User Task nativo (tiempos y volumetría)

Contrasta dos formas de enterarse de que un Ticket ya tiene su user task
esperando al usuario, para crear el formulario en el backend:

| | A. Job Worker | B. User Task + task listener `creating` |
|---|---|---|
| BPMN | `bpms/ticket-jobworker.bpmn` = réplica del diagrama **`pocJobWorker`** (`userTask` **sin** `zeebe:userTask`: implementación job worker; sin listener `creatingUserTask`) | `bpms/ticket-usertask.bpmn` = réplica del diagrama **`pocListener`** de Web Modeler (`zeebe:userTask` + listener `creating` → job `creatingUserTask`, execution listeners `logStart`, formulario `userTaskForm`) |
| Notificación | job `io.camunda.zeebe:userTask` (tipo fijo del motor) | job `creatingUserTask` (evento *creating* de la user task) |
| "Marcar como conocida" | **No se puede** sin completar el job, y completarlo avanza el BPMN. Solo `forward()` + tabla "already processed" | `job.complete()` del listener: el BPMN **no** avanza, queda parado en la user task |
| Reenvíos | Zeebe reentrega el job cada `timeout` hasta que se complete | Ninguno |
| Cierre ("done") | `completeJob(jobKey)` | `POST /v2/user-tasks/{key}/completion` |

El backend (Node, emula al Java) guarda el Ticket en SQLite (`node:sqlite`),
crea la instancia por gRPC, recibe las notificaciones, crea el form y registra
cada hito en una tabla `events` de la que sale todo el reporte. Ambas
alternativas terminan en un service task `ticket-closed` que marca cuándo avanzó
el motor tras el done (sin depender del secondary storage).

> **Restricción de negocio (A y B):** ni la user task ni el listener llevan un id
> propio que los distinga de otros; todo llega por el mismo tipo de job. Una user
> task job-worker, además, no admite un tipo propio: Zeebe siempre crea
> `io.camunda.zeebe:userTask`, común a todas las user tasks job-worker del cluster.
> La única correlación es la variable de proceso `ticketId`: los jobs sin ella (o
> con un ticket que el backend no conoce) se devuelven con `fail` (retries sin
> cambio, espera de 5 s). En un cluster compartido esto puede interferir con otros
> procesos; usa un cluster dedicado.

> **Alternativa B = `pocListener`.** El BPMN local usa el mismo process id, los mismos
> listeners y el mismo formulario que el diagrama del cluster SaaS. Único añadido de
> la POC: un execution listener `ticket-closed` en el end event, para medir cuándo
> avanza el motor tras el done. El worker de `logStart` va incluido (`WORKERS=logstart`
> para arrancarlo solo). **Ojo:** `npm run deploy` contra SaaS publicaría una versión
> nueva de `pocListener` con ese añadido; hazlo solo si quieres reemplazar tu modelo.

## Respuesta a la pregunta de la alternativa B

**Sí se puede.** El listener `creating` entrega la notificación como un job
propio; completarlo solo permite que la user task termine de crearse. El proceso
sigue detenido en esa user task hasta que se completa la tarea (verificado:
`notificaciones = 1` por ticket, 0 reenvíos, 0 entregas tras el done).
El tipo de evento se distingue por la definición del listener (`eventType` →
`type` del job); el job además trae el header `io.camunda.zeebe:userTaskKey`,
que se usa luego para completar la tarea sin consultar nada.

## Cómo reproducir

Requiere Docker, Node ≥ 22.13 y el Camunda local del `docker-compose.yml` de la raíz.

```bash
docker compose up -d                 # raíz del repo; esperar a healthy
cd "poc 2/backend"
npm install
npm run deploy                       # despliega los dos BPMN
JOB_TIMEOUT_MS=10000 npm start       # terminal 1: backend + workers
TICKETS=50 DONE_AFTER_MS=35000 npm run bench   # terminal 2
```

| Variable | Default | Qué controla |
|---|---|---|
| `JOB_TIMEOUT_MS` | 20000 | Timeout del job de la alternativa A = intervalo de reenvío (en prod. el "n minutos") |
| `TICKETS` | 20 | Tickets por alternativa |
| `DONE_AFTER_MS` | 65000 | Cuánto tarda el "usuario" en marcar done |
| `FORM_DELAY_MS` | 20 | Trabajo simulado al crear el form |

El reporte queda en `backend/results/run-*.md` (legible) y como JSON en `GET /report`. La lectura de los datos está en [interpretacion-resultados.md](interpretacion-resultados.md).
Endpoints: `POST /tickets {variant: jobworker|usertask}`, `POST /tickets/:id/done`,
`GET /tickets/:id`, `GET /report`, `POST /reset`.

## Resultados (corrida local del 2026-10-19)

Camunda 8.10.3 local (1 contenedor, H2), backend y workers en la misma máquina,
50 tickets por alternativa, timeout de job 10 s, usuario tarda 35 s, con A como
user task job worker (el BPMN actual). Latencias en ms, p50 / p95.
Archivo: `backend/results/run-local-2026-10-19T20-52-06-701Z.md`.

| Métrica | A. User task job worker | B. User task + listener |
|---|---|---|
| Crear instancia (API) | 72 / 112 | 49 / 102 |
| Ticket creado → notificación recibida | 113 / 225 | 96 / 142 |
| Ticket creado → form listo | 158 / 262 | 141 / 186 |
| Procesar la notificación | 48 / 64 | 50 / 62 |
| Ack de la notificación | n/a (no se completa) | 77 / 124 |
| Done → API responde | 65 / 133 | 50 / 94 |
| Done → el motor avanza | 201 / 373 | 192 / 382 |

| Volumetría (50 tickets) | A. User task job worker | B. User task + listener |
|---|---|---|
| Notificaciones recibidas | 200 (4 por ticket) | 50 (1 por ticket) |
| Duplicados descartados | 150 (75 %) | 0 |
| Intervalo de reenvío | p50 10.8 s (≈ timeout) | — |
| Entregas después del done | 0 | 0 |

**Lectura.**

- **Volumen**: es la diferencia real y se reprodujo igual en dos corridas. En A cada
  ticket abierto genera `1 + ⌊tiempo_abierto / timeout⌋` mensajes y todos salvo el
  primero son ruido. Con timeout de 5 min y tickets abiertos 1 h son ≈12 mensajes
  por ticket; con 8 h, ≈96. En B es siempre 1.
- **Latencia**: las dos alternativas son equivalentes dentro del ruido. Una corrida
  anterior, con A como service task, había mostrado a B unos 100 ms más lenta; con
  A como user task esa diferencia desapareció (y B salió incluso algo menor). La
  diferencia de aquella corrida venía de comparar un service task con una user
  task, no del listener. Entre corridas hay ~±50 ms de variación.
- **Done**: A por gRPC y B por REST tardan lo mismo para que el motor avance (~200 ms).
- La corrida anterior (A como service task) se conserva en
  `backend/results/run-local-A-service-task-2026-10-19T13-50-09Z.md`.

## Cosas a tener en cuenta

- Estas cifras son de un solo equipo y una sola corrida, sin carga concurrente
  real (50 tickets creados en ~15 s). Sirven para comparar, no como capacidad.
- En B la user task **no existe** hasta que el listener `creating` se completa:
  si el backend está caído, la tarea no aparece en Tasklist y el job se reintenta
  por su timeout. Completar rápido el listener es parte del camino crítico.
- En A el "already processed" depende de una tabla propia; si se pierde, cada
  reenvío vuelve a crear el form. En B el motor garantiza una entrega por evento.
- El job del listener también se reentrega si el backend no lo completa a tiempo
  (at-least-once), así que `createFormOnce` sigue siendo idempotente en ambos.
- Los resultados publicados son de Camunda local. SaaS está cableado (ver abajo), pero sus latencias incluyen la red y no son comparables con las de local.

## Scripts y colección de Postman

Los scripts son Node puro (sin dependencias), multiplataforma.

| Archivo | Para qué sirve |
|---|---|
| `scripts/run-poc2.mjs` | Prueba completa: levanta Camunda, instala, despliega, arranca el backend, corre el benchmark y lo apaga |
| `scripts/sweep-open-time.mjs` | Repite el benchmark con distintos tiempos abiertos (35/70/140/280 s) e imprime la tabla de mensajes por ticket |
| `postman/poc2-tickets.postman_collection.json` | Un ticket por alternativa de punta a punta, con 23 aserciones |

```bash
cd "poc 2"
node scripts/run-poc2.mjs --tickets 50 --done-after-ms 35000 --job-timeout-ms 10000
node scripts/sweep-open-time.mjs --tickets 20
# o, desde backend/:  npm run poc   |   npm run sweep
```

Opciones de `run-poc2`: `--tickets`, `--done-after-ms`, `--job-timeout-ms`, `--port`,
`--keep-backend` (deja el backend arriba para usar Postman). Opciones de `sweep`:
`--open-times 20000,40000`, `--tickets`, `--job-timeout-ms`, `--port`.

Colección: importarla en Postman con el backend corriendo (`--keep-backend` o
`npm start`). Por CLI, el delay entre requests hace falta para que el form
exista antes de consultarlo:

```bash
postman collection run "poc 2/postman/poc2-tickets.postman_collection.json" --delay-request 1000
```

Verificado: 12 requests, 23 aserciones, 0 fallos.

## Correr contra Camunda SaaS

1. Crear `backend/.env` (ignorado por git) con las credenciales del API Client:

```
ZEEBE_ADDRESS=<cluster-id>.<region>.zeebe.camunda.io:443
ZEEBE_CLIENT_ID=...
ZEEBE_CLIENT_SECRET=...
ZEEBE_AUTHORIZATION_SERVER_URL=https://login.cloud.camunda.io/oauth/token
ZEEBE_TOKEN_AUDIENCE=zeebe.camunda.io
ZEEBE_REST_ADDRESS=https://<region>.api.camunda.io/<cluster-id>/v2
```

2. Correr con `--target saas` (no levanta Docker; despliega los BPMN en el cluster):

```bash
node scripts/run-poc2.mjs --target saas --tickets 20 --done-after-ms 35000 --job-timeout-ms 10000
```

Los resultados se guardan como `results/run-saas-*.md`. Verificado: autenticación
y `GET /topology` contra un cluster 8.9.21 (los listeners `creating` requieren ≥ 8.8).
`GET /config` no expone las credenciales.
