# Interpretación de resultados — POC 2

Datos: `backend/results/run-local-2026-10-19T20-52-06-701Z.md` (50 tickets por
alternativa, timeout de job 10 s, usuario tarda 35 s, Camunda 8.10.3 local, A como
user task job worker). La corrida anterior, con A como service task, está en
`run-local-A-service-task-2026-10-19T13-50-09Z.md`.

## Conclusión corta

**La alternativa B (User Task + listener `creating`) gana por volumen, no por
velocidad.** B entrega 1 notificación por ticket y permite confirmarla sin que el
BPMN avance. A obliga a mantener el job abierto, lo que genera reenvíos
permanentes y una tabla de "already processed". En tiempos de respuesta las dos
son equivalentes.

## 1. Volumetría: la diferencia que importa

| | A. User task job worker | B. User task + listener |
|---|---:|---:|
| Notificaciones por ticket | 4 | 1 |
| Duplicados | 75 % | 0 % |

- En A, cada ticket recibe `1 + ⌊tiempo_abierto / timeout⌋` mensajes. Los medidos
  (4 con 35 s abierto y 10 s de timeout) cuadran con la fórmula, y el intervalo
  entre reenvíos fue ~10.8 s, es decir el timeout más el ciclo de polling.
- El crecimiento es lineal en el tiempo que el ticket está abierto, no en el número
  de tickets. Con timeout de 5 min: 1 h abierto → 13 mensajes; 8 h → 97; 24 h → 289
  por ticket.
- En B el número de mensajes es constante, sin importar cuánto tarde el usuario.
- Ninguna alternativa entregó mensajes después del done.
- El resultado de volumetría se repitió idéntico en las dos corridas (200 vs 50).

**En la práctica:** en A los duplicados consumen CPU, conexiones y lecturas a la BD
por cada ticket abierto, y la corrección depende de que la marca "already
processed" no se pierda ni se lea con retraso. En B esa lógica deja de ser
necesaria para el caso normal.

## 2. Tiempos de respuesta: empate técnico

| Paso (p50) | A | B |
|---|---:|---:|
| Ticket → notificación | 113 ms | 96 ms |
| Ticket → form listo | 158 ms | 141 ms |
| Done → API responde | 65 ms | 50 ms |
| Done → el motor avanza | 201 ms | 192 ms |

- Las diferencias (10–20 ms) están dentro de la variación entre corridas (~±50 ms).
  No hay un ganador en latencia.
- **Corrección de una conclusión anterior:** la primera corrida, con A como service
  task, mostró a B ~100 ms más lenta. Al cambiar A a user task job worker esa
  diferencia desapareció. Era un efecto de comparar tipos de elemento distintos, no
  del listener. Por eso conviene comparar siempre con el BPMN que se usará de verdad.
- Procesar la notificación en el backend tarda lo mismo (~50 ms, el trabajo
  simulado del form). Crear la instancia cuesta 50–70 ms en ambas.
- El ack de B (completar el listener) cuesta 77 ms p50 / 124 ms p95. A no lo paga
  porque nunca completa el job, pero lo compensa con los duplicados.

**Cuidado con los percentiles altos:** con 50 muestras y todo en una máquina, el
p95 y el máximo pueden ser ruido. Sirven para comparar, no como capacidad ni SLA.

## 3. Riesgos y matices

- **Sin ids en la user task ni en el listener** (restricción de negocio), todo llega
  por el mismo tipo de job y la única correlación es la variable `ticketId`. En A,
  además, el tipo `io.camunda.zeebe:userTask` es común a todas las user tasks job
  worker del cluster: un cluster compartido haría que el worker de A reciba jobs
  ajenos. Se devuelven con `fail`, pero ocupan capacidad y retrasan a quien los
  espera. Conviene un cluster dedicado.
- **B pone el backend en el camino crítico de la creación de la tarea.** Hasta que
  el listener `creating` se completa, la user task no existe (no aparece en
  Tasklist). Si el backend está caído, la tarea se retrasa.
- **Ambas son at-least-once.** Si el backend se cae después de crear el form y antes
  de completar el listener, B también reenviará. `createFormOnce` debe seguir siendo
  idempotente en las dos; en B ocurre de forma excepcional y no por diseño.
- **A depende de una tabla propia** para descartar duplicados; B delega la garantía
  en el motor.
- **El cierre es distinto:** A completa un job por gRPC, B llama a REST
  `user-tasks/{key}/completion`. Con B se pueden usar asignación y Tasklist nativos.
- **Job worker user task está en desuso** en la documentación de Camunda a favor de
  la user task nativa; conviene confirmar su soporte en la versión objetivo.

## 4. Qué no cubre esta corrida

- Una sola máquina, 100 instancias por corrida, sin concurrencia alta ni varias
  réplicas del backend.
- Timeout de 10 s en vez del real. La forma de la curva (reenvíos lineales) es la
  misma, pero conviene repetir con el valor de producción y tickets más largos.
- No se midió la caída del backend (qué pasa con A y B cuando no responde).
- Solo Camunda local (H2, un contenedor). SaaS está cableado pero sin medir.

## Recomendación

Adoptar **B** si el requisito es "notificar una vez y esperar al usuario": no
cuesta tiempo de respuesta y elimina la lógica de duplicados y la carga que crece
con el tiempo abierto de los tickets. Antes de cerrar la decisión, repetir con el
timeout real y probar con el backend caído para dimensionar el riesgo del primer
punto de la sección 3.
