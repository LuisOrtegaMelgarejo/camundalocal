// Prueba completa de la POC 2: levanta Camunda, instala, despliega los BPMN,
// arranca el backend, corre el benchmark y lo apaga. Resultado en backend/results/*.md
//
//   node scripts/run-poc2.mjs
//   node scripts/run-poc2.mjs --tickets 50 --done-after-ms 35000 --job-timeout-ms 10000
//   node scripts/run-poc2.mjs --keep-backend     # deja el backend arriba (para Postman)
//   node scripts/run-poc2.mjs --stress           # ráfaga con cola: 100 tickets, concurrencia 25, worker 4, descarte 50 ms
//   node scripts/run-poc2.mjs --stress          # rafaga con cola: 100 tickets, concurrencia 25, worker 4, descarte 50 ms
import { parseArgs } from 'node:util'
import { setTarget, ensureCamunda, ensureDeps, deployBpmn, startBackend, runBench } from './lib.mjs'

const { values: v } = parseArgs({
  options: {
    tickets: { type: 'string', default: '50' }, // por alternativa
    'done-after-ms': { type: 'string', default: '35000' }, // lo que tarda el "usuario"
    'job-timeout-ms': { type: 'string', default: '10000' }, // timeout del job = reenvio en A
    port: { type: 'string', default: '3000' },
    target: { type: 'string' }, // local | saas (por defecto lo que diga backend/.env o local)
    'keep-backend': { type: 'boolean', default: false },
    'skip-deploy': { type: 'boolean', default: false }, // no publicar BPMN (usa lo ya desplegado)
    variants: { type: 'string' }, // jobworker,usertask (por defecto ambas)
    workers: { type: 'string' }, // form,listener,closed,logstart
    concurrency: { type: 'string' }, // creaciones en paralelo (ráfaga)
    'worker-max-jobs': { type: 'string' }, // concurrencia de los workers (baja = más cola)
    'discard-delay-ms': { type: 'string' }, // costo simulado del 'already processed' de A
    stress: { type: 'boolean', default: false }, // preset de carga con cola (ver abajo)
    'close-by-polling': { type: 'boolean', default: false }, // cierre por REST, sin listener ticket-closed
  },
})
// --stress: ráfaga de tickets con workers de poca concurrencia y descarte con costo. Los valores
// explícitos ganan sobre el preset.
if (v.stress) {
  v.tickets = v.tickets === '50' ? '100' : v.tickets
  v.concurrency ??= '25'
  v['worker-max-jobs'] ??= '4'
  v['discard-delay-ms'] ??= '50'
}
if (v.concurrency) process.env.CONCURRENCY = v.concurrency
if (v['worker-max-jobs']) process.env.WORKER_MAX_JOBS = v['worker-max-jobs']
if (v['discard-delay-ms']) process.env.DISCARD_DELAY_MS = v['discard-delay-ms']
const port = Number(v.port)

setTarget(v.target)
if (v.variants) process.env.VARIANTS_TO_RUN = v.variants
if (v.workers) process.env.WORKERS = v.workers
if (v['close-by-polling']) process.env.CLOSE_BY_POLLING = 'true'
await ensureCamunda()
ensureDeps()
if (!v['skip-deploy']) deployBpmn()
console.log('Arrancando backend...')
const backend = await startBackend({ port, jobTimeoutMs: Number(v['job-timeout-ms']) })
try {
  runBench({ port, tickets: Number(v.tickets), doneAfterMs: Number(v['done-after-ms']) })
} finally {
  if (v['keep-backend']) console.log(`Backend sigue corriendo (PID ${backend.pid}) en :${port}`)
  else backend.kill()
}
