/**
 * Wire layer: OpenAI chat-completions SSE stream from the user's own Zen lane
 * -> DSH harness StreamChunks.
 *
 * Transport: Bun relay first (see relay.mjs — the gateway rate-limits by TLS
 * fingerprint and only Bun shares the CLI's healthy quota bucket), Node
 * direct fetch as fallback for machines without Bun.
 *
 * The stream must end with `usage` then `finish` (harness contract).
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { deriveRequestIDs, disguiseHeaders } from './ids.js'

// Overridable so the offline regression test can point the transport at a local
// SSE server instead of the live gateway (and so a user can aim at a mirror).
export const ZEN_CHAT_URL = process.env.OPENCODE_LOCAL_ZEN_URL || 'https://opencode.ai/zen/v1/chat/completions'

const RELAY_PATH = fileURLToPath(new URL('./relay.mjs', import.meta.url))

const IS_WIN = process.platform === 'win32'

/** Resolve the real Bun executable (npm shim is a .ps1/.cmd, not spawnable;
 *  execFileSync('npm') also fails on Windows where npm is npm.cmd). */
let bunPathCache
function resolveBunPath() {
  if (bunPathCache !== undefined) return bunPathCache
  const exeNames = IS_WIN ? ['bun.exe'] : ['bun']
  // 1. scan PATH
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const name of exeNames) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) {
        bunPathCache = candidate
        return candidate
      }
    }
  }
  // 2. npm global package layout
  const npmGlobal = process.env.APPDATA ? join(process.env.APPDATA, 'npm') : null
  if (npmGlobal) {
    const candidate = join(npmGlobal, 'node_modules', 'bun', 'bin', exeNames[0])
    if (existsSync(candidate)) {
      bunPathCache = candidate
      return candidate
    }
  }
  // 3. ~/.bun/bin
  const home = join(homedir(), '.bun', 'bin', exeNames[0])
  if (existsSync(home)) {
    bunPathCache = home
    return home
  }
  bunPathCache = null
  return null
}

/** Free-lane gate tools (the account lane shares the same request-shape gate). */
export const GATE_TOOL_NAMES = ['bash', 'read']

function gateTool(name) {
  return {
    type: 'function',
    function: {
      name,
      description: 'Reserved for the host runtime; do not call it.',
      parameters: { type: 'object', properties: {} },
    },
  }
}

export class HttpError extends Error {
  constructor(status, text) {
    super(text || `upstream returned ${status}`)
    this.code = 'HTTP_ERROR'
    this.status = status
    this.text = text ?? ''
  }
}

/**
 * The upstream's IP-level free-lane refusal.
 *
 * The message is:
 *
 *   OpenCode's free models aren't available from your current network because
 *   we've detected abusive traffic from this IP address. This isn't related
 *   to your account. If you're on a VPN or proxy, turn it off and try again,
 *   or subscribe to OpenCode Go at https://opencode.ai/go to keep building.
 *
 * This is NOT a per-model failure and NOT an account problem: the whole
 * free lane is closed for this IP, so every model behind it answers the same
 * way. Retrying the remaining models only adds requests to an address the
 * upstream has already flagged, so the caller must stop instead of probing on.
 *
 * @param {string} text the upstream error body
 * @returns {boolean} true when the refusal is IP-level
 */
export function isIpLaneBlocked(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  // Both phrases are required: together they are the upstream's IP-level
  // refusal and nothing else. Keying on the wording (rather than on
  // "FreeTierError") is deliberate — the error BODY carries the message
  // without the type name, and the message alone must be recognised.
  return (
    /abusive traffic from this IP address/i.test(text) &&
    /free models aren't available from your current network/i.test(text)
  )
}

/**
 * The user-facing explanation for an IP-level block.
 *
 * It is deliberately specific: the upstream blames the network address, not
 * the account, and it tells the user what to do about it. Repeating it
 * verbatim beats a generic "unavailable".
 */
export const IP_LANE_BLOCK_MESSAGE =
  "OpenCode's free models aren't available from your current network because " +
  "we've detected abusive traffic from this IP address. This isn't related to your account. " +
  'If you are on a VPN or proxy, turn it off and try again, or subscribe to OpenCode Go at ' +
  'https://opencode.ai/go to keep building.'

export function classifyError(text) {
  if (/\bRegionError\b|not available in your country/i.test(text)) return 'REGION_BLOCKED'
  // Throttling first: the lane wraps rate limits as
  // "Upstream request failed: Endpoint is unavailable." which must NOT read as
  // a dead model.
  if (/\bFreeUsageLimitError\b|\b429\b|rate.?limit|too many requests/i.test(text)) return 'RATE_LIMIT'
  // The lane cannot serve this model at all (delisted, protocol-unsupported,
  // region-less, or unknown). Distinct from throttling so the card can say
  // "unavailable" instead of "rate limited".
  if (
    /\bModelProtocolUnsupported\b|ModelDeprecated|ModelNotFound/i.test(text) ||
    // "Model X is unavailable" / "not supported" / "has been retired" — the
    // model name sits between the quotes or bare, so match loosely but only
    // within a line that also names a model.
    /model\b.*\b(?:is unavailable|not supported|does not exist|has been retired|unknown model)\b/i.test(text) ||
    /\bno such model\b/i.test(text)
  ) {
    return 'MODEL_UNAVAILABLE'
  }
  if (/\bNotFoundError\b|\b404\b/.test(text)) return 'MODEL_UNAVAILABLE'
  // The IP-level block gets its OWN code: every model behind the free lane
  // answers identically, so the caller has to stop the batch instead of
  // probing every remaining model against an address the upstream flagged.
  if (isIpLaneBlocked(text)) return 'IP_LANE_BLOCKED'
  if (/\bFreeTierError\b|free tier can only be used from within OpenCode/i.test(text)) return 'FREE_TIER_RESTRICTED'
  if (/\b(?:401|403)\b/.test(text)) return 'AUTH'
  if (/insufficient|quota|billing|funds/i.test(text)) return 'QUOTA_EXCEEDED'
  if (/\b413\b|payload too large/i.test(text)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(text)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(text)) return 'SERVER'
  if (/time.?out|timeout/i.test(text)) return 'TIMEOUT'
  if (/\b(?:network|connection|socket|fetch|terminated|premature close)\b/i.test(text)) return 'TRANSPORT'
  return 'UPSTREAM'
}

/** Convert DSH-style messages (blocks) to OpenAI chat-completions messages. */
export function toOpenAIMessages(options) {
  const out = []
  /** Tool-call ids the previous assistant turn actually advertised (null = none yet). */
  let expectedToolIds = null
  if (typeof options.system === 'string' && options.system.length > 0) {
    out.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages) {
    if (message.role === 'system') {
      const text = flattenText(message.content)
      if (text) out.push({ role: 'system', content: text })
      continue
    }
    if (message.role === 'assistant') {
      const blocks = Array.isArray(message.content) ? message.content : []
      const text = blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('')
      const calls = (message.toolCalls ?? blocks.filter((b) => b?.type === 'tool-call'))
      const assistant = { role: 'assistant' }
      if (text) assistant.content = text
      else if (!calls?.length) assistant.content = ''
      // History is REPLAYED to the upstream on every turn, so a single
      // malformed call turns into a permanent 400 for the rest of the session:
      // MiniMax answers `[bad_request_error] invalid params, 400 (2013)` and no
      // later request in that conversation can recover. Two shapes have to be
      // filtered here, because the host has already stored them:
      //   - a tool call with an EMPTY name (a stream fragment — the host turns
      //     it into `unknown tool ""`),
      //   - arguments that are not a JSON object (the host turns it into
      //     `invalid arguments: "arguments" must be an object`).
      const kept = []
      if (Array.isArray(calls)) {
        for (const c of calls) {
          const name = typeof c?.name === 'string' ? c.name.trim() : ''
          if (name === '') continue
          const id = typeof c?.id === 'string' && c.id !== '' ? c.id : `call_${kept.length}`
          kept.push({ id, type: 'function', function: { name, arguments: normaliseArgs(c?.arguments) } })
        }
      }
      if (kept.length > 0) assistant.tool_calls = kept
      // Keep the expected-id set in step even when the turn is elided below, so
      // the results of the dropped calls are dropped with them.
      const phantomTurn = Array.isArray(calls) && calls.length > 0 && kept.length === 0
      expectedToolIds = new Set(kept.map((k) => k.id))
      if (phantomTurn && !text) continue
      out.push(assistant)
      continue
    }
    if (message.role === 'tool') {
      const id = message.toolCallId ?? ''
      // A result whose call was filtered out above would be an orphan the
      // upstream rejects outright — drop it with the call it belonged to.
      if (expectedToolIds !== null && !expectedToolIds.has(id)) continue
      const text = flattenText(message.content)
      out.push({ role: 'tool', tool_call_id: id, content: text || '(no output)' })
      continue
    }
    out.push({ role: 'user', content: userContent(message.content) })
  }
  return out
}

function flattenText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('')
}

/**
 * Coerce a tool call's arguments to a JSON-object STRING.
 *
 * The upstream validates the replayed history strictly: an arguments value that
 * is not a serialised object (a bare `}`, a truncated fragment, `null`, a
 * number) is answered with `invalid params`. A `{}` is honest — the call fails
 * with missing parameters, which the host can report — where the raw fragment
 * kills the whole session.
 */
function normaliseArgs(args) {
  if (typeof args === 'string') {
    const trimmed = args.trim()
    if (trimmed === '') return '{}'
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return trimmed
      return '{}'
    } catch {
      return '{}'
    }
  }
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    try {
      return JSON.stringify(args)
    } catch {
      return '{}'
    }
  }
  return '{}'
}

function userContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  let hasImage = false
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push({ type: 'text', text: block.text })
    } else if (block?.type === 'image' && typeof block.data === 'string') {
      parts.push({ type: 'image_url', image_url: { url: `data:${block.mimeType ?? 'image/png'};base64,${block.data}` } })
      hasImage = true
    }
  }
  if (!hasImage && parts.length === 1) return parts[0].text
  return parts.length > 0 ? parts : ''
}

/** Build the chat-completions body with the free-lane shape (stream + gate tools). */
export function buildRequestBody(options) {
  const body = {
    model: options.model,
    messages: toOpenAIMessages(options),
    stream: true,
  }
  const tools = (options.tools ?? []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters ?? { type: 'object', properties: {} } },
  }))
  const names = new Set(tools.map((t) => t.function.name))
  const missing = GATE_TOOL_NAMES.filter((n) => !names.has(n))
  body.tools = [...tools, ...missing.map((n) => gateTool(n))]
  body.tool_choice = (options.tools ?? []).length > 0 ? 'auto' : 'none'
  if (typeof options.maxTokens === 'number' && options.maxTokens > 0) body.max_tokens = options.maxTokens
  if (typeof options.temperature === 'number') body.temperature = options.temperature
  if (options.reasoningEffort && options.reasoningEffort !== 'off') body.reasoning_effort = options.reasoningEffort
  else if (options.reasoningEffort === 'off') body.reasoning_effort = 'none'
  return body
}

/**
 * Bun relay transport: spawn `bun run relay.mjs`, hand it the request on
 * stdin, read the forwarded SSE stream from stdout. Throws BUN_UNAVAILABLE
 * when Bun is missing (caller falls back to Node direct), HttpError for a
 * non-200 upstream status, TRANSPORT when the relay dies before status.
 */
function bunRelay(request, signal) {
  const bun = resolveBunPath()
  if (!bun) {
    const err = new Error('bun runtime unavailable')
    err.code = 'BUN_UNAVAILABLE'
    throw err
  }
  let proc
  try {
    proc = spawn(bun, ['run', RELAY_PATH], { stdio: ['pipe', 'pipe', 'pipe'] })
  } catch {
    const err = new Error('bun runtime unavailable')
    err.code = 'BUN_UNAVAILABLE'
    throw err
  }
  const spawnFailed = new Promise((resolve) => {
    proc.once('error', (err) => {
      const e = new Error(`bun spawn failed: ${err.message}`)
      e.code = 'BUN_UNAVAILABLE'
      resolve(e)
    })
  })

  const kill = () => { try { proc.kill() } catch { /* already gone */ } }
  let aborted = false
  if (signal) {
    if (signal.aborted) {
      aborted = true
      kill()
    } else {
      signal.addEventListener(
        'abort',
        () => {
          aborted = true
          kill()
        },
        { once: true },
      )
    }
  }

  proc.stdin.on('error', () => {})
  proc.stdin.end(JSON.stringify(request))

  async function* payloads() {
    let buffer = ''
    let status = null
    let errorText = ''
    try {
      for await (const chunk of proc.stdout) {
        const spawnErr = await Promise.race([spawnFailed, Promise.resolve(null)])
        if (spawnErr) throw spawnErr
        buffer += chunk.toString('utf8')
        let nl
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, '')
          buffer = buffer.slice(nl + 1)
          if (status === null) {
            if (line.startsWith('status: ')) status = Number(line.slice(8))
            continue
          }
          if (status !== 200) {
            if (line.startsWith('error: ')) errorText = line.slice(7)
            continue
          }
          if (line === '[DONE]') return
          if (line.startsWith('data:')) yield line.slice(5).trimStart()
        }
      }
      if (status === null) {
        // A cancelled request closes the pipe without a status line: report it
        // as such instead of the vague "no status line".
        if (aborted) throw new HttpError(0, 'request aborted')
        // The relay produced NOTHING: bun is present but unusable (it died, it
        // could not run the script, the TLS stack is broken). That must be
        // reported as BUN_UNAVAILABLE so the caller falls back to the Node
        // transport instead of failing the request outright.
        const err = new HttpError(0, 'bun relay produced no status line')
        err.code = 'BUN_UNAVAILABLE'
        throw err
      }
      if (status !== 200) throw new HttpError(status, errorText)
    } finally {
      // The relay process must ALWAYS be reaped: the generator can end early
      // (the `[DONE]` line above, an error, a cancelled request) and a
      // surviving `bun run relay.mjs` would linger for the whole session —
      // one leaked process per request.
      kill()
      // Detach the abort listener so a long-lived signal does not keep this
      // closure (and the process reference) alive.
      if (signal) signal.removeEventListener?.('abort', kill)
    }
  }

  return payloads()
}

/** Node direct transport (fallback when Bun is unavailable). */
async function* nodeDirect(request, signal) {
  let response
  try {
    response = await fetch(request.url, {
      method: request.method ?? 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
    })
  } catch (err) {
    throw new HttpError(0, `request failed: ${err?.message ?? err}`)
  }
  if (!response.ok || !response.body) {
    let text = ''
    try {
      text = await response.text()
    } catch {
      /* ignore */
    }
    throw new HttpError(response.status, text)
  }
  yield* parseSse(response.body.getReader())
}

/** Parse an SSE byte stream into payload strings. */
export async function* parseSse(reader) {
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let sep
    while ((sep = findSeparator(buffer)).sepAt >= 0) {
      const chunk = buffer.slice(0, sep.sepAt)
      buffer = buffer.slice(sep.sepAt + sep.sepLen)
      const dataLines = []
      for (const line of chunk.split(/\r?\n/)) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
      }
      if (dataLines.length > 0) yield dataLines.join('\n')
    }
  }
}

function findSeparator(buffer) {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf < 0 && crlf < 0) return { sepAt: -1, sepLen: 0 }
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { sepAt: crlf, sepLen: 4 }
  return { sepAt: lf, sepLen: 2 }
}

/**
 * Resolve the open tool-call slot a streaming delta belongs to.
 *
 * A logical tool call is announced ONCE with an `id` and then continued by
 * deltas that carry only `index` (OpenAI's streaming convention). Keying the
 * accumulator by `id ?? index` therefore splits ONE call into TWO blocks: the
 * real one, holding the truncated arguments, plus a nameless `call_N` stub
 * holding the tail. The stub reaches the host as `unknown tool ""`, its
 * arguments are not a JSON object, and the replayed history then fails upstream
 * with `invalid params`.
 *
 * Both keys are registered for a new slot and either one may resolve an
 * existing slot, so id-first and index-first gateways behave the same.
 * Exported for the offline regression test.
 */
export function resolveToolSlot(state, call) {
  const id = typeof call?.id === 'string' ? call.id : ''
  const fn = call?.function ?? {}
  const name = typeof fn.name === 'string' ? fn.name : ''
  const argsDelta = typeof fn.arguments === 'string' ? fn.arguments : ''
  const upstreamIndex = typeof call?.index === 'number' ? call.index : undefined
  const idxKey = upstreamIndex !== undefined ? `idx:${upstreamIndex}` : ''

  let index
  if (id !== '' && state.byKey.has(id)) index = state.byKey.get(id)
  else if (idxKey !== '' && state.byKey.has(idxKey)) index = state.byKey.get(idxKey)
  // No id, no index and no name: by definition a continuation fragment, never a
  // new call — append it to the slot that is currently open.
  else if (id === '' && idxKey === '' && name === '' && state.last !== undefined) index = state.last

  const created = index === undefined
  if (created) {
    index = state.next
    state.next += 1
    if (id !== '') state.byKey.set(id, index)
    if (idxKey !== '') state.byKey.set(idxKey, index)
    state.last = index
  }
  return { index, created, id: id !== '' ? id : `call_${index}`, name, argsDelta }
}

/** Stream one request. Yields harness chunks; always ends with usage+finish. */
export async function* streamChat(options, token) {
  const ids = deriveRequestIDs(options.messages)
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...disguiseHeaders(ids),
  }
  const body = buildRequestBody(options)
  const request = { url: ZEN_CHAT_URL, method: 'POST', headers, body }

  // The free lane throttles per REQUEST, not per session: the model that
  // answers 429 `Upstream request failed: Endpoint is unavailable.` one second
  // is served again the next. ONE bounded retry — only while nothing has been
  // streamed to the host yet — turns most of those into a normal answer.
  //
  // It is deliberately not a loop, and it never retries:
  //   - an IP-level refusal (retrying only feeds an address the upstream has
  //     already flagged, and the plugin is told to stop instead),
  //   - a 4xx about the request body itself (the body will not change),
  //   - a stream that already yielded chunks (a second answer would duplicate).
  const MAX_ATTEMPTS = 2
  const RETRY_DELAY_MS = 1200

  for (let attempt = 1; ; attempt += 1) {
    let textIndex = 0
    let reasoningIndex = 1
    const toolState = { next: 2, byKey: new Map(), last: undefined }
    let finishReason = null
    let usage
    let sawAnything = false
    const openText = new Map()
    const openReasoning = new Map()
    const openTools = new Map()

    try {
      let payloads
      try {
        payloads = await bunRelay(request, options.signal)
      } catch (err) {
        if (err?.code !== 'BUN_UNAVAILABLE') throw err
        payloads = await nodeDirect(request, options.signal)
      }

      // The relay is a GENERATOR, so its body only runs at the first iteration:
      // a bun that is present but UNUSABLE fails INSIDE the loop, not at the
      // call that created it. The old code only caught failures around that
      // call, so the request failed outright instead of falling back to Node.
      //
      // Priming the generator here surfaces that failure while the Node
      // transport is still an option. The primed payload is replayed below, so
      // nothing is lost. The priming happens INSIDE the main try/catch: an
      // upstream error (a 403, a 429) must still be reported as a stream error
      // rather than escaping as an exception.
      let primed = null
      let source = payloads
      try {
        primed = await payloads.next()
    } catch (err) {
      if (err?.code !== 'BUN_UNAVAILABLE') throw err
      source = await nodeDirect(request, options.signal)
      primed = null
    }
    if (primed && primed.done) primed = null
    if (primed) {
      source = (async function* replay() {
        yield primed.value
        for await (const p of payloads) yield p
      })()
    }

    for await (const payload of source) {
      if (payload === '[DONE]') break
      let obj
      try {
        obj = JSON.parse(payload)
      } catch {
        continue
      }
      const usageObj = obj.usage
      if (usageObj) {
        const cacheRead = num(usageObj.prompt_tokens_details?.cache_read)
        usage = {
          inputTokens: num(usageObj.prompt_tokens),
          outputTokens: num(usageObj.completion_tokens),
          ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
        }
      }
      const choice = obj.choices?.[0]
      if (!choice) continue
      const delta = choice.delta
      if (delta?.content) {
        sawAnything = true
        if (!openText.has(textIndex)) {
          openText.set(textIndex, '')
          yield { type: 'block-start', index: textIndex, blockType: 'text' }
        }
        const piece = String(delta.content)
        openText.set(textIndex, openText.get(textIndex) + piece)
        yield { type: 'text-delta', index: textIndex, text: piece }
      }
      const reasoning = delta?.reasoning_content ?? delta?.reasoning
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        sawAnything = true
        if (!openReasoning.has(reasoningIndex)) {
          openReasoning.set(reasoningIndex, '')
          yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
        }
        openReasoning.set(reasoningIndex, openReasoning.get(reasoningIndex) + reasoning)
        yield { type: 'reasoning-delta', index: reasoningIndex, text: reasoning }
      }
      const calls = delta?.tool_calls
      if (Array.isArray(calls)) {
        sawAnything = true
        for (const call of calls) {
          const slot = resolveToolSlot(toolState, call)
          const index = slot.index
          if (slot.created) {
            // `started` stays false until the slot has a NAME: a nameless
            // fragment must never be announced as a tool call, because the host
            // would try to execute one called "".
            openTools.set(index, { id: slot.id, name: slot.name, args: '', started: false })
          }
          const open = openTools.get(index)
          if (!open) continue
          if (slot.name) open.name = slot.name
          open.args += slot.argsDelta
          if (!open.started && open.name) {
            open.started = true
            yield { type: 'block-start', index, blockType: 'tool-call' }
          }
          if (open.started) {
            yield { type: 'tool-call-delta', index, id: open.id, name: open.name, argumentsDelta: slot.argsDelta }
          }
        }
      }
      const finish = choice.finish_reason
      if (typeof finish === 'string' && finish.length > 0) {
        if (finish === 'length') finishReason = { kind: 'max-tokens' }
        else if (finish === 'tool_calls' || finish === 'function_call') finishReason = { kind: 'tool-calls' }
        else finishReason = { kind: 'stop' }
      }
    }
    } catch (err) {
      if (attempt < MAX_ATTEMPTS && !sawAnything && !options.signal?.aborted && isTransientFailure(err)) {
        await delay(RETRY_DELAY_MS)
        continue
      }
      if (err instanceof HttpError) {
        const message = `opencode-local: HTTP ${err.status} ${err.text.slice(0, 300)}`
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message, code: classifyError(err.text || String(err.status)) } },
        }
        return
      }
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: `opencode-local: stream failed: ${err?.message ?? err}`,
            code: classifyError(String(err?.message ?? err)),
          },
        },
      }
      return
    }

    for (const [index, text] of openText) {
      yield { type: 'block-end', index, block: { type: 'text', text } }
    }
    for (const [index, text] of openReasoning) {
      yield { type: 'block-end', index, block: { type: 'reasoning', text } }
    }
    for (const [index, tool] of openTools) {
      // A slot that never received a name is a stream fragment, not a call.
      if (!tool.started || !tool.name) continue
      yield { type: 'block-end', index, block: { type: 'tool-call', id: tool.id, name: tool.name, arguments: tool.args || '{}' } }
    }

    if (usage) yield { type: 'usage', usage }
    yield {
      type: 'finish',
      reason: finishReason ?? (sawAnything ? { kind: 'stop' } : { kind: 'error', failure: { message: 'opencode-local: stream ended without content', code: 'EMPTY_RESPONSE' } }),
    }
    return
  }
}

/**
 * A failure worth ONE retry: the lane refused the request, not the request
 * itself. An IP-level lane closure is excluded — it is not a throttle.
 */
function isTransientFailure(err) {
  if (!(err instanceof HttpError)) return false
  if (err.status !== 429 && !(err.status >= 500 && err.status <= 599)) return false
  return !isIpLaneBlocked(err.text ?? '')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
