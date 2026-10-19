#!/usr/bin/env node
/**
 * The free lane's context ceiling: 200,000 and 256k are the SAME tier.
 *
 * The README used to claim the upstream "honours longer input than the
 * model's own metadata advertises" — i.e. that the ceiling was somewhere
 * above the advertised 200,000. The recorded measurement says otherwise:
 *
 *     209,430 input tokens -> served
 *     249,318 input tokens -> served
 *     300,000             -> rejected
 *
 * 209,430 and 249,318 were both served, so the enforced limit is
 * demonstrably NOT 200,000. The rejection bracket is (249,318, 300,000], and
 * 262,144 — the standard 256 KiB context tier, and this plugin's own
 * DEFAULT_CONTEXT_WINDOW — sits inside it.
 *
 * These checks pin that reading so the docs cannot drift back to "past
 * 200k", and so the plugin's own default stays consistent with the tier the
 * upstream actually enforces.
 *
 * Run: node test/context-tier.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_CONTEXT_WINDOW } from '../catalog.js'

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

console.log('context-tier regression\n')

// --- the arithmetic of the recorded measurement ----------------------------
{
  // The numbers the needle test recorded (test/needle.mjs, README table).
  const served = [49878, 149598, 189486, 209430, 249318]
  const rejected = 300000

  check('1a 记录下来的测量：200k 档以上确实被服务过', () => {
    const aboveAdvertised = served.filter((n) => n > 200000)
    assert.ok(aboveAdvertised.length >= 2, 'the measurement must show tokens above 200,000 being served')
    assert.ok(Math.max(...served) < rejected, 'the largest served size must be below the rejected one')
  })

  check('1b 所以生效上限不可能是 200,000', () => {
    assert.ok(
      served.some((n) => n > 200000),
      'if 200,000 were the enforced limit, these requests would have been refused',
    )
  })

  check('1c 262,144（256 KiB）落在被拒区间内', () => {
    const ceiling = DEFAULT_CONTEXT_WINDOW
    assert.ok(ceiling > Math.max(...served), `${ceiling} must be above the largest served size`)
    assert.ok(ceiling < rejected, `${ceiling} must be below the rejected size`)
  })

  check('1d 插件的默认上下文就是 256 KiB 档', () => {
    assert.equal(DEFAULT_CONTEXT_WINDOW, 262144)
    assert.equal(DEFAULT_CONTEXT_WINDOW / 1024, 256)
  })
}

// --- the docs must not claim the old reading ------------------------------
{
  check('2a 英文 README 不再声称"超过 200k 也能用"', () => {
    const readme = read('README.md')
    assert.ok(
      !/past 200k/i.test(readme),
      'the ceiling is the 256k tier; "past 200k" is the wrong framing',
    )
    assert.ok(
      !/Context overrides really work/i.test(readme),
      'the override changes what DSH believes, not the upstream ceiling',
    )
  })
  check('2b 英文 README 说清 200,000 与 256k 是同一档', () => {
    const readme = read('README.md')
    assert.ok(/200,000 and 256k are the same tier/i.test(readme), 'the tier must be stated explicitly')
  })
  check('2c 中文 README 同样改口', () => {
    const readme = read('README.zh-CN.md')
    assert.ok(!/真的有效/.test(readme), 'the old claim must go')
    assert.ok(!/超过 200k/.test(readme), 'the old framing must go')
    assert.ok(/200,000 和 256k 是同一档/.test(readme), 'the tier must be stated explicitly')
  })
  check('2d 两份 README 都点明覆盖只改变 DSH 的认知', () => {
    assert.ok(/what DSH\s+believes/i.test(read('README.md')))
    assert.ok(/DSH 的认知/.test(read('README.zh-CN.md')))
  })
}

// --- the plugin must not send a context window upstream --------------------
{
  check('3a 请求体里没有上下文窗口字段（上游只认自己的闸门）', () => {
    const wire = read('wire.js')
    const body = wire.slice(wire.indexOf('export function buildRequestBody('))
    const end = body.indexOf('\n}')
    const fn = body.slice(0, end)
    assert.ok(
      !/context_window|contextWindow/.test(fn),
      'the request body must not carry a context window — the upstream gate decides',
    )
  })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exitCode = 1
}
