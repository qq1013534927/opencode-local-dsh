/**
 * opencode-local DSH plugin entry.
 *
 * Registers a native LlmAdapter ("opencode-local") that routes DSH model calls
 * through YOUR OWN running OpenCode client:
 *   - reads the local OpenCode service discovery (service.json) written by the
 *     desktop app / `opencode serve`;
 *   - obtains your account's active OAuth credential from the running client
 *     (never the anonymous `public` lane);
 *   - streams chat completions from https://opencode.ai/zen/v1 with your
 *     account token, exposing the account's free models by default.
 *
 * The adapter registration is disposed with the plugin fiber. The token is
 * kept in memory only.
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeFile, mkdir } from 'node:fs/promises'

import { OpenCodeLocalAdapter, PROVIDER_ID } from './adapter.js'

/** Minimal structural typing against the host ctx is intentionally omitted:
 * the plugin reads only ctx.logger / ctx.llm / ctx.effect, keeping it
 * independent of the exact host version. */

export const name = 'opencode-local'

/**
 * Plugin configuration (injected via cordis.patch.yml `config`). No `Config`
 * schema export on purpose: the plugin is dependency-free and the options are
 * composition-level settings.
 *
 *   freeOnly       (default true)  only expose the account's free models
 *   refreshSeconds (default 300)   model catalog refresh interval
 *   accessToken    (optional)      explicit token override; unset = read the
 *                                  running OpenCode client
 */

export const inject = ['llm']

export function apply(ctx, config = {}) {
  const logger = ctx.logger
  if (!ctx.llm || typeof ctx.llm.registerAdapter !== 'function') {
    logger.error('opencode-local: llm service unavailable; cannot register')
    return
  }

  const dataDir = join(homedir(), '.opencode-local-dsh')
  const statusPath = join(dataDir, 'adapter-status.json')

  let disposed = false
  const registration = { handle: null }

  const adapter = new OpenCodeLocalAdapter(
    {
      logger: {
        info: (...a) => logger.info(...a),
        warn: (...a) => logger.warn(...a),
        error: (...a) => logger.error(...a),
      },
      refreshSeconds: config.refreshSeconds ?? 300,
      freeOnly: config.freeOnly ?? true,
    },
    config.accessToken,
  )

  const writeStatus = () => {
    void (async () => {
      try {
        await mkdir(dataDir, { recursive: true })
        await writeFile(statusPath, JSON.stringify({ ...adapter.status(), writtenAt: new Date().toISOString() }, null, 2), 'utf8')
      } catch {
        /* status is best-effort */
      }
    })()
  }

  // Register FIRST so the provider appears in the model picker immediately;
  // the token resolves and the catalog warms in the background.
  registration.handle = ctx.llm.registerAdapter([PROVIDER_ID], adapter)
  logger.info(`opencode-local: adapter registered for "${PROVIDER_ID}" (resolves the running OpenCode in background)`)

  void adapter
    .warm()
    .then(() => {
      if (disposed) return
      logger.info(`opencode-local: lane ready — ${JSON.stringify(adapter.status())}`)
      writeStatus()
    })
    .catch((err) => {
      logger.error(`opencode-local: failed to resolve the running OpenCode: ${err instanceof Error ? err.message : String(err)}`)
    })

  const refreshTimer = setInterval(() => {
    if (disposed) return
    void adapter
      .warm()
      .then(() => writeStatus())
      .catch(() => {})
  }, Math.max(30, config.refreshSeconds ?? 300) * 1000)
  refreshTimer.unref?.()

  const maybeEffect = ctx.effect
  if (typeof maybeEffect === 'function') {
    maybeEffect.call(ctx, () => () => {
      disposed = true
      clearInterval(refreshTimer)
      const dispose = registration.handle?.dispose
      if (typeof dispose === 'function') void Promise.resolve(dispose.call(registration.handle)).catch(() => {})
    })
  }
}

export { OpenCodeLocalAdapter, PROVIDER_ID }
