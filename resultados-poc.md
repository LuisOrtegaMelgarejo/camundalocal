# POC SCOTIAFLOW-363 — Identificar el proceso principal desde un worker

## Objetivo

En ScotiaFlow los tickets disparan procesos en Camunda. Cuando un worker recibe una
tarea necesita saber a qué ticket pertenece. En el proceso principal es fácil, pero
si la tarea está en un subproceso invocado por Call Activity, el worker no tiene el
contexto del principal. La POC buscaba cómo resolverlo sin importar dónde esté la
tarea.

## Cómo lo probamos

Dos BPMN: `main-process` (User Task + Call Activity) y `child-process` (otra User
Task). Las User Tasks usan implementación *job worker*, así que generan jobs
`io.camunda.zeebe:userTask`. Un worker en Node los toma y guarda el payload completo
en `snapshots.jsonl`.

Corrió contra Camunda 8.10.3 local en Docker (Zeebe, Operate y Tasklist en un solo
contenedor). Antes se había probado en SaaS con los mismos resultados.

## Hallazgos

### 1. El job no trae al padre

El payload incluye `processInstanceKey`, `processDefinitionKey`, `bpmnProcessId`,
`elementId` y las variables, pero ninguna referencia al padre. Además:

- La Call Activity no genera job, así que el worker no puede interceptarla.
- El key de la instancia no se puede leer desde el modelo (ni FEEL, ni input mapping,
  ni Script Task): no es una variable.

### 2. La API sí conoce al padre

`GET /v2/process-instances/{key}` con el key del hijo devuelve
`parentProcessInstanceKey` y `parentElementInstanceKey`. Ojo: en 8.8+ es la API REST
v2 del Orchestration Cluster, no la API v1 de Operate (donde el campo era
`parentKey`). Lo verificamos: el hijo `...685409` devolvió como padre
`2251799813685398`, igual a lo que muestra Operate.

También existe `GET /v2/process-instances/{key}/call-hierarchy` para jerarquías de
más de dos niveles. El costo de este camino es una llamada HTTP por job.

### 3. Las variables del padre sí se pueden bajar

Hay dos formas, ambas probadas, cada una con su BPMN:

| Forma | Configuración | El hijo ve | Modelo |
|---|---|---|---|
| Propagación total | `propagateAllParentVariables="true"` | Todas las variables del padre | `proceso-principal.bpmn` |
| Input mapping | `propagateAllParentVariables="false"` + `ticketNumber → ticket` | Solo lo mapeado | `proceso-principal-input-mapping.bpmn` |

Arrancando ambos con `ticketNumber: "SCOTIAFLOW-363"` y `canal: "web"`:

```
main-process                 ->  child-process  vars={"canal":"web","ticketNumber":"SCOTIAFLOW-363"}
main-process-input-mapping   ->  child-process  vars={"ticket":"SCOTIAFLOW-363"}
```

## Decisión: input mapping

Pasamos el número de ticket al subproceso con **input mapping en la Call Activity**
(`propagateAllParentVariables="false"`). Descartamos la propagación total y dejamos
la API como alternativa.

El proceso de start ya setea el ticket number como variable, así que solo hay que
hacerlo llegar al hijo. Elegimos input mapping porque:

- El hijo recibe solo lo que necesita (con propagación total también recibía
  `canal`).
- El padre no puede pisar variables del hijo.
- Se ve en la Call Activity qué recibe el subproceso.

Y frente a la API: cero llamadas extra, el worker lee la variable del payload sin
importar dónde esté la tarea, y no hace falta agregar Service Tasks ni listeners.

La API queda para auditar, reconstruir jerarquías o si hiciera falta el key real del
padre.

## A tener en cuenta

- El ticket number debe estar seteado antes de la Call Activity; si se setea después,
  no baja.
- El renombre es opcional. Usamos `ticketNumber → ticket` solo para probar que se
  puede; `ticketNumber → ticketNumber` funcionaría igual y los workers leerían
  siempre la misma variable. Si se deja el renombre, documentarlo.
- Con `propagateAllParentVariables="false"` el hijo no hereda nada más: si necesita
  otro dato del padre, hay que mapearlo.
- Un subproceso arrancado por su cuenta no tendrá ticket; el worker debe contemplarlo.
- Las User Tasks con implementación *job worker* no aparecen en Tasklist (la API
  devuelve cero tareas). Solo las atiende un worker.
- Los keys son números enormes: siempre como string.
- El tipo `io.camunda.zeebe:userTask` es fijo; solo va en el `taskType` del worker.

## Pendiente

- Se comentó que la implementación *job worker* para User Tasks es obsoleta desde
  8.8. El engine 8.10.3 no avisó nada, así que hay que revisarlo en la documentación
  antes de depender de ella a largo plazo.
