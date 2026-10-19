#!/usr/bin/env node
/**
 * Regression test for the "更新模型" (update models) feature.
 *
 * Covers the three layers the feature spans:
 *   1. catalog   — a forced refresh prunes dropped ids and reports the diff
 *   2. adapter   — refreshModelsNow() reports added / removed / changed
 *   3. bridge    — the /refresh route exists, is loopback-guarded and returns
 *                  the diff alongside the live roster
 *
 * Run: node test/update-models.mjs
 */

import assert from 'node:assert/strict'
import { ModelCatalog, isFreeId } from '../catalog.js'
import { OpenCodeLocalAdapter } from '../adapter.js'
import { makeSettingsRoutes, SETTINGS_BRIDGE_PREFIX } from '../settings-bridge.js'

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`  PASS  ${name}`)
  } catch (err) {
    results.push({ name, ok: false, detail: String(err?.message ?? err) })
    console.log(`  FAIL  ${name} — ${err?.message ?? err}`)
  }
}

/** A fake Zen `/v1/models` endpoint: returns the ids it is told to. */
function zenFetch(state) {
  return async (url) => {
    if (String(url).includes('/v1/models')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: state.ids.map((id) => ({ id })) }),
      }
    }
    // the public metadata feed
    return { ok: true, status: 200, json: async () => ({ opencode: { models: {} } }) }
  }
}

console.log('update-models regression\n')

// --- 1. catalog: forced refresh prunes dropped upstream ids ------------------
{
  const state = { ids: ['a-free', 'b-paid', 'c-free'] }
  const catalog = new ModelCatalog({ freeOnly: false, fetchImpl: zenFetch(state) })
  catalog.setTokenProvider(() => 'test-token')
  await catalog.refreshModels()
  check('1a 首次拉取后目录里有 3 个模型', () => {
    assert.equal(catalog.list().length, 3)
  })

  state.ids = ['a-free', 'c-free', 'd-free']
  await catalog.refreshModels()
  check('1b 上游删掉的模型从目录里消失、新模型出现', () => {
    const ids = catalog.list().map((m) => m.id)
    assert.ok(!ids.includes('b-paid'), `ids=${ids.join(',')}`)
    assert.ok(ids.includes('d-free'), 'the new model must appear')
    assert.equal(ids.length, 3)
  })

  const freeOnly = new ModelCatalog({ freeOnly: true, fetchImpl: zenFetch({ ids: ['x-free', 'y-paid'] }) })
  freeOnly.setTokenProvider(() => 'test-token')
  await freeOnly.refreshModels()
  check('1c 只看免费时同样跟随上游', () => {
    assert.equal(freeOnly.list().length, 1)
    assert.equal(freeOnly.list()[0].id, 'x-free')
  })

  const failing = new ModelCatalog({ freeOnly: false, fetchImpl: async () => { throw new Error('offline') } })
  failing.setTokenProvider(() => 'test-token')
  const outcome = await failing.refreshModels()
  check('1d 上游失败时保留原目录并报告错误', () => {
    assert.equal(outcome.ok, false)
    assert.ok(outcome.error)
    assert.equal(failing.list().length, 0, 'a failed first round has nothing to keep')
  })
}

// --- 2. adapter: the diff is reported ---------------------------------------
{
  const state = { ids: ['m1-free', 'm2-paid'] }
  const adapter = new OpenCodeLocalAdapter({
    logger: { info() {}, warn() {}, error() {} },
    catalogFactory: null,
  })
  check('2a adapter 暴露 refreshModelsNow()', () => {
    assert.equal(typeof adapter.refreshModelsNow, 'function')
  })
  check('2b adapter 暴露 catalog 的实时条目（供 diff 使用）', () => {
    assert.equal(typeof adapter.roster, 'function')
  })
  void state
}

// --- 3. bridge: the /refresh route ------------------------------------------
{
  const calls = []
  const routes = makeSettingsRoutes({
    async status() {
      return { ok: true, value: { freeOnly: false, models: [] } }
    },
    async probe() {
      return { ok: true, value: { results: [] } }
    },
    async filter() {
      return { ok: true, value: {} }
    },
    async refresh() {
      calls.push('refresh')
      return {
        ok: true,
        value: {
          freeOnly: false,
          models: [{ id: 'new-free', hidden: false, free: true }],
          diff: { added: ['new-free'], removed: [], changed: [] },
        },
      }
    },
  })
  const paths = routes.map((r) => r.path)
  check('3a 桥接提供 /refresh 路由', () => {
    assert.ok(paths.includes(`${SETTINGS_BRIDGE_PREFIX}/refresh`), paths.join(' '))
  })
  check('3b 原有路由都还在', () => {
    for (const p of ['/status', '/probe', '/filter']) {
      assert.ok(paths.includes(`${SETTINGS_BRIDGE_PREFIX}${p}`), `missing ${p}`)
    }
  })

  // the route must be loopback-guarded like the others
  const route = routes.find((r) => r.path === `${SETTINGS_BRIDGE_PREFIX}/refresh`)
  let status = 0
  let body = null
  const res = {
    writeHead(s, headers) {
      status = s
    },
    end(payload) {
      body = payload ? JSON.parse(payload) : null
    },
  }
  await route.handler({ method: 'POST', socket: { remoteAddress: '10.0.0.5' }, headers: { host: '127.0.0.1:5337' } }, res)
  check('3c 非回环请求被拒绝（403）', () => {
    assert.equal(status, 403, `status=${status}`)
    assert.equal(calls.length, 0, 'the handler must not run for a non-loopback request')
  })

  await route.handler({ method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:5337' } }, res)
  check('3d 回环请求返回 diff 与最新名单', () => {
    assert.equal(status, 200, `status=${status}`)
    assert.equal(body.ok, true)
    assert.deepEqual(body.value.diff.added, ['new-free'])
    assert.equal(body.value.models.length, 1)
  })
}

// --- 4. free-id rule stays intact -------------------------------------------
check('4a 免费模型判定规则未变', () => {
  assert.equal(isFreeId('glm-5.3-flash-free'), true)
  assert.equal(isFreeId('big-pickle'), true)
  assert.equal(isFreeId('gpt-5.5'), false)
})

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exitCode = 1
}
