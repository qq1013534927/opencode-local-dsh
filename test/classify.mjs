import { classifyError } from '../wire.js'

const cases = [
  ['opencode-local: HTTP 429 {"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}', 'RATE_LIMIT'],
  ['ModelProtocolUnsupported', 'MODEL_UNAVAILABLE'],
  ['ModelDeprecated', 'MODEL_UNAVAILABLE'],
  ['Model "jev-1.13-free" is unavailable', 'MODEL_UNAVAILABLE'],
  ['FreeUsageLimitError', 'RATE_LIMIT'],
  ['RegionError', 'REGION_BLOCKED'],
  ['FreeTierError', 'FREE_TIER_RESTRICTED'],
  ['HTTP 400 invalid request', 'INVALID_REQUEST'],
  ['opencode-local: HTTP 500 internal', 'SERVER'],
]

let bad = 0
for (const [text, want] of cases) {
  const got = classifyError(text)
  const ok = got === want
  if (!ok) bad += 1
  console.log(`${ok ? 'OK  ' : 'BAD '}${got.padEnd(22)} <- ${text.slice(0, 72)}`)
}
console.log(bad === 0 ? 'ALL CLASSIFICATIONS CORRECT' : `${bad} MISCLASSIFIED`)
process.exit(bad === 0 ? 0 : 1)
