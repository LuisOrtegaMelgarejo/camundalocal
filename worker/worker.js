import 'dotenv/config'
import { appendFileSync } from 'node:fs'
import { Camunda8 } from '@camunda8/sdk'

// CAMUNDA_TARGET elige el entorno: 'local' (Docker, sin auth) o 'saas' (OAuth).
// Por defecto 'local', que es lo que no necesita credenciales.
const TARGET = (process.env.CAMUNDA_TARGET ?? 'local').toLowerCase()
if (!['local', 'saas'].includes(TARGET)) {
  console.error(`CAMUNDA_TARGET invalido: "${TARGET}". Usa 'local' o 'saas'.`)
  process.exit(1)
}
const IS_LOCAL = TARGET === 'local'

// En local el gRPC va sin TLS: con ZEEBE_GRPC_ADDRESS y protocolo grpc:// el SDK
// ignora ZEEBE_INSECURE_CONNECTION y CAMUNDA_SECURE_CONNECTION (comprobado en
// Configuration.js del SDK 8.8.18), asi que no hace falta tocarlas.
// CAMUNDA_AUTH_STRATEGY 'NONE' es uno de los valores validos del SDK.
const config = IS_LOCAL
  ? {
      CAMUNDA_AUTH_STRATEGY: 'NONE',
      ZEEBE_GRPC_ADDRESS: process.env.CAMUNDA_LOCAL_GRPC_ADDRESS ?? 'grpc://localhost:26500',
    }
  : {
      CAMUNDA_AUTH_STRATEGY: 'OAUTH',
      ZEEBE_GRPC_ADDRESS: process.env.ZEEBE_ADDRESS,
      ZEEBE_CLIENT_ID: process.env.ZEEBE_CLIENT_ID,
      ZEEBE_CLIENT_SECRET: process.env.ZEEBE_CLIENT_SECRET,
      CAMUNDA_OAUTH_URL: process.env.ZEEBE_AUTHORIZATION_SERVER_URL,
      ZEEBE_TOKEN_AUDIENCE: process.env.ZEEBE_TOKEN_AUDIENCE,
    }

const camunda = new Camunda8(config)
const zeebe = camunda.getZeebeGrpcApiClient()

// Cada entorno usa sus propias variables: asi un .env con los valores de SaaS no
// se cuela en modo local (dotenv carga el .env sea cual sea el target).
const REST_BASE = (
  IS_LOCAL
    ? (process.env.CAMUNDA_LOCAL_REST_ADDRESS ?? 'http://localhost:8080/v2')
    : process.env.ZEEBE_REST_ADDRESS
)?.replace(/\/+$/, '')
if (!REST_BASE) {
  console.error('Falta ZEEBE_REST_ADDRESS (necesario para consultar el padre).')
  process.exit(1)
}

// --- Cabecera de autorizacion para la API REST ---
// En local la API acepta llamadas sin token (unprotectedApi: true en el compose),
// asi que no se pide ninguno. En SaaS se usa client credentials con cache simple.
let cachedToken = null
let tokenExpiresAt = 0

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 30_000) return cachedToken
  const res = await fetch(process.env.ZEEBE_AUTHORIZATION_SERVER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.ZEEBE_CLIENT_ID,
      client_secret: process.env.ZEEBE_CLIENT_SECRET,
      audience: process.env.ZEEBE_TOKEN_AUDIENCE,
    }),
  })
  if (!res.ok) throw new Error(`OAuth ${res.status}: ${await res.text()}`)
  const data = await res.json()
  cachedToken = data.access_token
  tokenExpiresAt = Date.now() + data.expires_in * 1000
  return cachedToken
}

async function authHeaders() {
  return IS_LOCAL ? {} : { Authorization: `Bearer ${await getToken()}` }
}

// --- Consulta de la instancia para obtener el padre ---
// La API v2 lee del secondary storage (consistencia eventual): justo al crearse
// la instancia hija puede responder 404. Se reintenta unos segundos.
async function getProcessInstance(processInstanceKey, attempts = 10, delayMs = 1000) {
  for (let i = 1; ; i++) {
    const res = await fetch(`${REST_BASE}/process-instances/${processInstanceKey}`, {
      headers: await authHeaders(),
    })
    if (res.ok) return res.json()
    if (res.status !== 404 || i >= attempts) {
      throw new Error(`GET process-instances ${res.status} (intento ${i}): ${await res.text()}`)
    }
    await new Promise((r) => setTimeout(r, delayMs))
  }
}

// Chequeo de conexión al arrancar
try {
  const topology = await zeebe.topology()
  console.log(
    `Conectado a ${TARGET}. Gateway v${topology.gatewayVersion}, ` +
      `brokers: ${topology.brokers.length}, REST: ${REST_BASE}`,
  )
} catch (err) {
  console.error('No se pudo conectar al clúster:', err.message)
  process.exit(1)
}

// User Tasks (implementación job worker): captura el payload, consulta el
// padre en la API y completa el job.
zeebe.createWorker({
  taskType: 'io.camunda.zeebe:userTask',
  taskHandler: async (job) => {
    let parent = { parentProcessInstanceKey: null, parentElementInstanceKey: null }
    try {
      const instance = await getProcessInstance(job.processInstanceKey)
      parent = {
        parentProcessInstanceKey: instance.parentProcessInstanceKey ?? null,
        parentElementInstanceKey: instance.parentElementInstanceKey ?? null,
      }
    } catch (err) {
      console.error(`[userTask] no se pudo consultar el padre de ${job.processInstanceKey}:`, err.message)
    }

    const snapshot = {
      capturedAt: new Date().toISOString(),
      jobKey: job.key,
      processInstanceKey: job.processInstanceKey,
      processDefinitionKey: job.processDefinitionKey,
      bpmnProcessId: job.bpmnProcessId,
      elementId: job.elementId,
      ...parent,
      variables: job.variables,
      customHeaders: job.customHeaders,
    }
    console.log('[userTask]', JSON.stringify(snapshot, null, 2))
    appendFileSync('snapshots.jsonl', JSON.stringify(snapshot) + '\n')
    return job.complete()
  },
})

console.log('Worker escuchando: io.camunda.zeebe:userTask')