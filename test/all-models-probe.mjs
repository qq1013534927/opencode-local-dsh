/**
 * Can the adapter actually serve NON-opencode-provider models?
 *
 * The runtime directory lists every provider's models, but this plugin's
 * transport posts to https://opencode.ai/zen/v1 — so a model owned by another
 * provider (e.g. OpenRouter) may not be routable this way. Probe two of each
 * to decide whether to expose them.
 */
import { OpenCodeLocalAdapter } from '../adapter.js'

const logger = { info: () => {}, warn: () => {}, error: (...a) => console.error('[error]', ...a) }
const adapter = new OpenCodeLocalAdapter({ logger }, undefined)
adapter.setFreeOnly(false) // expose everything the runtime knows
await adapter.warm()

const all = (await adapter.listModels('opencode-local')).map((m) => m.id)
console.log('total models after runtime merge:', all.length)
console.log('sample non-free:', all.filter((id) => !id.includes('free')).slice(0, 8).join(', '))

// Probe a mix: a known free one, plus a few from other providers.
const candidates = [
  'deepseek-v4.1-flash-free',
  'glm-5.3',
  'claude-sonnet-5',
  'anthropic/claude-sonnet-5.5',
  'deepseek/deepseek-v4.1-flash-1017',
]
for (const id of candidates) {
  if (!all.includes(id)) {
    console.log(`${id.padEnd(38)} (not in list)`)
    continue
  }
  const r = await adapter.probeOne(id)
  console.log(`${id.padEnd(38)} ok=${r.ok} code=${r.code} ${r.message ? `| ${r.message.slice(0, 90)}` : ''}`)
}

console.log('\nDONE')
process.exit(0)
