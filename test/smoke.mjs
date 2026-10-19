/**
 * Smoke test for the opencode-local plugin modules, run directly with node.
 * Exercises the same code paths DSH will: credential discovery -> listModels
 * -> prepareCall -> stream. No DSH installation required.
 */
import { OpenCodeLocalAdapter } from './adapter.js'
import { buildRequestBody, toOpenAIMessages } from './wire.js'
import { invertedTimestampHex, canonicalSessionID } from './ids.js'

const logger = {
  info: (...a) => console.log('[info]', ...a),
  warn: (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
}

// --- unit checks first ---
const hex = invertedTimestampHex()
console.assert(/^[0-9a-f]{12}$/.test(hex), 'invertedTimestampHex shape', hex)
const ses = canonicalSessionID('smoke-test-signal')
console.assert(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(ses), 'canonicalSessionID shape', ses)
console.assert(canonicalSessionID('smoke-test-signal') === ses, 'session memoized')

const body = buildRequestBody({
  model: 'x',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ name: 'bash', description: 'run', parameters: { type: 'object', properties: {} } }],
})
console.assert(body.stream === true, 'stream forced')
console.assert(body.tools.some((t) => t.function.name === 'read'), 'gate read tool injected')
console.assert(body.tool_choice === 'auto', 'auto with host tools')
const plain = buildRequestBody({ model: 'x', messages: [{ role: 'user', content: 'hi' }] })
console.assert(plain.tool_choice === 'none', 'none without host tools')
console.log('unit checks passed')

// --- live adapter ---
const adapter = new OpenCodeLocalAdapter({ logger }, undefined)

console.log('\n=== listModels ===')
const models = await adapter.listModels('opencode-local')
console.log(`models: ${models.length}`)
for (const m of models) console.log(' -', m.id, m.inputModalities)

if (models.length === 0) {
  console.error('NO MODELS — aborting stream test')
  process.exit(1)
}

// pick a probe model preferring known-working ones
const prefer = ['nemotron-3-ultra-free', 'longcat-2.5-preview-free']
const probe = prefer.find((id) => models.some((m) => m.id === id)) ?? models[0].id
console.log(`\n=== stream with ${probe} ===`)
const prepared = await adapter.prepareCall('opencode-local', probe)
console.log('resolved model:', JSON.stringify(prepared.model))

let text = ''
let usage = null
let finish = null
for await (const chunk of prepared.stream({
  provider: 'opencode-local',
  model: probe,
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }],
  maxTokens: 300,
})) {
  if (chunk.type === 'text-delta') text += chunk.text
  else if (chunk.type === 'usage') usage = chunk.usage
  else if (chunk.type === 'finish') finish = chunk.reason
}
console.log('text:', JSON.stringify(text))
console.log('usage:', JSON.stringify(usage))
console.log('finish:', JSON.stringify(finish))
console.log('\n=== status ===')
console.log(JSON.stringify(adapter.status(), null, 2))

const ok = text.length > 0 && finish?.kind === 'stop'
console.log(ok ? '\nSMOKE TEST PASSED' : '\nSMOKE TEST INCOMPLETE (see above)')
process.exit(ok ? 0 : 1)
