/**
 * Needle test, calibrated. Answers the user's two questions:
 *   (a) with the card declaring 1M for deepseek-v4.1-flash-free, does it work?
 *   (b) can it REALLY read past the native 200k limit, or is input truncated?
 *
 * Calibration: the first run showed ~5.9 chars per reported input token for
 * this prose, so target sizes are computed from a MEASURED ratio, and the
 * output budget is large enough (and thinking disabled) so a reasoning model
 * does not burn the answer on hidden tokens.
 */
import { OpenCodeLocalAdapter } from '../adapter.js'

const logger = { info: () => {}, warn: () => {}, error: () => {} }
const MODEL = 'deepseek-v4.1-flash-free'
const CHARS_PER_TOKEN = 5.9 // measured from the first run's reported usage

const adapter = new OpenCodeLocalAdapter({ logger }, undefined)
await adapter.warm()
adapter.setOverrides({ [MODEL]: { contextWindow: 1048576, maxOutput: 32768 } })

const FILLER = 'The maintenance log records routine sensor telemetry for the platform. '
const NEEDLE_CODE = 'ARCHIVE-CODE-7731'

function haystack(targetTokens) {
  const targetChars = Math.floor(targetTokens * CHARS_PER_TOKEN)
  const repeats = Math.max(1, Math.floor(targetChars / FILLER.length))
  const third = Math.max(1, Math.floor(repeats / 3))
  const blocks = []
  for (let i = 0; i < third; i++) blocks.push(FILLER)
  blocks.push(`IMPORTANT: the archive code is ${NEEDLE_CODE}. Remember it. `)
  for (let i = 0; i < third * 2; i++) blocks.push(FILLER)
  return blocks.join('')
}

async function needle(targetTokens) {
  const text = haystack(targetTokens)
  let answer = ''
  let usage = null
  let finish = null
  let error = ''
  const started = Date.now()
  try {
    const prepared = await adapter.prepareCall('opencode-local', MODEL)
    for await (const chunk of prepared.stream({
      provider: 'opencode-local',
      model: MODEL,
      system: 'Answer only from the provided text. Do not think out loud.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `${text}\n\nQuestion: what is the archive code? Reply with ONLY the code, nothing else.`,
            },
          ],
        },
      ],
      maxTokens: 2000,
      // turn thinking off so the small budget reaches the answer
      reasoningEffort: 'off',
    })) {
      if (chunk.type === 'text-delta') answer += chunk.text
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') finish = chunk.reason
    }
  } catch (err) {
    error = String(err?.message ?? err)
  }
  const found = answer.includes(NEEDLE_CODE)
  const reported = usage?.inputTokens ?? 0
  console.log(
    `sent ~${String(targetTokens).padStart(6)} tok (${text.length} chars) | reported input=${reported} | ` +
      `answer=${JSON.stringify(answer.trim().slice(0, 48))} | ${found ? 'READ THROUGH' : 'LOST'} | ` +
      `${finish?.kind ?? '?'} | ${Date.now() - started}ms${error ? ` | ${error.slice(0, 80)}` : ''}`,
  )
  return { found, reported, finish: finish?.kind }
}

console.log('declared limit (card override): 1,048,576')
console.log('native metadata limit:          200,000')
console.log()

console.log('=== baseline: comfortably inside the native limit ===')
await needle(50000)
await needle(150000)

console.log('\n=== around the native 200k boundary ===')
await needle(190000)
await needle(210000)

console.log('\n=== clearly beyond the native 200k limit ===')
await needle(250000)
await needle(300000)

console.log('\nDONE')
process.exit(0)
