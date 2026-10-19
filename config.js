/**
 * Plugin Config — the served settings schema for Settings → Plugins →
 * 本机 OpenCode 通道.
 *
 * DSH reads this export to decide which fields are editable under the Loader
 * entry id. Fields marked `.volatile()` are the editable surface the settings
 * card writes through `configForms`; the rest are composition-level options set
 * by cordis.patch.yml.
 *
 * Live settings value shape:
 *   {
 *     freeOnly: boolean,
 *     refreshSeconds: number,
 *     accessToken: string,
 *     models: { [modelId]: { hidden?: boolean, contextWindow?: number, maxOutput?: number } },
 *   }
 *
 * `models` is ONE volatile node so the whole per-model map is the card's form
 * value (nesting `.volatile()` deeper is a schemastery error).
 */

import Schema from '@deepseek-ai/schemastery'

export const MODEL_OVERRIDE_DEFAULTS = {
  hidden: false,
  contextWindow: 0,
  maxOutput: 0,
}

export const Config = Schema.object({
  /** Only expose the account's free models (opencode built-in `-free` ids). */
  freeOnly: Schema.boolean().default(true).volatile(),
  /** Model catalog refresh interval in seconds. */
  refreshSeconds: Schema.number().step(1).min(30).default(300).volatile(),
  /** Explicit access token override (empty = resolve from the running OpenCode). */
  accessToken: Schema.string().default('').volatile(),
  /**
   * Per-model settings: visibility toggle and context/output overrides.
   * Keyed by model id; an absent entry means "metadata defaults, visible".
   */
  models: Schema.dict(
    Schema.object({
      /** Hide this model from the DSH model picker. */
      hidden: Schema.boolean().default(false),
      /** Context window override in tokens (0 = use discovered/metadata value). */
      contextWindow: Schema.number().step(1).min(0).default(0),
      /** Max output tokens override (0 = use discovered/metadata value). */
      maxOutput: Schema.number().step(1).min(0).default(0),
    }),
  ).default({}).volatile(),
})

/** The volatile part of the settings value (what the card edits). */
/**
 * Resolve one possibly-volatile field.
 *
 * The Loader hands `apply` a resolved Config where every `.volatile()` field is
 * a STABLE REFERENCE object with `.get()` (the settings page writes into it).
 * Ordinary fields arrive as plain values. Both spellings resolve here, so the
 * same code works on 0.1.7, 0.2 and on a hand-written patch object.
 */
function deref(field, fallback) {
  if (field === undefined || field === null) return fallback
  if (typeof field === 'object' && typeof field.get === 'function') {
    try {
      const value = field.get()
      return value === undefined || value === null ? fallback : value
    } catch {
      return fallback
    }
  }
  return field
}

/** The volatile part of the settings value (what the card edits). */
export function settingsValue(config = {}) {
  const models = deref(config.models, undefined)
  return {
    freeOnly: deref(config.freeOnly, true),
    refreshSeconds: deref(config.refreshSeconds, 300),
    accessToken: deref(config.accessToken, ''),
    models: models && typeof models === 'object' ? models : {},
  }
}

/**
 * Read the live settings value out of whatever the Loader handed `apply`.
 * Volatile fields are dereferenced; a plain patch object passes through.
 */
export function readSettings(raw) {
  return settingsValue(raw ?? {})
}

/** Convert the settings `models` map into catalog overrides. */
export function toOverrides(models) {
  const out = {}
  if (!models || typeof models !== 'object') return out
  for (const [id, entry] of Object.entries(models)) {
    if (!entry || typeof entry !== 'object') continue
    const override = {}
    if (entry.hidden === true) override.hidden = true
    const contextWindow = Number(entry.contextWindow)
    if (Number.isFinite(contextWindow) && contextWindow > 0) override.contextWindow = Math.trunc(contextWindow)
    const maxOutput = Number(entry.maxOutput)
    if (Number.isFinite(maxOutput) && maxOutput > 0) override.maxOutput = Math.trunc(maxOutput)
    if (Object.keys(override).length > 0) out[id] = override
  }
  return out
}
