/**
 * opencode-local DSH plugin entry (0.3).
 *
 * Registers a native LlmAdapter ("opencode-local") that routes DSH model calls
 * through YOUR OWN running OpenCode client:
 *   - reads the local OpenCode service discovery (service.json) written by the
 *     desktop app / `opencode serve`;
 *   - obtains your account's active OAuth credential from the running client
 *     (never the anonymous `public` lane), with a local DB fallback;
 *   - streams chat completions from https://opencode.ai/zen/v1 with your
 *     account token, through a Bun relay whose TLS fingerprint matches the CLI.
 *
 * It also serves a settings card (Settings → Plugins → 本机 OpenCode 通道)
 * with per-model visibility, availability tests and context/output limits.
 *
 * The adapter registration and the settings routes are disposed with the plugin
 * fiber. The token is kept in memory only.
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { writeFile, mkdir } from 'node:fs/promises'

import { OpenCodeLocalAdapter, PROVIDER_ID } from './adapter.js'
import { Config, readSettings, toOverrides } from './config.js'
import { makeSettingsRoutes, SETTINGS_BRIDGE_PREFIX } from './settings-bridge.js'

export const name = 'opencode-local'
export { Config }

export const inject = ['llm']

export function apply(ctx, rawConfig = {}) {
  const logger = ctx.logger
  if (!ctx.llm || typeof ctx.llm.registerAdapter !== 'function') {
    logger.error('opencode-local: llm service unavailable; cannot register')
    return
  }

  const dataDir = join(homedir(), '.opencode-local-dsh')
  const statusPath = join(dataDir, 'adapter-status.json')

  let disposed = false
  const registration = { handle: null }

  // Live settings snapshot: re-read whenever the settings page saves.
  let settings = readSettings(rawConfig)

  const adapter = new OpenCodeLocalAdapter(
    {
      logger: {
        info: (...a) => logger.info(...a),
        warn: (...a) => logger.warn(...a),
        error: (...a) => logger.error(...a),
      },
      refreshSeconds: settings.refreshSeconds,
      freeOnly: settings.freeOnly,
    },
    settings.accessToken,
  )
  adapter.setOverrides(toOverrides(settings.models))

  const writeStatus = () => {
    void (async () => {
      try {
        await mkdir(dataDir, { recursive: true })
        await writeFile(
          statusPath,
          JSON.stringify({ ...adapter.status(), writtenAt: new Date().toISOString() }, null, 2),
          'utf8',
        )
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
  }, Math.max(30, settings.refreshSeconds) * 1000)
  refreshTimer.unref?.()

  // ---- settings bridge (loopback-only) ------------------------------------
  // The card needs the LIVE roster and an on-demand availability probe, which
  // the served settings form cannot carry. Both ride a loopback route pair with
  // the same trust model as the reference implementation.
  const routes = makeSettingsRoutes(
    {
      async status() {
        return {
          ok: true,
          value: {
            ...adapter.status(),
            models: adapter.roster(),
            bridge: SETTINGS_BRIDGE_PREFIX,
          },
        }
      },
      async probe(body, onResult) {
        const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string' && id.length > 0) : []
        const results = await adapter.probe(ids, onResult)
        return { ok: true, value: { results } }
      },
    },
    {},
  )

  // Re-read the live settings on every save so the card's edits take effect
  // without a plugin reload (the Loader announces volatile updates).
  const onVolatileUpdate = () => {
    if (disposed) return
    const next = readSettings(rawConfig)
    settings = next
    adapter.setOverrides(toOverrides(next.models))
    void adapter
      .warm()
      .then(() => {
        writeStatus()
        logger.info('opencode-local: settings applied')
      })
      .catch(() => {})
  }
  const offVolatile = typeof ctx.on === 'function' ? ctx.on('loader/volatile-update', onVolatileUpdate) : undefined

  const maybeEffect = ctx.effect
  if (typeof maybeEffect === 'function') {
    maybeEffect.call(ctx, () => () => {
      disposed = true
      clearInterval(refreshTimer)
      if (typeof offVolatile === 'function') offVolatile()
      const dispose = registration.handle?.dispose
      if (typeof dispose === 'function') void Promise.resolve(dispose.call(registration.handle)).catch(() => {})
    })
  }

  // Routes need the web server service; request it in its own fiber so a
  // composition without a browser carrier still activates the provider.
  if (typeof ctx.inject === 'function') {
    void Promise.resolve(
      ctx.inject(['webServer'], (routeCtx) => {
        if (!routeCtx.webServer || disposed) return
        for (const route of routes) {
          routeCtx.effect(() => routeCtx.webServer.register(route), `opencode-local: ${route.path}`)
        }
        logger.info(`opencode-local: settings bridge ready at ${SETTINGS_BRIDGE_PREFIX}`)
      }),
    )
  }
}

export { OpenCodeLocalAdapter, PROVIDER_ID, SETTINGS_BRIDGE_PREFIX }
