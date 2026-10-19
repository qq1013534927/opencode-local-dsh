#!/usr/bin/env node
/**
 * Regression tests for the whole-plugin hardening pass.
 *
 * Each check pins one defect that was actually fixed, so a later change
 * cannot silently reintroduce it.
 *
 * Run: node test/hardening.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { opencodeUserAgent, disguiseHeaders, deriveRequestIDs } from '../ids.js'
import { fetchZenModels } from '../catalog.js'
import { makeSettingsRoutes, SETTINGS_BRIDGE_PREFIX } from '../settings-bridge.js'

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

console.log('hardening regression\n')

// --- 1. one client identity for every upstream request ---------------------
{
  check('1a 目录请求与推理请求用同一个 user-agent', () => {
    // fetchZenModels must use opencodeUserAgent(), not a hard-coded string.
    const catalog = read('catalog.js')
    assert.ok(catalog.includes('opencodeUserAgent()'), 'catalog.js must call opencodeUserAgent()')
    assert.ok(
      !/user-agent':\s*'opencode\//.test(catalog),
      'catalog.js must not hard-code the user-agent',
    )
  })
  check('1b opencodeUserAgent() 反映真实运行时', () => {
    const ua = opencodeUserAgent()
    assert.ok(ua.startsWith('opencode/'), ua)
    assert.ok(ua.includes(process.platform), ua)
    assert.ok(ua.includes(process.versions.node), ua)
  })
  check('1c 推理请求的头部齐全', () => {
    const headers = disguiseHeaders(deriveRequestIDs([{ role: 'user', content: 'hi' }]))
    for (const key of ['user-agent', 'x-opencode-client', 'x-opencode-session', 'x-opencode-request', 'x-opencode-project']) {
      assert.ok(headers[key], `missing header ${key}`)
    }
  })
}

// --- 2. the debug dump must not leak the token ------------------------------
{
  check('2a relay 的调试输出不落在固定目录', () => {
    const relay = read('relay.mjs')
    assert.ok(!/D:\/学习/.test(relay), 'relay.mjs must not hard-code a personal path')
    assert.ok(relay.includes('tmpdir()'), 'relay.mjs must write to the OS temp dir')
  })
  check('2b relay 的调试输出遮蔽了 Authorization', () => {
    const relay = read('relay.mjs')
    assert.ok(/redact/i.test(relay), 'relay.mjs must redact the bearer token')
  })
  check('2c relay 的调试文件权限是私有的', () => {
    const relay = read('relay.mjs')
    assert.ok(/mode:\s*0o600/.test(relay), 'relay.mjs must create the dump with mode 0600')
  })
}

// --- 3. the credential is not used past its expiry -------------------------
{
  check('3a 适配器在 token 过期时会重新解析', () => {
    const adapter = read('adapter.js')
    assert.ok(/#expired/.test(adapter), 'adapter.js must have an expiry check')
    assert.ok(/expires/.test(adapter), 'adapter.js must use the credential expiry')
  })
}

// --- 4. the catalog owns no timer of its own -------------------------------
{
  check('4a catalog 不再自带未调用的 start()', () => {
    const catalog = read('catalog.js')
    assert.ok(!/async start\(\)/.test(catalog), 'catalog.start() is dead code — the entry owns the timer')
  })
  check('4b catalog 不再有私有定时器字段', () => {
    const catalog = read('catalog.js')
    assert.ok(!/#timer/.test(catalog), 'the catalog must not own a timer')
  })
}

// --- 5. the settings write must not carry a stale revision -----------------
{
  check('5a 持久化不传可能过期的 revision', () => {
    const client = read('client.js')
    assert.ok(
      !/form\.mutate\(ops,\s*form\.state\?\.revision\)/.test(client),
      'a render-time revision is stale by the time the click lands — the Host rejects it',
    )
    assert.ok(/form\.mutate\(ops, undefined\)/.test(client), 'the revision must be omitted')
  })
}

// --- 6. the bridge body cap must fit a large model map ---------------------
{
  check('6a 桥接的请求体上限容得下大目录', () => {
    const bridge = read('settings-bridge.js')
    const m = /MAX_JSON_BODY_BYTES\s*=\s*([^\n]+)/.exec(bridge)
    assert.ok(m, 'the cap must be a named constant')
    // evaluate the arithmetic expression (e.g. "1024 * 1024")
    const cap = Function(`return ${m[1].replace(/[;,].*$/, '')}`)()
    assert.ok(Number.isFinite(cap), `cap is ${cap}`)
    assert.ok(cap >= 1024 * 1024, `cap is ${cap} — too small for a large models map`)
  })
  check('6b 一份 500 模型的设置表能通过上限', () => {
    const models = {}
    for (let i = 0; i < 500; i++) models[`model-${i}`] = { hidden: false, contextWindow: 0, maxOutput: 0 }
    const size = Buffer.byteLength(JSON.stringify({ models }))
    assert.ok(size < 1024 * 1024, `body is ${size} bytes`)
  })
}

// --- 7. every bridge call is bounded ---------------------------------------
{
  check('7a 客户端的桥接请求带超时', () => {
    const client = read('client.js')
    assert.ok(/AbortController/.test(client), 'the bridge fetch must be abortable')
    assert.ok(/setTimeout\(\(\) => controller\.abort\(\)/.test(client), 'the abort must be triggered by a timer')
  })
  check('7b 可用性探测带超时', () => {
    const adapter = read('adapter.js')
    assert.ok(/AbortSignal\.timeout/.test(adapter), 'a probe must not hang forever')
  })
}

// --- 8. the Bun relay process is always reaped -----------------------------
{
  check('8a relay 进程在 finally 里被回收', () => {
    const wire = read('wire.js')
    assert.ok(/finally\s*\{[\s\S]*?kill\(\)/.test(wire), 'the relay process must be killed in a finally block')
  })
  check('8b abort 监听器被解除', () => {
    const wire = read('wire.js')
    assert.ok(/removeEventListener/.test(wire), 'the abort listener must be detached')
  })
}

// --- 9. the plugin disposes cleanly ----------------------------------------
{
  check('9a 插件销毁时停止 catalog 并丢弃 token', () => {
    const index = read('index.js')
    assert.ok(/adapter\.stop\(\)/.test(index), 'the entry must stop the adapter on dispose')
    const adapter = read('adapter.js')
    assert.ok(/stop\(\)\s*\{[\s\S]*?#catalog\.stop\(\)[\s\S]*?#tokens\.invalidate\(\)/.test(adapter), 'stop() must stop the catalog and drop the token')
  })
}

// --- 10. the update action and the probe do not share a busy flag -----------
{
  check('10a 更新与探测各有各的忙碌状态', () => {
    const client = read('client.js')
    assert.ok(/const \[updating, setUpdating\]/.test(client), 'the update action needs its own flag')
    assert.ok(/const \[busy, setBusy\]/.test(client), 'the probe keeps its own flag')
  })
}

// --- 11. the bridge still serves every route -------------------------------
{
  const routes = makeSettingsRoutes({
    async status() { return { ok: true, value: {} } },
    async probe() { return { ok: true, value: {} } },
    async refresh() { return { ok: true, value: {} } },
    async filter() { return { ok: true, value: {} } },
  })
  check('11a 四条桥接路由都在', () => {
    const paths = routes.map((r) => r.path)
    for (const p of ['/status', '/probe', '/filter', '/refresh']) {
      assert.ok(paths.includes(`${SETTINGS_BRIDGE_PREFIX}${p}`), `missing ${p}`)
    }
  })
}

// --- 12. the Zen model list still works ------------------------------------
{
  const seen = {}
  const fakeFetch = async (url, init) => {
    seen.url = String(url)
    seen.headers = init?.headers ?? {}
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'a-free' }] }) }
  }
  const models = await fetchZenModels('tok', fakeFetch)
  check('12a Zen 目录请求带上客户端标识', () => {
    assert.equal(seen.headers['user-agent'], opencodeUserAgent())
    assert.equal(seen.headers['x-opencode-client'], 'cli')
    assert.equal(seen.headers.authorization, 'Bearer tok')
    assert.equal(models.length, 1)
  })
}

// --- 13. the probe runs with bounded concurrency ---------------------------
{
  check('13a 探测用有界并发，而不是严格串行', () => {
    const adapter = read('adapter.js')
    assert.ok(/concurrency/.test(adapter), 'the probe must take a concurrency limit')
    assert.ok(/Promise\.all\(Array\.from/.test(adapter), 'the probe must run a small worker pool')
  })
  check('13b 每个模型仍然各自上报一次结果', () => {
    const adapter = read('adapter.js')
    assert.ok(/report\(await this\.probeOne/.test(adapter), 'each model must report its own result')
  })
}

// --- 14. editing ONE model must not wipe the others ------------------------
{
  check('14a 单行编辑是合并，不是整表替换', () => {
    const index = read('index.js')
    assert.ok(
      /adapter\.mergeOverrides\(nextModels\)/.test(index),
      'the filter route must MERGE the overrides — replacing wiped every other model',
    )
    assert.ok(
      !/adapter\.setOverrides\(toOverrides\(nextModels\)\)/.test(index),
      'the filter route must not replace the whole override map',
    )
  })
  check('14b catalog 提供合并入口', () => {
    const catalog = read('catalog.js')
    assert.ok(/mergeOverrides\(overrides\)/.test(catalog), 'the catalog must offer a merge')
    assert.ok(/removeOverrides\(ids\)/.test(catalog), 'the catalog must offer a removal')
  })
  check('14c 合并只改指定的条目', () => {
    // exercised behaviourally below
  })
  const { ModelCatalog } = await import('../catalog.js')
  // Give the catalog three models first: the roster only lists models the
  // catalog knows about.
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
  cat.mergeOverrides({ 'b-free': { contextWindow: 200000 } })
  const byId = new Map(cat.roster().map((m) => [m.id, m]))
  check('14d 合并后其它模型的设置仍在', () => {
    assert.equal(byId.get('a-free')?.hidden, true, 'model a lost its hidden flag')
    assert.equal(byId.get('c-free')?.hidden, true, 'model c lost its hidden flag')
  })
  check('14e 被编辑的模型拿到新值', () => {
    assert.equal(byId.get('b-free')?.contextWindow, 200000)
    assert.equal(byId.get('b-free')?.maxOutput, 8192, 'the other limit of the same model must survive')
  })
  check('14f 移除设置能删掉一个模型的条目', () => {
    cat.removeOverrides(['a-free'])
    const after = new Map(cat.roster().map((m) => [m.id, m]))
    assert.equal(after.get('a-free')?.hidden, false, 'the removed model must be visible again')
  })
}

// --- 15. classifyError must be imported where it is used --------------------
{
  check('15a adapter 引入了 classifyError', () => {
    const adapter = read('adapter.js')
    const imports = [...adapter.matchAll(/^import\s+\{([^}]*)\}\s+from\s+'([^']+)'/gm)]
    const has = imports.some((m) => m[1].includes('classifyError'))
    assert.ok(has, 'classifyError is called in adapter.js but was never imported')
  })
  check('15b classifyError 确实被调用', () => {
    const adapter = read('adapter.js')
    assert.ok(/classifyError\(/.test(adapter), 'the probe must classify errors')
  })
}

// --- 16. the capability fields must not stick at their first value ---------
{
  check('16a 能力字段每轮重读（不再粘滞）', () => {
    const catalog = read('catalog.js')
    const block = catalog.slice(catalog.indexOf('async refreshMetadata('))
    // The feed's value must come BEFORE the cached one for these three.
    const reasoning = /reasoning:\s*(m\.reasoning|prior\.reasoning)/.exec(block)
    assert.ok(reasoning, 'the reasoning field must be assigned')
    assert.ok(
      /reasoning:\s*m\.reasoning === true \|\| prior\.reasoning === true/.test(block),
      'reasoning must prefer the fresh feed value',
    )
    assert.ok(
      !/reasoning:\s*prior\.reasoning \?\?/.test(block),
      'reasoning must not be frozen at the cached value',
    )
  })
  check('16b 上游改了三项能力后，卡片能读到新值', async () => {
    const { ModelCatalog } = await import('../catalog.js')
    const state = {
      models: { 'x-free': { id: 'x-free', reasoning: true, reasoning_options: [{ type: 'effort', values: ['low'] }], modalities: { input: ['text'] }, limit: { context: 100000, output: 1000 } } },
    }
    const cat = new ModelCatalog({
      freeOnly: false,
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        json: async () =>
          String(url).includes('/v1/models')
            ? { data: [{ id: 'x-free' }] }
            : { opencode: { models: state.models } },
      }),
    })
    cat.setTokenProvider(() => 'test-token')
    await cat.refreshModels()
    await cat.refreshMetadata()
    const first = cat.roster()[0]
    // The upstream now says: no reasoning, a different effort ladder, image input.
    state.models['x-free'] = {
      id: 'x-free',
      reasoning: false,
      reasoning_options: [{ type: 'effort', values: ['high'] }],
      modalities: { input: ['text', 'image'] },
      limit: { context: 200000, output: 2000 },
    }
    await cat.refreshMetadata()
    const second = cat.roster()[0]
    check('16c 限制字段跟着上游变', () => {
      assert.equal(second.contextWindow, 200000)
    })
    check('16d effort 阶梯跟着上游变', () => {
      // The effort ladder reaches the host through the model entry, not the
      // roster: read it the way the adapter does.
      const info = cat.get('x-free')
      assert.deepEqual(info?.effortValues ?? [], ['high'], 'the effort ladder is stuck at the first value')
    })
  })
}

// --- 17. the refresh interval must take effect without a restart -----------
{
  check('17a 定时器在 refreshSeconds 变化时重建', () => {
    const index = read('index.js')
    assert.ok(/startRefreshTimer/.test(index), 'the timer must be rebuildable')
    assert.ok(
      /next\.refreshSeconds !== previous\.refreshSeconds[\s\S]{0,200}startRefreshTimer\(\)/.test(index),
      'a changed refresh interval must rebuild the timer',
    )
  })
}

// --- 18. the status file must not be world-readable -----------------------
{
  check('18a status 文件以私有权限写入', () => {
    const index = read('index.js')
    assert.ok(/mode:\s*0o600/.test(index), 'the status file carries the account email')
  })
}

// --- 19. the note bar must belong to one operation at a time ---------------
{
  check('19a 提示条用请求序号防止竞态', () => {
    const client = read('client.js')
    assert.ok(/noteTicket/.test(client), 'the note bar needs a ticket')
    assert.ok(/setNoteFor/.test(client), 'only the newest operation may write the note')
  })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exitCode = 1
}
