# Resultado de corrida — 2026-10-19T13:50:09Z

## Parámetros

- Tickets por alternativa: 50
- Timeout del job (reenvío en A): 10.0 s
- El usuario marca done a los: 35.0 s

## Latencias (ms)

| Métrica | A. Job Worker p50 | B. User Task + listener p50 | A. Job Worker p95 | B. User Task + listener p95 | A. Job Worker máx | B. User Task + listener máx |
|---|---:|---:|---:|---:|---:|---:|
| Crear instancia (respuesta de la API) | 79 | 78 | 130 | 106 | 141 | 112 |
| Ticket creado → notificación recibida | 107 | 208 | 185 | 276 | 400 | 282 |
| Ticket creado → form listo | 136 | 232 | 213 | 301 | 431 | 310 |
| Procesar la primera notificación | 29 | 27 | 36 | 35 | 39 | 38 |
| Ack de la notificación (completar el job) | — | 41 | — | 114 | — | 134 |
| Done → la API responde | 43 | 73 | 131 | 136 | 167 | 195 |
| Done → el motor avanza | 147 | 290 | 357 | 374 | 391 | 380 |

## Volumetría

| | A. Job Worker | B. User Task + listener |
|---|---:|---:|
| Tickets / cerrados | 50 / 50 | 50 / 50 |
| Notificaciones recibidas | 200 | 50 |
| Notificaciones por ticket (prom. / máx.) | 4 / 4 | 1 / 1 |
| Duplicados descartados | 150 (75 %) | 0 (0 %) |
| Intervalo entre reenvíos (p50) | 10.8 s | — |
| Tiempo abierto del ticket (p50) | 35.1 s | 35.1 s |
| Entregas después del done | 0 | 0 |
