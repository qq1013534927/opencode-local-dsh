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
      updateModels: 'Update models',
      updateModelsHint: 'Fetch the model directory from OpenCode now, instead of waiting for the background refresh, and report what changed.',
      updating: 'Updating…',
      updated: 'Model list is up to date.',
      lastRefresh: 'updated',
      updatedWith: '{count} new model(s).',
      removedWith: '{count} model(s) removed.',
      changedWith: '{count} model(s) changed.',
      prunedWith: '{count} stale setting(s) cleaned up.',
      freeOnly: 'Free only',
      freeOnlyHint: 'Show only the built-in free models. Untick to see every model your account can route (including paid).',
      freeOnlyOn: 'Free-only filter on.',
      freeOnlyOff: 'Showing all models.',
      free: 'free',
      paid: 'paid',
      saving: 'Saving…',
      save: 'Save',
      saveRejected: 'Save rejected by the host.',
      saveError: 'Save failed',
      noForm: 'Settings form unavailable.',
      shown: 'Showing',
      allModels: 'all',
      filteredOut: 'filtered by free-only',
      pickFree: 'Tick free only',
      pickFreeHint: 'Explicitly hide every paid model (models.<id>.hidden) and turn the free-only switch on. The switch alone already filters the picker; this button also persists the hiding.',
      pickAll: 'Tick all',
      pickAllHint: 'Clear every hidden flag so all models show again (the free-only switch still filters the picker).',
      testAllHint: 'Probe the free models only (probing a paid model spends your account balance).',
      freePicked: 'Free models ticked; paid models hidden.',
      allPicked: 'All models ticked.',
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
      updateModels: '更新模型',
      updateModelsHint: '立刻从 OpenCode 拉取一次模型目录（不用等后台定时刷新），并告诉你目录有什么变化。',
      updating: '更新中…',
      updated: '模型列表已是最新。',
      lastRefresh: '更新于',
      updatedWith: '新增 {count} 个模型。',
      removedWith: '移除 {count} 个模型。',
      changedWith: '{count} 个模型的限制有变化。',
      prunedWith: '清理了 {count} 条过期设置。',
      freeOnly: '只看免费',
      freeOnlyHint: '只显示内置免费模型。取消勾选即可看到你账号可路由的全部模型（含付费）。',
      freeOnlyOn: '已开启只看免费。',
      freeOnlyOff: '已显示全部模型。',
      free: '免费',
      paid: '付费',
      saving: '保存中…',
      save: '保存',
      saveRejected: '保存被宿主拒绝。',
      saveError: '保存失败',
      noForm: '设置表单不可用。',
      shown: '当前列出',
      allModels: '全部',
      filteredOut: '仅免费',
      pickFree: '只勾选免费',
      pickFreeHint: '把全部付费模型显式标记为隐藏（写 models.<id>.hidden），并打开只看免费。只切换开关本身已经足以过滤选择器；本按钮额外把隐藏标记持久化。',
      pickAll: '全部勾选',
      pickAllHint: '清除全部隐藏标记，让全部模型重新显示（只看免费 开关仍会过滤选择器）。',
      testAllHint: '只测免费模型（测试付费模型会消耗你账号的余额）。',
      freePicked: '已勾选免费模型，付费模型已隐藏。',
      allPicked: '已勾选全部模型。',
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
     * The settings card.
     *
     * DSH binds `{ form, t, view }`: `form` is the served entry's
     * `ConfigPageForm` (`{ state, mutate }`), and `view === 'summary'` asks for
     * the row one-liner instead of the form. Reads come from `form.state.value`;
     * writes go through `form.mutate(ops, revision)`.
     */
    function OpenCodeLocalCard(props) {
      const t = props.t ?? ((key) => (zh[key] ?? en[key] ?? key))
      // The Plugins page also asks for a one-line summary (the row's subtitle).
      if (props.view === 'summary') return h('span', null, t('oneLiner'))

      const form = props.form ?? props.settings ?? {}
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
      /** Optimistic free-only value while the bridge round-trips (null = trust the bridge). */
      const [filterLocal, setFilterLocal] = React.useState(null)
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

      /**
       * Persist a change through the OFFICIAL settings transport.
       *
       * `props.form` is the served entry's `ConfigPageForm` (`{ state, mutate }`)
       * — a render-time snapshot of the Host's settings store. `state.writable`
       * says whether the Host accepts writes, and `state.revision` is the
       * conflict token the Host validates against.
       *
       * The bridge applies a change to the RUNNING adapter; only this path
       * makes it survive a restart, so every write goes through both: the
       * bridge first (so the UI reacts at once), then the form (so it sticks).
       *
       * All fields of one action are submitted as ONE operation list, because
       * the Host applies an operation list atomically — two separate calls
       * would each rewrite the whole entry and the second would drop the
       * first's change.
       *
       * @param {Array<[string[], unknown]>} entries path segments + value pairs
       * @param {Array<string[]>} unsetPaths paths to delete
       */
      const persist = React.useCallback(
        async (entries, unsetPaths = []) => {
          if (typeof form.mutate !== 'function') return false
          const writable = form.state?.writable !== false
          if (!writable) return false
          const ops = entries.map(([path, value]) => ({ op: 'set', path, value }))
          for (const path of unsetPaths) ops.push({ op: 'unset', path })
          if (ops.length === 0) return true
          try {
            const accepted = await form.mutate(ops, form.state?.revision)
            if (accepted === false) {
              setNote(t('saveRejected'))
              return false
            }
            return true
          } catch (err) {
            setNote(`${t('saveError')}: ${String(err?.message ?? err)}`)
            return false
          }
        },
        [form, t],
      )

      /**
       * Write one model's entry.
       *
       * Applied through the bridge (live) and persisted by the Host when a
       * settings surface exists — the same reliable path the bulk actions use.
       */
      const patchModel = React.useCallback(
        (id, patch) => {
          const current = draft?.[id] ?? { hidden: false, contextWindow: 0, maxOutput: 0 }
          const next = { ...current, ...patch }
          const nextDraft = { ...draft, [id]: next }
          setDraft(nextDraft)
          void bridge('/filter', { models: { [id]: next } })
            .then((payload) => {
              if (payload?.ok && payload.value) {
                setStatus(payload.value)
                setRoster(Array.isArray(payload.value.models) ? payload.value.models : [])
              }
            })
            .catch((err) => setNote(`${t('saveError')}: ${String(err?.message ?? err)}`))
          // Persist the same entry so it survives a restart.
          void persist([[['models', id], next]])
        },
        [draft, t, persist],
      )

      /**
       * The card's own roster uses the shared free-id rule (see isFreeId).
       */
      const isFree = React.useCallback(
        (id) => String(id ?? '').toLowerCase().includes('free') || String(id ?? '').toLowerCase() === 'big-pickle',
        [],
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
              free: isFree(id),
              contextWindow: 0,
              maxOutput: 0,
            })
          }
        }
        return merged.sort((a, b) => a.id.localeCompare(b.id))
      }, [roster, draft, isFree])

      /**
       * The free-only switch's displayed value.
       *
       * Order of authority:
       *   1. `filterLocal` — the optimistic value between a click and the
       *      bridge's answer, so the box never flickers.
       *   2. the live adapter state from the bridge (`status.freeOnly`) — this is
       *      what actually filters the model picker right now.
       *   3. the served settings form value — only as a fallback before the
       *      first /status answer arrives.
       *
       * The served form is deliberately LAST: it is a snapshot of the stored
       * settings, it does not refresh when the loopback bridge writes, and
       * trusting it first made the box snap back to its old state right after a
       * click (the "click does nothing" report).
       */
      const liveFreeOnly = typeof status?.freeOnly === 'boolean' ? status.freeOnly : undefined
      const freeOnlyValue =
        filterLocal !== null ? filterLocal : liveFreeOnly !== undefined ? liveFreeOnly : value.freeOnly === true

      /**
       * What the table lists.
       *
       * `roster` is always the WHOLE account catalog (so a paid row is still
       * there the moment the filter goes off), which means the table has to
       * apply the filter itself — otherwise ticking 只看免费 visibly changed
       * nothing but the picker, and the card looked like the switch "was not
       * implemented".
       */
      const shown = React.useMemo(
        () => (freeOnlyValue ? ordered.filter((m) => m.free === true || isFree(m.id)) : ordered),
        [ordered, freeOnlyValue, isFree],
      )

      /**
       * Bulk action: "only tick the free models".
       *
       * Hides every paid model and turns the free-only filter on.
       *
       * Both halves are written in ONE request and, more importantly, ONE
       * `form.mutate` operation list: the Host applies an operation list
       * atomically, whereas two separate mutations of the same entry each
       * rewrite the whole section and the later one drops the earlier half.
       */
      const selectFreeOnly = React.useCallback(async () => {
        const source = ordered.length > 0 ? ordered : roster
        const next = { ...draft }
        for (const m of source) {
          const free = m.free === true || isFree(m.id)
          const entry = next[m.id] ?? { hidden: false, contextWindow: 0, maxOutput: 0 }
          next[m.id] = { ...entry, hidden: !free }
        }
        setDraft(next)
        setFilterLocal(true)
        setNote(t('saving'))
        try {
          // The bridge applies the flags to the running adapter; the official
          // settings transport below makes them survive a restart.
          const payload = await bridge('/filter', { freeOnly: true, models: next })
          if (!payload?.ok || !payload.value) throw new Error(payload?.message ?? 'filter rejected')
          setStatus(payload.value)
          setRoster(Array.isArray(payload.value.models) ? payload.value.models : [])
          setNote(t('freePicked'))
        } catch (err) {
          setFilterLocal(null)
          setNote(`${t('saveError')}: ${String(err?.message ?? err)}`)
          void loadStatus()
          return
        }
        // ONE atomic operation list: the filter flag and the per-model flags
        // land together or not at all.
        await persist([[['freeOnly'], true], ...Object.entries(next).map(([id, entry]) => [['models', id], entry])])
        setFilterLocal(null)
      }, [ordered, roster, draft, isFree, t, persist])

      /**
       * Bulk action: show every model again (clear every hidden flag).
       */
      const selectAll = React.useCallback(async () => {
        const source = ordered.length > 0 ? ordered : roster
        const next = { ...draft }
        for (const m of source) {
          const entry = next[m.id] ?? { hidden: false, contextWindow: 0, maxOutput: 0 }
          next[m.id] = { ...entry, hidden: false }
        }
        setDraft(next)
        try {
          const payload = await bridge('/filter', { models: next })
          if (payload?.ok && payload.value) {
            setStatus(payload.value)
            setRoster(Array.isArray(payload.value.models) ? payload.value.models : [])
          }
          setNote(t('allPicked'))
        } catch (err) {
          setNote(`${t('saveError')}: ${String(err?.message ?? err)}`)
          return
        }
        await persist(Object.entries(next).map(([id, entry]) => [['models', id], entry]))
      }, [ordered, roster, draft, t, persist])

      /**
       * Availability test over SSE: the bridge pushes one `result` event per
       * model as soon as it settles, so rows fill in one by one instead of the
       * whole batch landing at the end.
       */
      const runProbe = React.useCallback(
        async (ids) => {
          // Default target: the FREE models only — probing a paid model spends
          // the account's balance.
          const targets =
            Array.isArray(ids) && ids.length > 0
              ? ids
              : ordered.filter((m) => m.free === true || isFree(m.id)).map((m) => m.id)
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
        [t, ordered, isFree],
      )

      /** Commit the whole edited map through the bridge + the official transport. */
      const commit = React.useCallback(async () => {
        setNote(t('saving'))
        try {
          const payload = await bridge('/filter', { models: draft })
          if (payload?.ok && payload.value) {
            setStatus(payload.value)
            setRoster(Array.isArray(payload.value.models) ? payload.value.models : [])
          }
          setNote(t('saved'))
        } catch (err) {
          setNote(`${t('saveError')}: ${String(err?.message ?? err)}`)
          return
        }
        await persist(Object.entries(draft).map(([id, entry]) => [['models', id], entry]))
      }, [draft, t, persist])

      const statusLine = status
        ? `${t('tokenSource')}: ${status.tokenSource}${status.account ? ` · ${t('account')}: ${status.account}` : ''} · ${t('catalog')}: ${status.catalog?.exposed ?? 0}/${status.catalog?.total ?? 0}`
        : statusError || '—'

      /** When the model directory was last pulled from upstream. */
      const lastRefreshText = status?.catalog?.lastRefresh
        ? new Date(status.catalog.lastRefresh).toLocaleTimeString()
        : ''

      /** "free N · paid M" — makes the current filter's scope explicit. */
      const countsLine = status?.counts
        ? `${t('free')} ${status.counts.free} · ${t('paid')} ${status.counts.paid}`
        : ''

      /**
       * Update the model list from upstream, now.
       *
       * The catalog also refreshes on a timer, but a user who just noticed a
       * missing model should not have to wait for it. This forces a round
       * through the bridge and reports what moved, so the card can say
       * "3 new models" instead of silently re-rendering.
       *
       * It also PRUNES the per-model settings map: an entry for a model the
       * upstream catalog no longer carries is dead weight, and it would keep
       * showing as a phantom row in this table forever. The pruned ids are
       * removed from the local draft and from the stored settings.
       */
      const updateModels = React.useCallback(async () => {
        setBusy(true)
        setNote(t('updating'))
        try {
          const payload = await bridge('/refresh', {})
          if (!payload?.ok || !payload.value) throw new Error(payload?.message ?? payload?.value?.error ?? 'refresh failed')
          setStatus(payload.value)
          const nextRoster = Array.isArray(payload.value.models) ? payload.value.models : []
          setRoster(nextRoster)
          const diff = payload.value.diff ?? {}
          const added = Array.isArray(diff.added) ? diff.added.length : 0
          const removed = Array.isArray(diff.removed) ? diff.removed.length : 0
          const changed = Array.isArray(diff.changed) ? diff.changed.length : 0
          const parts = []
          if (added > 0) parts.push(t('updatedWith', { count: added }))
          if (removed > 0) parts.push(t('removedWith', { count: removed }))
          if (changed > 0) parts.push(t('changedWith', { count: changed }))

          // Drop the settings of models that are no longer in the catalog.
          const live = new Set(nextRoster.map((m) => m.id))
          const stale = Object.keys(draft).filter((id) => !live.has(id))
          if (stale.length > 0) {
            const pruned = { ...draft }
            for (const id of stale) delete pruned[id]
            setDraft(pruned)
            parts.push(t('prunedWith', { count: stale.length }))
            // The stale entries are removed from the stored settings too, so
            // they do not come back on the next start.
            await persist([], stale.map((id) => ['models', id]))
          }
          setNote(parts.length > 0 ? parts.join(' · ') : t('updated'))
        } catch (err) {
          setNote(`${t('saveError')}: ${String(err?.message ?? err)}`)
        } finally {
          setBusy(false)
        }
      }, [t, draft, persist])

      /**
       * One-click free-only filter.
       *
       * Applied through the loopback bridge (which drives the running adapter),
       * so the switch works regardless of whether the served settings form can
       * be written. When the form IS writable the same change is also written
       * through the official settings transport, so the value survives a
       * restart — the bridge alone only moves the live adapter.
       *
       * This writes `freeOnly` and NOTHING else. It used to also clear every
       * `hidden` flag when unticked, which ticked all 48 model rows and rewrote
       * the whole per-model map in the profile for a one-bit toggle — that is
       * the "it ticks everything" report. Hiding paid rows is the separate,
       * explicitly labelled bulk button's job.
       */
      const setFreeOnlyFilter = async (next) => {
        setFilterLocal(next)
        setNote(t('saving'))
        try {
          const payload = await bridge('/filter', { freeOnly: next })
          if (!payload?.ok || !payload.value) throw new Error(payload?.message ?? 'filter rejected')
          // The bridge returns the live adapter state; adopt it and drop the
          // optimistic value in the same tick, so nothing can snap back.
          setStatus(payload.value)
          setRoster(Array.isArray(payload.value.models) ? payload.value.models : [])
          setFilterLocal(null)
          setNote(next ? t('freeOnlyOn') : t('freeOnlyOff'))
        } catch (err) {
          setFilterLocal(null)
          setNote(`${t('saveError')}: ${String(err?.message ?? err)}`)
          // Re-sync with whatever the adapter really holds.
          void loadStatus()
          return
        }
        // Persist through the official settings transport when it is writable.
        // This is what makes the choice survive a restart; the bridge above
        // only moves the running adapter.
        await persist([[['freeOnly'], next]])
      }

      return h(
        'div',
        { style: S.card },
        // status row
        h(
          'div',
          { style: S.row },
          h('span', { style: S.muted }, `${t('status')}: ${statusLine}`),
          lastRefreshText ? h('span', { style: S.muted }, `· ${t('lastRefresh')}: ${lastRefreshText}`) : null,
          h('button', { style: S.button, onClick: () => void loadStatus() }, t('refresh')),
          // Re-fetch the model directory from upstream, now.
          h(
            'button',
            { style: S.button, disabled: busy, title: t('updateModelsHint'), onClick: () => void updateModels() },
            busy ? t('updating') : t('updateModels'),
          ),
          // Bulk visibility: only the free models ticked (paid rows hidden), or
          // everything ticked again.
          h(
            'button',
            { style: S.button, disabled: busy, title: t('pickFreeHint'), onClick: () => void selectFreeOnly() },
            t('pickFree'),
          ),
          h('button', { style: S.button, disabled: busy, title: t('pickAllHint'), onClick: () => void selectAll() }, t('pickAll')),
          h(
            'button',
            {
              style: S.button,
              disabled: busy,
              title: t('testAllHint'),
              // Only the free models are probed: paid ones cost the account.
              onClick: () => void runProbe(ordered.filter((m) => m.free === true || isFree(m.id)).map((m) => m.id)),
            },
            busy ? t('testing') : t('testAll'),
          ),
          // One-click free-only filter (checked on a fresh install).
          h(
            'label',
            { style: { ...S.row, gap: 6, cursor: 'pointer' }, title: t('freeOnlyHint') },
            h('input', {
              type: 'checkbox',
              checked: freeOnlyValue,
              onChange: (e) => void setFreeOnlyFilter(e.target.checked),
            }),
            h('span', { style: S.muted }, t('freeOnly')),
            countsLine ? h('span', { style: S.muted }, `(${countsLine})`) : null,
          ),
          // What the table below currently lists — makes the filter's effect
          // explicit instead of leaving the switch with nothing to show. Kept
          // OUTSIDE the label so clicking the readout cannot toggle the switch.
          h(
            'span',
            { style: S.muted },
            freeOnlyValue
              ? `${t('shown')} ${shown.length}/${ordered.length} · ${t('filteredOut')}`
              : `${t('shown')} ${ordered.length} · ${t('allModels')}`,
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
        // rows — `shown` follows the free-only switch, `ordered` is the whole roster
        shown.length === 0
          ? h('div', { style: S.muted }, t('noModels'))
          : h(
              'div',
              { style: S.grid },
              ...shown.map((m) => {
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
        h('div', { style: S.row }, h('button', { style: S.button, onClick: commit }, t('save'))),
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
