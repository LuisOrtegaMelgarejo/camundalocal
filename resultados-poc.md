# POC SCOTIAFLOW-363 — Cómo identificar el proceso principal desde un worker

## Por qué hicimos esta POC

En ScotiaFlow los tickets disparan procesos en Camunda, y son esos procesos los que
nos llevan la gestión de estados. El problema práctico es este: cuando un worker
recibe una tarea, necesita saber a qué ticket pertenece. Si la tarea está en el
proceso principal, eso es fácil. Si está en un subproceso invocado por una Call
Activity, el worker ya no tiene el contexto del principal a mano.

Lo que queríamos averiguar era, entonces, cómo obtener el proceso principal
**indistintamente** de dónde esté la tarea: en el main o en un subproceso llamado
por Call Activity. Esa es la pregunta que esta POC vino a responder.

## Cómo lo probamos

Montamos dos procesos BPMN independientes. El principal (`main-process`) tiene una
User Task y después una Call Activity que invoca al segundo. El hijo
(`child-process`) tiene su propia User Task. Las User Tasks usan implementación
*job worker*, así que generan jobs del tipo `io.camunda.zeebe:userTask`, y un worker
en Node se suscribe a ese tipo, captura el payload completo de cada job y lo guarda
en `snapshots.jsonl`.

Las pruebas corrieron contra un Camunda 8.10.3 local en Docker (un solo contenedor
con Zeebe, Operate y Tasklist, H2 como almacenamiento). Antes se había probado
también contra el clúster de SaaS, con los mismos resultados.

## Los tres hallazgos

### 1. El proceso padre no llega al worker

Esto fue lo primero que confirmamos, y es el hallazgo que define todo lo demás. El
payload del job trae `processInstanceKey`, `processDefinitionKey`, `bpmnProcessId`,
`elementId` y las variables del proceso — pero **no trae ninguna referencia al
padre**. Cuando el worker atiende la tarea del subproceso, lo que ve es la instancia
hija y nada más.

Dos detalles que vale la pena anotar, porque nos costaron tiempo:

- La Call Activity **no genera ningún job**. Zeebe la gestiona internamente, así que
  no hay un punto donde el worker pueda "interceptar" la invocación y leer el
  contexto del padre.
- El key de la instancia tampoco se puede leer desde el modelo. Ni en una expresión
  FEEL, ni en un input mapping, ni en un Script Task: las expresiones solo ven
  variables del proceso, y el key de la instancia no es una variable.

Es decir: por el camino del modelo, no hay forma de que el padre viaje hacia abajo
por sí solo.

### 2. La API sí sabe quién es el padre

El vínculo padre–hijo existe, lo mantiene el engine, y se puede consultar. Con el
`processInstanceKey` del hijo que viene en el job, una llamada a
`GET /v2/process-instances/{key}` devuelve `parentProcessInstanceKey` y
`parentElementInstanceKey`.

Una precisión sobre esto, porque en las conversaciones quedó como "la API de
Operate": en los clústeres 8.8 y superiores el endpoint que usamos es el de la **API
REST v2 unificada del Orchestration Cluster**, no la API v1 de Operate. La de
Operate (donde el campo se llamaba `parentKey`) sería el camino solo en clústeres
anteriores a 8.8. En la implementación conviene tenerlo claro para no apuntar al
endpoint equivocado.

Lo verificamos de punta a punta. Una instancia del principal con key `...685398`
generó una instancia hija `...685409`, y el snapshot del job del hijo trajo
`parentProcessInstanceKey: 2251799813685398` — exactamente el key del padre, y
coincidiendo con lo que muestra Operate en su columna *Parent Process Instance Key*.

Como extra, encontramos que `GET /v2/process-instances/{key}/call-hierarchy`
devuelve la cadena completa padre→hijo en una sola llamada. Si alguna vez hiciera
falta resolver jerarquías de más de dos niveles, ese es el endpoint.

El costo de este camino es una llamada HTTP por cada job. Funciona, es el vínculo
nativo del engine y no obliga a tocar el modelo, pero es trabajo extra en cada
tarea.

### 3. Las variables del principal sí se pueden propagar, y de dos formas

Este es el hallazgo que nos dio la salida. Las variables del proceso principal
pueden bajar al subproceso, y hay dos maneras de hacerlo, con comportamientos
distintos:

| Forma | Cómo se configura | Qué ve el hijo | Modelo |
|---|---|---|---|
| **Propagación de entrada** | `propagateAllParentVariables="true"` en la Call Activity | Todas las variables del padre, con el mismo nombre | `proceso-principal.bpmn` |
| **Input mapping** | `propagateAllParentVariables="false"` más un input mapping `ticketNumber → ticket` | Solo lo mapeado, y con el nombre que uno elija | `proceso-principal-input-mapping.bpmn` |

Las dos quedaron probadas, y cada forma tiene su propio modelo en el repo para poder
compararlas. Arrancando ambos principales con las mismas variables
(`ticketNumber: "SCOTIAFLOW-363"` y `canal: "web"`), el job del hijo llegó así:

```
main-process                 ->  child-process  vars={"canal":"web","ticketNumber":"SCOTIAFLOW-363"}
main-process-input-mapping   ->  child-process  vars={"ticket":"SCOTIAFLOW-363"}
```

La diferencia práctica es que la primera es cómoda y la segunda es quirúrgica: pasa
solo lo que uno quiere y permite desacoplar los nombres entre el padre y el hijo.

## La solución que adoptamos

Nos quedamos con **propagar el ticket number al subproceso**.

La razón es que en el proceso de start ya existe una implementación que setea el
número de ticket como variable. Esa variable ya está ahí, ya es confiable, y es
justamente el dato que el worker necesita. Propagarla hacia el subproceso significa
que el worker la encuentra en el payload del job sin pedir nada a nadie.

Lo que nos convenció:

- **Cero llamadas extra.** El dato viaja en el propio job. No hay una consulta HTTP
  por tarea, que era el costo del camino de la API.
- **El worker no necesita saber dónde está.** Lee `ticketNumber` de las variables y
  ya. Le da igual si la tarea estaba en el principal o en un subproceso invocado por
  Call Activity — que era exactamente lo que la POC buscaba resolver.
- **No agrega piezas nuevas.** No hay que meter un Service Task, ni un listener, ni
  un script externo para calcular nada. Se apoya en lo que el proceso de start ya
  hace.

La consulta a la API queda como camino alternativo, no descartado. Sigue siendo útil
para auditar, para reconstruir jerarquías a posteriori o si alguna vez hiciera falta
el key real de la instancia padre y no el identificador de negocio.

## Cosas a tener en cuenta

- **El ticket number tiene que estar seteado antes de la Call Activity.** La
  propagación copia lo que exista en ese momento. Si la variable se setea después,
  no baja.
- **Si un subproceso se arranca por su cuenta**, sin pasar por el principal, no
  tendrá ticket number. El worker debería manejar ese caso en lugar de asumir que la
  variable siempre está.
- **Cuidado con los nombres al propagar todo.** Con `propagateAllParentVariables`
  baja todo el contexto del padre, y una variable del hijo que se llame igual queda
  pisada. Si eso llegara a ser un problema, el input mapping es la respuesta: pasa
  solo el ticket y con el nombre que convenga.
- **Las User Tasks con implementación *job worker* no aparecen en Tasklist.** Lo
  comprobamos: con el proceso corriendo y la tarea esperando, la API de Tasklist
  devuelve cero tareas. Solo las atiende un worker. Es un detalle de diseño a tener
  presente si en algún momento se quisiera que una persona tome esas tareas desde
  Tasklist.
- **Los keys son números enormes.** Siempre como string, nunca convertidos a número,
  porque se pierde precisión.
- El tipo `io.camunda.zeebe:userTask` es fijo. No se escribe en ningún campo del
  modelo; solo en el `taskType` del worker.

## Qué queda abierto

- Se comentó que la implementación *job worker* para User Tasks figura como obsoleta
  en 8.8 y superiores. El engine 8.10.3 no emitió ningún aviso al desplegar ni al
  ejecutar, así que no lo podemos confirmar ni descartar desde el runtime. Conviene
  revisarlo en la documentación antes de apoyarse en esa implementación a largo
  plazo.
- En SaaS quedó pendiente verificar si el token OAuth con audiencia
  `zeebe.camunda.io` sirve también para la API REST, y la URL que la consola muestra
  con un `/:443/` intercalado. Solo aplica si se vuelve al camino de consultar la
  API.

## Cómo reproducirlo

El entorno local se levanta con `docker compose up -d` desde la raíz del repo
(Operate en http://localhost:8080/operate, usuario `demo`/`demo`). Los BPMN se
despliegan con `POST /v2/deployments`, el hijo primero; después cualquiera de los
dos principales, según la forma de propagación que se quiera observar. El worker corre con
`CAMUNDA_TARGET=local npm start` desde `worker/`, y la misma variable en `saas`
apunta al clúster con OAuth. Cada job atendido deja su snapshot en
`worker/snapshots.jsonl`.
