// Barridos del benchmark. Cada corrida usa el benchmark completo (bench/bench.js) y deja su .md en
// backend/results/; al final se escribe una tabla resumen en backend/results/sweep-*.md.
//
//   Barrido por tiempo de atención del usuario (cuánto tarda en marcar done):
//     node scripts/sweep-open-time.mjs --open-times 20000,40000,80000 --tickets 10
//   Barrido por volumen de tickets (a un tiempo de atención fijo):
//     node scripts/sweep-open-time.mjs --tickets-list 10,30,60 --open-times 40000
//
// Acepta las mismas opciones de entorno/carga que run-poc2.mjs.
import { parseArgs } from 'node:util'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setTarget, ensureCamunda, ensureDeps, deployBpmn, startBackend, runBench, getReport } from './lib.mjs'

const { values: v } = parseArgs({
  options: {
    'open-times': { type: 'string', default: '35000,70000,140000,280000' },
    'tickets-list': { type: 'string' }, // si se indica, varía el volumen con el primer open-time
    tickets: { type: 'string', default: '20' },
    'job-timeout-ms': { type: 'string', default: '10000' },
    port: { type: 'string', default: '3000' },
    target: { type: 'string' }, // local | saas (por defecto lo que diga backend/.env o local)
    'skip-deploy': { type: 'boolean', default: false },
    variants: { type: 'string' },
    workers: { type: 'string' },
    'close-by-polling': { type: 'boolean', default: false },
    concurrency: { type: 'string' },
    'worker-max-jobs': { type: 'string' },
    'discard-delay-ms': { type: 'string' },
    label: { type: 'string', default: '' },
  },
})
const port = Number(v.port)
const jobTimeoutMs = Number(v['job-timeout-ms'])
const openTimes = v['open-times'].split(',').map(Number)
const runs = v['tickets-list']
  ? v['tickets-list'].split(',').map((n) => ({ tickets: Number(n), doneAfterMs: openTimes[0] }))
  : openTimes.map((t) => ({ tickets: Number(v.tickets), doneAfterMs: t }))

setTarget(v.target)
if (v.variants) process.env.VARIANTS_TO_RUN = v.variants
if (v.workers) process.env.WORKERS = v.workers
if (v['close-by-polling']) process.env.CLOSE_BY_POLLING = 'true'
if (v.concurrency) process.env.CONCURRENCY = v.concurrency
if (v['worker-max-jobs']) process.env.WORKER_MAX_JOBS = v['worker-max-jobs']
if (v['discard-delay-ms']) process.env.DISCARD_DELAY_MS = v['discard-delay-ms']

await ensureCamunda()
ensureDeps()
if (!v['skip-deploy']) deployBpmn()
const backend = await startBackend({ port, jobTimeoutMs })
const rows = []
try {
  for (const { tickets, doneAfterMs } of runs) {
    console.log(`\n>>> ${tickets} tickets por alternativa, usuario tarda ${doneAfterMs} ms`)
    runBench({ port, tickets, doneAfterMs })
    const r = await getReport(port)
    for (const [key, name] of [['jobworker', 'A'], ['usertask', 'B']]) {
      const x = r[key]
      if (!x.tickets) continue
      rows.push({
        alt: name,
        tickets: x.tickets,
        abiertoS: doneAfterMs / 1000,
        notif: x.volumetry.notificationsReceived,
        porTicket: x.volumetry.perTicketAvg,
        dupPct: x.volumetry.duplicatesPct,
        notifP50: x.latencyMs.ticketToNotification.p50,
        notifP95: x.latencyMs.ticketToNotification.p95,
        formP50: x.latencyMs.ticketToFormReady.p50,
        formP95: x.latencyMs.ticketToFormReady.p95,
        doneP50: x.latencyMs.doneApi.p50,
        cierreP50: x.latencyMs.doneToEngineAdvance.p50,
        colaMax: x.volumetry.peakBacklogTickets,
        busyPct: x.volumetry.workerBusyPct,
        backpressure: x.volumetry.backpressureRetries,
        ventanaS: x.volumetry.windowS,
      })
    }
  }
} finally {
  backend.kill()
}

console.log(`\n=== Resumen del barrido (timeout = ${jobTimeoutMs} ms) ===`)
console.table(rows)

const head = Object.keys(rows[0] ?? {})
const md = [
  `# Barrido ${v.label} — ${new Date().toISOString()}`,
  '',
  `Entorno: ${process.env.CAMUNDA_TARGET ?? 'local'} · timeout del job: ${jobTimeoutMs} ms · ` +
    `concurrencia de creación: ${process.env.CONCURRENCY ?? 1} · capacidad del worker: ${process.env.WORKER_MAX_JOBS ?? 64} · ` +
    `costo de descarte: ${process.env.DISCARD_DELAY_MS ?? 0} ms`,
  '',
  `| ${head.join(' | ')} |`,
  `|${head.map(() => '---:').join('|')}|`,
  ...rows.map((r) => `| ${head.map((h) => r[h] ?? '—').join(' | ')} |`),
  '',
].join('\n')
const out = fileURLToPath(new URL('../backend/results/', import.meta.url))
mkdirSync(out, { recursive: true })
const file = `${out}sweep-${process.env.CAMUNDA_TARGET ?? 'local'}-${v.label || 'run'}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`
writeFileSync(file, md)
console.log(`Guardado en ${file}`)
