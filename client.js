/**
 * opencode-local — browser half (0.3).
 *
 * Registers the plugin's settings card on the Plugins page
 * (设置 → 插件 → 本机 OpenCode 通道) through the `plugins.row.config` slot,
 * which @deepseek-ai/dsh-client-ui-plugin-manager owns. The Host serves this
 * entry's settings and the loopback bridge the card reads live state from.
 *
 * The card offers:
 *   - per-model visibility (是否显示),
 *   - an availability test per model and for all models at once (测试可用性),
 *   - context window / max output editing (上下文长度),
 *   - plus the lane status (token source, account, catalog).
 *
 * Cross-plugin collaboration goes through cordis services (`slots`, `locale`,
 * `configForms`); no value imports of other @deepseek-ai packages.
 */

window.__ModuleLoader__.load({
  id: '@local/opencode-local',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The Loader entry id whose settings this card edits. */
    const SETTINGS_NAMESPACE = 'opencode-local'
    /** The bridge prefix the Host serves (must match settings-bridge.js). */
    const BRIDGE = '/api/opencode-local/settings'
    /** This plugin's copy namespace. */
    const NS = 'settings.opencode-local'

    const en = {
      title: 'OpenCode Local Lane',
      oneLiner: 'Your own OpenCode account lane — model visibility, availability tests, context limits.',
      status: 'Lane status',
      tokenSource: 'Credential source',
      account: 'Account',
      catalog: 'Models',
      refresh: 'Refresh',
      testAll: 'Test all',
      testing: 'Testing…',
      models: 'Models',
      show: 'Show',
      hide: 'Hide',
      context: 'Context',
      maxOutput: 'Max output',
      test: 'Test',
      ok: 'Available',
      failed: 'Unavailable',
      noModels: 'No models discovered yet. Is the OpenCode client logged in?',
      auto: 'auto',
      adopt: 'auto',
      saved: 'Saved.',
      unspecified: 'Not set',
      freeOnly: 'Free only',
      freeOnlyHint: 'Show only the built-in free models. Untick to see every model your account can route (including paid).',
      freeOnlyOn: 'Free-only filter on.',
      freeOnlyOff: 'Showing all models.',
      free: 'free',
      paid: 'paid',
    }

    const zh = {
      title: '本机 OpenCode 通道',
      oneLiner: '走自己 OpenCode 账号的通道——模型显示、可用性测试、上下文长度。',
      status: '通道状态',
      tokenSource: '凭据来源',
      account: '账号',
      catalog: '模型',
      refresh: '刷新',
      testAll: '全部测试',
      testing: '测试中…',
      models: '模型',
      show: '显示',
      hide: '隐藏',
      context: '上下文',
      maxOutput: '最大输出',
      test: '测试',
      ok: '可用',
      failed: '不可用',
      noModels: '尚未发现模型。OpenCode 客户端是否已登录？',
      auto: '自动',
      adopt: '自动',
      saved: '已保存。',
      unspecified: '未设置',
      freeOnly: '只看免费',
      freeOnlyHint: '只显示内置免费模型。取消勾选即可看到你账号可路由的全部模型（含付费）。',
      freeOnlyOn: '已开启只看免费。',
      freeOnlyOff: '已显示全部模型。',
      free: '免费',
      paid: '付费',
    }

    // -- styles (theme tokens only) ----------------------------------------
    const S = {
      card: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0' },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      grid: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 340, overflowY: 'auto' },
      head: {
        display: 'grid',
        gridTemplateColumns: 'minmax(140px, 1.6fr) 64px 100px 100px 132px',
        gap: 8,
        padding: '4px 6px',
        fontSize: 12,
        opacity: 0.65,
      },
      line: {
        display: 'grid',
        gridTemplateColumns: 'minmax(140px, 1.6fr) 64px 100px 100px 132px',
        gap: 8,
        alignItems: 'center',
        padding: '3px 6px',
        borderRadius: 6,
      },
      name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '3px 6px',
        borderRadius: 6,
        border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))',
        background: 'var(--dsh-surface, transparent)',
        color: 'inherit',
        fontSize: 12,
      },
      button: {
        padding: '4px 10px',
        borderRadius: 6,
        border: '1px solid var(--dsh-border, rgba(127,127,127,0.35))',
        background: 'var(--dsh-surface, transparent)',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: 12,
      },
      muted: { fontSize: 12, opacity: 0.65 },
      badgeOk: { fontSize: 11, padding: '1px 6px', borderRadius: 999, background: 'rgba(46,160,67,0.18)', color: 'rgb(46,160,67)' },
      badgeBad: { fontSize: 11, padding: '1px 6px', borderRadius: 999, background: 'rgba(207,80,80,0.18)', color: 'rgb(207,80,80)' },
      badgeWait: { fontSize: 11, padding: '1px 6px', borderRadius: 999, opacity: 0.6 },
      tagFree: { fontSize: 10, padding: '0 5px', borderRadius: 4, background: 'rgba(46,160,67,0.16)', color: 'rgb(46,160,67)', flexShrink: 0 },
      tagPaid: { fontSize: 10, padding: '0 5px', borderRadius: 4, background: 'rgba(127,127,127,0.16)', opacity: 0.75, flexShrink: 0 },
    }

    /** Small same-origin POST to the loopback bridge. */
    async function bridge(path, body) {
      const res = await fetch(BRIDGE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      if (!res.ok) throw new Error(`bridge ${path} -> HTTP ${res.status}`)
      return res.json()
    }

    /**
     * The settings card. DSH hands it `{ state, mutate }` for the served entry;
     * `state.value` is the settings object, `mutate` applies an update.
     */
    function OpenCodeLocalCard(props) {
      const t = props.t ?? ((key) => (zh[key] ?? en[key] ?? key))
      const form = props.settings ?? props
      const state = form.state ?? {}
      const value = state.value ?? {}
      const revision = state.revision
      const modelsValue = value.models && typeof value.models === 'object' ? value.models : {}

      const [status, setStatus] = React.useState(null)
      const [statusError, setStatusError] = React.useState('')
      const [roster, setRoster] = React.useState([])
      const [results, setResults] = React.useState({})
      const [probing, setProbing] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState('')
      // Local draft of the per-model map; committed through mutate on change.
      const [draft, setDraft] = React.useState(modelsValue)

      React.useEffect(() => {
        setDraft(modelsValue)
      }, [JSON.stringify(modelsValue)])

      const loadStatus = React.useCallback(async () => {
        try {
          const payload = await bridge('/status')
          if (payload?.ok) {
            setStatus(payload.value)
            setRoster(Array.isArray(payload.value?.models) ? payload.value.models : [])
            setStatusError('')
          } else {
            setStatusError(payload?.message ?? 'status unavailable')
          }
        } catch (err) {
          setStatusError(String(err?.message ?? err))
        }
      }, [])

      React.useEffect(() => {
        void loadStatus()
      }, [loadStatus])

      /** Write one model's entry into the volatile map via a path op. */
      const patchModel = React.useCallback(
        (id, patch) => {
          const current = draft?.[id] ?? { hidden: false, contextWindow: 0, maxOutput: 0 }
          const next = { ...current, ...patch }
          const nextDraft = { ...draft, [id]: next }
          setDraft(nextDraft)
          if (typeof form.mutate === 'function') {
            void form.mutate([{ op: 'set', path: ['models', id], value: next }], revision)
          }
        },
        [draft, form, revision],
      )

      /** The rows the card shows: live roster merged with the edited draft. */
      const ordered = React.useMemo(() => {
        const byId = new Map(roster.map((m) => [m.id, m]))
        const merged = []
        for (const m of roster) merged.push(m)
        for (const id of Object.keys(draft)) {
          if (!byId.has(id)) {
            merged.push({
              id,
              hidden: draft[id]?.hidden === true,
              free: id.includes('free'),
              contextWindow: 0,
              maxOutput: 0,
            })
          }
        }
        return merged.sort((a, b) => a.id.localeCompare(b.id))
      }, [roster, draft])

      /**
       * Availability test over SSE: the bridge pushes one `result` event per
       * model as soon as it settles, so rows fill in one by one instead of the
       * whole batch landing at the end.
       */
      const runProbe = React.useCallback(
        async (ids) => {
          const targets = Array.isArray(ids) && ids.length > 0 ? ids : ordered.map((m) => m.id)
          setBusy(true)
          setNote(t('testing'))
          setProbing(Object.fromEntries(targets.map((id) => [id, true])))
          try {
            const res = await fetch(BRIDGE + '/probe', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ids: targets }),
            })
            if (!res.ok || !res.body) throw new Error(`bridge /probe -> HTTP ${res.status}`)
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            let event = ''
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += decoder.decode(value, { stream: true })
              let nl
              while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl).replace(/\r$/, '')
                buffer = buffer.slice(nl + 1)
                if (line.startsWith('event: ')) {
                  event = line.slice(7).trim()
                  continue
                }
                if (line.startsWith('data: ')) {
                  let payload
                  try {
                    payload = JSON.parse(line.slice(6))
                  } catch {
                    continue
                  }
                  if (event === 'result' && payload?.id) {
                    const result = payload
                    setResults((prev) => ({ ...prev, [result.id]: result }))
                    setProbing((prev) => {
                      const next = { ...prev }
                      delete next[result.id]
                      return next
                    })
                  } else if (event === 'done') {
                    setNote('')
                  } else if (event === 'failed') {
                    setNote(String(payload?.message ?? 'probe failed'))
                  }
                }
              }
            }
          } catch (err) {
            setNote(String(err?.message ?? err))
          } finally {
            setBusy(false)
            setProbing({})
          }
        },
        [t, ordered],
      )

      const commit = React.useCallback(() => {
        if (typeof form.mutate === 'function') {
          const ops = Object.entries(draft).map(([id, entry]) => ({ op: 'set', path: ['models', id], value: entry }))
          void form.mutate(ops, revision)
        }
        setNote(t('saved'))
      }, [draft, form, revision, t])

      const statusLine = status
        ? `${t('tokenSource')}: ${status.tokenSource}${status.account ? ` · ${t('account')}: ${status.account}` : ''} · ${t('catalog')}: ${status.catalog?.exposed ?? 0}/${status.catalog?.total ?? 0}`
        : statusError || '—'

      /** "free N · paid M" — makes the current filter's scope explicit. */
      const countsLine = status?.counts
        ? `${t('free')} ${status.counts.free} · ${t('paid')} ${status.counts.paid}`
        : ''

      /** One-click free-only filter: writes `freeOnly` and re-reads the roster. */
      const setFreeOnlyFilter = (next) => {
        if (typeof form.mutate === 'function') {
          void form.mutate([{ op: 'set', path: ['freeOnly'], value: next }], revision)
        }
        setNote(next ? t('freeOnlyOn') : t('freeOnlyOff'))
        // The Host applies the filter live; re-read so the rows follow.
        window.setTimeout(() => void loadStatus(), 400)
      }

      return h(
        'div',
        { style: S.card },
        // status row
        h(
          'div',
          { style: S.row },
          h('span', { style: S.muted }, `${t('status')}: ${statusLine}`),
          h('button', { style: S.button, onClick: () => void loadStatus() }, t('refresh')),
          h(
            'button',
            {
              style: S.button,
              disabled: busy,
              onClick: () => void runProbe(ordered.map((m) => m.id)),
            },
            busy ? t('testing') : t('testAll'),
          ),
          // One-click free-only filter (checked on a fresh install).
          h(
            'label',
            { style: { ...S.row, gap: 6, cursor: 'pointer' }, title: t('freeOnlyHint') },
            h('input', {
              type: 'checkbox',
              checked: Boolean(status?.freeOnly),
              onChange: (e) => setFreeOnlyFilter(e.target.checked),
            }),
            h('span', { style: S.muted }, t('freeOnly')),
            countsLine ? h('span', { style: S.muted }, `(${countsLine})`) : null,
          ),
          note ? h('span', { style: S.muted }, note) : null,
        ),
        // header
        h(
          'div',
          { style: S.head },
          h('span', null, t('models')),
          h('span', null, t('show')),
          h('span', null, t('context')),
          h('span', null, t('maxOutput')),
          h('span', null, ''),
        ),
        // rows
        ordered.length === 0
          ? h('div', { style: S.muted }, t('noModels'))
          : h(
              'div',
              { style: S.grid },
              ...ordered.map((m) => {
                const entry = draft[m.id] ?? {}
                const hidden = entry.hidden === true
                const result = results[m.id]
                return h(
                  'div',
                  { key: m.id, style: { ...S.line, opacity: hidden ? 0.55 : 1 } },
                  h(
                    'span',
                    { style: { ...S.name, display: 'flex', alignItems: 'center', gap: 6 }, title: m.id },
                    h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, m.id),
                    m.free
                      ? h('span', { style: S.tagFree }, 'free')
                      : h('span', { style: S.tagPaid }, t('paid')),
                  ),
                  h('input', {
                    type: 'checkbox',
                    checked: !hidden,
                    onChange: (e) => patchModel(m.id, { hidden: !e.target.checked }),
                  }),
                  // Context / output: the input shows the EFFECTIVE value
                  // (override when set, otherwise the discovered metadata), so
                  // the number on screen is what the model actually gets.
                  h('input', {
                    style: S.input,
                    type: 'number',
                    min: 0,
                    title: m.contextWindow ? `effective: ${m.contextWindow}` : t('auto'),
                    value: entry.contextWindow ? entry.contextWindow : m.contextWindow || '',
                    placeholder: t('auto'),
                    onChange: (e) => patchModel(m.id, { contextWindow: Number(e.target.value) || 0 }),
                  }),
                  h('input', {
                    style: S.input,
                    type: 'number',
                    min: 0,
                    title: m.maxOutput ? `effective: ${m.maxOutput}` : t('auto'),
                    value: entry.maxOutput ? entry.maxOutput : m.maxOutput || '',
                    placeholder: t('auto'),
                    onChange: (e) => patchModel(m.id, { maxOutput: Number(e.target.value) || 0 }),
                  }),
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' } },
                    probing[m.id]
                      ? h('span', S.badgeWait, t('testing'))
                      : result
                        ? h(
                            'span',
                            { style: result.ok ? S.badgeOk : S.badgeBad, title: result.message || result.code },
                            `${result.ok ? t('ok') : t('failed')} · ${result.code}${result.latencyMs ? ` · ${result.latencyMs}ms` : ''}`,
                          )
                        : null,
                    h(
                      'button',
                      { style: S.button, disabled: Boolean(probing[m.id]), onClick: () => void runProbe([m.id]) },
                      t('test'),
                    ),
                  ),
                )
              }),
            ),
        h('div', { style: S.row }, h('button', { style: S.button, onClick: commit }, t('saved'))),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'opencode-local: copy dictionaries')

        // 0.2 mounts configuration inside each installed bundle's row: the row
        // gains a configure control opening this page.
        const mountCard = (slots) => {
          const disposers = ['@local/opencode-local', 'opencode-local'].map((pkg) =>
            slots.register(
              { name: 'plugins.row.config', key: `${pkg}#${SETTINGS_NAMESPACE}`, locale: NS },
              OpenCodeLocalCard,
            ),
          )
          const legacy = slots.inject('plugins.item', () => {
            if (slots.spec && slots.spec('plugins.row.config') !== undefined) return () => {}
            return slots.register(
              { name: 'plugins.item', id: SETTINGS_NAMESPACE, order: 20, label: () => t('title'), locale: NS },
              OpenCodeLocalCard,
            )
          })
          return () => {
            for (const dispose of disposers) dispose()
            legacy()
          }
        }

        // Request configForms in its own fiber so an older host can still
        // activate the provider half.
        ctx.inject(['configForms'], (formCtx) => {
          if (!formCtx.configForms || typeof formCtx.configForms.whileServed !== 'function') {
            // No served-settings gate on this host: mount the card directly.
            formCtx.effect(() => mountCard(formCtx.slots), 'opencode-local: settings card')
            return
          }
          formCtx.effect(
            () =>
              formCtx.configForms.whileServed([SETTINGS_NAMESPACE], () => mountCard(formCtx.slots)),
            'opencode-local: settings page',
          )
        })
      },
    }
  },
})
