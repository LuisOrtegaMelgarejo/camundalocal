import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.js'

mkdirSync(dirname(config.dbFile), { recursive: true })
export const db = new DatabaseSync(config.dbFile)

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    variant TEXT NOT NULL,
    status TEXT NOT NULL,            -- NEW | FORM_PENDING | DONE | CLOSED
    process_instance_key TEXT,
    job_key TEXT,                    -- A: job abierto que hay que completar
    user_task_key TEXT,              -- B: user task que hay que completar
    form TEXT,                       -- JSON del form (null = aun no se creo)
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    ticket_id TEXT NOT NULL,
    variant TEXT NOT NULL,
    type TEXT NOT NULL,
    meta TEXT
  );
  CREATE INDEX IF NOT EXISTS events_ticket ON events(ticket_id, type);
`)

const insertEvent = db.prepare(
  'INSERT INTO events (ts, ticket_id, variant, type, meta) VALUES (?, ?, ?, ?, ?)',
)
export const logEvent = (ticketId, variant, type, meta) =>
  insertEvent.run(Date.now(), ticketId, variant, type, meta ? JSON.stringify(meta) : null)

export const getTicket = (id) => db.prepare('SELECT * FROM tickets WHERE id = ?').get(id)

export function updateTicket(id, fields) {
  const cols = Object.keys(fields)
  db.prepare(`UPDATE tickets SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
    ...cols.map((c) => fields[c]),
    id,
  )
}

export function resetAll() {
  db.exec('DELETE FROM events; DELETE FROM tickets;')
}
