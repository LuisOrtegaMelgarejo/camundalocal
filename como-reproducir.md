# Cómo reproducir la POC SCOTIAFLOW-363

Guía paso a paso para levantar el entorno local, desplegar los procesos y ver al
worker identificar el ticket desde el subproceso.

## Requisitos

- Docker Desktop corriendo (el contenedor usa hasta 1 GB de RAM).
- Node.js 18 o superior.
- Puertos libres: `8080` (Operate y API REST), `26500` (gRPC de Zeebe) y `9600`
  (health).

## Qué hay en el repo

| Archivo | Para qué sirve |
|---|---|
| `docker-compose.yml` | Camunda 8.10.3 local, un solo contenedor con H2 |
| `proceso-hijo.bpmn` | `child-process`, con su propia User Task |
| `proceso-principal.bpmn` | `main-process`, propagación total de variables |
| `proceso-principal-input-mapping.bpmn` | `main-process-input-mapping`, la opción adoptada |
| `worker/worker.js` | Worker que atiende los jobs y guarda el payload |
| `worker/snapshots.jsonl` | Salida: un snapshot por job atendido |

## 1. Levantar Camunda

```bash
docker compose up -d
```

Esperar a que el contenedor esté `healthy` (puede tardar un minuto):

```bash
docker compose ps
```

Operate queda en http://localhost:8080/operate con usuario `demo` y clave `demo`.

## 2. Desplegar los procesos

El hijo va primero, porque los principales lo referencian por `processId`
(`child-process`).

```bash
curl -X POST http://localhost:8080/v2/deployments \
  -F "resources=@proceso-hijo.bpmn"

curl -X POST http://localhost:8080/v2/deployments \
  -F "resources=@proceso-principal-input-mapping.bpmn" \
  -F "resources=@proceso-principal.bpmn"
```

En local la API no pide token. También se pueden desplegar desde el Desktop Modeler.

## 3. Arrancar el worker

```bash
cd worker
npm install
npm start
```

`CAMUNDA_TARGET` vale `local` por defecto. Debe aparecer:

```
Conectado a local. Gateway v8.10.3, ...
Worker escuchando: io.camunda.zeebe:userTask
```

El worker queda esperando jobs; déjalo corriendo en esa terminal.

## 4. Crear una instancia

En otra terminal, con las mismas variables que usamos en la POC:

```bash
curl -X POST http://localhost:8080/v2/process-instances \
  -H "Content-Type: application/json" \
  -d '{
    "processDefinitionId": "main-process-input-mapping",
    "variables": { "ticketNumber": "SCOTIAFLOW-363", "canal": "web" }
  }'
```

Para comparar con la propagación total, repetir con
`"processDefinitionId": "main-process"`.

## 5. Qué esperar

El worker atiende dos jobs por instancia: la User Task del principal y, después de la
Call Activity, la del hijo. Cada uno se imprime en la consola y se agrega a
`worker/snapshots.jsonl`.

Lo que se debe ver en el job del hijo:

| Proceso | Variables que llegan al hijo |
|---|---|
| `main-process-input-mapping` | `{"ticket":"SCOTIAFLOW-363"}` |
| `main-process` | `{"canal":"web","ticketNumber":"SCOTIAFLOW-363"}` |

Además, en el snapshot del hijo, `parentProcessInstanceKey` trae el key de la
instancia principal. Se puede contrastar con la columna *Parent Process Instance Key*
de Operate.

## Problemas comunes

- **`No se pudo conectar al clúster`**: el contenedor aún no está `healthy`, o los
  puertos están ocupados. Revisar `docker compose ps` y `docker compose logs`.
- **El hijo no llega a ejecutarse**: se desplegó el principal sin desplegar antes el
  hijo. Desplegar `proceso-hijo.bpmn` y crear una instancia nueva.
- **No aparece nada en Tasklist**: es lo esperado. Las User Tasks con implementación
  *job worker* solo las atiende el worker.
- **`parentProcessInstanceKey` en `null` en el job del principal**: es lo esperado,
  el principal no tiene padre.
- **Error 404 al consultar el padre**: la API lee de un almacenamiento con
  consistencia eventual; el worker reintenta hasta 10 veces, un segundo entre cada
  intento.

## Empezar de cero

```bash
docker compose down -v   # borra también los volúmenes y los procesos desplegados
```

## Contra SaaS

Cambiar a `CAMUNDA_TARGET=saas` y copiar `worker/env.example` a `worker/.env`,
completando `ZEEBE_CLIENT_ID` y `ZEEBE_CLIENT_SECRET` con los del API Client del
clúster (Console → clúster → API). No subir el `.env` a git.
