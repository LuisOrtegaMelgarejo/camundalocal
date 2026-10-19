import { fileURLToPath } from 'node:url'

// Configuracion unica del backend de la POC 2. Todo por variable de entorno.
const num = (name, def) => (process.env[name] ? Number(process.env[name]) : def)

export const config = {
  port: num('PORT', 3000),
  grpcAddress: process.env.CAMUNDA_LOCAL_GRPC_ADDRESS ?? 'grpc://localhost:26500',
  restBase: (process.env.CAMUNDA_LOCAL_REST_ADDRESS ?? 'http://localhost:8080/v2').replace(/\/+$/, ''),
  dbFile: process.env.DB_FILE ?? fileURLToPath(new URL('../data/poc2.db', import.meta.url)),
  // Tiempo tras el cual Zeebe vuelve a entregar un job que no se completo.
  // En produccion es el "cada n minutos" observado; aqui es corto para poder medirlo.
  jobTimeoutMs: num('JOB_TIMEOUT_MS', 20_000),
  // Trabajo simulado al crear el form en la BD local.
  formDelayMs: num('FORM_DELAY_MS', 20),
}

export const VARIANTS = {
  jobworker: { processId: 'ticket-jobworker' },
  usertask: { processId: 'ticket-usertask' },
}
