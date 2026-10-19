/**
 * Host-side smoke test for 0.3: Config schema, overrides, roster and probe.
 * Run with node from the plugin directory.
 */
import { Config, readSettings, toOverrides, settingsValue } from '../config.js'
import { OpenCodeLocalAdapter } from '../adapter.js'
import { makeSettingsRoutes, isTrustedBridgeRequest } from '../settings-bridge.js'

const logger = { info: () => {}, warn: (...a) => console.warn('[warn]', ...a), error: (...a) => console.error('[error]', ...a) }

// --- Config schema ---
console.log('=== Config schema ===')
const resolved = new Config({})
console.log('defaults:', JSON.stringify({ freeOnly: resolved.freeOnly, refreshSeconds: resolved.refreshSeconds, models: resolved.models }))
const custom = new Config({ freeOnly: false, models: { 'glm-5.3-flash-free': { hidden: true, contextWindow: 500000 } } })
console.log('custom models:', JSON.stringify(custom.models))

// --- settings conversion ---
console.log('\n=== overrides conversion ===')
const overrides = toOverrides({ 'a-free': { hidden: true, contextWindow: 123456, maxOutput: 4096 }, 'b-free': { hidden: false } })
console.log('overrides:', JSON.stringify(overrides))
console.log('settingsValue:', JSON.stringify(settingsValue({ freeOnly: false })))

// --- adapter: overrides + roster + probe ---
console.log('\n=== adapter ===')
const adapter = new OpenCodeLocalAdapter({ logger })
await adapter.warm()
const rosterBefore = adapter.roster()
console.log('roster size:', rosterBefore.length)
console.log('sample:', JSON.stringify(rosterBefore.slice(0, 2)))

// hide one model and override its context
const target = rosterBefore[0]?.id
if (target) {
  adapter.setOverrides({ [target]: { hidden: true, contextWindow: 4242 } })
  const after = adapter.roster()
  const row = after.find((m) => m.id === target)
  console.log(`after hiding ${target}: hidden=${row?.hidden} ctx=${row?.contextWindow} overridden=${row?.contextWindowOverridden}`)
  const listed = (await adapter.listModels('opencode-local')).map((m) => m.id)
  console.log('visible list contains hidden model?', listed.includes(target))
  adapter.setOverrides({})
}

// --- probe a known-good model ---
console.log('\n=== probe ===')
const probeTarget = (await adapter.listModels('opencode-local')).map((m) => m.id)
const pick = ['longcat-2.5-preview-free', 'glm-5.3-flash-free'].find((id) => probeTarget.includes(id)) ?? probeTarget[0]
if (pick) {
  const results = await adapter.probe([pick])
  console.log(JSON.stringify(results, null, 2))
}

// --- bridge routes ---
console.log('\n=== bridge routes ===')
const routes = makeSettingsRoutes({
  async status() {
    return { ok: true, value: { ...adapter.status(), models: adapter.roster() } }
  },
  async probe(body) {
    return { ok: true, value: { results: await adapter.probe(Array.isArray(body.ids) ? body.ids : []) } }
  },
})
console.log('routes:', routes.map((r) => r.path).join(', '))
console.log('trust (no socket):', isTrustedBridgeRequest({ headers: {} }))
console.log('trust (loopback):', isTrustedBridgeRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:10006' } }))

console.log('\nHOST SMOKE OK')
process.exit(0)
