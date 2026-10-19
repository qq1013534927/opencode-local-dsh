/**
 * Verify the "tick free only" bulk action's EFFECT, using the same Host path
 * the card's mutate() drives: models.<id>.hidden flags + freeOnly.
 */
import { OpenCodeLocalAdapter } from '../adapter.js'
import { toOverrides } from '../config.js'

const logger = { info: () => {}, warn: () => {}, error: () => {} }
const adapter = new OpenCodeLocalAdapter({ logger }, undefined)
await adapter.warm()

const isFree = (id) => id.toLowerCase().includes('free') || id.toLowerCase() === 'big-pickle'

adapter.setFreeOnly(false) // list everything so we can see the hidden flags
const all = adapter.roster()
console.log('total rows:', all.length, '| free:', all.filter((r) => r.free).length)

// Build the map exactly as the card's selectFreeOnly() does.
const models = {}
for (const row of all) {
  const free = isFree(row.id)
  models[row.id] = { hidden: !free, contextWindow: 0, maxOutput: 0 }
}

console.log('\n=== after "tick free only" (freeOnly stays false to reveal flags) ===')
adapter.setOverrides(toOverrides(models))
const roster = adapter.roster()
const ticked = roster.filter((r) => !r.hidden)
const hidden = roster.filter((r) => r.hidden)
console.log('ticked rows:', ticked.length, '->', ticked.map((r) => r.id).join(', '))
console.log('hidden rows:', hidden.length)
console.log('every ticked row is free?', ticked.every((r) => r.free))
console.log('every hidden row is paid?', hidden.every((r) => !r.free))

console.log('\n=== with freeOnly also true (what the button writes) ===')
adapter.setFreeOnly(true)
const exposed = await adapter.listModels('opencode-local')
console.log('picker exposes:', exposed.length, '->', exposed.map((m) => m.id).join(', '))

console.log('\nDONE')
process.exit(0)
