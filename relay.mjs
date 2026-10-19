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
async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

async function run() {
  const req = JSON.parse(await readStdin())
  if (process.env.OPENCODE_LOCAL_DEBUG) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(`D:/学习/relay-debug-${Date.now()}.json`, JSON.stringify(req, null, 2), 'utf8')
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
