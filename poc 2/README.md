# POC 2 — Job Worker vs. User Task nativo (tiempos y volumetría)

Contrasta dos formas de enterarse de que un Ticket ya tiene su user task
esperando al usuario, para crear el formulario en el backend:

| | A. Job Worker | B. User Task + task listener `creating` |
|---|---|---|
| BPMN | `bpms/ticket-jobworker.bpmn` (service task `ticket-form`) | `bpms/ticket-usertask.bpmn` (`zeebe:userTask` + listener `creating` → job `ticket-created`) |
| Notificación | job `ticket-form` | job `ticket-created` (evento *created* del user task) |
| "Marcar como conocida" | **No se puede** sin completar el job, y completarlo avanza el BPMN. Solo `forward()` + tabla "already processed" | `job.complete()` del listener: el BPMN **no** avanza, queda parado en la user task |
| Reenvíos | Zeebe reentrega el job cada `timeout` hasta que se complete | Ninguno |
| Cierre ("done") | `completeJob(jobKey)` | `POST /v2/user-tasks/{key}/completion` |

El backend (Node, emula al Java) guarda el Ticket en SQLite (`node:sqlite`),
crea la instancia por gRPC, recibe las notificaciones, crea el form y registra
cada hito en una tabla `events` de la que sale todo el reporte. Ambas
alternativas terminan en un service task `ticket-closed` que marca cuándo avanzó
el motor tras el done (sin depender del secondary storage).

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

## Resultados (corrida del 2026-10-19)

Camunda 8.10.3 local (1 contenedor, H2), backend y workers en la misma máquina,
50 tickets por alternativa, timeout de job 10 s, usuario tarda 35 s.
Latencias en ms, p50 / p95.

| Métrica | A. Job Worker | B. User Task |
|---|---|---|
| Crear instancia (API) | 79 / 130 | 78 / 106 |
| Ticket creado → notificación recibida | 107 / 185 | 208 / 276 |
| Ticket creado → form listo | 136 / 213 | 232 / 301 |
| Procesar la notificación | 29 / 36 | 27 / 35 |
| Ack de la notificación | n/a (no se completa) | 41 / 114 |
| Done → API responde | 43 / 131 | 73 / 136 |
| Done → el motor avanza | 147 / 357 | 290 / 374 |

| Volumetría (50 tickets) | A. Job Worker | B. User Task |
|---|---|---|
| Notificaciones recibidas | 200 (4 por ticket) | 50 (1 por ticket) |
| Duplicados descartados | 150 (75 %) | 0 |
| Intervalo de reenvío | p50 10.8 s (≈ timeout) | — |
| Entregas después del done | 0 | 0 |

**Lectura.**

- **Volumen**: en A cada ticket abierto genera `1 + ⌊tiempo_abierto / timeout⌋`
  mensajes, y todos salvo el primero son ruido que el backend debe filtrar.
  Con un timeout de 5 min y tickets abiertos 1 h son 13 mensajes por ticket; con
  8 h, 97. En B es siempre 1, sin importar cuánto tarde el usuario.
- **Latencia**: A llega más rápido (~100 ms menos) y B cuesta ~100 ms extra por
  la ruta de la user task nativa y por completar el listener. Es una diferencia
  de décimas de segundo; frente al tiempo humano que espera el ticket no pesa.
- **Done**: en B es una llamada REST (`user-tasks/{key}/completion`) y el motor
  avanza ~140 ms más tarde que en A (`completeJob` por gRPC). Mismo orden de magnitud.

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
- Solo se probó contra Camunda local. SaaS no está cableado en esta POC.
