# Continuar en Claude Code — POC Camunda (SCOTIAFLOW-363)

Este archivo es el traspaso de la conversación de chat a Claude Code. Léelo
completo antes de tocar nada. Si algo aquí contradice a `CLAUDE.md`, **manda este
archivo**: `CLAUDE.md` se escribió antes de decidir correr Camunda en local y
sigue hablando solo de SaaS. La primera tarea es reconciliarlos (ver "Tareas").

## Objetivo del ticket

[POC] Validar tareas de usuario para los Call Activity. Probar en Camunda que:

- Hay dos procesos BPMN independientes: el principal invoca al segundo mediante
  una **Call Activity**.
- Ambos tienen al menos una **User Task**.
- Un **Job Worker** escucha jobs de tipo `io.camunda.zeebe:userTask`, captura una
  instantánea del payload (consola y/o archivo) y permite **asociar la instancia
  hija con la padre**.
- Se documentan resultados, limitaciones y conclusiones.

Prioridad Medium, Fix Version Release 16.

## Estado actual

Hecho, pero **nada de esto se ha probado contra un clúster real**:

- `proceso-principal.bpmn` (`main-process`): Inicio → User Task → Call Activity
  (`calledElement` = `child-process`, propagate all parent variables = On) → Fin.
  Sin input mappings.
- `proceso-hijo.bpmn` (`child-process`): Inicio → User Task → Fin.
- Las User Tasks usan implementación **job worker** (sin la extensión
  `zeebe:userTask`), por eso generan jobs `io.camunda.zeebe:userTask`.
- `worker.js`: conecta por gRPC con el SDK `@camunda8/sdk` y OAuth (pensado para
  SaaS). Por cada job de User Task consulta `GET /process-instances/{key}` de la
  API REST v2 para leer `parentProcessInstanceKey` y `parentElementInstanceKey`,
  guarda el snapshot en `snapshots.jsonl` y completa el job.
- `start-instance.js`: crea una instancia de `main-process` y le escribe su
  propio key con `setVariables`. Es una **alternativa**, no el camino elegido.
- `docker-compose.yml`: Camunda 8.10 local (ver abajo). Validado con
  `docker compose config`, **no levantado**.

El BPMN en Camunda SaaS pudo haberse modificado a mano en Web Modeler durante las
pruebas (se quitó y se añadió la User Task del principal, y hubo un input mapping
`instace` que debía borrarse). Los archivos `.bpmn` de este repo son la versión
buena; no los compares contra lo que haya en SaaS.

## Decisiones tomadas (y por qué)

1. **La Call Activity no genera job.** Zeebe la gestiona internamente. El worker
   solo ve los jobs de las User Tasks.
2. **El payload del job no trae el padre.** Trae `processInstanceKey`,
   `processDefinitionKey`, `bpmnProcessId`, `elementId` y las variables.
3. **El key de la instancia no se puede leer en FEEL ni en un input mapping.**
   Las expresiones solo ven variables del proceso. Está confirmado solo por
   respuestas del foro de Camunda (existe una solicitud abierta para añadirlo),
   no por una página de la documentación oficial. Un Script Task con FEEL
   tampoco puede.
4. **Camino elegido: consultar la API** desde el worker con el
   `job.processInstanceKey` del hijo. Es el vínculo nativo del engine y no
   exige tocar el modelo. Costo: una llamada HTTP por job.
5. Alternativas descartadas para esta POC, por si se necesitan:
   - Service/Script Task con *Job worker* (`set-parent-key`) que devuelve
     `job.processInstanceKey` como variable; la Call Activity la propaga al hijo.
   - Execution listener `start` a nivel de proceso, atendido por el mismo tipo de
     worker. Los start events no admiten listeners; el proceso sí. Hay que
     verificar versión y dónde queda la variable (según la documentación, el
     start listener la guarda como variable local del elemento).
   - `start-instance.js` (`setVariables` tras crear la instancia). Exige que la
     instancia esté esperando en la User Task y que todo arranque con el script.
6. Los keys son números enormes: **siempre string**, nunca `Number`.

## Entorno local con Docker

`docker-compose.yml` es una versión reducida del compose ligero oficial
`docker-compose-8.10` (paquete de `camunda/camunda-distributions`). Un solo
contenedor `orchestration` con Zeebe + Operate + Tasklist + Admin, H2 en archivo
como almacenamiento secundario; sin Elasticsearch ni Connectors.

```bash
docker compose up -d
docker compose logs -f orchestration     # el primer arranque tarda unos minutos
docker compose down                      # -v borra también los datos
```

| Qué | Dónde |
|---|---|
| Operate | http://localhost:8080/operate |
| Tasklist | http://localhost:8080/tasklist |
| API REST v2 | http://localhost:8080/v2/ |
| gRPC de Zeebe | localhost:26500 |
| Health | http://localhost:9600/actuator/health |
| Usuario | `demo` / `demo` |

- Imagen `camunda/camunda:8.10.3` (el tag sale del `.env` del paquete oficial;
  se puede cambiar con la variable `CAMUNDA_VERSION`).
- Autenticación `basic` con **`unprotectedApi: true`**: la API REST y el gRPC
  aceptan llamadas sin credenciales ni token. Solo sirve para desarrollo local.
- Requiere Docker Compose 2.24.0 o superior.
- Desktop Modeler: Deploy → Camunda 8 Self-Managed, endpoint
  `http://localhost:26500`, autenticación *None* (tomado de la documentación de
  Camunda 8 Run, que usa los mismos puertos; no probado con este compose).

## Tareas pendientes (en este orden)

1. **Reconciliar la documentación.** Actualizar `CLAUDE.md` para que cubra los dos
   entornos (SaaS y local) o consolidar con este archivo. Quitar de `CLAUDE.md`
   lo que ya no aplique.
2. **Hacer que el código funcione en local y en SaaS** con una sola variable, por
   ejemplo `CAMUNDA_TARGET=local|saas`, en `worker.js`, `start-instance.js` y
   `.env.example`:
   - **local:** gRPC `localhost:26500` sin TLS ni OAuth, y REST
     `http://localhost:8080/v2` **sin token**. Hoy `worker.js` siempre pide un
     token OAuth contra `ZEEBE_AUTHORIZATION_SERVER_URL`; en local eso falla.
   - **saas:** el comportamiento actual.
   - Los nombres de variables del SDK para modo sin autenticación y conexión no
     segura (por ejemplo `CAMUNDA_AUTH_STRATEGY=NONE` y
     `ZEEBE_INSECURE_CONNECTION=true`) **deben verificarse** en la documentación de
     `@camunda8/sdk` antes de usarlos.
3. **Levantar el compose** y comprobar `docker compose ps`, el health y el login
   `demo`/`demo` en Operate.
4. **Desplegar los dos BPMN** (primero el hijo, luego el principal), desde Desktop
   Modeler o por la API REST de deployments. Comprobar el endpoint exacto en la
   documentación (`/v2/deployments` existe en la API unificada, sin verificar aquí).
5. **Prueba de punta a punta:** arrancar el worker, iniciar una instancia de
   `main-process`, dejar que el worker complete la User Task del principal y luego
   la del hijo.
6. **Verificar el criterio central:** en `snapshots.jsonl`, el snapshot del job
   del hijo debe traer `parentProcessInstanceKey` igual al `processInstanceKey`
   del job del principal, y coincidir con la columna *Parent Process Instance
   Key* de Operate.
7. **Documentar resultados:** qué funcionó, el costo de la llamada extra, y las
   limitaciones (ver abajo). Dejar una tabla breve con las alternativas del punto 5
   de "Decisiones".

## Criterios de aceptación

- El worker se conecta al clúster (local y, si se prueba, SaaS).
- Recibe los jobs de ambas User Tasks y registra un snapshot de cada uno.
- El snapshot de la tarea del hijo contiene su `processInstanceKey` y el
  `parentProcessInstanceKey`, y coinciden con Operate.
- Los resultados y las limitaciones quedan documentados.

## Dudas abiertas (no verificadas; no darlas por ciertas)

- Que los BPMN escritos a mano abran sin errores en el Modeler. Ambos declaran
  `executionPlatformVersion` 8.5.0, que es anterior a la versión local (8.10);
  si el Modeler se queja, subir esa versión.
- Los nombres de campo `parentProcessInstanceKey` y `parentElementInstanceKey` en
  `GET /v2/process-instances/{key}`: salen de los tipos del cliente oficial de la
  API, pero no se han visto en una respuesta real.
- `setVariables` y `elementInstanceKey` en el SDK de Node (usados por
  `start-instance.js`): los nombres vienen de la API de Zeebe, sin probar.
- En SaaS, la consola mostró la REST API como
  `https://ric-1.zeebe.camunda.io/:443/<cluster-id>/v2/` (con un `/:443/` raro) y
  no está claro si el mismo token de OAuth con audiencia `zeebe.camunda.io` sirve
  para la REST. Si se vuelve a SaaS, probar y ajustar.
- Si en SaaS la versión del clúster fuera anterior a 8.8, la consulta del padre se
  haría con la Operate API v1 (campo `parentKey`, sin confirmar en documentación).

## Limitaciones a documentar en la POC

- Cada job de User Task del hijo requiere una llamada HTTP adicional.
- El padre no viaja en el payload del job. Si hiciera falta sin consultar nada,
  habría que setear una variable propia (Service Task, listener o script externo).
- Las User Tasks con implementación *job worker* no pasan por Tasklist; solo las
  atiende un worker. En el chat se comentó que en versiones recientes (8.8+) esa
  implementación aparece como obsoleta, pero **no se verificó en la
  documentación**: comprobarlo para la versión 8.10 y anotar el resultado.
- El tipo `io.camunda.zeebe:userTask` es fijo: no se escribe en ningún campo del
  modelo, solo en el `taskType` del worker.

## Reglas de trabajo

- No leer, imprimir ni commitear `.env` ni ningún secret. En local no hay
  credenciales, pero `.env` sigue fuera de git.
- No inventar endpoints ni nombres de campos: verificar en docs.camunda.io antes
  de usarlos. Si no se puede verificar, dejarlo anotado como duda abierta.
- No convertir keys a número.
- Mantener todo simple: es una POC, no producción. No añadir dependencias ni
  servicios que no hagan falta.
- Los archivos subidos desde el chat son copias de solo lectura: copiarlos a un
  directorio de trabajo antes de modificarlos.