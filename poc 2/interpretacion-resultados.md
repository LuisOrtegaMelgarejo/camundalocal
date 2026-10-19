# Interpretación de resultados — POC 2

Datos: `backend/results/run-2026-10-19T13-50-09-252Z.md` (50 tickets por
alternativa, timeout de job 10 s, usuario tarda 35 s, Camunda 8.10.3 local).

## Conclusión corta

**La alternativa B (User Task + listener `creating`) resuelve el problema de
fondo; la A solo lo esquiva.** B entrega 1 notificación por ticket y permite
confirmarla sin que el BPMN avance. A obliga a mantener el job abierto, lo que
genera reenvíos permanentes y una tabla de "already processed". A cambio, B es
unos 100–140 ms más lenta en cada paso, diferencia irrelevante para un flujo
donde un humano tarda minutos u horas.

## 1. Volumetría: la diferencia que importa

| | A. Job Worker | B. User Task |
|---|---:|---:|
| Notificaciones por ticket | 4 | 1 |
| Duplicados | 75 % | 0 % |

- En A, cada ticket recibe `1 + ⌊tiempo_abierto / timeout⌋` mensajes. Los
  medidos (4 con 35 s abierto y 10 s de timeout) cuadran con la fórmula y el
  intervalo entre reenvíos fue ~10.8 s, es decir el timeout más el ciclo de
  polling del worker.
- El crecimiento es lineal en el tiempo que el ticket está abierto, no en el
  número de tickets. Con el timeout de producción (n minutos) y tickets que
  viven horas, la carga de duplicados la dicta el usuario final. Ejemplo con
  timeout de 5 min: 1 h abierto → 13 mensajes; 8 h → 97; 24 h → 289 por ticket.
- En B el número de mensajes es constante. No depende de cuánto tarde el
  usuario ni del timeout.
- Ninguna de las dos alternativas entregó mensajes después del done, así que el
  cierre es limpio en ambas.

**Qué significa en la práctica:** en A los duplicados consumen CPU, conexiones
y lecturas a la BD en el backend por cada ticket abierto, y la corrección
depende de que la marca "already processed" no se pierda ni se lea con retraso.
En B esa lógica deja de ser necesaria para el caso normal.

## 2. Tiempos de respuesta: A gana por poco

| Paso (p50) | A | B | Diferencia |
|---|---:|---:|---:|
| Ticket → notificación | 107 ms | 208 ms | +101 ms |
| Ticket → form listo | 136 ms | 232 ms | +96 ms |
| Done → API responde | 43 ms | 73 ms | +30 ms |
| Done → el motor avanza | 147 ms | 290 ms | +143 ms |

- Crear la instancia cuesta lo mismo en ambas (~78 ms): es el mismo comando.
- El form está listo en ~0.1–0.2 s con cualquiera; para el usuario es inmediato.
- Procesar la notificación en el backend tarda lo mismo (~28 ms, es el trabajo
  simulado del form). La diferencia está en el motor, no en nuestro código.
- Hipótesis de por qué B es más lenta (no medida directamente): el listener
  añade un viaje extra dentro del motor (se crea la tarea → se emite el job del
  listener → se completa → recién entonces la tarea queda disponible), y el
  completion de la tarea pasa por la API REST en lugar de gRPC.
- El ack de B (completar el listener) cuesta 41 ms p50 / 114 ms p95. Es un
  costo que A no paga porque nunca completa el job, pero que A compensa con los
  duplicados.

**Cuidado con los p95/máx:** con 50 muestras y todo en una máquina, los valores
altos (p. ej. 400 ms máx en A) pueden ser ruido de arranque o del propio
equipo. Son comparables entre sí, pero no sirven como capacidad ni como SLA.

## 3. Riesgos y matices

- **B pone el backend en el camino crítico de la creación de la tarea.** Hasta
  que el listener `creating` se completa, la user task no existe (no aparece en
  Tasklist). Si el backend está caído, el job se reintenta por timeout y la
  tarea se retrasa. En A la tarea espera igual, pero no hay una "tarea visible"
  que se esté ocultando.
- **Ambas son at-least-once.** Si el backend se cae después de crear el form y
  antes de completar el listener, B también reenviará. `createFormOnce` debe
  seguir siendo idempotente en las dos, solo que en B ocurre de forma
  excepcional y no por diseño.
- **A depende de una tabla propia** para descartar duplicados; B delega la
  garantía en el motor.
- **El cierre es distinto:** A completa un job por gRPC, B llama a REST
  `user-tasks/{key}/completion`. En B además se pueden usar asignación y
  Tasklist nativos; en A habría que construirlos.

## 4. Qué no cubre esta corrida

- Una sola máquina, una sola corrida, 100 instancias en total. No hay prueba de
  concurrencia alta ni de varias réplicas del backend.
- Timeout de 10 s en vez del real. La forma de la curva (reenvíos lineales) es
  la misma, pero conviene repetir con el valor de producción y tickets más
  largos antes de decidir.
- No se midió la caída del backend (qué pasa con A y B cuando no responde).
- Solo Camunda local (H2, un contenedor), no SaaS.

## Recomendación

Adoptar **B** si el requisito es "notificar una vez y esperar al usuario". El
sobrecosto de ~0.1 s por paso no compensa mantener la lógica de duplicados de A
ni la carga que crece con el tiempo abierto de los tickets. Antes de cerrar la
decisión, repetir el benchmark con el timeout real y añadir una prueba con el
backend caído para dimensionar el riesgo del primer punto de la sección 3.
