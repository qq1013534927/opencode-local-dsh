[English](README.md) | [简体中文](README.zh-CN.md)

# opencode-local — DSH 插件：走自己的 OpenCode 通道，不走共享额度

在 DeepSeek Harness (DSH) 里使用**你自己账号**的 OpenCode Zen 免费模型。

> **不走共享额度。** 与 [opencode2dsh](https://github.com/FishBottle7/opencode2dsh) 的匿名通道
> （`Bearer public`，全匿名用户共享、按 IP 限流、429 频发）不同，本插件用**你自己登录的
> OpenCode 账号 token** 直连 `https://opencode.ai/zen/v1`——免费额度是你账号私有的，
> 不与他人共享。

## 它做什么

```
DSH 会话
  │  harness chunk（block-start / text-delta / usage / finish …）
  ▼
OpenCodeLocalAdapter（原生 LlmAdapter，注册为 opencode-local）
  │  ① 凭据：运行中的 OpenCode 客户端 /api/credential（或本地 DB 缓存）
  │  ② 传输：spawn Bun 中继（TLS 指纹与官方 CLI 一致 → 健康配额桶）
  │  ③ 门形状：canonical ses_ 会话 id + stream + bash/read 工具
  ▼
https://opencode.ai/zen/v1  ← 你自己的账号 token
```

## 上下文覆盖到底改变了什么（实测）

卡片可以把模型的声明上下文调大。它改变的是**DSH 的认知**——并不会抬高上游的上限。

`buildRequestBody()` 从不发送任何上下文窗口字段，所以能服务多少由**上游自己的闸门**决定。
覆盖只是拆掉了 **DSH 侧**的保险：声明 1M 之后，DSH 会真的拼出并发送一个 1M 的提示词，
然后被上游拒掉——而且是**整个提示词都发完了才拒**。

对 `deepseek-v4.1-flash-free` 做针尖测试（卡片声明 **1,048,576**，
而元数据与运行中的客户端都报 200,000）。把唯一编号埋在填充文本的三分之二深处，再问回来：

| 发送 | 上游上报 input | 编号是否读到 |
| --- | ---: | --- |
| ~50k | 49,878 | ✅ |
| ~150k | 149,598 | ✅ |
| ~190k | 189,486 | ✅ |
| **~210k** | 209,430 | ✅ |
| **~250k** | 249,318 | ✅ |
| ~300k | — | ❌（请求被拒） |

**上限要这么读：200,000 和 256k 是同一档。** 上游对外写的是 `200,000`，
那是 262,144（标准 256 KiB 上下文档）向下取整的十进制写法——本插件自己的
`DEFAULT_CONTEXT_WINDOW` 也正是 262,144。实测也印证了这一点：209,430 与 249,318
两个请求**都成功服务了**，所以实际生效的上限**显然不是** 200,000。
被拒的区间是 (249,318, 300,000]，262,144 正好落在里面。

所以这个模型的实际上限就是 **256k 档**：

- 声明超过 ~262,144 什么也换不来——上游照样拒，只是让你白发一个更大的提示词、
  再迟一步失败；
- 覆盖真正有用的方向是**调低**（压缩 DSH 自己的提示词预算），或者在上游写
  200,000（取整值）时把它改成真实的 256k；
- 卡片显示**生效值**并允许编辑，就是为了让你填上一个真正对得上账号档位的数字。

测量脚本在 `test/needle.mjs`（可先跑 `node test/runtime-limit.mjs` 看看运行中客户端
自己报的 `limit`）。

## 为什么需要 Bun 中继

实测发现 opencode.ai 网关**按 TLS 指纹分限流桶**：

| 传输层 | TLS 指纹 | 配额桶 |
| --- | --- | --- |
| 官方 OpenCode CLI（Bun 编译） | Bun | ✅ 健康（你的桌面客户端一直能用） |
| Node / Python / curl | 其他 | ❌ 共享桶已耗尽（429，Retry-After ~16h） |

插件 spawn 一个 Bun 进程（`relay.mjs`）发请求，TLS 指纹与官方 CLI 一致，进入健康配额桶。
Bun 不可用时自动回退 Node 直连（冷门 free 模型仍可用）。

## 设置卡（0.3）

在 **设置 → 插件** 里点击本插件的名字即可打开它的设置卡（与 `dsh-free-search` 同一模式）。卡片提供：

| 控件 | 作用 |
| --- | --- |
| **更新模型** 按钮 | **立刻**从 OpenCode 拉一次模型目录（不用等后台定时刷新），并告诉你目录发生了什么变化：新增 / 移除 / 限制变动各多少个。顺带**清理过期设置**——上游已经下架的模型，它的 `models.<id>` 设置会被删除，表格里不再留幽灵行 |
| **只看免费** 开关 | **全新安装时默认勾选** —— 把 DSH 选择器*和*卡片下方的表格一起过滤到内置免费模型。它只写 `freeOnly`，别的一概不写：不会连带勾选、隐藏或恢复任何一行。取消勾选即可重新列出**你账号可路由的全部模型**（含付费——但你自己隐藏过的行除外）。标签实时反映表格：`当前列出 N/M · 仅免费` 或 `当前列出 M · 全部` |
| **只勾选免费** 按钮 | 把每个付费模型显式标记为隐藏（`models.<id>.hidden`），**并**打开只看免费——两者作为**一次原子写入**落盘，不会互相覆盖 |
| **全部勾选** 按钮 | 清除所有 `hidden` 标记，让全部模型重新显示；它不动只看免费开关，而那个开关仍会过滤选择器 |
| 每个模型 **显示/隐藏** | 从 DSH 模型选择器里隐藏该模型（`models.<id>.hidden`） |
| 每个模型 **上下文 / 最大输出** | 显示**生效值**；填入数值即覆盖，清空恢复自动（`models.<id>.contextWindow`、`maxOutput`） |
| **测试**（每行） | 对该模型发一个极小的流式请求，返回 `OK` / `RATE_LIMIT` / `MODEL_UNAVAILABLE` / `REGION_BLOCKED` / `QUOTA_EXCEEDED` / `IP_LANE_BLOCKED` 与延迟。测试会发**真实**请求，卡片常驻一条提示说明这点——见 [可用性测试与 IP 封禁](#可用性测试与-ip-封禁) |
| **全部测试** | **只测免费模型**（测试付费模型会消耗账号余额）；结果**逐个到达、逐行显示**（SSE）。批次在**第一次 IP 级封禁处停下**，其余行记为「已跳过」 |
| **刷新** / **保存** | 重读实时通道状态 / 提交编辑后的模型表（`models.<id>.hidden`、`contextWindow`、`maxOutput`）。按钮文案就是**保存**，「已保存。」是保存完成后才出现的提示 |
| 状态行 | 凭据来源、账号、目录统计（免费 / 付费）、上次更新时间 |

### 过滤与隐藏的区别

开关与两个批量按钮写入的内容**并不相同**：

- **只看免费** 开关 → 只写 `freeOnly`。它同时过滤 DSH 模型选择器和卡片下方的表格；
  完全不动 `models.<id>.hidden`，所以不会连带勾选、隐藏或恢复任何一行。
- **只勾选免费** → 写 `freeOnly: true`，**并**把每个付费模型写成 `models.<id>.hidden`
  （付费行仍留在表里，只是标记为隐藏，清除标记即可恢复）。两者在**同一个操作列表**里
  一次提交，因此要么一起生效、要么都不生效——不会互相覆盖。
- **全部勾选** → 把每个模型的 `models.<id>.hidden` 写回 `false`，所有行重新勾选。
  它**不改** `freeOnly`：开关仍开着时，选择器与表格依旧只列免费模型。
- 每行复选框 / **保存** → 原样保存你编辑后的 `models.<id>.hidden`（以及上下文/输出）表。

复选框状态取自回环桥接（`/status`）返回的**实时通道**状态，而不是设置页里存的快照，
所以点击立刻生效、不会再弹回旧值。

设置页那个快照只是渲染时抓拍的一帧，写入后要等两跳异步才会刷新——所以它只做首帧兜底。
真正让它活下来的是设置页的正式写入通道（`form.mutate`）：桥接负责让**运行中**的适配器
立刻生效，正式通道负责让这个选择**重启后依然有效**。

### 更新模型

模型目录有两个来源：Zen 的 `/v1/models`（有哪些模型）和 `models.opencode.ai`（每个模型的上下文/输出限制），
再叠加**正在运行的 OpenCode 客户端自己的 `/api/model`**（权威限制）。插件会按 `refreshSeconds`
（默认 300 秒）后台刷新，但你在卡片上按 **更新模型** 可以**立刻**拉一次，不必等。

按下去会发生这些事：

1. 立刻重新拉取上游目录（`/api/model` 与 `models.opencode.ai` 一起）。
2. 对比更新前后的目录，报告**新增 / 移除 / 限制变动**各多少个——没变化就显示「模型列表已是最新」。
3. **清理过期设置**：上游已经下架的模型，它的 `models.<id>` 设置会被删除（`op: unset`），
   表格里不再留一行点不动的幽灵模型。顺带也解决了上游给某个模型改了限制、
   而卡片还显示旧值的问题——限制现在每次刷新都会重新读。

第 3 步会写设置（仅在**仍有**目录外条目时才写），所以它也算一次设置变更。

### 模型范围

卡片列出运行中客户端可路由的 **`opencode` 通道**模型——既含内置免费模型，也含付费模型（订阅账号）。
其他 provider（OpenRouter、自建端点）的模型只计入诊断统计、不暴露，因为本插件的传输只发到
`opencode.ai/zen`，那些 id 在那里无法路由。

上下文长度取自**正在运行的 OpenCode 客户端自身的 `/api/model`**（权威来源）；
公开的 `models.opencode.ai` 只用来补缺。因此卡片上的上下文/输出是真实的每模型限制，
而不是统一的默认值。

实时状态与写入都走**仅本机回环**的桥接
（`/api/opencode-local/settings/status`、`/filter`、`/refresh`、`/probe`，其中 `/probe` 是 SSE 流）：
卡片把过滤/显示变更直接作用到运行中的 adapter，随后才通过官方设置通道持久化（宿主提供可写表单时）。
因此即便那个表单不可写，点击也一定生效。

## 前提

- **OpenCode 客户端登录过一次**（桌面版或 `opencode serve`）。
  - 客户端运行时：插件从 `/api/credential` 取活跃 token（自动刷新）。
  - 客户端关闭时：插件从本地 SQLite（`~/.local/share/opencode/opencode.db`）读缓存 token，
    只要没过期就能用。过期后打开客户端刷新一次即可。
- **Bun 运行时**（`npm install -g bun`）——用于 TLS 指纹匹配；缺失时回退 Node 直连。
- DSH ≥ 0.1.7，Node.js ≥ 20。

## 安装

```sh
dsh plugin --profile <profile> add <本目录>
```

或 DSH 界面：设置 → 插件 → 安装本地 bundle。

## 验证

1. 重启 DSH（或等待插件热加载）。
2. 模型选择器出现 **OpenCode Local** 分组，列出你账号的 free 模型
   （`glm-5.3-flash-free`、`mimo-v2.6-flash-free`、`deepseek-v4.1-flash-free`、
   `longcat-2.5-preview-free`、`big-pickle` 等）。
3. 发送消息，观察流式回复。
4. 诊断状态：`~/.opencode-local-dsh/adapter-status.json`。

## 配置（cordis.patch.yml 的 config 对象）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `freeOnly` | `true` | 只暴露 free 模型；`false` 暴露账号全部模型 |
| `refreshSeconds` | `300` | 模型目录刷新间隔（秒） |
| `accessToken` | — | 显式 access token 覆盖（留空则自动获取） |

## 凭据来源（三级回退）

1. 运行中客户端的 `/api/credential`（支持 token 自动刷新）
2. 本地 SQLite 缓存 `~/.local/share/opencode/opencode.db`（客户端关闭时）
3. 报错提示（token 过期且客户端未运行）

token 仅保存在内存，插件不写盘。

## 可用性测试与 IP 封禁

卡片的**测试**按钮会对每个模型发一个真实请求。而上游对「同一地址反复请求」的回答，
就是封掉这个地址：

> OpenCode's free models aren't available from your current network because
> we've detected abusive traffic from this IP address. This isn't related to
> your account. If you're on a VPN or proxy, turn it off and try again, or
> subscribe to OpenCode Go at https://opencode.ai/go to keep building.

这个拒绝**不是**单个模型失效，**也不是**账号问题——它把整条免费通道对
该地址关闭了，所以通道后面的每个模型回答都一样。既然封禁正是「反复请求」的
后果，插件做的恰恰是**不去重试**：

- 这个拒绝有独立错误码 `IP_LANE_BLOCKED`，绝不会被误当成「某个模型不可用」；
- 探测批次在**第一次封禁处停下**——没轮到的模型记为 `SKIPPED_IP_BLOCKED`，
  而不是照样去问；
- 随后进入 **30 分钟冷却**：冷却期间点测试**一个请求都不发**，所以连点五次
  「全部测试」不会让封禁一直续命；
- 卡片直接显示上游的原话，因为它说清了三件事：出问题的是网络地址、
  VPN/代理是可能的原因、解决办法是关掉代理或订阅。

卡片还常驻一条提示：测试会发真实请求。如果真的撞上封禁，**关掉代理/VPN**
才是解法——客户端这边没办法替上游解封。

## 错误码说明

- `429 FreeUsageLimitError`：账号免费额度限流；DSH 自动重试，仍失败换模型（各模型配额独立）。
- `403 RegionError`：该模型不向当前地区提供，换模型。
- `403 FreeTierError`（IP 级）：上游已封禁本机地址的免费通道，
  见 [可用性测试与 IP 封禁](#可用性测试与-ip-封禁)。
- `402 Insufficient funds`：账号余额不足（付费模型）。
- `bun relay produced no status line`：Bun 中继异常，检查 `bun --version`。

## 文件结构

```
opencode-local-dsh/
├── index.js        # 插件入口：注册 LlmAdapter、目录刷新、状态文件
├── adapter.js      # DSH LlmAdapter 实现（providerInfo/listModels/resolveModel/stream）
├── wire.js         # 传输层：Bun 中继 + Node 回退、SSE 解析、harness chunk 构建
├── relay.mjs       # Bun 中继进程（stdin 收请求，stdout 转发 SSE）
├── credential.js   # 凭据解析：服务发现 → /api/credential → 本地 DB 回退
├── catalog.js      # 模型目录：Zen /v1/models + models.opencode.ai 元数据增强
├── ids.js          # canonical 会话 id 派生 + CLI 同形请求头
├── locale/         # 界面文案（en / zh）
├── icon.svg        # 插件图标
├── cordis.patch.yml
└── test/           # 开发测试（probe-one.mjs / smoke.mjs）
```

## 致谢

- [**opencode2dsh**](https://github.com/FishBottle7/opencode2dsh)（[FishBottle7](https://github.com/FishBottle7)）—— OpenCode Zen 的参考 DSH 集成；本插件沿用其 adapter 形态，但把匿名共享通道替换为你自己账号的通道。
- [**opencode2api**](https://github.com/jasonxu114514/opencode2api)（[@jasonxu114514](https://github.com/jasonxu114514)）—— `legacy/agent` 里的旧版 Go sidecar 是其匿名通道实现的移植版，目录回退链与请求伪装细节同样源自它。本项目站在它的肩膀上。
- [OpenCode](https://opencode.ai) —— 运营免费匿名 Zen 通道。
- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) —— adapter 模式使用的线层协议。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与 [dsh-market](https://github.com/dsh-market/dsh-market) 社区。

## 许可

MIT
