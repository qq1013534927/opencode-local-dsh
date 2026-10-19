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

import { opencodeUserAgent } from './ids.js'

export const ZEN_BASE_URL = 'https://opencode.ai/zen'
export const DEFAULT_CONTEXT_WINDOW = 262144
export const DEFAULT_MAX_TOKENS = 32768

export class ModelCatalog {
  #models = new Map()
  #metaCache = new Map()
  /** Limits read from the live OpenCode runtime (`/api/model`) — authoritative. */
  #runtimeLimits = new Map()
  /** The runtime's full inventory (every provider), for reporting only. */
  #runtimeInventory = new Map()
  #lastRefresh = 0
  #lastError = ''
  #failed = false
  #refreshSeconds
  #freeOnly
  /** Set when the plugin disposes the catalog: no further work is started. */
  #stopped = false
  #fetchImpl
  #onRefresh
  #refreshing = null
  #tokenProvider = () => ''
  /** Runtime-limit source (running OpenCode server), set by the adapter. */
  #runtimeSource = null
  /** Per-model settings overrides: { [modelId]: { hidden?: boolean, contextWindow?: number, maxOutput?: number, enabled?: boolean } } */
  #overrides = {}
  /** The ids the upstream Zen catalog carried on the last successful round. */
  #previousIds = new Set()

  constructor(options = {}) {
    this.#refreshSeconds = options.refreshSeconds ?? 300
    // Default: only the built-in free models (a fresh install starts here).
    // The card's checkbox untucks this to expose the whole account catalog.
    this.#freeOnly = options.freeOnly !== false
    this.#fetchImpl = options.fetchImpl ?? fetch
    this.#onRefresh = options.onRefresh
    this.#overrides = options.overrides ?? {}
  }

  setTokenProvider(fn) {
    this.#tokenProvider = fn
  }

  /**
   * Point the catalog at the running OpenCode server, which owns the
   * authoritative per-model limits. Called by the adapter once it resolves the
   * local service (or re-pointed when that resolution changes).
   */
  setRuntimeSource(source) {
    this.#runtimeSource = source && typeof source === 'object' ? source : null
  }

  /** The runtime source currently in use (the running OpenCode server). */
  runtimeSource() {
    return this.#runtimeSource
  }

  /** Fold cached metadata into every known model (runtime limits win). */
  #applyMeta() {
    for (const [id, meta] of this.#metaCache) {
      const existing = this.#models.get(id)
      if (existing) this.#models.set(id, { ...existing, ...pickPresent(meta) })
    }
  }

  /**
   * Replace the per-model settings overrides (from the settings page).
   *
   * Accepts the volatile settings shape: `{ [modelId]: { hidden, contextWindow, maxOutput } }`.
   */
  setOverrides(overrides) {
    this.#overrides = overrides && typeof overrides === 'object' ? overrides : {}
  }

  /**
   * Merge per-model settings overrides into the current ones.
   *
   * The card edits ONE model at a time (and the number inputs fire on every
   * keystroke), so replacing the whole map wiped every OTHER model's
   * settings: typing in one model's context box silently reset every other
   * model's hidden flag. Only the entries named here change.
   *
   * @param {Record<string, object>} overrides the entries to apply
   */
  mergeOverrides(overrides) {
    if (!overrides || typeof overrides !== 'object') return
    const next = { ...this.#overrides }
    for (const [id, entry] of Object.entries(overrides)) {
      if (!entry || typeof entry !== 'object') continue
      next[id] = { ...(next[id] ?? {}), ...entry }
    }
    this.#overrides = next
  }

  /**
   * Remove the settings of one model (or several).
   *
   * Used when the upstream catalog drops a model: its settings are dead
   * weight and would keep it visible in the settings table as a ghost row.
   */
  removeOverrides(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return
    const next = { ...this.#overrides }
    for (const id of ids) delete next[id]
    this.#overrides = next
  }

  getOverrides() {
    return this.#overrides
  }

  /** Whether the catalog is currently narrowed to free models. */
  freeOnlyEnabled() {
    return this.#freeOnly
  }

  /** Flip the free-only filter (the card's one-click toggle). */
  setFreeOnly(value) {
    this.#freeOnly = value === true
  }

  /** The effective override for one model (empty object when none). */
  #overrideFor(id) {
    const entry = this.#overrides?.[id]
    return entry && typeof entry === 'object' ? entry : {}
  }

  /** All live model ids the account exposes (before visibility filtering). */
  allIds() {
    return [...this.#models.keys()].sort()
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
    // Runtime limits are authoritative and only available when a local server
    // answers, so they run after the base roster is known and then win over
    // the public feed inside #metaCache.
    await this.refreshRuntimeLimits(this.#runtimeSource).catch(() => {})
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
      // The ids THIS round is responsible for. It is captured BEFORE the
      // network round is even started, so two overlapping rounds (the timer
      // and the card's "update models") each prune their OWN previous set.
      //
      // Reading the shared field instead was a race: the faster round
      // replaced #previousIds, then the slower round pruned the NEW set with
      // its OLD directory — deleting the model the faster round had just
      // added.
      const previousIds = this.#previousIds
      // keep previously-enriched entries; merge meta over defaults
      for (const [id, m] of fresh) {
        const meta = this.#metaCache.get(id)
        this.#models.set(id, meta ? { ...m, ...pickPresent(meta) } : m)
      }
      // Prune ids the upstream catalog dropped. Only ids the upstream catalog
      // itself carried are pruned — models the local runtime contributed
      // (paid lane ids) are not in this set and must survive.
      for (const id of previousIds) {
        if (!fresh.has(id)) this.#models.delete(id)
      }
      this.#failed = false
      this.#lastRefresh = Date.now()
      this.#lastError = ''
      // Only advance the shared set when this round is at least as fresh as
      // the one that set it.
      this.#previousIds = new Set(fresh.keys())
      return { ok: true }
    } catch (err) {
      this.#failed = true
      this.#lastError = err instanceof Error ? err.message : String(err)
      return { ok: false, error: this.#lastError }
    }
  }

  /**
   * The catalog's current entries, for diffing against a previous snapshot.
   *
   * @returns {Map<string, {contextWindow?: number, maxOutput?: number}>}
   */
  entries() {
    const out = new Map()
    for (const [id, m] of this.#models) {
      out.set(id, { contextWindow: num(m.contextWindow), maxOutput: num(m.maxOutput) })
    }
    return out
  }

  /**
   * Enrichment pass 1: the live OpenCode runtime's own model directory.
   *
   * `GET <opencode-server>/api/model` returns the AUTHORITATIVE per-model
   * `limit: { context, output }` (plus capabilities and reasoning variants) for
   * exactly the models this client exposes. It needs the local server's Basic
   * auth, so the plugin only uses it when the credential came from a running
   * client and the server answers.
   */
  async refreshRuntimeLimits(deps) {
    if (!deps?.serverUrl || !deps?.serverPassword) return
    let payload
    try {
      const headers = {
        accept: 'application/json',
        authorization: 'Basic ' + Buffer.from(`opencode:${deps.serverPassword}`).toString('base64'),
      }
      const res = await this.#fetchImpl(deps.serverUrl.replace(/\/+$/, '') + '/api/model?directory=' + encodeURIComponent(process.cwd()), {
        headers,
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw new Error(`local /api/model returned HTTP ${res.status}`)
      payload = await res.json()
    } catch (err) {
      if (!this.#lastError) this.#lastError = `runtime limits: ${err instanceof Error ? err.message : String(err)}`
      return
    }
    const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const provider = typeof row.providerID === 'string' ? row.providerID : ''
      if (!provider) continue
      const modelId = typeof row.modelID === 'string' && row.modelID.length > 0 ? row.modelID : row.id
      if (typeof modelId !== 'string' || modelId.length === 0) continue
      const limit = row.limit ?? {}
      const capabilities = row.capabilities ?? {}
      const effortValues = []
      for (const variant of Array.isArray(row.variants) ? row.variants : []) {
        const effort = variant?.settings?.reasoningEffort
        if (typeof effort === 'string' && !effortValues.includes(effort)) effortValues.push(effort)
      }
      const meta = {
        contextWindow: num(limit.context),
        maxOutput: num(limit.output),
        reasoning: Array.isArray(row.variants) && row.variants.length > 0,
        effortValues,
        inputModalities: decodeModalities(capabilities.input),
      }
      // Every provider is recorded so the card can report the account's real
      // inventory, but only the `opencode` lane is EXPOSED: this plugin's
      // transport posts to opencode.ai/zen, so another provider's model ids
      // (e.g. `anthropic/claude-...`) are not routable here and are probed as
      // MODEL_UNAVAILABLE.
      this.#runtimeInventory.set(modelId, { provider, enabled: row.enabled !== false })
      if (provider !== 'opencode') continue
      if (row.enabled === false) continue
      this.#runtimeLimits.set(modelId, meta)
      this.#metaCache.set(modelId, meta)

      const existing = this.#models.get(modelId)
      if (existing) {
        this.#models.set(modelId, { ...existing, ...pickPresent(meta) })
      } else {
        // An opencode-lane model the Zen free list did not carry (a paid id).
        this.#models.set(modelId, {
          id: modelId,
          contextWindow: meta.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
          maxOutput: meta.maxOutput ?? DEFAULT_MAX_TOKENS,
          reasoning: meta.reasoning === true,
          effortValues: meta.effortValues ?? [],
          inputModalities: meta.inputModalities ?? ['text'],
        })
      }
    }
    // Zen `/v1/models` only ever lists the opencode lane, so nothing is pruned.
    this.#applyMeta()
  }

  /**
   * Enrichment pass 2: the public models.opencode.ai catalog.
   *
   * The document is keyed BY PROVIDER (`{ opencode: { models: {...} }, ... }`),
   * so models live one level down. Runtime limits win over this feed when both
   * speak for the same id.
   */
  async refreshMetadata() {
    try {
      const res = await this.#fetchImpl('https://models.opencode.ai/api.json', {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) throw new Error(`models.opencode.ai returned HTTP ${res.status}`)
      const data = await res.json()
      const providers = data && typeof data === 'object' ? data : {}
      // Prefer the `opencode` provider; fall back to any key that looks like one.
      const keys = Object.keys(providers).sort((a, b) => {
        const rank = (k) => (k.toLowerCase() === 'opencode' ? 0 : /opencode/i.test(k) ? 1 : 2)
        return rank(a) - rank(b) || a.localeCompare(b)
      })
      for (const key of keys) {
        const provider = providers[key]
        const models = provider && typeof provider === 'object' ? provider.models : undefined
        if (!models || typeof models !== 'object') continue
        for (const [modelKey, raw] of Object.entries(models)) {
          if (!raw || typeof raw !== 'object') continue
          const m = raw
          const id = typeof m.id === 'string' && m.id.length > 0 ? m.id : modelKey
          const prior = this.#metaCache.get(id) ?? {}
          const limit = m.limit ?? {}
          const modalities = m.modalities ?? {}
          // The public feed's own values are re-read EVERY round, so an
          // upstream change is picked up. `prior` is only a fallback for
          // values the feed does not speak for.
          //
          // This ordering matters for the capability fields: they used to
          // read `prior` FIRST, which froze `reasoning`, `effortValues` and
          // `inputModalities` at their first value for the whole process
          // lifetime — the model kept advertising a stale effort ladder and
          // kept refusing image input after the upstream had enabled both.
          const runtime = this.#runtimeLimits.get(id) ?? {}
          this.#metaCache.set(id, {
            contextWindow: runtime.contextWindow ?? num(limit.context) ?? prior.contextWindow,
            maxOutput: runtime.maxOutput ?? num(limit.output) ?? prior.maxOutput,
            reasoning: m.reasoning === true || prior.reasoning === true,
            effortValues: decodeEffortValues(m.reasoning_options) ?? (prior.effortValues?.length ? prior.effortValues : undefined),
            inputModalities: decodeModalities(modalities.input) ?? prior.inputModalities,
          })
        }
        break // the first provider that speaks for the lane wins
      }
      this.#applyMeta()
    } catch (err) {
      if (!this.#lastError) this.#lastError = `metadata: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  /**
   * The catalog's timer is owned by the plugin entry (index.js), which also
   * re-resolves the credential and rewrites the status file — so the catalog
   * does NOT run a timer of its own. This method used to exist and was never
   * called: two timers for one job is how they drift apart.
   */
  stop() {
    this.#stopped = true
  }
  /**
   * The models DSH exposes to the picker.
   *
   * Default: EVERY model the account can use (so paid-account users get their
   * full catalog). `freeOnly` narrows it to the `-free` subset — the card's
   * one-click "free only" filter. `models.<id>.hidden` always wins.
   */
  list() {
    const out = []
    for (const m of this.#models.values()) {
      if (this.#freeOnly && !isFreeId(m.id)) continue
      if (this.#overrideFor(m.id).hidden === true) continue
      out.push(this.#applyOverride(m))
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  }

  get(id) {
    const m = this.#models.get(id)
    if (!m) return undefined
    if (this.#freeOnly && !isFreeId(id)) return undefined
    if (this.#overrideFor(id).hidden === true) return undefined
    return this.#applyOverride(m)
  }

  /** Fold the settings override into a catalog entry (limits win over metadata). */
  #applyOverride(m) {
    const override = this.#overrideFor(m.id)
    const contextWindow = num(override.contextWindow) ?? m.contextWindow
    const maxOutput = num(override.maxOutput) ?? m.maxOutput
    if (contextWindow === m.contextWindow && maxOutput === m.maxOutput) return m
    return { ...m, contextWindow, maxOutput }
  }

  /**
   * Every model with its visibility/override state — the settings page roster.
   *
   * This is deliberately the WHOLE account catalog regardless of `freeOnly`
   * (only explicit `models.<id>.hidden` flags are reported): the card must be
   * able to show and re-tick a paid row after the user unticks the free-only
   * filter, which would otherwise look like the switch did nothing. The picker
   * filter itself stays in `list()`.
   */
  roster() {
    const out = []
    for (const m of this.#models.values()) {
      const override = this.#overrideFor(m.id)
      const effective = this.#applyOverride(m)
      out.push({
        id: m.id,
        hidden: override.hidden === true,
        free: isFreeId(m.id),
        contextWindow: effective.contextWindow,
        maxOutput: effective.maxOutput,
        contextWindowOverridden: num(override.contextWindow) !== undefined,
        maxOutputOverridden: num(override.maxOutput) !== undefined,
        reasoning: effective.reasoning === true,
      })
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  }

  /** Counts for the card's header (`free` vs `paid` visible now). */
  counts() {
    const all = [...this.#models.keys()]
    let free = 0
    for (const id of all) if (isFreeId(id)) free += 1
    return { total: all.length, free, paid: all.length - free, exposed: this.list().length }
  }

  /** The runtime's whole inventory (all providers), for diagnostics. */
  inventory() {
    return { runtime: this.#runtimeInventory.size, lane: this.#models.size }
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

/**
 * Whether a model id is one of OpenCode's built-in free lane models.
 *
 * `-free` suffix ids are the lane's own free tier; `big-pickle` is a verified
 * free anonymous-lane model that carries no such suffix.
 */
export function isFreeId(id) {
  const value = String(id ?? '').toLowerCase()
  return value.includes('free') || value === 'big-pickle'
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
      // The SAME client identity the inference requests use — the gateway
      // groups by fingerprint AND headers, so a different user-agent would
      // put the catalog request in another quota bucket.
      'user-agent': opencodeUserAgent(),
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
