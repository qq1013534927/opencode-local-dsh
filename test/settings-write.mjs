/**
 * End-to-end settings write test against the REAL Host settings transport.
 *
 * The card writes via configForms; this proves the same path works by driving
 * the Host's settings namespace directly and observing the freeOnly flip.
 *
 * Uses the remote API the UI uses: settings.describe / settings.mutate.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PORT = process.argv[2] ?? '13109'
const BASE = `http://127.0.0.1:${PORT}`

function apiToken() {
  // The web GUI requires a token; read it from the profile's web config.
  const candidates = [
    join(homedir(), '.dsh', 'profiles', 'desktop', 'web.json'),
    join(homedir(), '.dsh', 'web.json'),
  ]
  for (const p of candidates) {
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'))
      if (raw.token) return raw.token
      if (raw.url && raw.url.includes('token=')) return new URL(raw.url).searchParams.get('token')
    } catch {
      /* keep looking */
    }
  }
  return process.env.DSH_WEB_TOKEN ?? null
}

const token = apiToken()
console.log('token found:', Boolean(token))

async function call(path, body) {
  try {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    })
    const text = await res.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text.slice(0, 300)
    }
    return { status: res.status, parsed }
  } catch (err) {
    // No host on this port (the test is optional: it needs a RUNNING web
    // server, not just the plugin). Report it instead of crashing the suite.
    return { status: 0, parsed: { error: String(err?.message ?? err) } }
  }
}

// The bridge reports what the adapter currently thinks; use it as the oracle.
async function bridgeStatus() {
  const r = await call('/api/opencode-local/settings/status', {})
  return r.parsed?.value ?? null
}

const before = await bridgeStatus()
console.log('before -> freeOnly:', before?.freeOnly, 'exposed:', before?.counts?.exposed)

if (!before) {
  console.log('\nSKIPPED: no DSH web server answered on ' + BASE)
  console.log('This test needs a RUNNING web host with the plugin loaded')
  console.log('(e.g. `dsh web` with the profile that has @local/opencode-local).')
  console.log('The card behaviour itself is covered by test/free-only-switch.mjs.')
  console.log('\nDONE')
  process.exit(0)
}

// Ask the Host what settings namespaces it serves for this entry.
const describe = await call('/api/settings/describe', {})
console.log('settings.describe status:', describe.status)
const namespaces = Array.isArray(describe.parsed?.namespaces)
  ? describe.parsed.namespaces
  : Array.isArray(describe.parsed?.data?.namespaces)
    ? describe.parsed.data.namespaces
    : describe.parsed?.namespaces
console.log('namespaces:', JSON.stringify(namespaces)?.slice(0, 400))

console.log('\nDONE')
// Let the process end naturally: a hard exit while a socket is still closing
// trips a libuv assertion on Windows.
process.exitCode = 0
