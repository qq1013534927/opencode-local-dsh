// What does the running OpenCode runtime say the limit IS, and what does the
// upstream say when the limit is exceeded?
import { resolveLocalOpencode } from '../credential.js'

const MODEL = 'deepseek-v4.1-flash-free'
const logger = { info: () => {}, warn: (...a) => console.warn('[warn]', ...a), error: () => {} }

const cred = await resolveLocalOpencode(undefined, logger)
console.log('server:', cred.serverUrl || '(none — DB fallback)')

if (cred.serverUrl) {
  const headers = { accept: 'application/json' }
  if (cred.serverPassword) headers.authorization = 'Basic ' + Buffer.from(`opencode:${cred.serverPassword}`).toString('base64')
  const res = await fetch(`${cred.serverUrl.replace(/\/+$/, '')}/api/model?directory=${encodeURIComponent(process.cwd())}`, { headers })
  const rows = await res.json()
  const list = Array.isArray(rows) ? rows : rows?.data ?? []
  const row = list.find((r) => r.modelID === MODEL || r.id === MODEL)
  console.log('\n--- the runtime entry for', MODEL, '---')
  console.log(JSON.stringify(row, null, 2).slice(0, 1200))
} else {
  console.log('\n(no running server — the runtime limits are not reachable)')
}
