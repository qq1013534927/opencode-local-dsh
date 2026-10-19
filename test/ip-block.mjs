#!/usr/bin/env node
/**
 * Regression test: the availability test must not make the IP ban worse.
 *
 * The upstream's refusal:
 *
 *   OpenCode's free models aren't available from your current network
 *   because we've detected abusive traffic from this IP address. This isn't
 *   related to your account. If you're on a VPN or proxy, turn it off and try
 *   again, or subscribe to OpenCode Go at https://opencode.ai/go to keep
 *   building.
 *
 * This is an ADDRESS-level block, not an account problem and not a per-model
 * problem: every model behind the free lane answers identically. So:
 *
 *   1. the refusal gets its OWN error code (IP_LANE_BLOCKED), so it cannot be
 *      confused with a model that merely happens to be unavailable;
 *   2. the probe batch STOPS at the first block — probing the remaining
 *      models would only send more requests to the address the upstream just
 *      flagged, which is how a few availability tests become the block;
 *   3. a cooldown keeps the test OFF afterwards, so clicking "test all" five
 *      times in a row does not re-trigger it;
 *   4. the card shows the upstream's own explanation, so the user knows it
 *      is the network address and not their account.
 *
 * Run: node test/ip-block.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyError, isIpLaneBlocked, IP_LANE_BLOCK_MESSAGE } from '../wire.js'
import { OpenCodeLocalAdapter, IP_BLOCK_COOLDOWN_MS } from '../adapter.js'

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

// The upstream's message, verbatim.
const UPSTREAM_MESSAGE =
  "OpenCode's free models aren't available from your current network because " +
  "we've detected abusive traffic from this IP address. This isn't related to your account. " +
  "If you're on a VPN or proxy, turn it off and try again, or subscribe to OpenCode Go at " +
  'https://opencode.ai/go to keep building.'

// The upstream's wire shape.
const UPSTREAM_ERROR = JSON.stringify({
  type: 'error',
  error: {
    type: 'FreeTierError',
    message: UPSTREAM_MESSAGE,
    code: 'FREE_TIER_RESTRICTED',
  },
})

console.log('ip-block regression\n')

// --- 1. the refusal is recognised ------------------------------------------
{
  check('1a isIpLaneBlocked 认出上游的封禁措辞', () => {
    assert.ok(isIpLaneBlocked(UPSTREAM_MESSAGE), 'the upstream wording must be detected')
    assert.ok(isIpLaneBlocked(UPSTREAM_ERROR), 'the whole error body must be detected')
  })
  check('1b 普通的免费额度错误不算 IP 封禁', () => {
    assert.ok(!isIpLaneBlocked('FreeTierError: free tier can only be used from within OpenCode'))
    assert.ok(!isIpLaneBlocked('HTTP 403 Forbidden'))
    assert.ok(!isIpLaneBlocked(''))
    assert.ok(!isIpLaneBlocked(undefined))
  })
  check('1c IP 封禁有自己的错误码（不是 FREE_TIER_RESTRICTED）', () => {
    assert.equal(classifyError(UPSTREAM_MESSAGE), 'IP_LANE_BLOCKED')
    assert.equal(classifyError(UPSTREAM_ERROR), 'IP_LANE_BLOCKED')
    // The per-model free-tier refusal keeps its own code.
    assert.equal(
      classifyError('FreeTierError: free tier can only be used from within OpenCode'),
      'FREE_TIER_RESTRICTED',
    )
  })
  check('1d 对外文案保留上游的原话（说明是 IP 不是账号）', () => {
    assert.ok(/abusive traffic from this IP address/.test(IP_LANE_BLOCK_MESSAGE))
    assert.ok(/isn't related to your account/.test(IP_LANE_BLOCK_MESSAGE))
    assert.ok(/VPN or proxy/.test(IP_LANE_BLOCK_MESSAGE))
    assert.ok(/opencode\.ai\/go/.test(IP_LANE_BLOCK_MESSAGE))
  })
}

/**
 * An adapter whose probes all fail with the upstream's IP refusal.
 *
 * The probe transport is stubbed at `prepareCall` so no network is touched
 * and the number of REQUESTS is countable — which is the whole point: a
 * block must cut the request count short.
 */
const buildAdapter = () => {
  const adapter = new OpenCodeLocalAdapter({ logger: { warn() {}, info() {} } }, 'token')
  const sent = []
  adapter.prepareCall = async (_provider, id) => ({
    model: { id },
    stream: async function* () {
      sent.push(id)
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: UPSTREAM_MESSAGE, code: 'IP_LANE_BLOCKED' } },
      }
    },
  })
  return { adapter, sent }
}

// --- 2. the batch stops at the first block ----------------------------------
{
  check('2a 第一个封禁之后不再发请求', async () => {
    const { adapter, sent } = buildAdapter()
    const ids = Array.from({ length: 11 }, (_, i) => `free-model-${i + 1}`)
    const results = await adapter.probe(ids, undefined, 1)
    // With concurrency 1 the first probe blocks the lane; the worker must not
    // pick up the remaining ten.
    assert.equal(sent.length, 1, `expected 1 request, sent ${sent.length}: ${sent.join(', ')}`)
    assert.equal(results[0].code, 'IP_LANE_BLOCKED')
  })

  check('2b 没测到的模型标记为「已跳过」而不是静默消失', async () => {
    const { adapter } = buildAdapter()
    const ids = Array.from({ length: 5 }, (_, i) => `free-model-${i + 1}`)
    const results = await adapter.probe(ids, undefined, 1)
    assert.equal(results.length, ids.length, `expected ${ids.length} results, got ${results.length}`)
    const skipped = results.filter((r) => r.code === 'SKIPPED_IP_BLOCKED')
    assert.equal(skipped.length, ids.length - 1, `expected ${ids.length - 1} skipped, got ${skipped.length}`)
  })

  check('2c 封禁后进入冷却：再次测试一个请求都不发', async () => {
    const { adapter, sent } = buildAdapter()
    const ids = ['a-free', 'b-free', 'c-free']
    await adapter.probe(ids, undefined, 1)
    const afterFirst = sent.length
    // A second click during the cooldown must send NOTHING.
    const second = await adapter.probe(ids, undefined, 1)
    assert.equal(sent.length, afterFirst, `a blocked lane must send nothing, sent ${sent.length - afterFirst} more`)
    assert.ok(
      second.every((r) => r.code === 'IP_LANE_BLOCKED'),
      'every row must report the block, not a fresh probe',
    )
  })

  check('2d 冷却状态可被读取（供卡片显示）', async () => {
    const { adapter } = buildAdapter()
    assert.equal(adapter.ipBlockState().blocked, false, 'a fresh adapter is not blocked')
    await adapter.probe(['a-free'], undefined, 1)
    const state = adapter.ipBlockState()
    assert.equal(state.blocked, true, 'the adapter must remember the block')
    assert.ok(state.remainingMs > 0, 'the cooldown must have time left on it')
    assert.ok(state.remainingMs <= IP_BLOCK_COOLDOWN_MS, 'the cooldown must not exceed the configured window')
  })

  check('2e 冷却窗口是一个有意义的量级（不是几秒）', () => {
    assert.ok(IP_BLOCK_COOLDOWN_MS >= 5 * 60_000, 'a few seconds would not cool an address down')
    assert.ok(IP_BLOCK_COOLDOWN_MS <= 60 * 60_000, 'and it must not lock the card away for hours')
  })
}

// --- 4. the state reaches the card -------------------------------------------
{
  check('4a /status 报告封禁状态（含剩余时间）', async () => {
    const { adapter } = buildAdapter()
    await adapter.probe(['a-free'], undefined, 1)
    const status = adapter.status()
    assert.ok(status.ipBlock, 'the status must carry the block')
    assert.equal(status.ipBlock.blocked, true)
    assert.ok(status.ipBlock.remainingMs > 0, 'the card needs the remaining time for the countdown')
    assert.ok(
      /abusive traffic from this IP address/.test(status.ipBlock.message),
      'the status must carry the upstream wording',
    )
  })

  check('4b 未被封禁时 /status 不带 ipBlock 字段', async () => {
    const { adapter } = buildAdapter()
    assert.equal(adapter.status().ipBlock, undefined, 'a clean lane must not report a block')
  })

  check('4c 探测结果带 retryAfterMs（供卡片倒计时）', async () => {
    const { adapter } = buildAdapter()
    const results = await adapter.probe(['a-free'], undefined, 1)
    assert.equal(results[0].code, 'IP_LANE_BLOCKED')
    assert.ok(results[0].retryAfterMs > 0, 'the result must say how long the cooldown runs')
    assert.ok(results[0].detail, 'the result must carry the full upstream wording')
  })

  check('4d 桥接的 probe 路由把封禁状态一并返回', () => {
    const index = read('index.js')
    assert.ok(/ipBlock/.test(index), 'the probe route must report the block state')
    assert.ok(
      /IP_LANE_BLOCK_MESSAGE/.test(index),
      'it must import the upstream wording instead of repeating it',
    )
  })
}

// --- 3. the card says it out loud -------------------------------------------
{
  check('3a 卡片常驻提示：测试会发真实请求', () => {
    const client = read('client.js')
    assert.ok(/probeWarn/.test(client), 'the card must carry a standing warning')
  })
  check('3b 封禁期间测试按钮不可点', () => {
    const client = read('client.js')
    assert.ok(
      /disabled: busy \|\| Boolean\(ipBlock\?\.blocked\)/.test(client),
      'the "test all" button must be inert while the IP is blocked',
    )
    assert.ok(
      /disabled: Boolean\(probing\[m\.id\]\) \|\| Boolean\(ipBlock\?\.blocked\)/.test(client),
      'the per-row test button must be inert too',
    )
  })
  check('3c 卡片显示上游自己的说明', () => {
    const client = read('client.js')
    assert.ok(/ipBlockedDetail/.test(client), 'the upstream wording must be in the card')
    assert.ok(/ipBlockBanner/.test(client), 'the card must render a banner')
  })
  check('3d 中文文案解释了这是 IP 而不是账号', () => {
    // The card's copy dictionaries live in client.js (the locale JSON files
    // only carry the plugin row's meta).
    const client = read('client.js')
    assert.ok(/上游已封禁本机 IP 的免费通道/.test(client), 'the Chinese banner must say it is the IP')
    assert.ok(/可用性测试已暂停/.test(client), 'the Chinese copy must say the tests are paused')
    assert.ok(/已暂停——上游封禁了本机 IP，本次没有发出任何请求。/.test(client), 'the paused note must be explicit')
    assert.ok(/反复测试可能让上游封禁本机 IP/.test(client), 'the standing warning must name the risk')
  })
  check('3e runProbe 在封禁期间直接返回，不发请求', () => {
    const client = read('client.js')
    const fn = client.slice(client.indexOf('const runProbe = React.useCallback('))
    const guard = fn.slice(0, 1400)
    assert.ok(/ipBlock\?\.blocked/.test(guard), 'runProbe must bail out when the IP is blocked')
    assert.ok(/probePaused/.test(guard), 'and it must say why')
  })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exitCode = 1
}
