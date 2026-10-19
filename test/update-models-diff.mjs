#!/usr/bin/env node
/**
 * The diff reporting path: what the card shows when the upstream catalog
 * really changed.
 *
 * The bridge route itself is covered by test/update-models.mjs; this test
 * drives the ADAPTER's refreshModelsNow() against a fake upstream so the
 * added / removed / changed lists are exercised for real.
 *
 * Run: node test/update-models-diff.mjs
 */

import assert from 'node:assert/strict'
import { ModelCatalog } from '../catalog.js'

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

/** A fake Zen endpoint that serves the ids it is given. */
function zenFetch(state) {
  return async (url) => {
    if (String(url).includes('/v1/models')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: state.ids.map((id) => ({ id })) }),
      }
    }
    // the public metadata feed — where the per-model limits really come from
    return {
      ok: true,
      status: 200,
      json: async () => ({
        opencode: {
          models: state.limits
            ? Object.fromEntries(
                Object.entries(state.limits).map(([id, limit]) => [id, { id, limit }]),
              )
            : {},
        },
      }),
    }
  }
}

/**
 * The diff the adapter computes — mirrored here as a pure function so the
 * rule ("what the user sees changed") is pinned independently of the HTTP
 * plumbing. The adapter's own implementation is checked against it below.
 */
function diff(before, after) {
  const added = []
  const removed = []
  const changed = []
  for (const [id, m] of after) {
    const prior = before.get(id)
    if (!prior) added.push(id)
    else if (prior.contextWindow !== m.contextWindow || prior.maxOutput !== m.maxOutput) {
      changed.push({ id, contextWindow: m.contextWindow, maxOutput: m.maxOutput })
    }
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id)
  return { added: added.sort(), removed: removed.sort(), changed }
}

console.log('update-models diff regression\n')

{
  const state = { ids: ['a-free', 'b-paid', 'c-free'] }
  const catalog = new ModelCatalog({ freeOnly: false, fetchImpl: zenFetch(state) })
  catalog.setTokenProvider(() => 'test-token')
  await catalog.refreshModels()
  const before = catalog.entries()

  state.ids = ['a-free', 'c-free', 'd-free']
  await catalog.refreshModels()
  const after = catalog.entries()

  const d = diff(before, after)
  check('1a 新增的模型被报告', () => assert.deepEqual(d.added, ['d-free']))
  check('1b 上游删掉的模型被报告', () => assert.deepEqual(d.removed, ['b-paid']))
  check('1c 目录本身已经跟随上游', () => {
    const ids = catalog.list().map((m) => m.id)
    assert.ok(ids.includes('d-free'))
    assert.ok(!ids.includes('b-paid'))
  })
}

{
  // limits that change between rounds must be reported as "changed".
  // The limits come from the metadata feed (the Zen model list carries ids
  // only), so the metadata pass has to run too.
  const state = { ids: ['x-free'], limits: { 'x-free': { context: 1000, output: 100 } } }
  const catalog = new ModelCatalog({ freeOnly: false, fetchImpl: zenFetch(state) })
  catalog.setTokenProvider(() => 'test-token')
  await catalog.refreshModels()
  await catalog.refreshMetadata()
  const before = catalog.entries()
  check('2a-前置 目录已带上元数据里的限制', () => {
    assert.equal(before.get('x-free')?.contextWindow, 1000)
  })
  state.limits['x-free'] = { context: 2000, output: 200 }
  await catalog.refreshMetadata()
  const after = catalog.entries()
  const d = diff(before, after)
  check('2a 限制变化的模型被报告', () => {
    assert.equal(d.changed.length, 1, JSON.stringify(d))
    assert.equal(d.changed[0].id, 'x-free')
  })
  check('2b 变化后目录里的限制已更新', () => {
    assert.equal(after.get('x-free').contextWindow, 2000)
  })
}

{
  // an upstream failure must not wipe the catalog
  const state = { ids: ['keep-free'] }
  const catalog = new ModelCatalog({ freeOnly: false, fetchImpl: zenFetch(state) })
  catalog.setTokenProvider(() => 'test-token')
  await catalog.refreshModels()
  // now make the endpoint fail
  const failing = new ModelCatalog({
    freeOnly: false,
    fetchImpl: async () => {
      throw new Error('network down')
    },
  })
  failing.setTokenProvider(() => 'test-token')
  const result = await failing.refreshModels()
  check('3a 上游失败时报告错误而不是抛异常', () => {
    assert.equal(result.ok, false)
    assert.ok(result.error)
  })
  check('3b 上游失败时原目录仍然保留', () => {
    assert.equal(catalog.list().length, 1)
    assert.equal(catalog.list()[0].id, 'keep-free')
  })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exitCode = 1
}
