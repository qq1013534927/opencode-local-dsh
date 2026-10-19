#!/usr/bin/env node
/**
 * Regression test for the settings card's 只看免费 (free-only) switch.
 *
 * The card is a browser module (`window.__ModuleLoader__.load(...)`), so this
 * harness stubs the loader, `window`, `fetch` and React's hooks (a ~50 line
 * runtime) and drives the real component. No dependencies, no DOM.
 *
 * It pins the three failures reported against 0.3.9:
 *   1. "clicking does nothing"  — the checkbox must not fall back to the served
 *      settings form value (a stale snapshot) once the bridge has answered.
 *   2. "it ticks everything"    — toggling must write `freeOnly` and nothing
 *      else; no `models` map, no mass rewrite of the profile.
 *   3. "only-free is not implemented" — with the filter on, the card's table
 *      must list the free models only.
 *
 * Run: node test/free-only-switch.mjs
 */

import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BRIDGE = '/api/opencode-local/settings'

// ---------------------------------------------------------------- fake roster
const FREE_IDS = [
  'beam-free',
  'big-pickle',
  'deepseek-v4.1-flash-free',
  'glm-5.3-flash-free',
  'jev-1.13-free',
  'longcat-2.5-preview-free',
  'mimo-v2.6-flash-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'nemotron-3.5-super-vl-free',
  'space-bunny-free',
]
const PAID_IDS = Array.from({ length: 37 }, (_, i) => `paid-model-${String(i + 1).padStart(2, '0')}`)
const ROSTER = [...FREE_IDS, ...PAID_IDS].sort().map((id) => ({
  id,
  hidden: false,
  free: FREE_IDS.includes(id),
  contextWindow: 200000,
  maxOutput: 32000,
  contextWindowOverridden: false,
  maxOutputOverridden: false,
  reasoning: false,
}))
const IDS = new Set(ROSTER.map((m) => m.id))

// ------------------------------------------------------------------ fake host
const host = { freeOnly: true, overrides: {} }
const calls = []

const exposedCount = () =>
  ROSTER.filter((m) => (!host.freeOnly || m.free) && host.overrides[m.id]?.hidden !== true).length

const statusPayload = () => ({
  ok: true,
  value: {
    tokenSource: 'test',
    account: 'tester@example.com',
    freeOnly: host.freeOnly,
    counts: { total: ROSTER.length, free: FREE_IDS.length, paid: PAID_IDS.length, exposed: exposedCount() },
    catalog: { total: ROSTER.length, exposed: exposedCount(), status: 'ready', lastError: '' },
    models: ROSTER.map((m) => ({ ...m, hidden: host.overrides[m.id]?.hidden === true })),
    bridge: BRIDGE,
  },
})

const jsonResponse = (payload) => ({ ok: true, status: 200, json: async () => payload })

globalThis.fetch = async (url, init = {}) => {
  const target = String(url)
  const body = init.body ? JSON.parse(init.body) : {}
  calls.push({ url: target, body })
  if (target.endsWith('/status')) return jsonResponse(statusPayload())
  if (target.endsWith('/refresh')) {
    return jsonResponse({
      ok: true,
      value: {
        ...statusPayload().value,
        diff: { added: ['brand-new-free'], removed: [], changed: [] },
      },
    })
  }
  if (target.endsWith('/filter')) {
    if (typeof body.freeOnly === 'boolean') host.freeOnly = body.freeOnly
    if (body.models && typeof body.models === 'object') {
      for (const [id, entry] of Object.entries(body.models)) host.overrides[id] = entry
    }
    return jsonResponse(statusPayload())
  }
  return { ok: false, status: 404, json: async () => ({ ok: false }) }
}

// ------------------------------------------------------------- mini React
function createRuntime(component) {
  const hooks = []
  const pendingEffects = []
  const cleanups = []
  let cursor = 0
  let dirty = false
  let tree = null

  const sameDeps = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
      }
    },
    useState(init) {
      const i = cursor++
      if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init
      return [
        hooks[i],
        (value) => {
          hooks[i] = typeof value === 'function' ? value(hooks[i]) : value
          dirty = true
        },
      ]
    },
    useRef(init) {
      const i = cursor++
      if (!(i in hooks)) hooks[i] = { current: init }
      return hooks[i]
    },
    useMemo(fn, deps) {
      const i = cursor++
      const slot = hooks[i]
      if (!slot || !sameDeps(slot.deps, deps)) hooks[i] = { value: fn(), deps }
      return hooks[i].value
    },
    useCallback(fn, deps) {
      const i = cursor++
      const slot = hooks[i]
      if (!slot || !sameDeps(slot.deps, deps)) hooks[i] = { value: fn, deps }
      return hooks[i].value
    },
    useEffect(fn, deps) {
      const i = cursor++
      const slot = hooks[i]
      if (!slot || !sameDeps(slot.deps, deps)) {
        hooks[i] = { deps }
        pendingEffects.push(fn)
      }
    },
  }

  const runtime = {
    React,
    render(props) {
      do {
        dirty = false
        cursor = 0
        pendingEffects.length = 0
        tree = component(props)
        for (const fn of pendingEffects) {
          const cleanup = fn()
          if (typeof cleanup === 'function') cleanups.push(cleanup)
        }
      } while (dirty)
      return tree
    },
    async settle(props, ticks = 16) {
      for (let i = 0; i < ticks; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (dirty) runtime.render(props)
      }
      return tree
    },
    dispose() {
      for (const fn of cleanups.splice(0)) fn()
    },
  }
  return runtime
}

// -------------------------------------------------------------- tree helpers
function walk(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  if (typeof node.type === 'string' || typeof node.type === 'function') out.push(node)
  for (const child of node.children ?? []) walk(child, out)
  return out
}

const checkboxes = (node) => walk(node).filter((n) => n.type === 'input' && n.props.type === 'checkbox')
const rowNodes = (tree) => walk(tree).filter((n) => n.type === 'div' && n.props.key && IDS.has(n.props.key))
function freeOnlyBox(tree) {
  const label = walk(tree).find((n) => n.type === 'label' && n.props.title === 'freeOnlyHint')
  assert.ok(label, 'the free-only label must be rendered')
  const inside = checkboxes(label)
  assert.equal(inside.length, 1, 'the free-only label must wrap exactly one checkbox')
  return inside[0]
}

// ------------------------------------------------------- load the real card
let loaderFactory = null
globalThis.window = {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
  __ModuleLoader__: {
    load({ factory }) {
      loaderFactory = factory
    },
  },
}

// The card captures `h = React.createElement` once, at module load, before any
// runtime exists — so element building is a stateless shared function while the
// hook API resolves per render to the runtime that is currently mounted.
const createElement = (type, props, ...children) => ({
  type,
  props: props ?? {},
  children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
})
let activeHooks = null
const ReactForwarder = new Proxy(
  {},
  {
    get(_target, key) {
      if (key === 'createElement') return createElement
      const impl = activeHooks?.[key]
      if (impl === undefined) throw new Error(`react.${String(key)} is not provided by the harness`)
      return impl
    },
  },
)

await import(pathToFileURL(join(ROOT, 'client.js')).href)
assert.equal(typeof loaderFactory, 'function', 'client.js must register with window.__ModuleLoader__')

const captured = []
const ctx = {
  locale: { bind: () => (key) => key, register: () => () => {} },
  slots: {
    register(spec, component) {
      captured.push({ spec, component })
      return () => {}
    },
    inject: () => () => {},
  },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  inject(_names, cb) {
    cb({ slots: ctx.slots, effect: ctx.effect })
    return () => {}
  },
}
loaderFactory((name) => {
  if (name === 'react') return ReactForwarder
  throw new Error(`unexpected require(${name})`)
}).apply(ctx)

const card = captured.find((c) => c.spec?.name === 'plugins.row.config')?.component
assert.ok(card, 'the card must register on the plugins.row.config slot')

/** Mount the card against a fake served settings form + the fake host. */
const formMutations = []
const servedValue = { freeOnly: true }
function mount({ servedFreeOnly, hostFreeOnly }) {
  host.freeOnly = hostFreeOnly
  host.overrides = {}
  calls.length = 0
  formMutations.length = 0
  servedValue.freeOnly = servedFreeOnly
  const props = {
    view: 'page',
    t: (key) => key,
    form: {
      state: { value: { freeOnly: servedFreeOnly, models: {} }, revision: 7, writable: true },
      mutate: async (ops) => {
        formMutations.push(ops)
        for (const op of ops ?? []) {
          if (op.path?.[0] === 'freeOnly') servedValue.freeOnly = op.value
        }
        return true
      },
    },
  }
  const runtime = createRuntime(card)
  activeHooks = runtime.React
  runtime.render(props)
  return { runtime, props }
}

// --------------------------------------------------------------- scenarios
const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`  PASS  ${name}`)
  } catch (err) {
    const detail = String(err?.message ?? err)
    results.push({ name, ok: false, detail })
    console.log(`  FAIL  ${name} — ${detail}`)
  }
}

console.log('free-only switch regression\n')

// --- S1: a stale served-form snapshot must not re-check the box -------------
{
  const { runtime, props } = mount({ servedFreeOnly: true, hostFreeOnly: false })
  const tree = await runtime.settle(props)
  check('S1a 复选框跟随 live 宿主状态（served form 说 true、宿主说 false 时显示未勾选）', () => {
    assert.equal(freeOnlyBox(tree).props.checked, false, 'stale served form value re-checked the box')
  })
  check('S1b 首帧只拉一次 /status', () => {
    assert.equal(calls.filter((c) => c.url.endsWith('/status')).length, 1)
  })

  freeOnlyBox(tree).props.onChange({ target: { checked: true } })
  const after = await runtime.settle(props)
  const filterCalls = calls.filter((c) => c.url.endsWith('/filter'))
  check('S1c 点击只写 { freeOnly: true }（不带 models）', () => {
    assert.equal(filterCalls.length, 1, `expected 1 /filter call, saw ${filterCalls.length}`)
    assert.deepEqual(filterCalls[0].body, { freeOnly: true })
  })
  check('S1d 宿主状态随点击翻转', () => assert.equal(host.freeOnly, true))
  check('S1e 点击后复选框保持勾选（不弹回）', () => {
    assert.equal(freeOnlyBox(after).props.checked, true)
  })
  check('S1f 通过官方设置通道持久化 freeOnly（重启后仍在）', () => {
    assert.equal(formMutations.length, 1, `expected 1 form.mutate call, saw ${formMutations.length}`)
    assert.deepEqual(formMutations[0], [{ op: 'set', path: ['freeOnly'], value: true }])
  })
  runtime.dispose()
}

// --- S2: unticking must not mass-tick anything ------------------------------
{
  const { runtime, props } = mount({ servedFreeOnly: true, hostFreeOnly: true })
  const before = await runtime.settle(props)
  check('S2a 过滤开启时表格只列免费模型', () => {
    assert.equal(rowNodes(before).length, FREE_IDS.length, `rows=${rowNodes(before).length}`)
    assert.equal(freeOnlyBox(before).props.checked, true)
  })
  check('S2b 复选框总数 = 1（工具条）+ 模型行数', () => {
    assert.equal(checkboxes(before).length, FREE_IDS.length + 1)
  })

  freeOnlyBox(before).props.onChange({ target: { checked: false } })
  const after = await runtime.settle(props)
  const filterCalls = calls.filter((c) => c.url.endsWith('/filter'))
  check('S2c 取消勾选只写 { freeOnly: false }', () => {
    assert.equal(filterCalls.length, 1, `expected 1 /filter call, saw ${filterCalls.length}`)
    assert.deepEqual(filterCalls[0].body, { freeOnly: false })
    assert.ok(!('models' in filterCalls[0].body), 'the toggle must not carry a models map')
  })
  check('S2d 没有任何模型被批量写成 hidden', () => {
    assert.deepEqual(host.overrides, {}, `overrides=${JSON.stringify(host.overrides)}`)
  })
  check('S2e 取消勾选后复选框保持未勾选（不弹回）', () => {
    assert.equal(freeOnlyBox(after).props.checked, false)
  })
  check('S2f 过滤关闭后表格列全部模型', () => {
    assert.equal(rowNodes(after).length, ROSTER.length, `rows=${rowNodes(after).length}`)
  })
  check('S2g 关闭过滤没有把任何行改成“隐藏”', () => {
    const rows = rowNodes(after)
    const shown = rows.filter((r) => checkboxes(r)[0].props.checked).length
    assert.equal(shown, ROSTER.length, `shown=${shown}`)
  })
  check('S2h 持久化只写 freeOnly，不写任何 models 条目', () => {
    assert.equal(formMutations.length, 1, `expected 1 form.mutate call, saw ${formMutations.length}`)
    assert.deepEqual(formMutations[0], [{ op: 'set', path: ['freeOnly'], value: false }])
  })
  runtime.dispose()
}

// --- S3: before the first /status answer the form value is the fallback -----
{
  const { runtime, props } = mount({ servedFreeOnly: true, hostFreeOnly: false })
  const first = runtime.render(props)
  check('S3 首帧（status 未到达）回退到 served form 值', () => {
    assert.equal(freeOnlyBox(first).props.checked, true)
  })
  await runtime.settle(props)
  runtime.dispose()
}

// --- S4: the bulk "tick free only" button writes BOTH halves atomically ----
{
  const { runtime, props } = mount({ servedFreeOnly: false, hostFreeOnly: false })
  await runtime.settle(props)
  const tree = runtime.render(props)
  // the "只勾选免费" button
  const button = walk(tree).find((n) => n.type === 'button' && (n.props.title === 'pickFreeHint' || n.props.title === '只勾选免费'));
  check('S4a 卡片上有「只勾选免费」按钮', () => assert.ok(button, 'bulk free-only button not found'));
  if (button) {
    await button.props.onClick();
    await runtime.settle(props);
    const filterCalls = calls.filter((c) => c.url.endsWith('/filter'));
    check('S4b 按钮一次请求里同时写 freeOnly 与 models', () => {
      assert.equal(filterCalls.length, 1, `expected 1 /filter call, saw ${filterCalls.length}`);
      assert.equal(filterCalls[0].body.freeOnly, true);
      assert.ok(filterCalls[0].body.models, 'models map must be sent');
    });
    check('S4c 付费模型被标记隐藏、免费模型保持显示', () => {
      const m = filterCalls[0].body.models;
      assert.equal(m['paid-model-01'].hidden, true);
      assert.equal(m['beam-free'].hidden, false);
    });
    check('S4d 持久化是 ONE 操作列表（原子，不会互相覆盖）', () => {
      assert.equal(formMutations.length, 1, `expected 1 form.mutate call, saw ${formMutations.length}`);
      const ops = formMutations[0];
      assert.ok(ops.some((o) => o.path[0] === 'freeOnly' && o.value === true), 'freeOnly op missing');
      assert.ok(ops.some((o) => o.path[0] === 'models' && o.path[1] === 'paid-model-01'), 'models op missing');
    });
  }
  runtime.dispose()
}

// --- S5: the "更新模型" button forces a refresh and reports the diff ------
{
  const { runtime, props } = mount({ servedFreeOnly: false, hostFreeOnly: false })
  await runtime.settle(props)
  const tree = runtime.render(props)
  const button = walk(tree).find((n) => n.type === 'button' && n.props.title === 'updateModelsHint');
  check('S5a 卡片上有「更新模型」按钮', () => assert.ok(button, 'update-models button not found'));
  if (button) {
    await button.props.onClick();
    await runtime.settle(props);
    const refreshCalls = calls.filter((c) => c.url.endsWith('/refresh'));
    check('S5b 点击后调用 /refresh 桥接路由', () => {
      assert.equal(refreshCalls.length, 1, `expected 1 /refresh call, saw ${refreshCalls.length}`);
    });
    check('S5c 更新不改动任何仍在目录里的模型', () => {
      const filterCalls = calls.filter((c) => c.url.endsWith('/filter'));
      assert.equal(filterCalls.length, 0, 'updating must not write through the filter route');
      // The draft holds only live ids in this scenario, so nothing is pruned.
      const pruned = formMutations.filter((ops) => ops.some((o) => o.op === 'unset'));
      assert.equal(pruned.length, 0, `unexpected prune: ${JSON.stringify(pruned)}`);
      const sets = formMutations.flat().filter((o) => o.op === 'set' && o.path[0] === 'models');
      assert.equal(sets.length, 0, 'updating must not rewrite live model entries');
    });
  }
  runtime.dispose()
}

// --- S6: 更新模型 prunes the settings of models that left the catalog -------
{
  const { runtime, props } = mount({ servedFreeOnly: false, hostFreeOnly: false })
  // a model that is in the settings map but NOT in the live roster
  const tree = runtime.render(props)
  void tree
  // make the draft carry a stale id by writing a model entry that the
  // roster does not carry
  const stale = 'gone-model-free'
  await runtime.settle(props)
  // simulate: the settings map has an entry for a model the catalog dropped
  props.form.state.value.models = { [stale]: { hidden: false, contextWindow: 0, maxOutput: 0 } }
  const after = runtime.render(props)
  const button = walk(after).find((n) => n.type === 'button' && n.props.title === 'updateModelsHint');
  check('S6a 更新模型按钮存在', () => assert.ok(button, 'update-models button not found'));
  if (button) {
    await button.props.onClick();
    await runtime.settle(props);
    const pruned = formMutations.flat().filter((o) => o.op === 'unset');
    check('S6b 过期的模型设置被 unset 掉', () => {
      assert.equal(pruned.length, 1, `expected 1 unset op, saw ${JSON.stringify(formMutations)}`);
      assert.deepEqual(pruned[0].path, ['models', stale]);
    });
  }
  runtime.dispose()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exitCode = 1
}
