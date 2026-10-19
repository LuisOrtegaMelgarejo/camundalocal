import { Camunda8 } from '@camunda8/sdk'
import { config } from './config.js'

// Local: sin auth (la API del compose de la raiz acepta llamadas sin token).
const camunda = new Camunda8({
  CAMUNDA_AUTH_STRATEGY: 'NONE',
  ZEEBE_GRPC_ADDRESS: config.grpcAddress,
})
export const zeebe = camunda.getZeebeGrpcApiClient()

async function rest(method, path, body) {
  const res = await fetch(`${config.restBase}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json().catch(() => null)
}

export const completeUserTask = (userTaskKey) =>
  rest('POST', `/user-tasks/${userTaskKey}/completion`, {})

export const searchUserTasks = (processInstanceKey) =>
  rest('POST', '/user-tasks/search', { filter: { processInstanceKey: String(processInstanceKey) } })
