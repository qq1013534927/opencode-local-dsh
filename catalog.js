/**
 * Model catalog for the user's own OpenCode account.
 *
 * Source of truth: `GET https://opencode.ai/zen/v1/models` with the user's OWN
 * OAuth token (never `public`). We expose the `-free` subset by default
 * (opencode's built-in free models), with the full list available via config.
 *
 * Enrichment: opencode's `https://models.opencode.ai/api.json` catalog adds
 * limits (context/output) and reasoning metadata where available.
 */

export const ZEN_BASE_URL = 'https://opencode.ai/zen'
export const DEFAULT_CONTEXT_WINDOW = 262144
export const DEFAULT_MAX_TOKENS = 32768

export class ModelCatalog {
  #models = new Map()
  #metaCache = new Map()
  #lastRefresh = 0
  #lastError = ''
  #failed = false
  #refreshSeconds
  #freeOnly
  #timer = null
  #stopped = false
  #fetchImpl
  #onRefresh
  #refreshing = null
  #tokenProvider = () => ''

  constructor(options = {}) {
    this.#refreshSeconds = options.refreshSeconds ?? 300
    this.#freeOnly = options.freeOnly ?? true
    this.#fetchImpl = options.fetchImpl ?? fetch
    this.#onRefresh = options.onRefresh
  }

  setTokenProvider(fn) {
    this.#tokenProvider = fn
  }

  refreshOnce() {
    if (this.#refreshing === null) {
      this.#refreshing = this.#refreshRound().finally(() => {
        this.#refreshing = null
      })
    }
    return this.#refreshing
  }

  async #refreshRound() {
    await Promise.allSettled([this.refreshModels(), this.refreshMetadata()])
    if (this.#onRefresh) {
      try {
        this.#onRefresh(this.snapshot(), this.#lastError)
      } catch {
        /* observers never break the loop */
      }
    }
  }

  async refreshModels() {
    try {
      const models = await fetchZenModels(this.#tokenProvider(), this.#fetchImpl)
      const fresh = new Map(models.map((m) => [m.id, m]))
      // keep previously-enriched entries; merge meta over defaults
      for (const [id, m] of fresh) {
        const meta = this.#metaCache.get(id)
        this.#models.set(id, meta ? { ...m, ...pickPresent(meta) } : m)
      }
      this.#failed = false
      this.#lastRefresh = Date.now()
      this.#lastError = ''
    } catch (err) {
      this.#failed = true
      this.#lastError = err instanceof Error ? err.message : String(err)
    }
  }

  async refreshMetadata() {
    try {
      const res = await this.#fetchImpl('https://models.opencode.ai/api.json', {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`models.opencode.ai returned HTTP ${res.status}`)
      const data = await res.json()
      // the catalog is a top-level model map keyed by id
      for (const [id, raw] of Object.entries(data ?? {})) {
        if (!raw || typeof raw !== 'object') continue
        const m = raw
        const limit = m.limit ?? {}
        const modalities = m.modalities ?? {}
        this.#metaCache.set(id, {
          contextWindow: num(limit.context),
          maxOutput: num(limit.output),
          reasoning: m.reasoning === true,
          effortValues: decodeEffortValues(m.reasoning_options),
          inputModalities: decodeModalities(modalities.input),
        })
      }
      // re-apply enrichment to already-known models
      for (const [id, meta] of this.#metaCache) {
        const existing = this.#models.get(id)
        if (existing) this.#models.set(id, { ...existing, ...pickPresent(meta) })
      }
    } catch (err) {
      if (!this.#lastError) this.#lastError = `metadata: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  async start() {
    await this.refreshOnce()
    let attempts = 0
    while (this.list().length === 0 && attempts < 4 && !this.#stopped) {
      attempts += 1
      await new Promise((r) => setTimeout(r, 15_000))
      if (this.#stopped) return
      await this.refreshOnce()
    }
    if (this.#stopped) return
    this.#timer = setInterval(() => {
      void this.refreshOnce()
    }, this.#refreshSeconds * 1000)
    this.#timer.unref?.()
  }

  stop() {
    this.#stopped = true
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  list() {
    const out = []
    for (const m of this.#models.values()) {
      if (this.#freeOnly && !m.id.toLowerCase().includes('free')) continue
      out.push(m)
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  }

  get(id) {
    const m = this.#models.get(id)
    if (!m) return undefined
    if (this.#freeOnly && !m.id.toLowerCase().includes('free')) return undefined
    return m
  }

  snapshot() {
    const exposed = this.list().length
    const age = this.#lastRefresh === 0 ? Infinity : Date.now() - this.#lastRefresh
    const stale = this.#lastRefresh !== 0 && age > 2 * this.#refreshSeconds * 1000
    return {
      status: this.#lastRefresh === 0 ? (this.#failed ? 'error' : 'pending') : this.#failed || stale ? 'stale' : 'ready',
      total: this.#models.size,
      exposed,
      lastError: this.#lastError,
      ...(this.#lastRefresh !== 0 ? { lastRefresh: new Date(this.#lastRefresh).toISOString() } : {}),
    }
  }
}

function pickPresent(meta) {
  const out = {}
  if (meta.contextWindow) out.contextWindow = meta.contextWindow
  if (meta.maxOutput) out.maxOutput = meta.maxOutput
  if (meta.reasoning !== undefined) out.reasoning = meta.reasoning
  if (meta.effortValues) out.effortValues = meta.effortValues
  if (meta.inputModalities) out.inputModalities = meta.inputModalities
  return out
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function decodeEffortValues(raw) {
  if (!Array.isArray(raw)) return undefined
  const values = []
  for (const option of raw) {
    if (typeof option !== 'object' || option === null) continue
    if (option.type !== 'effort' || !Array.isArray(option.values)) continue
    for (const value of option.values) {
      if (typeof value === 'string' && value.length > 0 && !values.includes(value)) values.push(value)
    }
  }
  return values.length > 0 ? values : undefined
}

function decodeModalities(input) {
  if (!Array.isArray(input)) return undefined
  const kinds = []
  for (const kind of input) {
    if (typeof kind === 'string' && kind.length > 0 && !kinds.includes(kind)) kinds.push(kind)
  }
  return kinds.length > 0 ? kinds : undefined
}

/** Fetch the account's own model directory from Zen. */
export async function fetchZenModels(token, fetchImpl = fetch) {
  if (!token) throw new Error('no account token available yet')
  const res = await fetchImpl(`${ZEN_BASE_URL}/v1/models`, {
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': 'opencode/1.18.31 (win32 x64; node22.0.0)',
      'x-opencode-client': 'cli',
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`zen /v1/models returned HTTP ${res.status}`)
  const payload = await res.json()
  const models = []
  for (const item of payload?.data ?? []) {
    const id = typeof item?.id === 'string' ? item.id : ''
    if (!id) continue
    models.push({
      id,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxOutput: DEFAULT_MAX_TOKENS,
      reasoning: false,
      effortValues: [],
      inputModalities: ['text'],
    })
  }
  if (models.length === 0) throw new Error('zen /v1/models returned an empty list')
  return models
}
