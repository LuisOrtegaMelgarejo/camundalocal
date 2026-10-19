import { fileURLToPath } from 'node:url'
import { db } from './db.js'

function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return { n: 0 }
  const q = (p) => v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)]
  const avg = v.reduce((s, x) => s + x, 0) / v.length
  return { n: v.length, min: v[0], p50: q(0.5), p95: q(0.95), max: v[v.length - 1], avg: Math.round(avg) }
}

// Agrupa los eventos por ticket: { type: [ {ts, meta}, ... ] }
function eventsByTicket(variant) {
  const rows = db
    .prepare('SELECT ticket_id, ts, type, meta FROM events WHERE variant = ? ORDER BY ts, id')
    .all(variant)
  const out = new Map()
  for (const r of rows) {
    const t = out.get(r.ticket_id) ?? {}
    ;(t[r.type] ??= []).push({ ts: r.ts, meta: r.meta ? JSON.parse(r.meta) : {} })
    out.set(r.ticket_id, t)
  }
  return out
}

export function buildReport() {
  const report = {}
  for (const variant of ['jobworker', 'usertask']) {
    const tickets = [...eventsByTicket(variant).values()]
    const first = (t, type) => t[type]?.[0]
    const diff = (t, a, b) => (first(t, a) && first(t, b) ? first(t, b).ts - first(t, a).ts : NaN)

    const notifs = tickets.flatMap((t) => t['notif.received'] ?? [])
    const duplicates = notifs.filter((n) => n.meta.duplicate).length
    const gaps = tickets.flatMap((t) => {
      const r = t['notif.received'] ?? []
      return r.slice(1).map((n, i) => n.ts - r[i].ts)
    })
    const lastDelivery = (t) => (t['notif.received'] ?? []).at(-1)?.ts
    const afterDone = tickets.reduce(
      (s, t) => s + (t['notif.received'] ?? []).filter((n) => first(t, 'done.requested') && n.ts > first(t, 'done.requested').ts).length,
      0,
    )

    report[variant] = {
      tickets: tickets.length,
      closed: tickets.filter((t) => t['closed.received']).length,
      latencyMs: {
        instanceCreateApi: stats(tickets.map((t) => first(t, 'instance.created')?.meta.ms)),
        ticketToNotification: stats(tickets.map((t) => diff(t, 'ticket.created', 'notif.received'))),
        ticketToFormReady: stats(tickets.map((t) => diff(t, 'ticket.created', 'form.created'))),
        firstNotificationHandling: stats(tickets.map((t) => first(t, 'notif.handled')?.meta.ms)),
        notificationAck: stats(tickets.map((t) => first(t, 'notif.acked')?.meta.ms)),
        doneApi: stats(tickets.map((t) => first(t, 'done.accepted')?.meta.ms)),
        doneToEngineAdvance: stats(tickets.map((t) => diff(t, 'done.requested', 'closed.received'))),
      },
      volumetry: {
        notificationsReceived: notifs.length,
        perTicketAvg: tickets.length ? +(notifs.length / tickets.length).toFixed(2) : 0,
        perTicketMax: Math.max(0, ...tickets.map((t) => (t['notif.received'] ?? []).length)),
        duplicatesDiscarded: duplicates,
        duplicatesPct: notifs.length ? +((100 * duplicates) / notifs.length).toFixed(1) : 0,
        redeliveryGapMs: stats(gaps),
        deliveriesAfterDone: afterDone,
        openMs: stats(tickets.map((t) => diff(t, 'ticket.created', 'done.requested'))),
        lastDeliveryToDoneMs: stats(
          tickets.map((t) => (first(t, 'done.requested') ? first(t, 'done.requested').ts - lastDelivery(t) : NaN)),
        ),
      },
    }
  }
  return report
}

const LABELS = {
  instanceCreateApi: 'Crear instancia (respuesta de la API)',
  ticketToNotification: 'Ticket creado → notificación recibida',
  ticketToFormReady: 'Ticket creado → form listo',
  firstNotificationHandling: 'Procesar la primera notificación',
  notificationAck: 'Ack de la notificación (completar el job)',
  doneApi: 'Done → la API responde',
  doneToEngineAdvance: 'Done → el motor avanza',
}
const NAMES = { jobworker: 'A. Job Worker', usertask: 'B. User Task + listener' }
const cell = (s, k) => (s?.n ? `${s[k]}` : '—')
const sec = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : '—')

// Resultado de una corrida en Markdown, para leerlo sin abrir un JSON.
export function renderMarkdown(report, cfg) {
  const A = report.jobworker
  const B = report.usertask
  const lat = (k, col) => `${cell(A.latencyMs[k], col)} / ${cell(B.latencyMs[k], col)}`
  const lines = [
    `# Resultado de corrida — ${new Date().toISOString()}`,
    '',
    '## Parámetros',
    '',
    `- Tickets por alternativa: ${cfg.tickets}`,
    `- Timeout del job (reenvío en A): ${sec(cfg.jobTimeoutMs)}`,
    `- El usuario marca done a los: ${sec(cfg.doneAfterMs)}`,
    '',
    '## Latencias (ms)',
    '',
    `| Métrica | ${NAMES.jobworker} p50 | ${NAMES.usertask} p50 | ${NAMES.jobworker} p95 | ${NAMES.usertask} p95 | ${NAMES.jobworker} máx | ${NAMES.usertask} máx |`,
    '|---|---:|---:|---:|---:|---:|---:|',
    ...Object.entries(LABELS).map(([k, label]) => {
      const a = A.latencyMs[k]
      const b = B.latencyMs[k]
      return `| ${label} | ${cell(a, 'p50')} | ${cell(b, 'p50')} | ${cell(a, 'p95')} | ${cell(b, 'p95')} | ${cell(a, 'max')} | ${cell(b, 'max')} |`
    }),
    '',
    '## Volumetría',
    '',
    `| | ${NAMES.jobworker} | ${NAMES.usertask} |`,
    '|---|---:|---:|',
    `| Tickets / cerrados | ${A.tickets} / ${A.closed} | ${B.tickets} / ${B.closed} |`,
    `| Notificaciones recibidas | ${A.volumetry.notificationsReceived} | ${B.volumetry.notificationsReceived} |`,
    `| Notificaciones por ticket (prom. / máx.) | ${A.volumetry.perTicketAvg} / ${A.volumetry.perTicketMax} | ${B.volumetry.perTicketAvg} / ${B.volumetry.perTicketMax} |`,
    `| Duplicados descartados | ${A.volumetry.duplicatesDiscarded} (${A.volumetry.duplicatesPct} %) | ${B.volumetry.duplicatesDiscarded} (${B.volumetry.duplicatesPct} %) |`,
    `| Intervalo entre reenvíos (p50) | ${sec(A.volumetry.redeliveryGapMs.p50)} | ${sec(B.volumetry.redeliveryGapMs.p50)} |`,
    `| Tiempo abierto del ticket (p50) | ${sec(A.volumetry.openMs.p50)} | ${sec(B.volumetry.openMs.p50)} |`,
    `| Entregas después del done | ${A.volumetry.deliveriesAfterDone} | ${B.volumetry.deliveriesAfterDone} |`,
    '',
  ]
  return lines.join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(buildReport(), null, 2))
}
