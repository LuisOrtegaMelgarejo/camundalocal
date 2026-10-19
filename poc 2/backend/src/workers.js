import { zeebe } from './camunda.js'
import { config } from './config.js'
import { getTicket, updateTicket, logEvent } from './db.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// "Crea el form" para el usuario. La columna form solo se escribe una vez.
async function createFormOnce(ticket) {
  if (ticket.form) return
  await sleep(config.formDelayMs) // trabajo simulado
  updateTicket(ticket.id, {
    form: JSON.stringify({ fields: ['descripcion', 'monto', 'adjunto'] }),
    status: 'FORM_PENDING',
  })
  logEvent(ticket.id, ticket.variant, 'form.created')
}

// ---------------------------------------------------------------------------
// Alternativa A - Job Worker.
// El job NO se completa: completarlo haria avanzar el BPMN. Por eso, tras
// procesarlo, solo se hace forward() (no-op hacia el broker). Al vencer el
// timeout Zeebe lo vuelve a entregar y hay que descartar el duplicado con la
// logica "already processed". El job se completa recien cuando el usuario
// marca el ticket como done (ver server.js).
// ---------------------------------------------------------------------------
const deliveries = new Map() // jobKey -> n de entregas vistas (solo para medir)

export function startJobWorker() {
  return zeebe.createWorker({
    taskType: 'ticket-form',
    timeout: config.jobTimeoutMs,
    maxJobsToActivate: 64,
    taskHandler: async (job) => {
      const t0 = Date.now()
      const { ticketId } = job.variables
      const ticket = getTicket(ticketId)
      const delivery = (deliveries.get(job.key) ?? 0) + 1
      deliveries.set(job.key, delivery)
      const alreadyProcessed = Boolean(ticket.form)
      logEvent(ticketId, ticket.variant, 'notif.received', {
        kind: 'job', jobKey: job.key, delivery, duplicate: alreadyProcessed,
      })
      if (!alreadyProcessed) {
        updateTicket(ticketId, { job_key: job.key })
        await createFormOnce(ticket)
      }
      logEvent(ticketId, ticket.variant, 'notif.handled', {
        ms: Date.now() - t0, duplicate: alreadyProcessed,
      })
      return job.forward()
    },
  })
}

// ---------------------------------------------------------------------------
// Alternativa B - User Task nativo + task listener "creating".
// Zeebe entrega un job por el evento "creating". Se procesa y se COMPLETA: eso
// solo deja que la user task termine de crearse; el BPMN sigue parado en ella
// hasta que se complete la tarea. No hay timeout pendiente => no hay reenvios.
// ---------------------------------------------------------------------------
let headersLogged = false

export function startListenerWorker() {
  return zeebe.createWorker({
    taskType: 'ticket-created',
    timeout: config.jobTimeoutMs,
    maxJobsToActivate: 64,
    taskHandler: async (job) => {
      const t0 = Date.now()
      if (!headersLogged) {
        headersLogged = true
        console.log('[listener] customHeaders:', JSON.stringify(job.customHeaders))
      }
      const { ticketId } = job.variables
      const ticket = getTicket(ticketId)
      logEvent(ticketId, ticket.variant, 'notif.received', {
        kind: 'listener', jobKey: job.key, delivery: 1, duplicate: Boolean(ticket.form),
      })
      updateTicket(ticketId, {
        user_task_key: job.customHeaders['io.camunda.zeebe:userTaskKey'] ?? null,
      })
      await createFormOnce(ticket)
      logEvent(ticketId, ticket.variant, 'notif.handled', { ms: Date.now() - t0, duplicate: false })
      const tAck = Date.now()
      const res = await job.complete() // knowledged: el BPMN NO avanza
      logEvent(ticketId, ticket.variant, 'notif.acked', { ms: Date.now() - tAck })
      return res
    },
  })
}

// ---------------------------------------------------------------------------
// Ambas alternativas terminan en este service task: marca el instante en que el
// motor avanzo tras el done, sin depender del secondary storage.
// ---------------------------------------------------------------------------
export function startClosedWorker() {
  return zeebe.createWorker({
    taskType: 'ticket-closed',
    maxJobsToActivate: 64,
    taskHandler: async (job) => {
      const { ticketId } = job.variables
      const ticket = getTicket(ticketId)
      updateTicket(ticketId, { status: 'CLOSED' })
      logEvent(ticketId, ticket.variant, 'closed.received')
      return job.complete()
    },
  })
}
