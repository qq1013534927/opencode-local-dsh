/**
 * Where is the REAL input ceiling for a free model?
 *
 * The card's README claims the ceiling is "past the advertised 200k". The
 * measurement says otherwise: 249,318 tokens were served and 300,000 were
 * rejected — which brackets the ceiling at 262,144 (256k), the tier the
 * upstream actually enforces, not the 200,000 the metadata advertises.
 *
 * This walks the boundary in steps and records the upstream's own error, so
 * the number in the README is a measurement rather than a claim.
 */
import { OpenCodeLocalAdapter } from '../adapter.js'

const logger = { info: () => {}, warn: (...a) => console.warn('[warn]', ...a), error: () => {} }
const MODEL = 'deepseek-v4.1-flash-free'
const CHARS_PER_TOKEN = 5.9

const adapter = new OpenCodeLocalAdapter({ logger })
await adapter.warm()
adapter.setOverrides({ [MODEL]: { contextWindow: 1048576, maxOutput: 32768 } })

const FILLER = 'The maintenance log records routine sensor telemetry for the platform. '

function haystack(targetTokens) {
  const targetChars = Math.floor(targetTokens * CHARS_PER_TOKEN)
  const repeats = Math.max(1, Math.floor(targetChars / FILLER.length))
  return FILLER.repeat(repeats)
}

async function attempt(targetTokens) {
  const text = haystack(targetTokens)
  let finish = null
  let usage = null
  let error = ''
  const started = Date.now()
  try {
    const prepared = await adapter.prepareCall('opencode-local', MODEL)
    for await (const chunk of prepared.stream({
      provider: 'opencode-local',
      model: MODEL,
      system: 'Answer only from the provided text. Do not think out loud.',
      messages: [{ role: 'user', content: [{ type: 'text', text: `${text}\n\nQuestion: what is the archive code? Reply with ONLY the code, nothing else.` }] }],
      maxTokens: 64,
      reasoningEffort: 'off',
    })) {
      if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') finish = chunk.reason
    }
  } catch (err) {
    error = String(err?.message ?? err)
  }
  const reported = usage?.inputTokens ?? 0
  const code = finish?.failure?.code ?? '-'
  const msg = String(finish?.failure?.message ?? error).slice(0, 120)
  console.log(
    `target=${String(targetTokens).padStart(7)} reported=${String(reported).padStart(7)} ` +
      `finish=${String(finish?.kind ?? '-').padEnd(6)} code=${String(code).padEnd(16)} ${Date.now() - started}ms ${msg}`,
  )
  return { targetTokens, reported, code, kind: finish?.kind, msg }
}

console.log('the metadata advertises 200,000; the plugin default is 262,144 (256k)')
console.log('walking the boundary:\n')
for (const target of [200000, 240000, 250000, 256000, 262000, 270000, 280000, 300000]) {
  await attempt(target)
}

console.log('\nDONE')
process.exit(0)
