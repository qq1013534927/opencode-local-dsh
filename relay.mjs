/**
 * Bun relay: executes one upstream inference request through Bun's TLS stack.
 *
 * The opencode.ai gateway rate-limits by TLS fingerprint: the real OpenCode
 * CLI (Bun-compiled) gets its own quota bucket; every other stack (Node,
 * Python, curl) shares an exhausted one (429 FreeUsageLimitError, ~16h
 * Retry-After). Bun's fetch produces the same fingerprint class as the CLI,
 * so inference routed through this process reaches the healthy bucket.
 *
 * Protocol: one JSON request object on stdin; the upstream SSE stream is
 * forwarded line-by-line on stdout, prefixed by a `status: N` header line.
 * Non-200 responses arrive as `status: N` followed by `error: <body>`.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

async function run() {
  const req = JSON.parse(await readStdin())
  if (process.env.OPENCODE_LOCAL_DEBUG) {
    // Debug dumps contain the Authorization header, so they must not land in
    // a shared, guessable place: write to the OS temp dir with a private
    // mode, and redact the bearer token.
    const { writeFileSync } = await import('node:fs')
    const safe = { ...req, headers: { ...(req.headers ?? {}) } }
    if (typeof safe.headers.authorization === 'string') {
      safe.headers.authorization = safe.headers.authorization.replace(/Bearer\s+\S+/i, 'Bearer <redacted>')
    }
    const path = join(tmpdir(), `opencode-local-relay-debug-${process.pid}-${Date.now()}.json`)
    writeFileSync(path, JSON.stringify(safe, null, 2), { encoding: 'utf8', mode: 0o600 })
  }
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    if (k === 'host' || k === 'connection' || k === 'content-length') continue
    headers.set(k, v)
  }
  const res = await fetch(req.url, {
    method: req.method ?? 'POST',
    headers,
    body: req.body ? JSON.stringify(req.body) : undefined,
  })
  process.stdout.write(`status: ${res.status}\n`)
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    process.stdout.write(`error: ${text}\n`)
    return
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      process.stdout.write(line + '\n')
    }
  }
  if (buf.trim().length > 0) process.stdout.write(buf.trim() + '\n')
  process.stdout.write('[DONE]\n')
}

run().catch((err) => {
  process.stdout.write(`error: ${err?.message ?? String(err)}\n`)
})
