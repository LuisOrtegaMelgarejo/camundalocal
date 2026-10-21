import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { config, VARIANTS } from './config.js'
import { zeebe, completeUserTask, searchUserTasks, restFetch } from './camunda.js'
import { db, getTicket, updateTicket, logEvent, resetAll } from './db.js'
import { startJobWorker, startListenerWorker, startClosedWorker, startLogStartWorker } from './workers.js'
import { buildReport } from './report.js'

const httpError = (status, message) => Object.assign(new Error(message), { status })

// Contrapresión del motor (gRPC RESOURCE_EXHAUSTED / HTTP 503): con ráfagas grandes Zeebe rechaza
// comandos. Se reintenta con espera creciente y cada reintento queda como evento "backpressure".
const isBackpressure = (e) => /RESOURCE_EXHAUSTED|request limit|\b503\b/.test(String(e?.message ?? e))
async function withBackpressureRetry(ticketId, variant, op, fn, attempts = 12) {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (!isBackpressure(e) || i >= attempts) throw e
      logEvent(ticketId, variant, 'backpressure', { op, attempt: i })
      await new Promise((r) => setTimeout(r, Math.min(3000, 150 * i) + Math.random() * 100))
    }
  }
}

// POST /tickets {variant}: guarda el Ticket y crea la instancia de proceso.
async function createTicket(variant) {
  if (!VARIANTS[variant]) throw httpError(400, `variant debe ser ${Object.keys(VARIANTS).join(' | ')}`)
  const id = randomUUID().slice(0, 8)
  db.prepare('INSERT INTO tickets (id, variant, status, created_at) VALUES (?, ?, ?, ?)').run(
    id, variant, 'NEW', Date.now(),
  )
  logEvent(id, variant, 'ticket.created')

  const t0 = Date.now()
  const instance = await withBackpressureRetry(id, variant, 'createInstance', () =>
    zeebe.createProcessInstance({
      bpmnProcessId: VARIANTS[variant].processId,
      variables: { ticketId: id },
    }),
  )
  logEvent(id, variant, 'instance.created', { ms: Date.now() - t0 })
  updateTicket(id, { process_instance_key: String(instance.processInstanceKey) })
  return getTicket(id)
}

// Detecta el cierre leyendo la instancia por REST (cada 250 ms, hasta 60 s). Incluye el
// retraso del secondary storage, por eso solo se usa cuando no hay listener ticket-closed.
async function pollUntilCompleted(id, ticket) {
  for (let i = 0; i < 240; i++) {
    try {
      const res = await restFetch('GET', `/process-instances/${ticket.process_instance_key}`)
      if (res.ok && (await res.json()).state === 'COMPLETED') {
        updateTicket(id, { status: 'CLOSED' })
        return logEvent(id, ticket.variant, 'closed.received', { polled: true })
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
}

// POST /tickets/:id/done: el usuario termino su ticket -> ahora si avanza el BPMN.
async function markDone(id) {
  let ticket = getTicket(id)
  if (!ticket) throw httpError(404, 'ticket no existe')
  if (ticket.status === 'DONE' || ticket.status === 'CLOSED') return ticket
  // Un usuario solo puede terminar su ticket cuando ya tiene el formulario: si la cola de
  // notificaciones lo retrasa, el "done" espera (hasta 2 min) en vez de fallar.
  const tWait = Date.now()
  while (!ticket.form && Date.now() - tWait < 120_000) {
    await new Promise((r) => setTimeout(r, 250))
    ticket = getTicket(id)
  }
  if (!ticket.form) throw httpError(409, 'el ticket no recibio su formulario en 2 min')
  if (Date.now() - tWait > 250) logEvent(id, ticket.variant, 'done.waitedForm', { ms: Date.now() - tWait })
  logEvent(id, ticket.variant, 'done.requested')
  const t0 = Date.now()
  if (ticket.variant === 'jobworker') {
    // Recien aqui se completa el job que se mantuvo abierto.
    await withBackpressureRetry(id, ticket.variant, 'completeJob', () =>
      zeebe.completeJob({ jobKey: ticket.job_key, variables: {} }),
    )
  } else {
    let key = ticket.user_task_key
    if (!key) {
      key = (await searchUserTasks(ticket.process_instance_key)).items?.[0]?.userTaskKey
    }
    await withBackpressureRetry(id, ticket.variant, 'completeUserTask', () => completeUserTask(key))
  }
  logEvent(id, ticket.variant, 'done.accepted', { ms: Date.now() - t0 })
  if (config.closeByPolling) pollUntilCompleted(id, ticket)
  if (getTicket(id).status !== 'CLOSED') updateTicket(id, { status: 'DONE' })
  return getTicket(id)
}

const readBody = async (req) => {
  let raw = ''
  for await (const c of req) raw += c
  return raw ? JSON.parse(raw) : {}
}

const server = createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  try {
    const url = new URL(req.url, 'http://x')
    const m = url.pathname.match(/^\/tickets\/([^/]+)(\/done)?$/)
    if (req.method === 'POST' && url.pathname === '/tickets') {
      return send(201, await createTicket((await readBody(req)).variant))
    }
    if (req.method === 'POST' && m?.[2]) return send(200, await markDone(m[1]))
    if (req.method === 'GET' && m && !m[2]) {
      const t = getTicket(m[1])
      return t ? send(200, t) : send(404, { error: 'no existe' })
    }
    if (req.method === 'GET' && url.pathname === '/report') return send(200, buildReport())
    if (req.method === 'POST' && url.pathname === '/reset') {
      resetAll()
      return send(200, { ok: true })
    }
    if (req.method === 'GET' && url.pathname === '/config') return send(200, { ...config, saas: undefined })
    send(404, { error: 'ruta no existe' })
  } catch (e) {
    send(e.status ?? 500, { error: e.message })
  }
})

// WORKERS=form,listener,closed,logstart (por defecto todos). Util en un
// cluster compartido: p. ej. WORKERS=logstart para no tocar user tasks ajenas.
const enabled = (process.env.WORKERS ?? 'form,listener,closed,logstart').split(',').map((s) => s.trim())
const registry = {
  form: startJobWorker,
  listener: startListenerWorker,
  closed: startClosedWorker,
  logstart: startLogStartWorker,
}
for (const name of enabled) {
  if (!registry[name]) throw new Error(`WORKERS: "${name}" desconocido. Opciones: ${Object.keys(registry).join(', ')}`)
  registry[name]()
}
console.log(`workers activos: ${enabled.join(', ')}`)
server.listen(config.port, () =>
  console.log(`backend en :${config.port} | jobTimeout=${config.jobTimeoutMs}ms | db=${config.dbFile}`),
)
