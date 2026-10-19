/**
 * Verify the /filter bridge route: the reliable path behind the free-only
 * switch. It must drive the running adapter directly and report the result.
 */
import { OpenCodeLocalAdapter } from '../adapter.js'
import { makeSettingsRoutes } from '../settings-bridge.js'
import { toOverrides } from '../config.js'

const logger = { info: () => {}, warn: () => {}, error: () => {} }
const adapter = new OpenCodeLocalAdapter({ logger }, undefined)
await adapter.warm()

let persisted = { freeOnly: null, models: null }
const routes = makeSettingsRoutes({
  async status() {
    return { ok: true, value: { ...adapter.status(), models: adapter.roster() } }
  },
  async probe(body, onResult) {
    return { ok: true, value: { results: await adapter.probe(body.ids, onResult) } }
  },
  async filter(body) {
    if (typeof body.freeOnly === 'boolean') {
      adapter.setFreeOnly(body.freeOnly)
      persisted.freeOnly = body.freeOnly
    }
    if (body.models && typeof body.models === 'object') {
      adapter.setOverrides(toOverrides(body.models))
      persisted.models = Object.keys(body.models).length
    }
    return { ok: true, value: { ...adapter.status(), models: adapter.roster() } }
  },
})

const filterRoute = routes.find((r) => r.path.endsWith('/filter'))
console.log('route registered:', filterRoute?.path)

/** Drive the route with a fake trusted request. */
async function callFilter(body) {
  let out = ''
  const res = {
    writeHead: () => {},
    end: (chunk) => {
      out = chunk
    },
  }
  const req = Object.assign(
    (async function* () {
      yield Buffer.from(JSON.stringify(body))
    })(),
    { method: 'POST', headers: { host: '127.0.0.1:4714' }, socket: { remoteAddress: '127.0.0.1' } },
  )
  await filterRoute.handler(req, res)
  return JSON.parse(out)
}

console.log('\n=== toggle freeOnly=false via /filter ===')
let r = await callFilter({ freeOnly: false })
console.log('ok:', r.ok, '| freeOnly:', r.value.freeOnly, '| exposed:', r.value.catalog.exposed)

console.log('\n=== toggle freeOnly=true via /filter ===')
r = await callFilter({ freeOnly: true })
console.log('ok:', r.ok, '| freeOnly:', r.value.freeOnly, '| exposed:', r.value.catalog.exposed)

console.log('\n=== bulk "tick free only" (freeOnly + models map) ===')
adapter.setFreeOnly(false) // reveal all rows so hidden flags are visible
const all = adapter.roster()
const models = {}
for (const row of all) {
  const free = row.free === true
  models[row.id] = { hidden: !free, contextWindow: 0, maxOutput: 0 }
}
r = await callFilter({ freeOnly: true, models })
const ticked = r.value.models.filter((m) => !m.hidden)
const hidden = r.value.models.filter((m) => m.hidden)
console.log('ok:', r.ok, '| freeOnly:', r.value.freeOnly)
console.log('ticked:', ticked.length, '| all free?', ticked.every((m) => m.free))
console.log('hidden:', hidden.length, '| all paid?', hidden.every((m) => !m.free))
console.log('persisted through filter handler:', JSON.stringify(persisted))

console.log('\nDONE')
process.exit(0)
