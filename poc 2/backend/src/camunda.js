import { Camunda8 } from '@camunda8/sdk'
import { config } from './config.js'

const IS_LOCAL = config.target === 'local'

// Local: sin auth (la API del compose de la raiz acepta llamadas sin token).
// SaaS: OAuth client credentials; el SDK renueva el token para gRPC.
const camunda = new Camunda8(
  IS_LOCAL
    ? { CAMUNDA_AUTH_STRATEGY: 'NONE', ZEEBE_GRPC_ADDRESS: config.grpcAddress }
    : {
        CAMUNDA_AUTH_STRATEGY: 'OAUTH',
        ZEEBE_GRPC_ADDRESS: config.saas.address,
        ZEEBE_CLIENT_ID: config.saas.clientId,
        ZEEBE_CLIENT_SECRET: config.saas.clientSecret,
        CAMUNDA_OAUTH_URL: config.saas.oauthUrl,
        ZEEBE_TOKEN_AUDIENCE: config.saas.audience,
      },
)
export const zeebe = camunda.getZeebeGrpcApiClient()

// Token para la API REST (cache simple).
let cachedToken = null
let tokenExpiresAt = 0
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 30_000) return cachedToken
  const res = await fetch(config.saas.oauthUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.saas.clientId,
      client_secret: config.saas.clientSecret,
      audience: config.saas.audience,
    }),
  })
  if (!res.ok) throw new Error(`OAuth ${res.status}: ${await res.text()}`)
  const data = await res.json()
  cachedToken = data.access_token
  tokenExpiresAt = Date.now() + data.expires_in * 1000
  return cachedToken
}

// body: objeto (se envia como JSON) o FormData (multipart). Devuelve la Response.
export async function restFetch(method, path, body) {
  const headers = IS_LOCAL ? {} : { Authorization: `Bearer ${await getToken()}` }
  let payload
  if (body instanceof FormData) payload = body
  else if (body) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  return fetch(`${config.restBase}${path}`, { method, headers, body: payload })
}

async function rest(method, path, body) {
  const res = await restFetch(method, path, body)
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json().catch(() => null)
}

export const completeUserTask = (userTaskKey) =>
  rest('POST', `/user-tasks/${userTaskKey}/completion`, {})

export const searchUserTasks = (processInstanceKey) =>
  rest('POST', '/user-tasks/search', { filter: { processInstanceKey: String(processInstanceKey) } })
