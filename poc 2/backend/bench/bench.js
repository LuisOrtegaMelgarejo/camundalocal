// Banco de pruebas: crea N tickets por alternativa contra el backend, deja que
// pase el "tiempo del usuario" y los marca como done. Al final imprime el
// reporte y lo guarda en results/.
//
//   TICKETS=20 DONE_AFTER_MS=65000 npm run bench
//
// El backend debe estar corriendo (npm start) y los BPMN desplegados (npm run deploy).
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderMarkdown } from '../src/report.js'

const API = process.env.API ?? 'http://localhost:3000'
const TICKETS = Number(process.env.TICKETS ?? 20) // por alternativa
const DONE_AFTER_MS = Number(process.env.DONE_AFTER_MS ?? 65_000) // lo que tarda el usuario
const CREATE_SPACING_MS = Number(process.env.CREATE_SPACING_MS ?? 100)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`)
  return json
}

const cfg = await call('GET', '/config')
console.log(`Backend jobTimeout=${cfg.jobTimeoutMs}ms | ${TICKETS} tickets x 2 alternativas | usuario tarda ${DONE_AFTER_MS}ms`)
await call('POST', '/reset')

const started = Date.now()
const lifecycle = []
for (let i = 0; i < TICKETS; i++) {
  for (const variant of ['jobworker', 'usertask']) {
    const t = await call('POST', '/tickets', { variant })
    lifecycle.push(
      sleep(DONE_AFTER_MS).then(() => call('POST', `/tickets/${t.id}/done`)),
    )
    await sleep(CREATE_SPACING_MS)
  }
}
console.log(`Tickets creados en ${Date.now() - started}ms. Esperando al usuario...`)
await Promise.all(lifecycle)

// Esperar a que todos los procesos avancen y dejar una ventana para detectar
// entregas tardias (no deberia haber ninguna tras el done).
const expected = TICKETS * 2
for (let i = 0; i < 60; i++) {
  const r = await call('GET', '/report')
  if (r.jobworker.closed + r.usertask.closed >= expected) break
  await sleep(1000)
}
await sleep(Math.min(cfg.jobTimeoutMs, 30_000) + 2000)

const report = await call('GET', '/report')
const out = fileURLToPath(new URL('../results/', import.meta.url))
mkdirSync(out, { recursive: true })
const file = `${out}run-${new Date().toISOString().replace(/[:.]/g, '-')}.md`
writeFileSync(file, renderMarkdown(report, { ...cfg, tickets: TICKETS, doneAfterMs: DONE_AFTER_MS }))

const row = (label, s) =>
  `  ${label.padEnd(30)} n=${String(s.n).padStart(3)}  p50=${String(s.p50 ?? '-').padStart(6)}  p95=${String(s.p95 ?? '-').padStart(6)}  max=${String(s.max ?? '-').padStart(6)}`
for (const [variant, r] of Object.entries(report)) {
  console.log(`\n=== ${variant} (tickets=${r.tickets}, cerrados=${r.closed}) ===`)
  for (const [k, s] of Object.entries(r.latencyMs)) console.log(row(k, s))
  const v = r.volumetry
  console.log(`  notificaciones: ${v.notificationsReceived} (${v.perTicketAvg}/ticket, max ${v.perTicketMax}) | duplicados: ${v.duplicatesDiscarded} (${v.duplicatesPct}%) | tras done: ${v.deliveriesAfterDone}`)
  console.log(row('redeliveryGapMs', v.redeliveryGapMs))
}
console.log(`\nGuardado en ${file}`)
