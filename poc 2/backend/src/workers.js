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
// Alternativa A - User Task con implementacion "job worker".
// Una user task sin <zeebe:userTask/> genera un job de tipo fijo
// "io.camunda.zeebe:userTask" (no admite un tipo propio). Ese tipo es comun a TODAS
// las user tasks job-worker del cluster y no hay ningun id discriminador.
// El job NO se completa: completarlo haria avanzar el BPMN. Por eso, tras
// procesarlo, solo se hace forward() (no-op hacia el broker). Al vencer el
// timeout Zeebe lo vuelve a entregar y hay que descartar el duplicado con la
// logica "already processed". El job se completa recien cuando el usuario
// marca el ticket como done (ver server.js).
// ---------------------------------------------------------------------------
const deliveries = new Map() // jobKey -> n de entregas vistas (solo para medir)

export function startJobWorker() {
  return zeebe.createWorker({
    taskType: 'io.camunda.zeebe:userTask',
    timeout: config.jobTimeoutMs,
    maxJobsToActivate: config.workerMaxJobs,
    taskHandler: async (job) => {
      const t0 = Date.now()
      // Restriccion de negocio: la user task no lleva ningun id propio que la distinga
      // de otras; todo llega por el mismo tipo. Lo unico que correlaciona es la
      // variable de proceso ticketId. Sin ella (o sin ticket local) el job no es
      // nuestro: se devuelve sin tocarlo, con espera para no girar en vacio.
      const { ticketId } = job.variables
      const ticket = ticketId ? getTicket(ticketId) : null
      if (!ticket) {
        return job.fail({ errorMessage: 'sin ticketId conocido', retries: job.retries, retryBackOff: 5000 })
      }
      const delivery = (deliveries.get(job.key) ?? 0) + 1
      deliveries.set(job.key, delivery)
      const alreadyProcessed = Boolean(ticket.form)
      logEvent(ticketId, ticket.variant, 'notif.received', {
        kind: 'job', jobKey: job.key, delivery, duplicate: alreadyProcessed,
      })
      if (!alreadyProcessed) {
        updateTicket(ticketId, { job_key: job.key })
        await createFormOnce(ticket)
      } else if (config.discardDelayMs) {
        await sleep(config.discardDelayMs) // costo simulado de comprobar "already processed"
      }
      logEvent(ticketId, ticket.variant, 'notif.handled', {
        ms: Date.now() - t0, duplicate: alreadyProcessed,
      })
      return job.forward()
    },
  })
}

// ---------------------------------------------------------------------------
// Alternativa B - User Task nativo + task listener "creating" (diagrama pocListener).
// Zeebe entrega un job por el evento "creating". Se procesa y se COMPLETA: eso
// solo deja que la user task termine de crearse; el BPMN sigue parado en ella
// hasta que se complete la tarea. No hay timeout pendiente => no hay reenvios.
// ---------------------------------------------------------------------------
let headersLogged = false

export function startListenerWorker() {
  return zeebe.createWorker({
    taskType: 'creatingUserTask', // listener "creating" del diagrama pocListener
    timeout: config.jobTimeoutMs,
    maxJobsToActivate: config.workerMaxJobs,
    taskHandler: async (job) => {
      const t0 = Date.now()
      if (!headersLogged) {
        headersLogged = true
        console.log('[listener] customHeaders:', JSON.stringify(job.customHeaders))
      }
      const { ticketId } = job.variables
      const ticket = ticketId ? getTicket(ticketId) : null
      if (!ticket) {
        // Instancia creada fuera del backend (p. ej. a mano en SaaS): no hay form que crear.
        console.log(`[listener] instancia ${job.processInstanceKey} sin ticket local; se completa sin notificar`)
        return job.complete()
      }
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
// Execution listener "logStart" (evento START del proceso). Lo declara el diagrama
// pocListener de Web Modeler; no lleva ticketId asociado a una fila local, asi que
// solo se registra por consola y se completa para que la instancia siga.
// ---------------------------------------------------------------------------
export function startLogStartWorker() {
  return zeebe.createWorker({
    taskType: 'logStart',
    timeout: config.jobTimeoutMs,
    taskHandler: async (job) => {
      console.log(
        `[logStart] proceso=${job.bpmnProcessId} instancia=${job.processInstanceKey} elemento=${job.elementId} vars=${JSON.stringify(job.variables)}`,
      )
      return job.complete()
    },
  })
}

// ---------------------------------------------------------------------------
// Ambas alternativas terminan en un job "ticket-closed" (A: service task; B: execution
// listener del end event, unico anadido al diagrama pocListener): marca el instante en que el
// motor avanzo tras el done, sin depender del secondary storage.
// ---------------------------------------------------------------------------
export function startClosedWorker() {
  return zeebe.createWorker({
    taskType: 'ticket-closed',
    maxJobsToActivate: 64,
    taskHandler: async (job) => {
      const { ticketId } = job.variables
      const ticket = ticketId ? getTicket(ticketId) : null
      if (!ticket) return job.complete()
      updateTicket(ticketId, { status: 'CLOSED' })
      logEvent(ticketId, ticket.variant, 'closed.received')
      return job.complete()
    },
  })
}
