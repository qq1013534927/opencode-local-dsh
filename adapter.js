/**
 * The DSH LlmAdapter for the user's own OpenCode lane.
 *
 * Adapter contract (dsh-llm, structural — no host import):
 *   providerInfo(provider) / listModels(provider) / resolveModel(provider, model)
 *   prepareCall(provider, model, signal) -> { model, stream(options) }
 *   providerRetryPolicy(provider)
 */

import { ModelCatalog, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './catalog.js'
// classifyError is used by probeOne's catch block. It was NEVER imported here,
// so a ReferenceError was thrown INSIDE that catch — it escaped probeOne,
// escaped the probe loop, and aborted the whole batch plus the SSE route:
// one failing model killed the entire availability test.
import { streamChat, classifyError, IP_LANE_BLOCK_MESSAGE } from './wire.js'
import { resolveLocalOpencode } from './credential.js'

export const PROVIDER_ID = 'opencode-local'

/** Reasoning effort ladder (dsh-llm treats ids as opaque). */
export const REASONING_EFFORT_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const DEFAULT_EFFORT_LADDER = ['off', 'minimal', 'low', 'medium', 'high']

/** Advertised effort list for a reasoning model. */
export function reasoningEfforts(capability) {
  if (!capability?.reasoning) return undefined
  const declared = []
  for (const value of capability.effortValues ?? []) {
    const level = value === 'none' ? 'off' : value
    if (REASONING_EFFORT_LADDER.includes(level) && !declared.includes(level)) declared.push(level)
  }
  const levels = declared.length > 0
    ? declared.sort((a, b) => REASONING_EFFORT_LADDER.indexOf(a) - REASONING_EFFORT_LADDER.indexOf(b))
    : DEFAULT_EFFORT_LADDER
  return levels.map((level) => ({ id: level, name: level.charAt(0).toUpperCase() + level.slice(1) }))
}

/** Retry policy the host runs for this provider (own-account lane is per-account rate limited). */
export const OWN_LANE_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 8,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  initialDelayMs: 1_000,
  maxDelayMs: 20_000,
  jitterRatio: 0.2,
})

/**
 * How long the availability test stays refused after an IP-level block.
 *
 * The upstream does not publish a retry time, and the block is the answer to
 * repeated requests from one address — so the window has to be long enough
 * that a user who clicks "test all" five times in a row is NOT the reason the
 * block persists. 30 minutes is a compromise: long enough to cool the
 * address down, short enough that the card is useful again the same evening.
 */
export const IP_BLOCK_COOLDOWN_MS = 30 * 60_000

/**
 * Token holder: resolves once; invalidation (after AUTH failure, or when the
 * token has expired) re-resolves from the running OpenCode. The token never
 * touches disk.
 */
class TokenHolder {
  #resolved = null
  #resolving = null
  #logger
  #explicitToken

  constructor(logger, explicitToken) {
    this.#logger = logger
    this.#explicitToken = explicitToken
  }

  get current() {
    return this.#resolved
  }

  /**
   * Whether the held credential is past its expiry.
   *
   * The credential carries an `expires` timestamp (ms since epoch). Without
   * this check an expired token is used until the upstream answers 401 — the
   * request is wasted and the failure is opaque. Probing the expiry first
   * turns it into a cheap re-resolve.
   *
   * @param {number} [skewMs] treat a token that expires within this window as
   *   expired, so a request never starts with a token that dies mid-flight.
   */
  #expired(skewMs = 30_000) {
    const expires = this.#resolved?.expires
    if (typeof expires !== 'number' || !Number.isFinite(expires)) return false
    return Date.now() + skewMs >= expires
  }

  resolve() {
    if (this.#resolved && !this.#expired()) return Promise.resolve(this.#resolved)
    if (this.#resolved && this.#expired()) {
      this.#logger?.info?.('opencode-local: the held credential has expired; re-resolving')
      this.#resolved = null
    }
    if (this.#resolving) return this.#resolving
    this.#resolving = resolveLocalOpencode(this.#explicitToken, this.#logger)
      .then((value) => {
        this.#resolved = value
        this.#resolving = null
        return value
      })
      .catch((err) => {
        this.#resolving = null
        throw err
      })
    return this.#resolving
  }

  invalidate() {
    this.#resolved = null
  }
}

export class OpenCodeLocalAdapter {
  #catalog
  #logger
  #tokens
  /**
   * When the upstream last refused the free lane for this IP.
   *
   * The upstream's block is the answer to "too many requests from this
   * address", so the cure is to STOP asking for a while. Until the cooldown
   * expires the availability test refuses to send anything, and says why.
   */
  #ipBlockedUntil = 0

  constructor(deps, explicitToken) {
    this.#logger = deps.logger
    this.#tokens = new TokenHolder(deps.logger, explicitToken)
    this.#catalog = new ModelCatalog({
      refreshSeconds: deps.refreshSeconds,
      freeOnly: deps.freeOnly,
      onRefresh: (snapshot, lastError) => {
        if (lastError) this.#logger.warn(`opencode-local: catalog refresh issue: ${lastError}`)
      },
    })
    this.#catalog.setTokenProvider(() => this.#tokens.current?.accessToken ?? '')
  }

  providerInfo(provider) {
    return { id: provider, name: 'OpenCode Local' }
  }

  providerRetryPolicy(_provider) {
    return OWN_LANE_RETRY_POLICY
  }

  imageRequestPricing(_provider, _model) {
    return undefined
  }

  async #ensureToken() {
    const resolved = await this.#tokens.resolve()
    // The runtime owns the authoritative per-model limits; keep the catalog
    // pointed at whichever server we last resolved credentials from.
    this.#catalog.setRuntimeSource({
      serverUrl: resolved.serverUrl,
      serverPassword: resolved.serverPassword,
    })
    return resolved.accessToken
  }

  /** Warm the token + one catalog round before the host snapshots listModels. */
  async warm() {
    await this.#ensureToken()
    await this.#catalog.refreshOnce()
  }

  /**
   * Stop background work.
   *
   * Called when the plugin is disposed: the catalog must not start another
   * refresh round, and the held credential is dropped (it only lives in
   * memory).
   */
  stop() {
    this.#catalog.stop()
    this.#tokens.invalidate()
  }

  /**
   * Re-fetch the account's model directory from upstream, now.
   *
   * This is what the card's "update models" button calls: the catalog also
   * refreshes on a timer, but that timer can be minutes away from the moment
   * the user notices a missing model. The round is forced (the catalog's
   * in-flight guard is bypassed) and reports WHAT changed, so the card can
   * say "3 new models" instead of silently re-rendering.
   *
   * @returns {Promise<{ok: boolean, added: string[], removed: string[], changed: object[], error?: string, lastRefresh?: string}>}
   */
  async refreshModelsNow() {
    const before = this.#catalog.entries()
    try {
      await this.#ensureToken()
      await this.#catalog.refreshModels()
      await this.#catalog.refreshMetadata()
      await this.#catalog.refreshRuntimeLimits(this.#catalog.runtimeSource()).catch(() => {})
    } catch (err) {
      return {
        ok: false,
        added: [],
        removed: [],
        changed: [],
        error: err instanceof Error ? err.message : String(err),
      }
    }
    const after = this.#catalog.entries()
    const added = []
    const removed = []
    const changed = []
    for (const [id, m] of after) {
      const prior = before.get(id)
      if (!prior) {
        added.push(id)
        continue
      }
      if (prior.contextWindow !== m.contextWindow || prior.maxOutput !== m.maxOutput) {
        changed.push({ id, contextWindow: m.contextWindow, maxOutput: m.maxOutput })
      }
    }
    for (const id of before.keys()) {
      if (!after.has(id)) removed.push(id)
    }
    return {
      ok: true,
      added: added.sort(),
      removed: removed.sort(),
      changed,
      lastRefresh: this.#catalog.snapshot().lastRefresh,
    }
  }

  /** Apply settings overrides (visibility + context/output limits) live. */
  setOverrides(overrides) {
    this.#catalog.setOverrides(overrides)
  }

  /**
   * Merge settings overrides into the live ones (one model at a time).
   *
   * The card edits ONE model at a time — and the context/output inputs fire on
   * every keystroke — so replacing the whole map wiped every OTHER model's
   * settings. Only the named entries change here.
   */
  mergeOverrides(overrides) {
    this.#catalog.mergeOverrides(overrides)
  }

  /** Drop the settings of models the catalog no longer carries. */
  removeOverrides(ids) {
    this.#catalog.removeOverrides(ids)
  }

  /**
   * Flip the "free only" filter live.
   *
   * false exposes every model the account can use (paid users); true narrows
   * the picker to the built-in free models.
   */
  setFreeOnly(freeOnly) {
    this.#catalog.setFreeOnly(freeOnly)
  }

  /** The live roster for the settings page (visibility/limits per model). */
  roster() {
    return this.#catalog.roster()
  }

  /** Token/catalog diagnostics for the settings page. */
  status() {
    const catalog = this.#catalog.snapshot()
    const ipBlock = this.ipBlockState()
    return {
      tokenSource: this.#tokens.current?.source ?? 'unresolved',
      account: this.#tokens.current?.account,
      freeOnly: this.#catalog.freeOnlyEnabled(),
      counts: this.#catalog.counts(),
      catalog: {
        total: catalog.total,
        exposed: catalog.exposed,
        status: catalog.status,
        lastError: catalog.lastError,
        ...(catalog.lastRefresh ? { lastRefresh: catalog.lastRefresh } : {}),
      },
      // Only present while the block is in force. The card reads it to show
      // the upstream's own explanation and to keep the test buttons inert.
      ...(ipBlock.blocked ? { ipBlock: { ...ipBlock, message: IP_LANE_BLOCK_MESSAGE } } : {}),
    }
  }

  /**
   * Whether the availability test is currently refused for this IP.
   *
   * The upstream blocks an ADDRESS, not an account, and the block is the
   * answer to repeated requests from that address. So the plugin does not
   * retry: it reports the block and waits out a cooldown, and a click during
   * the cooldown sends NOTHING.
   */
  ipBlockState(now = Date.now()) {
    const until = this.#ipBlockedUntil
    return {
      blocked: now < until,
      until,
      remainingMs: Math.max(0, until - now),
    }
  }

  /**
   * Availability test: send one tiny streaming request per model through the
   * same transport inference uses, and classify the outcome.
   *
   * Models are probed with BOUNDED CONCURRENCY (a few at a time) and each
   * result is handed to `onResult` as soon as it settles, so a caller can
   * stream per-model progress instead of waiting for the whole batch.
   *
   * Strictly sequential probing was too slow to be usable: the card probes
   * every free model (a dozen), and a model that hangs would have delayed
   * the whole batch by its full timeout each time. A small worker pool keeps
   * the batch short without hammering the account.
   *
   * THE BATCH STOPS at an IP-level block. When the upstream answers "we've
   * detected abusive traffic from this IP address", the free lane is closed
   * for the whole address and EVERY model behind it answers the same way.
   * Probing the remaining models would only send more requests to an address
   * that has already been flagged — which is how a handful of availability
   * tests escalates into the block that caused it. The worker pool stops
   * picking up new models, the remaining rows are reported as skipped, and
   * the caller is told why.
   *
   * @param ids model ids to probe (empty = every visible model)
   * @param onResult per-model callback (result) => void
   * @param concurrency how many probes may run at once
   */
  async probe(ids = [], onResult, concurrency = 4) {
    const targets = (Array.isArray(ids) && ids.length > 0 ? ids : this.#catalog.list().map((m) => m.id)).filter(
      (id) => typeof id === 'string' && id.length > 0,
    )
    const results = []
    const report = (result) => {
      results.push(result)
      if (typeof onResult === 'function') {
        try {
          onResult(result)
        } catch {
          /* observer must not break the loop */
        }
      }
    }
    // A block is already in force: send NOTHING. Every click would otherwise
    // be one more request to the address the upstream just refused, which is
    // the behaviour that earns the block in the first place.
    const state = this.ipBlockState()
    if (state.blocked) {
      for (const id of targets) {
        report({
          id,
          ok: false,
          code: 'IP_LANE_BLOCKED',
          message: IP_LANE_BLOCK_MESSAGE,
          latencyMs: 0,
          retryAfterMs: state.remainingMs,
        })
      }
      return results
    }
    const limit = Math.max(1, Math.min(concurrency, targets.length))
    let next = 0
    // Set once the upstream reports an IP-level block. The in-flight probes
    // are allowed to finish (they were already sent) but no NEW model is
    // picked up.
    let ipBlocked = false
    const worker = async () => {
      for (;;) {
        if (ipBlocked) return
        const index = next++
        if (index >= targets.length) return
        const result = await this.probeOne(targets[index])
        if (result.code === 'IP_LANE_BLOCKED') ipBlocked = true
        report(result)
      }
    }
    await Promise.all(Array.from({ length: limit }, worker))
    // The models that were never reached are reported as skipped rather than
    // silently missing, so the card can say "stopped after the IP block"
    // instead of leaving the remaining rows without a verdict.
    if (ipBlocked) {
      const probed = new Set(results.map((r) => r.id))
      for (const id of targets) {
        if (probed.has(id)) continue
        report({ id, ok: false, code: 'SKIPPED_IP_BLOCKED', message: 'not probed: the free lane is blocked for this IP', latencyMs: 0 })
      }
    }
    return results
  }

  /**
   * Probe one model and classify the outcome.
   *
   * The probe is BOUNDED: a model that never answers must not hold the
   * card's SSE stream open forever (the browser would wait on it, and the
   * "probing" spinner would never clear).
   */
  async probeOne(id, timeoutMs = 60_000) {
    const started = Date.now()
    let ok = false
    let code = 'UNKNOWN'
    let message = ''
    let text = ''
    try {
      await this.#ensureToken()
      const prepared = await this.prepareCall(PROVIDER_ID, id)
      for await (const chunk of prepared.stream({
        provider: PROVIDER_ID,
        model: id,
        system: 'Availability probe. Follow the instruction exactly.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }],
        maxTokens: 24,
        signal: AbortSignal.timeout(timeoutMs),
      })) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish') {
          if (chunk.reason?.kind === 'stop') ok = true
          else if (chunk.reason?.kind === 'tool-calls') ok = true
          else if (chunk.reason?.kind === 'max-tokens') ok = true
          else if (chunk.reason?.kind === 'error') {
            code = chunk.reason.failure?.code ?? 'ERROR'
            message = chunk.reason.failure?.message ?? ''
          } else if (chunk.reason?.kind === 'aborted') {
            code = 'ABORTED'
            message = chunk.reason.failure?.message ?? ''
          }
        }
      }
      if (ok) {
        code = 'OK'
        message = ''
      }
    } catch (err) {
      code = classifyError(String(err?.message ?? err))
      message = String(err?.message ?? err)
    }
    // An IP-level block arms the cooldown: the upstream has closed the free
    // lane for this ADDRESS, so the plugin stops asking for a while instead
    // of making the block worse.
    if (code === 'IP_LANE_BLOCKED') {
      this.#ipBlockedUntil = Date.now() + IP_BLOCK_COOLDOWN_MS
      this.#logger?.warn?.(
        `opencode-local: the upstream blocked this IP's free lane; the availability test stays off for ${Math.round(IP_BLOCK_COOLDOWN_MS / 60000)} minutes`,
      )
      // The upstream's own wording is what the user needs to read, and it is
      // longer than the 300-char message cap — so it is carried separately.
      message = IP_LANE_BLOCK_MESSAGE
    }
    return {
      id,
      ok,
      code,
      message: String(message).slice(0, 300),
      detail: code === 'IP_LANE_BLOCKED' ? IP_LANE_BLOCK_MESSAGE : undefined,
      // How long the cooldown runs, so the card can count it down.
      retryAfterMs: code === 'IP_LANE_BLOCKED' ? IP_BLOCK_COOLDOWN_MS : undefined,
      sample: text.slice(0, 60),
      latencyMs: Date.now() - started,
    }
  }

  async listModels(provider) {
    try {
      await this.#ensureToken()
      if (this.#catalog.list().length === 0) await this.#catalog.refreshOnce()
    } catch (err) {
      this.#logger.warn(`opencode-local: listModels warm-up failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return this.#catalog.list().map((m) => ({
      provider,
      id: m.id,
      name: m.id,
      inputModalities: m.inputModalities.includes('image') ? ['text', 'image'] : ['text'],
    }))
  }

  #modelInfo(model) {
    return (
      this.#catalog.get(model) ?? {
        id: model,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxOutput: DEFAULT_MAX_TOKENS,
        reasoning: false,
        effortValues: [],
        inputModalities: ['text'],
      }
    )
  }

  resolveModel(provider, model) {
    const info = this.#modelInfo(model)
    const resolved = {
      provider,
      id: model,
      name: model,
      inputModalities: info.inputModalities.includes('image') ? ['text', 'image'] : ['text'],
      context: { contextWindow: info.contextWindow },
      defaultMaxTokens: info.maxOutput,
    }
    const efforts = reasoningEfforts({ reasoning: info.reasoning, effortValues: info.effortValues })
    if (efforts) resolved.reasoning = { efforts }
    return resolved
  }

  async prepareCall(provider, model, _signal) {
    await this.#ensureToken().catch(() => {})
    return {
      model: this.resolveModel(provider, model),
      stream: (options) => this.stream(options),
    }
  }

  /** The main stream: one retry on AUTH failure (token rotation), then usage/finish. */
  async *stream(options) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let token
      try {
        token = await this.#ensureToken()
      } catch (err) {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: `opencode-local: ${err?.message ?? err}`, code: 'TRANSPORT' } },
        }
        return
      }
      let sawAuthFailure = false
      let usageChunk
      let finishChunk
      for await (const chunk of streamChat(this.#toWireOptions(options), token)) {
        if (chunk.type === 'usage') {
          usageChunk = chunk
          continue
        }
        if (chunk.type === 'finish') {
          finishChunk = chunk
          if (chunk.reason?.kind === 'error' && chunk.reason.failure?.code === 'AUTH') sawAuthFailure = true
          continue
        }
        yield chunk
      }
      if (sawAuthFailure && attempt === 0) {
        this.#tokens.invalidate()
        continue
      }
      if (usageChunk) yield usageChunk
      if (finishChunk) yield finishChunk
      return
    }
  }

  #toWireOptions(options) {
    const messages = Array.isArray(options.messages) ? options.messages : []
    const wireMessages = messages.map((m) => ({
      role: m.role ?? 'user',
      content: m.content,
      toolCalls: Array.isArray(m.content)
        ? m.content.filter((b) => b?.type === 'tool-call')
        : undefined,
      toolCallId: typeof m.toolCallId === 'string' ? m.toolCallId : undefined,
    }))
    return {
      model: String(options.model ?? ''),
      messages: wireMessages,
      system: typeof options.system === 'string' ? options.system : undefined,
      tools: Array.isArray(options.tools) ? options.tools : undefined,
      maxTokens: typeof options.maxTokens === 'number' ? options.maxTokens : undefined,
      temperature: typeof options.temperature === 'number' ? options.temperature : undefined,
      reasoningEffort:
        typeof options.reasoningEffort === 'string'
          ? options.reasoningEffort
          : typeof options.reasoning === 'string'
            ? options.reasoning
            : undefined,
      signal: options.signal,
    }
  }
}
