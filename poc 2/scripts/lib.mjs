// Utilidades compartidas por los scripts de la POC 2. Solo Node, sin dependencias.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, openSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

export const ROOT = fileURLToPath(new URL('../../', import.meta.url)) // raiz del repo (docker-compose.yml)
export const BACKEND = fileURLToPath(new URL('../backend/', import.meta.url))
const isWin = process.platform === 'win32'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Ejecuta un comando mostrando su salida; aborta si falla.
export function run(cmd, args, { cwd = BACKEND, env = {} } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: isWin, // npm y docker son .cmd/.exe en Windows
  })
  if (r.status !== 0) throw new Error(`Fallo (exit ${r.status}): ${cmd} ${args.join(' ')}`)
}

async function waitFor(label, check, tries, delayMs) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await check()) return
    } catch {}
    await sleep(delayMs)
  }
  throw new Error(`Timeout esperando: ${label}`)
}

// Los scripts y sus procesos hijos leen backend/.env (CAMUNDA_TARGET, credenciales).
try {
  process.loadEnvFile(join(BACKEND, '.env'))
} catch {}

// --target local|saas gana sobre lo que diga .env.
export function setTarget(target) {
  if (target) process.env.CAMUNDA_TARGET = target
}

export async function ensureCamunda() {
  if ((process.env.CAMUNDA_TARGET ?? 'local') === 'saas') {
    console.log('Entorno SaaS: no se levanta Docker.')
    return
  }
  console.log('Levantando Camunda...')
  run('docker', ['compose', 'up', '-d'], { cwd: ROOT })
  await waitFor(
    'Camunda healthy (puerto 9600)',
    async () => (await (await fetch('http://localhost:9600/actuator/health/status')).json()).status === 'UP',
    90,
    2000,
  )
}

export function ensureDeps() {
  if (!existsSync(join(BACKEND, 'node_modules'))) {
    console.log('Instalando dependencias...')
    run('npm', ['install', '--silent'])
  }
}

export function deployBpmn() {
  console.log('Desplegando BPMN...')
  run('node', ['src/deploy.js'])
}

// Arranca el backend en segundo plano; su salida va a backend/server.log.
export async function startBackend({ port, jobTimeoutMs }) {
  const log = openSync(join(BACKEND, 'server.log'), 'w')
  const child = spawn('node', ['--no-warnings', 'src/server.js'], {
    cwd: BACKEND,
    stdio: ['ignore', log, log],
    env: { ...process.env, PORT: String(port), JOB_TIMEOUT_MS: String(jobTimeoutMs) },
  })
  await waitFor(
    'backend (ver backend/server.log)',
    async () => (await fetch(`http://localhost:${port}/config`)).ok,
    30,
    1000,
  )
  return child
}

export function runBench({ port, tickets, doneAfterMs }) {
  run('node', ['--no-warnings', 'bench/bench.js'], {
    env: { API: `http://localhost:${port}`, TICKETS: String(tickets), DONE_AFTER_MS: String(doneAfterMs) },
  })
}

export const getReport = async (port) => (await fetch(`http://localhost:${port}/report`)).json()
