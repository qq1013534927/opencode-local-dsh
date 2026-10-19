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

      const runProbe = React.useCallback(
        async (ids) => {
          setBusy(true)
          setNote(t('testing'))
          try {
            const payload = await bridge('/probe', { ids: ids ?? [] })
            const list = payload?.value?.results ?? []
            const next = { ...results }
            for (const r of list) next[r.id] = r
            setResults(next)
            setNote('')
          } catch (err) {
            setNote(String(err?.message ?? err))
          } finally {
            setBusy(false)
          }
        },
        [results, t],
      )

      const commit = React.useCallback(() => {
        if (typeof form.mutate === 'function') {
          const ops = Object.entries(draft).map(([id, entry]) => ({ op: 'set', path: ['models', id], value: entry }))
          void form.mutate(ops, revision)
        }
        setNote(t('saved'))
      }, [draft, form, revision, t])

      const ordered = React.useMemo(() => {
        const byId = new Map(roster.map((m) => [m.id, m]))
        const merged = []
        for (const m of roster) merged.push(m)
        for (const id of Object.keys(draft)) {
          if (!byId.has(id)) merged.push({ id, hidden: draft[id]?.hidden === true, free: id.includes('free'), contextWindow: 0, maxOutput: 0 })
        }
        return merged.sort((a, b) => a.id.localeCompare(b.id))
      }, [roster, draft])

      const statusLine = status
        ? `${t('tokenSource')}: ${status.tokenSource}${status.account ? ` · ${t('account')}: ${status.account}` : ''} · ${t('catalog')}: ${status.catalog?.exposed ?? 0}/${status.catalog?.total ?? 0}`
        : statusError || '—'

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
                  h('span', { style: S.name, title: m.id }, m.id),
                  h('input', {
                    type: 'checkbox',
                    checked: !hidden,
                    onChange: (e) => patchModel(m.id, { hidden: !e.target.checked }),
                  }),
                  h('input', {
                    style: S.input,
                    type: 'number',
                    min: 0,
                    placeholder: String(m.contextWindow || t('auto')),
                    value: entry.contextWindow || '',
                    onChange: (e) => patchModel(m.id, { contextWindow: Number(e.target.value) || 0 }),
                  }),
                  h('input', {
                    style: S.input,
                    type: 'number',
                    min: 0,
                    placeholder: String(m.maxOutput || t('auto')),
                    value: entry.maxOutput || '',
                    onChange: (e) => patchModel(m.id, { maxOutput: Number(e.target.value) || 0 }),
                  }),
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' } },
                    result
                      ? h(
                          'span',
                          result.ok ? S.badgeOk : S.badgeBad,
                          `${result.ok ? t('ok') : t('failed')}${result.message ? ` · ${result.code}` : ''}`,
                        )
                      : null,
                    result && result.latencyMs ? h('span', { style: S.muted }, `${result.latencyMs}ms`) : null,
                    h('button', { style: S.button, disabled: busy, onClick: () => void runProbe([m.id]) }, t('test')),
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
