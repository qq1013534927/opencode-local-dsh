/**
 * Context-limit experiment for deepseek-v4.1-flash-free.
 *
 * Question: if the card declares 1M context for this model, does the upstream
 * actually serve requests beyond its declared 200k limit — or does the local
 * declaration only change what DSH believes?
 *
 * Method: drive the adapter with the override applied, send progressively
 * larger inputs, and record the finish reason + reported input tokens.
 */
import { OpenCodeLocalAdapter } from '../adapter.js'

const logger = { info: () => {}, warn: (...a) => console.warn('[warn]', ...a), error: (...a) => console.error('[error]', ...a) }
const MODEL = 'deepseek-v4.1-flash-free'

const adapter = new OpenCodeLocalAdapter({ logger })
await adapter.warm()
// Exactly what the card's "context override" does.
adapter.setOverrides({ [MODEL]: { contextWindow: 1048576, maxOutput: 32768 } })

const resolved = adapter.resolveModel('opencode-local', MODEL)
console.log('DSH would announce contextWindow =', resolved.context.contextWindow)
console.log('DSH would announce defaultMaxTokens =', resolved.defaultMaxTokens)
console.log()

const UNIT = 'The quick brown fox jumps over the lazy dog while the system records every observation carefully. '
const UNIT_TOKENS = UNIT.length / 4 // ~4 chars/token for English prose

function filler(targetTokens) {
  const repeats = Math.max(1, Math.round(targetTokens / UNIT_TOKENS))
  return UNIT.repeat(repeats)
}

async function attempt(label, targetTokens) {
  const text = filler(targetTokens)
  const started = Date.now()
  let finish = null
  let usage = null
  let error = ''
  try {
    const prepared = await adapter.prepareCall('opencode-local', MODEL)
    for await (const chunk of prepared.stream({
      provider: 'opencode-local',
      model: MODEL,
      system: 'You are a helpful assistant. Obey the instruction exactly.',
      messages: [{ role: 'user', content: [{ type: 'text', text: `${text}\n\nReply with exactly: DONE` }] }],
      maxTokens: 32,
    })) {
      if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') finish = chunk.reason
    }
  } catch (err) {
    error = String(err?.message ?? err)
  }
  const approx = Math.round(text.length / 4)
  console.log(
    `${label.padEnd(18)} chars=${text.length} ~tokens=${approx} | ` +
      `finish=${JSON.stringify(finish)} usage=${JSON.stringify(usage)} ` +
      `| ${Date.now() - started}ms ${error}`,
  )
  return { finish, usage, error }
}

console.log('=== probing sizes around the declared 200,000 limit ===')
await attempt('tiny(~500)', 500)
await attempt('mid(~20k)', 20000)
await attempt('below-200k(~190k)', 190000)
await attempt('above-200k(~250k)', 250000)

console.log('\nEXPERIMENT COMPLETE')
process.exit(0)
