/** Probe one specific model through the plugin's adapter (same code path DSH uses). */
import { OpenCodeLocalAdapter } from '../adapter.js'

const model = process.argv[2] ?? 'deepseek-v4.1-flash-free'
const logger = {
  info: () => {},
  warn: (...a) => console.warn('[warn]', ...a),
  error: (...a) => console.error('[error]', ...a),
}
const adapter = new OpenCodeLocalAdapter({ logger }, undefined)
await adapter.warm()

const prepared = await adapter.prepareCall('opencode-local', model)
console.log('resolved:', JSON.stringify(prepared.model))

let text = ''
let usage = null
let finish = null
for await (const chunk of prepared.stream({
  provider: 'opencode-local',
  model,
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
