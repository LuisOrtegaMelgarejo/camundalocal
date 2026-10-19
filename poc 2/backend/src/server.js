import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { config, VARIANTS } from './config.js'
import { zeebe, completeUserTask, searchUserTasks } from './camunda.js'
import { db, getTicket, updateTicket, logEvent, resetAll } from './db.js'
import { startJobWorker, startListenerWorker, startClosedWorker } from './workers.js'
import { buildReport } from './report.js'

const httpError = (status, message) => Object.assign(new Error(message), { status })

// POST /tickets {variant}: guarda el Ticket y crea la instancia de proceso.
async function createTicket(variant) {
  if (!VARIANTS[variant]) throw httpError(400, `variant debe ser ${Object.keys(VARIANTS).join(' | ')}`)
  const id = randomUUID().slice(0, 8)
  db.prepare('INSERT INTO tickets (id, variant, status, created_at) VALUES (?, ?, ?, ?)').run(
    id, variant, 'NEW', Date.now(),
  )
  logEvent(id, variant, 'ticket.created')

  const t0 = Date.now()
  const instance = await zeebe.createProcessInstance({
    bpmnProcessId: VARIANTS[variant].processId,
    variables: { ticketId: id },
  })
  logEvent(id, variant, 'instance.created', { ms: Date.now() - t0 })
  updateTicket(id, { process_instance_key: String(instance.processInstanceKey) })
  return getTicket(id)
}

// POST /tickets/:id/done: el usuario termino su ticket -> ahora si avanza el BPMN.
async function markDone(id) {
  const ticket = getTicket(id)
  if (!ticket) throw httpError(404, 'ticket no existe')
  if (ticket.status === 'DONE' || ticket.status === 'CLOSED') return ticket
  logEvent(id, ticket.variant, 'done.requested')
  const t0 = Date.now()
  if (ticket.variant === 'jobworker') {
    // Recien aqui se completa el job que se mantuvo abierto.
    await zeebe.completeJob({ jobKey: ticket.job_key, variables: {} })
  } else {
    let key = ticket.user_task_key
    if (!key) {
      key = (await searchUserTasks(ticket.process_instance_key)).items?.[0]?.userTaskKey
    }
    await completeUserTask(key)
  }
  logEvent(id, ticket.variant, 'done.accepted', { ms: Date.now() - t0 })
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
    if (req.method === 'GET' && url.pathname === '/config') return send(200, config)
    send(404, { error: 'ruta no existe' })
  } catch (e) {
    send(e.status ?? 500, { error: e.message })
  }
})

startJobWorker()
startListenerWorker()
startClosedWorker()
server.listen(config.port, () =>
  console.log(`backend en :${config.port} | jobTimeout=${config.jobTimeoutMs}ms | db=${config.dbFile}`),
)
