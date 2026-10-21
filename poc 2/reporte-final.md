# Conclusión Técnica: Evaluación de Alternativas para Tareas de Usuario en Camunda 8Tras la evaluación realizada en esta Prueba de Concepto (PoC) sobre la interceptación del ciclo de vida en la creación de User Tasks, se compararon dos alternativas de implementación en Node.js:1. **Primera alternativa (Job Worker en la User Task):** Consiste en tratar la User Task como un Service Task tradicional, procesando el evento directamente desde un worker acoplado al flujo.2. **Segunda alternativa (Task Listener en evento creating):** Consiste en utilizar un canal de eventos específico mediante un Task Listener dedicado que reacciona de manera limpia e inmediata al ciclo de vida del nodo.---# Entorno de PruebasSe diseñó un modelo de proceso compuesto por un nodo de inicio (Start Event), un nodo de tipo User Task y un nodo de cierre (End Event).En el evento de inicio se configuró un Execution Listener para registrar la fecha y hora iniciales, mientras que en la User Task se alternó la ejecución entre un Job Worker y un Task Listener para comparar su impacto en el motor.## Comportamiento Observado con Job Worker
**Latencia en el ciclo de vida:** El worker intercepta y retiene la ejecución del nodo. Mientras no responda confirmando el trabajo, el motor Zeebe asume que la tarea sigue procesándose activamente dentro del worker.
**Mapeo incorrecto de estados:** Un Job Worker en Zeebe está concebido para tareas automáticas de corta duración (Service Tasks). Por el contrario, una User Task está diseñada para permanecer en espera pasiva durante minutos, horas o días hasta que un operador complete un formulario.
**Saturación por reintentos y timeouts:** Si el worker intenta mantener la tarea en espera omitiendo la respuesta o ejecutando job.forward(), el tiempo de bloqueo (lock duration) vence en Zeebe. El clúster asume un fallo de conectividad y reintenta el envío en bucle, lo que genera incidentes en Camunda Operate, duplica llamadas y satura la cola de mensajes innecesariamente.
## Comportamiento Observado con Listener Worker (Task Listener)
**Ejecución casi instantánea:** Su única responsabilidad es notificar a la aplicación que la User Task ha sido instanciada.
**Respuesta inmediata (job.complete()):** El worker recibe el evento, ejecuta la lógica ligera (como calcular el timestamp o crear un registro de auditoría en la base de datos) y responde de inmediato con job.complete().
**Cero reintentos e interrupciones:** Al confirmar el evento en milisegundos, el listener finaliza su tarea de forma limpia. La User Task queda activa normalmente en el motor, esperando de forma pasiva a que el usuario interactúe con el formulario en Tasklist o en la interfaz propia, sin generar reintentos ni bloqueos.
---## Análisis Diferencial de la Confirmación (job.complete())En ambas alternativas, si el worker responde inmediatamente confirmando el evento, la ejecución no se bloquea ni genera flujos de reintentos en Zeebe. Sin embargo, la diferencia técnica fundamental reside en el propósito y efecto de dicha confirmación:
**En un Task Listener:** Confirmar el trabajo (job.complete()) solo notifica a Camunda que el evento del ciclo de vida (como creating) se procesó correctamente. No es necesario mantener el listener abierto para preservar la User Task. Al responder de inmediato, la tarea se habilita en el motor y el flujo continúa de manera natural, quedando a la espera de que el usuario final interactúe con el formulario.
**En un Job Worker:** Para evitar que el proceso avance prematuramente al siguiente nodo, el worker debe omitir la confirmación, recurriendo a mecanismos técnicos para forzar que la tarea siga abierta. Esto desencadena la expiración del tiempo de bloqueo (lock duration), acumulando latencia e incrementando los incidentes en el clúster.
---## Por qué Implementar un Task Listener es Superior a un Job Worker
**Rendimiento y latencia mínima:** El uso de Task Listeners no bloquea la ejecución del motor Zeebe ni genera saturación en la cola gRPC. La latencia observada entre la creación del evento en el clúster y la recepción en el worker es prácticamente instantánea.
**Gestión limpia de estado:** Al confirmar la notificación inmediatamente con job.complete(), el listener finaliza de forma limpia sin intervenir en la disponibilidad de la User Task para los usuarios finales.
**Eliminación de reintentos e incidentes:** La alternativa basada en Job Worker requiere forzar comportamientos para mantener la tarea abierta (como el uso de expiración de lock duration o timeouts). Esto satura el clúster con reintentos automáticos innecesarios y genera incidentes en Operate. El Task Listener elimina este problema por completo.
**Obtención precisa de metadatos:** Permite calcular el timestamp real de creación de la tarea en el clúster decodificando el job.key (identificador Snowflake) mediante operaciones de BigInt, sin necesidad de consumir APIs adicionales ni propiedades inexistentes en el SDK.
---## Estrategia Propuesta de Resolución y Ciclo de Vida Completo de la User TaskPara implementar una arquitectura escalable, limpia y libre de bloqueos en Camunda 8, el patrón de diseño para la resolución de **User Tasks** se debe estructurar bajo dos modalidades principales, según el origen de la interacción:### 1. Interacción Manual (Formulario de Usuario)1. **Creación:** El motor Zeebe instancia la User Task y emite el evento creating.2. **Notificación:** Un **Task Listener** recibe el evento, registra la auditoría/metadatos necesarios y responde de inmediato con job.complete().3. **Espera Pasiva:** La User Task queda abierta de manera pasiva en el clúster, visible en Camunda Tasklist o en el Portal/App propia.4. **Finalización:** El usuario final completa los campos del formulario y presiona "Enviar". La interfaz envía la instrucción de cierre al motor, haciendo avanzar la instancia de proceso al siguiente nodo.### 2. Interacción Programática (Automatización vía API REST)Si la User Task debe resolverse de forma automática o mediante una acción ejecutada por un sistema o backend externo (sin intervención humana directa en un formulario):1. **Creación y Registro:** El **Task Listener** notifica la creación de la tarea (creating), responde con job.complete() para mantener el flujo sano y persiste el userTaskKey en la base de datos o sistema externo.2. **Procesamiento Backend:** El servicio externo realiza sus validaciones o integraciones de negocio de forma asíncrona.3. **Cierre por API:** El backend invoca el endpoint oficial de la API REST de Camunda 8 para completar la tarea:   * **Endpoint:** POST /v2/user-tasks/{userTaskKey}/completion   * **Payload:** Variables requeridas para continuar el proceso.4. **Avance del Proceso:** Zeebe valida la llamada, marca la User Task como completada y avanza automáticamente al siguiente paso del workflow.---## Recomendación FinalLa arquitectura basada en **Task Listeners** es el patrón estándar, óptimo y más performante para la auditoría y control del ciclo de vida de **User Tasks** en Camunda 8. Se recomienda **desestimar el uso de Job Workers dentro de User Tasks**, reservando los Job Workers únicamente para tareas automatizadas de tipo **Service Task**. Con este diseño se garantiza compatibilidad total tanto para la resolución manual mediante formularios como para la resolución programática mediante APIs REST.Este cambio de arquitectura en la implementación de las User Tasks resuelve definitivamente los problemas de latencia y reintentos en bucle. Asimismo, elimina la complejidad técnica de diferenciar en observabilidad si un evento responde a un error real de ejecución o simplemente a un reintento del motor por expiración de tiempo.

---

# Sección de métricas — Comparativa de tiempos y crecimiento lineal

Este documento reúne solo números: cuánto tarda cada alternativa en responder y cuántos
mensajes genera, y cómo crecen esas cifras cuando sube el tiempo que el usuario tarda en
atender su ticket o cuando sube la cantidad de tickets. Las conclusiones y recomendaciones
están en `interpretacion-resultados.md`.

La **alternativa A** es la user task con implementación job worker (`pocJobWorker`): el job
se queda abierto y Zeebe lo vuelve a enviar cada vez que vence su timeout. La
**alternativa B** es la user task nativa con listener `creating` (`pocListener`): el
listener se completa de inmediato y no hay nada pendiente que reenviar.

## 1. Cómo se midió

Se corrieron tres tipos de prueba, y conviene no mezclar sus cifras porque cada una pasó en
un entorno distinto.

| Prueba | Entorno | Tickets por alternativa | Qué se variaba |
|---|---|---:|---|
| Barrido por tiempo de atención | Camunda SaaS (cluster jfk-1, v8.9.21) | 10 | Tiempo que tarda el usuario: 20, 40 y 80 s |
| Barrido por volumen | Camunda SaaS | 10, 30 y 60 | Cantidad de tickets, en ráfaga de 20 creaciones en paralelo |
| Cola saturada | Camunda local (8.10.3, un contenedor de 1 GB) | 100 | Ráfaga de 25 en paralelo, worker limitado a 4 jobs a la vez y 50 ms de costo por cada descarte |

En todas el timeout del job fue de 10 s, que es el intervalo con el que Zeebe reenvía a la
alternativa A. Las latencias son percentiles 50 y 95 en milisegundos, medidos desde el
reloj del backend. En SaaS el cierre del proceso se detecta consultando la instancia por
REST, así que ese tiempo incluye el retraso propio del almacenamiento secundario y no es
puro tiempo del motor.

## 2. Comparativa de tiempos

### 2.1 Sin carga, en local (50 tickets por alternativa, usuario tarda 35 s)

| Paso | A, p50 / p95 | B, p50 / p95 |
|---|---:|---:|
| Crear la instancia | 72 / 112 | 49 / 102 |
| Ticket creado → notificación recibida | 113 / 225 | 96 / 142 |
| Ticket creado → formulario listo | 158 / 262 | 141 / 186 |
| Done → la API responde | 65 / 133 | 50 / 94 |
| Done → el motor avanza | 201 / 373 | 192 / 382 |

Sin carga las dos alternativas responden igual, con diferencias de unos 10 a 20 ms que
caen dentro de la variación normal entre corridas.

### 2.2 En SaaS según cuánto tarda el usuario (10 tickets por alternativa)

| Tiempo de atención | Ticket → notificación A | B | Ticket → form listo A | B | Done → API A | B | Done → cierre A | B |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 20 s | 632 | 891 | 668 | 942 | 218 | 242 | 2151 | 2506 |
| 40 s | 568 | 841 | 615 | 884 | 218 | 243 | 2461 | 2528 |
| 80 s | 630 | 843 | 671 | 893 | 214 | 237 | 2473 | 2548 |

(Todos en p50, milisegundos.) Los tiempos de respuesta no se mueven aunque el usuario tarde
cuatro veces más: lo que cambia con el tiempo de atención es la cantidad de mensajes, no su
latencia. En SaaS la alternativa B tarda entre 210 y 270 ms más en entregar la primera
notificación que la A; en local esa diferencia no aparecía.

### 2.3 En SaaS según el volumen de tickets (ráfaga, usuario tarda 40 s)

| Tickets por alternativa | Ticket → notificación A, p50 / p95 | B, p50 / p95 | Ticket → form listo A, p50 | B, p50 | Done → cierre A, p50 | B, p50 |
|---:|---:|---:|---:|---:|---:|---:|
| 10 | 1569 / 1692 | 2151 / 2263 | 1678 | 2319 | 2130 | 2507 |
| 30 | 1663 / 2628 | 3090 / 3808 | 1800 | 3233 | 2491 | 2530 |
| 60 | 3296 / 5372 | 5105 / 6646 | 3629 | 5352 | 2724 | 2533 |

Aquí sí hay un efecto del volumen: cuando entran muchas creaciones a la vez, la primera
notificación tarda más en llegar, y en la alternativa B se nota más. El tiempo de cierre, en
cambio, casi no cambia con el volumen.

### 2.4 Cola saturada, en local (100 tickets por alternativa)

Aquí el worker solo podía atender 4 jobs a la vez y cada descarte de A costaba 50 ms.

| Medida | A | B |
|---|---:|---:|
| Ticket → notificación, p50 / p95 | 37 133 / 55 273 | 31 665 / 40 941 |
| Ticket → form listo, p50 / p95 | 37 338 / 55 373 | 31 794 / 40 996 |
| Crear la instancia, p50 / p95 | 908 / 5 223 | 1 055 / 6 223 |
| Done → la API responde, p50 / p95 | 475 / 968 | 577 / 2 333 |
| Done → el motor avanza, p50 / p95 | 1 725 / 7 658 | 5 439 / 8 083 |
| Cola máxima (tickets creados sin notificar) | 100 | 88 |
| Notificaciones por segundo, promedio / pico | 1,78 / 12 | 1,63 / 8 |
| Reintentos por contrapresión del motor | 0 | 104 |
| Notificaciones por ticket | 1,24 | 1,00 |

Con 200 instancias creadas casi a la vez, el motor local tardó cerca de 20 segundos en
empezar a entregar jobs: en los primeros 20 s de la corrida no llegó ninguna notificación a
ninguna de las dos alternativas. A partir de ahí, el reparto fue lento para ambas
(menos de 2 notificaciones por segundo en promedio) y la espera de los tickets creados al
inicio superó los 30 segundos.

## 3. Volumetría y crecimiento lineal

### 3.1 Según el tiempo de atención del usuario

Con 10 tickets en SaaS y un timeout de 10 s:

| Tiempo de atención | Mensajes por ticket A | B | Duplicados A | Intervalo entre reenvíos A |
|---:|---:|---:|---:|---:|
| 20 s | 2 | 1 | 50 % | ≈ 10,7 s |
| 40 s | 4 | 1 | 75 % | ≈ 10,7 s |
| 80 s | 8 | 1 | 87,5 % | ≈ 10,7 s |

La alternativa A crece en línea recta con el tiempo que el ticket permanece abierto. Cada vez
que el usuario tarda el doble, la cantidad de mensajes también se duplica: de 20 a 40 s se
suman 2 mensajes y de 40 a 80 s se suman 4, lo que da una pendiente constante de **0,1
mensajes por segundo de ticket abierto**, es decir, un mensaje nuevo cada 10 segundos, justo
el timeout configurado más unos 700 ms de ciclo de consulta del worker. La alternativa B no
se mueve de 1 sin importar cuánto tarde el usuario.

La regla que describe lo medido es que, tras la primera entrega, A recibe un mensaje más
cada `timeout + 0,7 s`. Con el timeout de 10 s de esta prueba eso da 2, 4 y 8 mensajes a los
20, 40 y 80 s. Trasladada a un timeout de 5 minutos, que se toma aquí solo como ejemplo (el valor real
de producción no se midió en esta POC), la misma regla da aproximadamente esto:

| Tiempo que el ticket queda abierto | Mensajes por ticket A (timeout 5 min) | B |
|---:|---:|---:|
| 1 hora | ≈ 12 | 1 |
| 8 horas | ≈ 96 | 1 |
| 24 horas | ≈ 288 | 1 |

Esta tabla es una proyección con la regla anterior, no una medición: nadie dejó tickets
abiertos tanto tiempo.

### 3.2 Según el volumen de tickets

Con el usuario tardando 40 s y el timeout en 10 s:

| Tickets por alternativa | Mensajes totales A | Mensajes totales B | Relación A / B |
|---:|---:|---:|---:|
| 10 | 40 | 10 | 4,0 |
| 30 | 120 | 30 | 4,0 |
| 60 | 240 | 60 | 4,0 |

Los mensajes totales crecen en proporción exacta al número de tickets en ambas alternativas.
Lo que distingue a A es el factor: 4 mensajes por ticket con este tiempo de atención, contra
1 en B. Juntando las dos dimensiones, el total de A se puede escribir como

> mensajes de A ≈ tickets × (1 + ⌊tiempo abierto ÷ (timeout + 0,7 s)⌋)

mientras que el de B es simplemente igual al número de tickets. Dicho de otra forma, el
volumen que genera A depende del producto entre cuántos tickets hay abiertos y cuánto
tiempo permanece abierto cada uno, y el de B solo de cuántos tickets se crean.

El mismo razonamiento aplicado a la carga sostenida da una tasa estable: si hay *K* tickets
abiertos a la vez, A recibe alrededor de *K ÷ 10,7* mensajes por segundo solo en
reenvíos, es decir, unos 5,6 por segundo con 60 tickets abiertos y un timeout de 10 s.

### 3.3 Qué crece con el volumen y qué no

Lo que se midió en SaaS al subir de 10 a 60 tickets por alternativa:

| Medida (p50) | 10 tickets | 30 tickets | 60 tickets | Cómo crece |
|---|---:|---:|---:|---|
| Notificación A | 1569 ms | 1663 ms | 3296 ms | Casi plana hasta 30, luego se duplica |
| Notificación B | 2151 ms | 3090 ms | 5105 ms | Sube en cada escalón, cada vez más |
| Cierre A | 2130 ms | 2491 ms | 2724 ms | Casi plana |
| Cierre B | 2507 ms | 2530 ms | 2533 ms | Plana |

Los mensajes crecen de forma lineal con el volumen, pero la latencia de la primera
notificación no lo hace con una recta limpia. En A se mantiene estable hasta 30 tickets y
da un salto al llegar a 60, lo que apunta a un punto de saturación entre esos dos valores.
En B sube en cada escalón y el último tramo es más pronunciado que el primero. Con solo tres
puntos por alternativa no se puede afirmar una pendiente exacta; sí se puede decir que, en
esta prueba, B sufrió más que A con las ráfagas.

La utilización del worker fue muy baja en todas las pruebas de SaaS: entre 0,1 % y 1 %
porque cada notificación se procesa en unos 50 ms y llegan pocas por segundo. El cuello de
botella no está en el código del backend, sino en lo rápido que el motor entrega los jobs.
En la prueba local con la capacidad limitada a 4 jobs, la utilización declarada fue de 5 %
y aun así la cola llegó a 100 tickets: el límite también era el ritmo de entrega del motor,
no el trabajo de los handlers.

## 4. Datos de origen

Todos los archivos están en `backend/results/`:

- `sweep-saas-tiempo-2026-10-21T15-11-36-533Z.md`: barrido por tiempo de atención.
- `sweep-saas-volumen-2026-10-21T15-18-49-154Z.md`: barrido por volumen.
- `run-local-2026-10-21T15-21-26-898Z.md`: cola saturada, con línea de tiempo por tramos.
- `run-local-2026-10-19T20-52-06-701Z.md`: referencia local sin carga.

Una limitación que afecta a todas las cifras de SaaS: son muestras pequeñas, de 10 a 60
tickets, y se tomaron en un cluster compartido con otros procesos, así que la variación entre
corridas puede ser de varios cientos de milisegundos.
