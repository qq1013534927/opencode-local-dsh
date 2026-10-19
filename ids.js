/**
 * Canonical OpenCode session/request id derivation — ported from the
 * opencode2dsh ids.ts implementation (which itself ports opencode2api ids.go).
 *
 * The Zen endpoint validates that the session id has OpenCode's canonical
 * `ses_<12-hex><14-base62>` shape AND that the 12 hex chars decode to a real
 * (bitwise-inverted) timestamp. Non-conforming ids are rejected with 403.
 */

import { createHash, randomBytes } from 'node:crypto'

const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function base62Fixed(value, width) {
  let n = value
  const out = new Array(width)
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = BASE62_ALPHABET.charAt(Number(n % 62n))
    n /= 62n
  }
  return out.join('')
}

/**
 * The 12 hex chars a genuine OpenCode client emits: millisecond clock with a
 * per-millisecond sequence in the low 12 bits, bitwise-inverted.
 */
export function invertedTimestampHex(now = Date.now()) {
  const current = BigInt(Math.trunc(now)) * 0x1000n + 1n
  const inverted = ~current & 0xffffffffffffn
  return inverted.toString(16).padStart(12, '0')
}

/** sha256("prefix\0value") truncated to 12 bytes. */
export function stableID(prefix, value) {
  const sum = createHash('sha256').update(prefix + '\x00' + value).digest()
  return `${prefix}_${sum.subarray(0, 12).toString('hex')}`
}

export function randomID(prefix, size) {
  return `${prefix}_${randomBytes(size).toString('hex')}`
}

/** The conversation signal: JSON of the first user message's content. */
export function conversationSeed(messages) {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const encoded = JSON.stringify(message.content ?? null)
    if (encoded !== 'null' && encoded.length > 0) return encoded
  }
  return ''
}

const SESSION_MEMO_LIMIT = 1024
const sessionMemo = new Map()

/** Canonical `ses_…` id, memoized per conversation signal (stable across retries). */
export function canonicalSessionID(signal) {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal
  const memoized = sessionMemo.get(signal)
  if (memoized !== undefined) return memoized
  const sum = createHash('sha256').update('ses\x00' + signal).digest()
  const timePart = invertedTimestampHex()
  const randomPart = base62Fixed(BigInt('0x' + sum.subarray(6, 16).toString('hex')), 14)
  const session = `ses_${timePart}${randomPart}`
  if (sessionMemo.size >= SESSION_MEMO_LIMIT) {
    const oldest = sessionMemo.keys().next()
    if (!oldest.done) sessionMemo.delete(oldest.value)
  }
  sessionMemo.set(signal, session)
  return session
}

/**
 * The CLI-identical user agent.
 *
 * The gateway groups requests by TLS fingerprint AND by the client headers, so
 * the catalog request must look like the same client as the inference one —
 * otherwise the two land in different quota buckets. One source of truth:
 * every upstream request uses THIS function.
 */
export function opencodeUserAgent() {
  return `opencode/1.18.31 (${process.platform} ${process.arch}; node${process.versions.node})`
}

export function deriveRequestIDs(messages) {
  let signal = conversationSeed(messages)
  if (signal === '' || signal === '{}') signal = randomID('fallback', 16)
  return {
    session: canonicalSessionID(signal),
    request: randomID('req', 16),
    project: stableID('prj', 'opencode-local:dsh'),
  }
}

/** The full header set sent with every upstream request. */
export function disguiseHeaders(ids) {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
  }
}
