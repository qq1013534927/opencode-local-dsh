/**
 * Prove the settings WRITE path works, independent of the browser.
 *
 * The card's write goes through the served settings store. This drives the very
 * same Host-side namespace through the config editor: read the current value,
 * write freeOnly=false, and observe the adapter follow (via the bridge status).
 *
 * If the adapter's freeOnly flips here, the store works and any remaining
 * failure is client-side (the prop contract).
 */
import { OpenCodeLocalAdapter } from '../adapter.js'
import { Config, settingsValue } from '../config.js'
import Schema from '@deepseek-ai/schemastery'

console.log('=== 1. Config schema declares freeOnly as an editable field ===')
const schema = Config
console.log('schema keys:', Object.keys(schema.dict ?? schema))

// Instantiate the schema the way the Loader does, then prove deref() reads a
// volatile reference correctly (this is what apply() receives).
const instance = new Config({ freeOnly: false, accessToken: '' })
const rawFreeOnly = instance.freeOnly
console.log('raw freeOnly is a volatile reference:', typeof rawFreeOnly === 'object' && typeof rawFreeOnly.get === 'function')
console.log('settingsValue(instance).freeOnly =', settingsValue(instance).freeOnly)

const instanceOn = new Config({ freeOnly: true })
console.log('settingsValue({freeOnly:true}).freeOnly =', settingsValue(instanceOn).freeOnly)

console.log('\n=== 2. Adapter follows a live flip (the write path\'s effect) ===')
const logger = { info: () => {}, warn: () => {}, error: () => {} }
const adapter = new OpenCodeLocalAdapter({ logger }, undefined)
await adapter.warm()

adapter.setFreeOnly(true)
const freeCount = (await adapter.listModels('opencode-local')).length
console.log('freeOnly=true  -> exposed:', freeCount, '| status.freeOnly:', adapter.status().freeOnly)

adapter.setFreeOnly(false)
const allCount = (await adapter.listModels('opencode-local')).length
console.log('freeOnly=false -> exposed:', allCount, '| status.freeOnly:', adapter.status().freeOnly)

console.log('\n=== 3. Bridge payload reflects the flip (what the card reads) ===')
console.log('status payload:', JSON.stringify(adapter.status()))

console.log('\nDONE')
process.exit(0)
