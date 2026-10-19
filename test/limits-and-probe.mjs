/**
 * Verify the 0.3.1 fixes:
 *   1. context/limits come from the running OpenCode runtime (authoritative)
 *   2. probe streams results one by one (callback fires per model)
 *   3. unavailable models classify as MODEL_UNAVAILABLE
 */
import { OpenCodeLocalAdapter } from '../adapter.js'
import { makeSettingsRoutes } from '../settings-bridge.js'
import { classifyError } from '../wire.js'

const logger = { info: () => {}, warn: (...a) => console.warn('[warn]', ...a), error: (...a) => console.error('[error]', ...a) }
const adapter = new OpenCodeLocalAdapter({ logger })
await adapter.warm()

console.log('=== roster limits (should match the runtime, not 262144 defaults) ===')
for (const m of adapter.roster()) {
  console.log(`  ${m.id.padEnd(32)} ctx=${m.contextWindow} out=${m.maxOutput} overridden=${m.contextWindowOverridden}`)
}

console.log('\n=== classifyError checks ===')
for (const [text, want] of [
  ['ModelProtocolUnsupported', 'MODEL_UNAVAILABLE'],
  ['ModelDeprecated', 'MODEL_UNAVAILABLE'],
  ['FreeUsageLimitError', 'RATE_LIMIT'],
  ['RegionError', 'REGION_BLOCKED'],
  ['FreeTierError', 'FREE_TIER_RESTRICTED'],
]) {
  const got = classifyError(text)
  console.log(`  ${text.padEnd(28)} -> ${got} ${got === want ? 'OK' : `WANT ${want}`}`)
}

console.log('\n=== probe with per-model streaming (order + timing) ===')
const targets = ['glm-5.3-flash-free', 'longcat-2.5-preview-free', 'jev-1.13-free']
const timeline = []
const results = await adapter.probe(targets, (r) => {
  timeline.push(`${r.id}: ${r.ok ? 'OK' : r.code}`)
  console.log(`  [streamed] ${r.id} -> ${r.ok ? 'OK' : r.code} (${r.latencyMs}ms)`)
})
console.log('callback order:', timeline.join(' | '))
console.log('total results:', results.length)

console.log('\n=== bridge SSE route (headers + event framing) ===')
const routes = makeSettingsRoutes({
  async status() {
    return { ok: true, value: { models: adapter.roster() } }
  },
  async probe(body, onResult) {
    return { ok: true, value: { results: await adapter.probe(body.ids, onResult) } }
  },
})
const probeRoute = routes.find((r) => r.path.endsWith('/probe'))
console.log('route:', probeRoute.path)

// Fake req/res to observe the SSE framing without a real socket.
const events = []
const res = {
  writeHead: (status, headers) => events.push(`HEAD ${status} ${headers['content-type']}`),
  write: (chunk) => events.push(String(chunk).trim().split('\n')[0]),
  end: () => events.push('END'),
}
const req = Object.assign(
  (async function* () {
    yield Buffer.from(JSON.stringify({ ids: ['glm-5.3-flash-free'] }))
  })(),
  { method: 'POST', headers: { host: '127.0.0.1:4714' }, socket: { remoteAddress: '127.0.0.1' } },
)
await probeRoute.handler(req, res)
console.log('SSE frames:')
for (const e of events) console.log('  ', e)

console.log('\nDONE')
process.exit(0)
