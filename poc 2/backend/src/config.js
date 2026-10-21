import { fileURLToPath } from 'node:url'

// Credenciales/entorno opcionales en backend/.env (ignorado por git).
// loadEnvFile no pisa variables que ya vengan del entorno.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
} catch {}

// Configuracion unica del backend de la POC 2. Todo por variable de entorno.
const num = (name, def) => (process.env[name] ? Number(process.env[name]) : def)

// CAMUNDA_TARGET: 'local' (Docker, sin auth) o 'saas' (OAuth). Por defecto 'local'.
const target = (process.env.CAMUNDA_TARGET ?? 'local').toLowerCase()
if (!['local', 'saas'].includes(target)) {
  throw new Error(`CAMUNDA_TARGET invalido: "${target}". Usa 'local' o 'saas'.`)
}

const saas = {
  address: process.env.ZEEBE_ADDRESS,
  clientId: process.env.ZEEBE_CLIENT_ID,
  clientSecret: process.env.ZEEBE_CLIENT_SECRET,
  oauthUrl: process.env.ZEEBE_AUTHORIZATION_SERVER_URL ?? 'https://login.cloud.camunda.io/oauth/token',
  audience: process.env.ZEEBE_TOKEN_AUDIENCE ?? 'zeebe.camunda.io',
}
// El SDK avisa si ve ZEEBE_ADDRESS y ZEEBE_GRPC_ADDRESS a la vez; solo usamos la segunda.
delete process.env.ZEEBE_ADDRESS
if (target === 'saas') {
  for (const [k, v] of Object.entries({ ZEEBE_ADDRESS: saas.address, ZEEBE_CLIENT_ID: saas.clientId, ZEEBE_CLIENT_SECRET: saas.clientSecret, ZEEBE_REST_ADDRESS: process.env.ZEEBE_REST_ADDRESS })) {
    if (!v) throw new Error(`Falta ${k} (CAMUNDA_TARGET=saas). Defínela en poc 2/backend/.env`)
  }
}

export const config = {
  target,
  port: num('PORT', 3000),
  grpcAddress: process.env.CAMUNDA_LOCAL_GRPC_ADDRESS ?? 'grpc://localhost:26500',
  restBase: (target === 'saas'
    ? process.env.ZEEBE_REST_ADDRESS
    : (process.env.CAMUNDA_LOCAL_REST_ADDRESS ?? 'http://localhost:8080/v2')
  ).replace(/\/+$/, ''),
  saas, // no se expone en GET /config (ver server.js)
  dbFile: process.env.DB_FILE ?? fileURLToPath(new URL('../data/poc2.db', import.meta.url)),
  // Tiempo tras el cual Zeebe vuelve a entregar un job que no se completo.
  // En produccion es el "cada n minutos" observado; aqui es corto para poder medirlo.
  jobTimeoutMs: num('JOB_TIMEOUT_MS', 20_000),
  // Trabajo simulado al crear el form en la BD local.
  formDelayMs: num('FORM_DELAY_MS', 20),
  // Concurrencia maxima de los workers de notificacion (jobs en vuelo a la vez). Bajarla
  // provoca cola cuando hay muchos tickets: es lo que hace visible el encolamiento.
  workerMaxJobs: num('WORKER_MAX_JOBS', 64),
  // Costo simulado de la logica "already processed" de A (p. ej. consulta a una BD remota).
  discardDelayMs: num('DISCARD_DELAY_MS', 0),
  // Si el BPMN no tiene el listener ticket-closed (p. ej. pocListener sin modificar en SaaS), el
  // cierre se detecta consultando el estado de la instancia por REST (consistencia eventual).
  closeByPolling: process.env.CLOSE_BY_POLLING === 'true',
}

export const VARIANTS = {
  jobworker: { processId: 'pocJobWorker' }, // mismo id que el diagrama de Web Modeler
  usertask: { processId: 'pocListener' }, // mismo id que el diagrama de Web Modeler
}
