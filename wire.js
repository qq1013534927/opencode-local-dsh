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

export const ZEN_CHAT_URL = 'https://opencode.ai/zen/v1/chat/completions'

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

export function classifyError(text) {
  if (/\bRegionError\b|not available in your country/i.test(text)) return 'REGION_BLOCKED'
  if (/\bFreeTierError\b|free tier can only be used from within OpenCode/i.test(text)) return 'FREE_TIER_RESTRICTED'
  if (/\bFreeUsageLimitError\b|rate.?limit/i.test(text)) return 'RATE_LIMIT'
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
      if (Array.isArray(calls) && calls.length > 0) {
        assistant.tool_calls = calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments ?? '{}' },
        }))
      }
      out.push(assistant)
      continue
    }
    if (message.role === 'tool') {
      const text = flattenText(message.content)
      out.push({ role: 'tool', tool_call_id: message.toolCallId ?? '', content: text || '(no output)' })
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
  if (signal) {
    if (signal.aborted) kill()
    else signal.addEventListener('abort', kill, { once: true })
  }

  proc.stdin.on('error', () => {})
  proc.stdin.end(JSON.stringify(request))

  async function* payloads() {
    let buffer = ''
    let status = null
    let errorText = ''
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
    if (status === null) throw new HttpError(0, 'bun relay produced no status line')
    if (status !== 200) throw new HttpError(status, errorText)
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

  let payloads
  try {
    payloads = await bunRelay(request, options.signal)
  } catch (err) {
    if (err?.code !== 'BUN_UNAVAILABLE') throw err
    payloads = await nodeDirect(request, options.signal)
  }

  let textIndex = 0
  let reasoningIndex = 1
  const toolIndices = new Map()
  let nextToolIndex = 2
  let finishReason = null
  let usage
  let sawAnything = false
  const openText = new Map()
  const openReasoning = new Map()
  const openTools = new Map()

  try {
    for await (const payload of payloads) {
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
          const id = typeof call.id === 'string' ? call.id : ''
          const fn = call.function ?? {}
          const name = typeof fn.name === 'string' ? fn.name : ''
          const argsDelta = typeof fn.arguments === 'string' ? fn.arguments : ''
          let index = toolIndices.get(id)
          if (index === undefined && id) {
            index = nextToolIndex
            nextToolIndex += 1
            toolIndices.set(id, index)
            openTools.set(index, { id, name, args: '' })
            yield { type: 'block-start', index, blockType: 'tool-call' }
          }
          if (index !== undefined) {
            const open = openTools.get(index)
            if (name) open.name = name
            open.args += argsDelta
            yield { type: 'tool-call-delta', index, id: open.id, name: open.name, argumentsDelta: argsDelta }
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
    yield { type: 'block-end', index, block: { type: 'tool-call', id: tool.id, name: tool.name, arguments: tool.args || '{}' } }
  }

  if (usage) yield { type: 'usage', usage }
  yield {
    type: 'finish',
    reason: finishReason ?? (sawAnything ? { kind: 'stop' } : { kind: 'error', failure: { message: 'opencode-local: stream ended without content', code: 'EMPTY_RESPONSE' } }),
  }
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
