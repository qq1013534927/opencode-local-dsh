/**
 * Verify 0.3.3: full opencode-lane catalog + one-click free filter.
 */
import { OpenCodeLocalAdapter } from '../adapter.js'

const logger = { info: () => {}, warn: () => {}, error: (...a) => console.error('[error]', ...a) }
const adapter = new OpenCodeLocalAdapter({ logger }, undefined)
await adapter.warm()

const s0 = adapter.status()
console.log('=== default (freeOnly=false: whole account catalog) ===')
console.log('counts:', JSON.stringify(s0.counts))
console.log('inventory:', JSON.stringify(adapter.roster().length), 'roster rows')
const allModels = await adapter.listModels('opencode-local')
console.log('exposed models:', allModels.length)
const paid = allModels.filter((m) => !m.id.includes('free') && m.id !== 'big-pickle')
console.log('paid sample:', paid.slice(0, 6).map((m) => m.id).join(', '))

console.log('\n=== flip freeOnly=true (one-click filter) ===')
adapter.setFreeOnly(true)
const freeModels = await adapter.listModels('opencode-local')
console.log('exposed models:', freeModels.length)
console.log('ids:', freeModels.map((m) => m.id).join(', '))
console.log('counts:', JSON.stringify(adapter.status().counts))

console.log('\n=== roster marks free vs paid ===')
adapter.setFreeOnly(false)
const roster = adapter.roster()
console.log('roster size:', roster.length)
console.log('free rows:', roster.filter((r) => r.free).length, '| paid rows:', roster.filter((r) => !r.free).length)

console.log('\n=== limits still authoritative after the merge ===')
for (const id of ['deepseek-v4.1-flash-free', 'glm-5.3', 'claude-sonnet-5', 'longcat-2.5-preview-free']) {
  const m = roster.find((r) => r.id === id)
  console.log(`  ${id.padEnd(30)} ${m ? `ctx=${m.contextWindow} out=${m.maxOutput} free=${m.free}` : '(absent)'}`)
}

console.log('\nDONE')
process.exit(0)
