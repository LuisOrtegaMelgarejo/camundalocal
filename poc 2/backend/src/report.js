import { fileURLToPath } from 'node:url'
import { db } from './db.js'
import { config } from './config.js'

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

// Serie temporal de un variant: cola (tickets sin primera notificacion), handlers en vuelo,
// mensajes por segundo y tabla por tramos. Todo sale de la tabla events.
function volumeSeries(variant) {
  const rows = db
    .prepare('SELECT ticket_id, ts, type, meta FROM events WHERE variant = ? ORDER BY ts, id')
    .all(variant)
  const created = rows.filter((r) => r.type === 'ticket.created')
  if (!created.length) return null
  const t0 = created[0].ts
  const windowMs = Math.max(1, rows.at(-1).ts - t0)
  // ~20 tramos como maximo, multiplos de 1 s
  const bucketMs = Math.max(1000, Math.ceil(windowMs / 20 / 1000) * 1000)
  const buckets = Array.from({ length: Math.floor(windowMs / bucketMs) + 1 }, () => ({
    created: 0, firstNotified: 0, notifications: 0, duplicates: 0, backlogEnd: 0, inFlightPeak: 0,
  }))
  const perSec = new Map() // segundo -> {n, dup}
  const notified = new Set()
  let backlog = 0, inFlight = 0, busyMs = 0
  let peakBacklog = 0, peakInFlight = 0
  for (const r of rows) {
    const b = buckets[Math.floor((r.ts - t0) / bucketMs)]
    const meta = r.meta ? JSON.parse(r.meta) : {}
    if (r.type === 'ticket.created') {
      backlog++; b.created++
    } else if (r.type === 'notif.received') {
      if (!notified.has(r.ticket_id)) { notified.add(r.ticket_id); backlog--; b.firstNotified++ }
      inFlight++; b.notifications++
      if (meta.duplicate) b.duplicates++
      const s = perSec.get(Math.floor((r.ts - t0) / 1000)) ?? { n: 0, dup: 0 }
      s.n++; if (meta.duplicate) s.dup++
      perSec.set(Math.floor((r.ts - t0) / 1000), s)
    } else if (r.type === 'notif.handled') {
      inFlight--; busyMs += meta.ms ?? 0
    }
    peakBacklog = Math.max(peakBacklog, backlog)
    peakInFlight = Math.max(peakInFlight, inFlight)
    b.backlogEnd = backlog
    b.inFlightPeak = Math.max(b.inFlightPeak, inFlight)
  }
  // arrastrar el ultimo valor de cola en tramos sin eventos
  for (let i = 1; i < buckets.length; i++) {
    if (!buckets[i].created && !buckets[i].notifications && !buckets[i].firstNotified) buckets[i].backlogEnd = buckets[i - 1].backlogEnd
  }
  const secs = [...perSec.values()]
  return {
    windowMs, bucketMs, busyMs, peakBacklog, peakInFlight,
    createdSpanMs: Math.max(1, created.at(-1).ts - t0),
    notifPeakPerSec: Math.max(0, ...secs.map((s) => s.n)),
    dupPeakPerSec: Math.max(0, ...secs.map((s) => s.dup)),
    timeline: buckets.map((b, i) => ({ fromS: (i * bucketMs) / 1000, ...b })),
  }
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

    const series = volumeSeries(variant)
    const openHours = tickets.reduce((s, t) => s + (diff(t, 'ticket.created', 'done.requested') || 0), 0) / 3_600_000
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
      timeline: series ? { bucketS: series.bucketMs / 1000, rows: series.timeline } : null,
      volumetry: {
        notificationsReceived: notifs.length,
        perTicketAvg: tickets.length ? +(notifs.length / tickets.length).toFixed(2) : 0,
        perTicketMax: Math.max(0, ...tickets.map((t) => (t['notif.received'] ?? []).length)),
        duplicatesDiscarded: duplicates,
        duplicatesPct: notifs.length ? +((100 * duplicates) / notifs.length).toFixed(1) : 0,
        redeliveryGapMs: stats(gaps),
        deliveriesAfterDone: afterDone,
        openMs: stats(tickets.map((t) => diff(t, 'ticket.created', 'done.requested'))),
        windowS: series ? +(series.windowMs / 1000).toFixed(1) : 0,
        ticketsCreatedPerSec: series ? +((tickets.length * 1000) / series.createdSpanMs).toFixed(1) : 0,
        notifPerSecAvg: series ? +((notifs.length * 1000) / series.windowMs).toFixed(2) : 0,
        notifPeakPerSec: series?.notifPeakPerSec ?? 0,
        duplicatesPeakPerSec: series?.dupPeakPerSec ?? 0,
        peakBacklogTickets: series?.peakBacklog ?? 0,
        peakInFlightHandlers: series?.peakInFlight ?? 0,
        workerCapacity: config.workerMaxJobs,
        backpressureRetries: tickets.reduce((s, t) => s + (t['backpressure']?.length ?? 0), 0),
        workerBusyPct: series ? +((100 * series.busyMs) / (series.windowMs * config.workerMaxJobs)).toFixed(1) : 0,
        messagesPerTicketHour: openHours ? +(notifs.length / openHours).toFixed(1) : 0, // notificaciones por hora de ticket abierto
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
    `- Entorno: ${cfg.target}${cfg.target === 'saas' ? ' (latencias incluyen red a internet; no comparables con local)' : ''}`,
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
    '## Volumetría y cola',
    '',
    `| | ${NAMES.jobworker} | ${NAMES.usertask} |`,
    '|---|---:|---:|',
    ...[
      ['Ventana de la corrida', (v) => `${v.windowS} s`],
      ['Tickets creados por segundo', (v) => v.ticketsCreatedPerSec],
      ['Notificaciones por segundo (prom. / pico)', (v) => `${v.notifPerSecAvg} / ${v.notifPeakPerSec}`],
      ['Duplicados por segundo (pico)', (v) => v.duplicatesPeakPerSec],
      ['Notificaciones por hora de ticket abierto', (v) => v.messagesPerTicketHour],
      ['Cola máxima (tickets creados sin notificar)', (v) => v.peakBacklogTickets],
      ['Handlers en vuelo (pico / capacidad)', (v) => `${v.peakInFlightHandlers} / ${v.workerCapacity}`],
      ['Utilización del worker', (v) => `${v.workerBusyPct} %`],
      ['Reintentos por contrapresión del motor', (v) => v.backpressureRetries],
    ].map(([label, f]) => `| ${label} | ${f(A.volumetry)} | ${f(B.volumetry)} |`),
    '',
    ...[['jobworker', A], ['usertask', B]].flatMap(([k, r]) =>
      !r.timeline
        ? []
        : [
            `### Línea de tiempo — ${NAMES[k]} (tramos de ${r.timeline.bucketS} s)`,
            '',
            '| desde (s) | tickets creados | 1ª notificación | notificaciones | duplicados | cola al cierre | handlers pico |',
            '|---:|---:|---:|---:|---:|---:|---:|',
            ...r.timeline.rows.map(
              (b) => `| ${b.fromS} | ${b.created} | ${b.firstNotified} | ${b.notifications} | ${b.duplicates} | ${b.backlogEnd} | ${b.inFlightPeak} |`,
            ),
            '',
          ],
    ),
  ]
  return lines.join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(buildReport(), null, 2))
}
