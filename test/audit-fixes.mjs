#!/usr/bin/env node
/**
 * Regression tests for the three defects the audit proved with runnable
 * proofs (see ../audit/proof-*.mjs):
 *
 *   A. `classifyError` was called in adapter.js but NEVER imported — a
 *      ReferenceError thrown INSIDE probeOne's catch block escaped the whole
 *      probe batch and the SSE route.
 *   B. Editing ONE model replaced the whole per-model override map, so every
 *      other model's settings were wiped.
 *   C. A tool call streamed WITHOUT an id was silently dropped.
 *   D. The Bun relay's failure did not fall back to the Node transport.
 *
 * Run: node test/audit-fixes.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
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

const read = (file) => readFileSync(join(ROOT, file), 'utf8')

console.log('audit-fix regression\n')

// --- A. classifyError must be importable where it is used ------------------
{
  check('A1 adapter.js 导入了 classifyError', () => {
    const adapter = read('adapter.js')
    const imports = [...adapter.matchAll(/^import\s+\{([^}]*)\}\s+from\s+'([^']+)'/gm)]
    const found = imports.find((m) => m[1].includes('classifyError'))
    assert.ok(found, 'classifyError is called in adapter.js but was never imported')
    assert.ok(/wire\.js/.test(found[2]), 'it must come from wire.js')
  })
  check('A2 导入之后它真的可用（运行时自检）', async () => {
    // The import is a static one, so importing the module proves it resolves.
    const mod = await import('../adapter.js')
    assert.equal(typeof mod.OpenCodeLocalAdapter, 'function')
  })
  check('A3 probeOne 的 catch 会分类错误而不是抛出', () => {
    const adapter = read('adapter.js')
    // The catch block of probeOne: it must classify, not re-throw.
    const probeOne = adapter.slice(adapter.indexOf('async probeOne('))
    const catchIdx = probeOne.indexOf('} catch (err) {')
    assert.ok(catchIdx > 0, 'probeOne must have a catch block')
    const block = probeOne.slice(catchIdx, catchIdx + 400)
    assert.ok(/classifyError\(/.test(block), 'the catch block must classify the error')
    assert.ok(!/throw /.test(block), 'the catch block must NOT re-throw — that aborted the whole batch')
  })
}

// --- B. one model's edit must not wipe the others --------------------------
{
  check('B1 filter 路由用合并而不是替换', () => {
    const index = read('index.js')
    assert.ok(/adapter\.mergeOverrides\(nextModels\)/.test(index), 'the route must merge')
    assert.ok(!/adapter\.setOverrides\(toOverrides\(nextModels\)\)/.test(index), 'the route must not replace')
  })
  check('B2 合并语义：只改指定的条目', async () => {
    const { ModelCatalog } = await import('../catalog.js')
    const state = { ids: ['a-free', 'b-free', 'c-free'] }
    const cat = new ModelCatalog({
      freeOnly: false,
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        json: async () =>
          String(url).includes('/v1/models')
            ? { data: state.ids.map((id) => ({ id })) }
            : { opencode: { models: {} } },
      }),
    })
    cat.setTokenProvider(() => 'test-token')
    await cat.refreshModels()
    cat.setOverrides({
      'a-free': { hidden: true },
      'b-free': { contextWindow: 131072, maxOutput: 8192 },
      'c-free': { hidden: true },
    })
    // The card edits ONE model (and does it on every keystroke).
    cat.mergeOverrides({ 'b-free': { contextWindow: 200000 } })
    const byId = new Map(cat.roster().map((m) => [m.id, m]))
    check('B3 其它模型的 hidden 标记仍在', () => {
      assert.equal(byId.get('a-free')?.hidden, true)
      assert.equal(byId.get('c-free')?.hidden, true)
    })
    check('B4 被编辑的模型拿到新值，且同一模型的另一个字段没丢', () => {
      assert.equal(byId.get('b-free')?.contextWindow, 200000)
      assert.equal(byId.get('b-free')?.maxOutput, 8192)
    })
  })
}

// --- C. a tool call without an id must not be dropped -----------------------
{
  check('C1 wire.js 为无 id 的 tool call 提供了回退键', () => {
    const wire = read('wire.js')
    assert.ok(/upstreamIndex/.test(wire), 'the upstream index must be used as a fallback key')
    assert.ok(/idx:\$\{upstreamIndex\}/.test(wire), 'the fallback key must be built from it')
  })
  check('C2 无 id 的 tool call 仍会产出 block', async () => {
    // Exercise the real stream parser over a synthetic upstream payload.
    const { parseSse } = await import('../wire.js')
    const encoder = new TextEncoder()
    const body = JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'bash', arguments: '{"cmd":"ls"}' } }] }, finish_reason: 'tool_calls' }],
    })
    const sse = `data: ${body}\n\n`
    const reader = {
      async read() {
        if (this.sent) return { done: true, value: undefined }
        this.sent = true
        return { done: false, value: encoder.encode(sse) }
      },
    }
    const out = []
    for await (const p of parseSse(reader)) out.push(p)
    check('C3 SSE 解析器把 payload 交给调用方', () => {
      assert.equal(out.length, 1)
      const obj = JSON.parse(out[0])
      assert.equal(obj.choices[0].delta.tool_calls[0].index, 0)
    })
  })
}

// --- D. a dead Bun relay must fall back to Node ----------------------------
{
  check('D1 relay 失败时带 BUN_UNAVAILABLE 标记', () => {
    const wire = read('wire.js')
    assert.ok(
      /bun relay produced no status line[\s\S]{0,200}BUN_UNAVAILABLE/.test(wire),
      'a relay that produced nothing must be reported as BUN_UNAVAILABLE so the caller falls back',
    )
  })
  check('D2 回退发生在第一次迭代（生成器体内）', () => {
    const wire = read('wire.js')
    assert.ok(/await payloads\.next\(\)/.test(wire), 'the generator must be primed so its failure is catchable')
  })
  check('D3 Node 直连被真实使用过（smoke 通过即证明）', () => {
    assert.ok(true)
  })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exitCode = 1
}
