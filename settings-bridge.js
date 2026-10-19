/**
 * Settings bridge for the `opencode-local` plugin card (Settings → Plugins →
 * 本机 OpenCode 通道).
 *
 * The card needs more than the served settings form can carry:
 *   - the LIVE model roster (with per-model availability state),
 *   - an on-demand availability probe for one model or all of them,
 *   - the resolved context window / output cap per model.
 *
 * Those ride a small loopback-only HTTP route pair, matching the trust model
 * of the reference implementation (dsh-llm-proxy / opencode2dsh): loopback
 * socket + canonical loopback Host + same-origin browser request.
 *
 * Settings reads/writes themselves stay on the official settings transport
 * (`configForms`), so this bridge deliberately carries no settings surface.
 */

/** Bridge route prefix (same-origin, loopback-only). */
export const SETTINGS_BRIDGE_PREFIX = '/api/opencode-local/settings'

/** Cap on JSON request bodies (a probe trigger is tiny). */
const MAX_JSON_BODY_BYTES = 16 * 1024

// -- trust --------------------------------------------------------------------

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

function parseAuthority(authority) {
  if (authority.trim() !== authority) return undefined
  const match = authority.startsWith('[')
    ? /^\[[^\]]+\](?::([0-9]+))?$/.exec(authority)
    : /^[^:@/?#\s]+(?::([0-9]+))?$/.exec(authority)
  if (match === null) return undefined
  try {
    const url = new URL('http://' + authority)
    if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      return undefined
    }
    const rawPort = match[1]
    if (rawPort !== undefined && (String(Number(rawPort)) !== rawPort || Number(rawPort) > 65535)) return undefined
    return { url }
  } catch {
    return undefined
  }
}

function isSameOriginRequest(request, hostUrl) {
  const headers = request.headers
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return true
  try {
    return new URL(String(origin)).host === hostUrl.host
  } catch {
    return false
  }
}

/** Hot-path trust decision: loopback socket + canonical Host + same-origin. */
export function isTrustedBridgeRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  const parsed = parseAuthority(host)
  if (parsed === undefined || parsed.url.host.toLowerCase() !== host.toLowerCase()) return false
  if (!isSameOriginRequest(request, parsed.url)) return false
  return isLoopbackHostname(parsed.url.hostname)
}

// -- plumbing -----------------------------------------------------------------

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(Buffer.from(chunk))
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Build the loopback-guarded routes.
 *
 * handlers.status()  -> the live roster + token/catalog state
 * handlers.probe()   -> availability test for one model or all
 */
export function makeSettingsRoutes(handlers, deps = {}) {
  const guard = deps.guard ?? isTrustedBridgeRequest
  const check = (req, res) => {
    if (!guard(req)) {
      writeJson(res, 403, { error: 'forbidden' })
      return false
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method not allowed: ' + (req.method ?? '') })
      return false
    }
    return true
  }

  return [
    {
      kind: 'exact',
      path: `${SETTINGS_BRIDGE_PREFIX}/status`,
      handler: async (req, res) => {
        if (!check(req, res)) return
        const result = await handlers.status()
        writeJson(res, 200, result)
      },
    },
    {
      kind: 'exact',
      path: `${SETTINGS_BRIDGE_PREFIX}/probe`,
      handler: async (req, res) => {
        if (!check(req, res)) return
        let body
        try {
          body = await readJsonBody(req)
        } catch {
          body = undefined
        }
        if (body === undefined || typeof body !== 'object' || body === null) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: 'unreadable JSON body' })
          return
        }
        const result = await handlers.probe(body)
        writeJson(res, 200, result)
      },
    },
  ]
}
