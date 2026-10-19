import { readFile } from 'node:fs/promises'
import { config } from './config.js'

const form = new FormData()
for (const f of ['ticket-jobworker.bpmn', 'ticket-usertask.bpmn']) {
  const buf = await readFile(new URL(`../../bpms/${f}`, import.meta.url))
  form.append('resources', new Blob([buf]), f)
}
const res = await fetch(`${config.restBase}/deployments`, { method: 'POST', body: form })
console.log(res.status, (await res.text()).slice(0, 600))
if (!res.ok) process.exit(1)
