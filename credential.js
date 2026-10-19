/**
 * Credential resolution for the user's OWN OpenCode account.
 *
 * Discovery order (all local, no network):
 *  1. `service.json` under the OpenCode state home — the file the OpenCode
 *     desktop app itself writes for `opencode-cli serve --service`; it carries
 *     the live URL and Basic-auth password. Locations checked:
 *       - $OPENCODE_STATE_HOME/opencode/service.json
 *       - ~/.local/state/opencode/service.json
 *       - %APPDATA%/ai.opencode.desktop/opencode/service.json (desktop override)
 *  2. Ask the running service for the ACTIVE opencode-account OAuth credential
 *     (GET /api/credential with Basic auth). This always reflects what the
 *     running client uses, including freshly rotated access tokens.
 *  3. Fallback: read the credential straight from the OpenCode SQLite DB
 *     (~/.local/share/opencode/opencode.db) via Node's built-in node:sqlite —
 *     works with the client CLOSED, as long as the cached token is unexpired.
 *     (The client refreshes the token only while running, so an expired DB
 *     token asks the user to open the client once.)
 *
 * The token is kept in memory only; it is never written to disk by this plugin.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function stateDirCandidates() {
  const out = []
  const env = process.env.OPENCODE_STATE_HOME?.trim()
  if (env) out.push(join(env, 'opencode'))
  out.push(join(homedir(), '.local', 'state', 'opencode'))
  const appData = process.env.APPDATA?.trim()
  if (appData) out.push(join(appData, 'ai.opencode.desktop', 'opencode'))
  return out
}

/** Read the desktop/service discovery file, first hit wins. */
export async function findServiceFile() {
  for (const dir of stateDirCandidates()) {
    for (const name of ['service.json', 'service-local.json']) {
      const path = join(dir, name)
      if (!existsSync(path)) continue
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8'))
        if (typeof parsed.url === 'string' && /^https?:\/\//.test(parsed.url)) return parsed
      } catch {
        // unreadable/corrupt file: keep looking
      }
    }
  }
  return null
}

const FETCH_TIMEOUT_MS = 15_000

/** fetch with timeout for local service calls. */
async function localFetch(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: options.signal ?? controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask the running OpenCode server for the active opencode-account credential.
 */
async function credentialFromService(serverUrl, password) {
  const headers = { accept: 'application/json' }
  if (password) headers.authorization = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64')
  let payload
  try {
    const res = await localFetch(serverUrl.replace(/\/+$/, '') + '/api/credential', { headers })
    if (!res.ok) return null
    payload = await res.json()
  } catch {
    return null
  }
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : []
  for (const row of rows) {
    if (row?.integrationID !== 'opencode' && row?.integration !== 'opencode') continue
    if (row?.active !== true && row?.active !== 1) continue
    const value = row.value ?? {}
    const token = typeof value.access === 'string' ? value.access : undefined
    if (!token) continue
    const meta = value.metadata ?? {}
    return {
      serverUrl,
      serverPassword: password,
      accessToken: token,
      source: 'local service /api/credential',
      account: typeof meta.email === 'string' ? meta.email : undefined,
      expires: typeof value.expires === 'number' ? value.expires : undefined,
    }
  }
  return null
}

/** Candidate locations for the OpenCode SQLite DB (fallback credential source). */
export function opencodeDbCandidates() {
  const out = []
  const env = process.env.OPENCODE_DATA_HOME?.trim()
  if (env) out.push(join(env, 'opencode.db'))
  out.push(join(homedir(), '.local', 'share', 'opencode', 'opencode.db'))
  return out
}

/**
 * Fallback: read the active opencode-account credential straight from the
 * OpenCode SQLite DB (works with the client closed). Returns null when the DB
 * or node:sqlite is unavailable; throws when the cached token is expired
 * (only the running client can refresh it).
 */
export function credentialFromDb(logger) {
  let DatabaseSync
  try {
    ;({ DatabaseSync } = require('node:sqlite'))
  } catch {
    logger?.warn?.('opencode-local: node:sqlite unavailable; DB credential fallback disabled')
    return null
  }
  for (const path of opencodeDbCandidates()) {
    if (!existsSync(path)) continue
    let db
    try {
      db = new DatabaseSync(path, { readOnly: true })
      const row = db
        .prepare("SELECT value FROM credential WHERE integration_id='opencode' AND active=1")
        .get()
      if (!row) continue
      const value = JSON.parse(row.value)
      const token = value?.access
      if (typeof token !== 'string' || token.length === 0) continue
      const expires = typeof value?.expires === 'number' ? value.expires : undefined
      if (expires !== undefined && Date.now() > expires) {
        throw new Error(
          `opencode-local: 本地缓存的 OpenCode 凭据已过期（${new Date(expires).toISOString()}）。` +
            '请打开 OpenCode 客户端一次以刷新 token，之后即可关闭使用。',
        )
      }
      const meta = value?.metadata ?? {}
      logger?.info?.('opencode-local: credential from local opencode.db (client may be closed)')
      return {
        serverUrl: '',
        accessToken: token,
        source: 'local opencode.db',
        account: typeof meta.email === 'string' ? meta.email : undefined,
        expires,
      }
    } catch (err) {
      if (err?.message?.startsWith('opencode-local:')) throw err
      // unreadable/corrupt DB: keep looking
    } finally {
      try {
        db?.close()
      } catch {
        /* ignore */
      }
    }
  }
  return null
}

/**
 * Resolve the user's own OpenCode lane.
 */
export async function resolveLocalOpencode(explicitToken, logger) {
  if (explicitToken && String(explicitToken).trim().length > 0) {
    logger?.info?.('opencode-local: using configured explicit access token')
    return {
      serverUrl: '',
      accessToken: String(explicitToken).trim(),
      source: 'explicit config token',
    }
  }

  const service = await findServiceFile()
  if (service) {
    const via = await credentialFromService(service.url, service.password)
    if (via) {
      logger?.info?.(
        `opencode-local: credential from running OpenCode (${service.url})${via.account ? `, account ${via.account}` : ''}`,
      )
      return via
    }
    logger?.warn?.(`opencode-local: service file at ${service.url} but no active opencode credential; is the app logged in?`)
  } else {
    logger?.warn?.('opencode-local: no OpenCode service.json found — is the OpenCode desktop app / `opencode serve` running?')
  }

  // Fallback: read the cached credential from the local DB (client may be closed).
  const viaDb = credentialFromDb(logger)
  if (viaDb) return viaDb

  throw new Error(
    'opencode-local: 无法找到正在运行的 OpenCode。请先打开 OpenCode 客户端并登录，然后重启 DSH。' +
      ' (Open the OpenCode desktop app (logged in) or run `opencode serve`, then restart DSH.)',
  )
}
