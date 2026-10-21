import { readFile } from 'node:fs/promises'
import { isAbsolute, basename } from 'node:path'
import { config } from './config.js'
import { restFetch } from './camunda.js'

// El .form lo referencia la user task de la alternativa B (formId="userTaskForm").
const form = new FormData()
// Sin argumentos despliega todo. Con argumentos solo esos archivos de bpms/ (util en SaaS, para
// no publicar de nuevo el formulario ni el otro proceso): node src/deploy.js ticket-jobworker.bpmn
const files = process.argv.slice(2)
for (const f of files.length ? files : ['ticket-jobworker.bpmn', 'ticket-usertask.bpmn', 'userTaskForm.form']) {
  // Ruta absoluta = archivo suelto (p. ej. una copia sin los anadidos de la POC); si no, bpms/
  const abs = isAbsolute(f) || /^[A-Za-z]:/.test(f)
  const buf = await readFile(abs ? f : new URL(`../../bpms/${f}`, import.meta.url))
  form.append('resources', new Blob([buf]), abs ? basename(f) : f)
}
console.log(`Desplegando en ${config.target} (${config.restBase})`)
const res = await restFetch('POST', '/deployments', form)
console.log(res.status, (await res.text()).slice(0, 600))
if (!res.ok) process.exit(1)
process.exit(0) // el cliente gRPC del SDK deja handles abiertos
