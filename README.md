[English](README.md) | [简体中文](README.zh-CN.md)

# opencode-local — DSH plugin: your own OpenCode lane, never the shared quota

Use **your own account's** OpenCode Zen free models inside DeepSeek Harness (DSH).

> **Never the shared quota.** Unlike the
> [opencode2dsh](https://github.com/FishBottle7/opencode2dsh) anonymous lane
> (`Bearer public` — shared by every anonymous user, IP-rate-limited, frequent
> 429s), this plugin calls `https://opencode.ai/zen/v1` with **your own logged-in
> OpenCode account token** — the free quota is private to your account.

## How it works

```
DSH session
  │  harness chunks (block-start / text-delta / usage / finish …)
  ▼
OpenCodeLocalAdapter (native LlmAdapter, registered as `opencode-local`)
  │  ① Credential: running OpenCode client /api/credential (or local DB cache)
  │  ② Transport: spawns a Bun relay (TLS fingerprint matches the official CLI)
  │  ③ Gate shape: canonical ses_ session id + stream + bash/read tools
  ▼
https://opencode.ai/zen/v1  ← YOUR account token
```

## Context overrides really work (measured)

The card can raise a model's declared context window. That is not cosmetic —
the upstream honours longer input than the model's own metadata advertises:

Needle test on `deepseek-v4.1-flash-free` with the card declaring **1,048,576**
(its metadata says 200,000). A unique code was buried two-thirds deep in filler
text and asked back:

| Sent | Upstream reported input | Code recovered |
| --- | ---: | --- |
| ~50k | 49,878 | ✅ |
| ~150k | 149,598 | ✅ |
| ~190k | 189,486 | ✅ |
| **~210k** (past 200k) | 209,430 | ✅ |
| **~250k** | 249,318 | ✅ |
| ~300k | — | ❌ (request rejected) |

So a 1M declaration is **usable to roughly 250k on this model** — input beyond
the advertised 200k is genuinely processed, not silently truncated. The real
ceiling is between 250k and 300k, not 1M, so a very large declared window trades
a bigger prompt for a late request failure. Values in that gap are best treated
as "the account's practical ceiling", which is why the card shows the effective
value and lets you lower it.

## Why the Bun relay

The opencode.ai gateway **rate-limits by TLS fingerprint**:

| Transport | TLS fingerprint | Quota bucket |
| --- | --- | --- |
| Official OpenCode CLI (Bun-compiled) | Bun | ✅ healthy (your desktop client keeps working) |
| Node / Python / curl | anything else | ❌ shared bucket exhausted (429, Retry-After ~16 h) |

The plugin spawns a Bun process (`relay.mjs`) for inference — its TLS fingerprint
matches the CLI's, reaching the healthy quota bucket. Falls back to a direct Node
fetch when Bun is missing (cold free models still work there).

## Settings card (0.3)

Click the plugin's name under **Settings → Plugins** to open its card
(the same pattern as `dsh-free-search`). The card offers:

| Control | What it does |
| --- | --- |
| **Free only** toggle | **Checked on a fresh install** — the picker starts with the 11 built-in free models. Untick it to see **every model your account can route** (paid included) |
| Per-model **show/hide** | Hide a model from the DSH model picker (`models.<id>.hidden`) |
| Per-model **context / max output** | Shows the effective limit; typing a value overrides it, clearing it returns to auto (`models.<id>.contextWindow`, `maxOutput`) |
| **Test** (per row) | Send a tiny streaming request to that model and report `OK` / `RATE_LIMIT` / `MODEL_UNAVAILABLE` / `REGION_BLOCKED` / `QUOTA_EXCEEDED` with latency |
| **Test all** | Probe every listed model; results stream in **one row at a time** (SSE) |
| **Refresh** / **Save** | Re-read the live lane status / commit the edited model map |
| Lane status line | Credential source, account, and catalog counts (free / paid) |

### Model scope

The card lists the models of the **`opencode` lane** the running client can
route — its built-in free models *and* its paid models (for a subscribed
account). Models belonging to other providers (OpenRouter, a custom endpoint)
are counted for diagnostics but not exposed, because this plugin's transport
posts to `opencode.ai/zen`, where those ids are not routable.

Limits come from the **running OpenCode client's own `/api/model`** (the
authoritative source); the public `models.opencode.ai` feed only fills gaps.
Context/output values on the card are therefore the real per-model limits, not
a blanket default.

Live state (roster, availability) rides a loopback-only bridge
(`/api/opencode-local/settings/status`, `/probe` — the latter is an SSE stream);
settings writes go through the official `configForms` transport.

## Prerequisites

- **OpenCode client logged in once** (desktop app or `opencode serve`).
  - Client running: plugin reads the active token from `/api/credential`
    (auto-refreshed).
  - Client closed: plugin reads the cached token from the local SQLite DB
    (`~/.local/share/opencode/opencode.db`) — works until the token expires;
    reopen the client once to refresh.
- **Bun runtime** (`npm install -g bun`) — for the TLS fingerprint match;
  falls back to Node direct fetch when unavailable.
- DSH ≥ 0.1.7, Node.js ≥ 20.

## Install

```sh
dsh plugin --profile <profile> add <this directory>
```

Or via the DSH UI: Settings → Plugins → install local bundle.

## Verify

1. Restart DSH (or wait for the plugin hot-reload).
2. The model picker shows an **OpenCode Local** group with your account's free
   models (`glm-5.3-flash-free`, `mimo-v2.6-flash-free`,
   `deepseek-v4.1-flash-free`, `longcat-2.5-preview-free`, `big-pickle`, …).
3. Send a message and watch the streaming reply.
4. Diagnostics: `~/.opencode-local-dsh/adapter-status.json`.

## UI Language

The plugin's display name and description follow DSH's UI language setting automatically:
English (`locale/en.json`) or 简体中文 (`locale/zh.json`). Switch in DSH settings.

## Configuration (cordis.patch.yml `config` object)

| Field | Default | Meaning |
| --- | --- | --- |
| `freeOnly` | `true` | Only expose free models; `false` exposes the whole account catalog |
| `refreshSeconds` | `300` | Model catalog refresh interval (seconds) |
| `accessToken` | — | Explicit access token override (empty = auto-resolve) |

## Credential resolution (three-level fallback)

1. Running client's `/api/credential` (supports token auto-refresh)
2. Local SQLite cache `~/.local/share/opencode/opencode.db` (client may be closed)
3. Error asking you to open the client (token expired and client not running)

The token lives in memory only; the plugin never writes it to disk.

## Error codes

- `429 FreeUsageLimitError`: per-account free-tier throttling; DSH retries
  automatically — switch models if it persists (quotas are per-model).
- `403 RegionError`: the model is not offered in your region; switch models.
- `402 Insufficient funds`: account balance too low (paid models).
- `bun relay produced no status line`: the Bun relay misbehaved; check `bun --version`.

## Project layout

```
opencode-local-dsh/
├── index.js       plugin entry: adapter registration, catalog refresh, status file
├── adapter.js     DSH LlmAdapter implementation (providerInfo/listModels/resolveModel/stream)
├── wire.js        transport: Bun relay + Node fallback, SSE parsing, harness chunk building
├── relay.mjs      Bun relay process (request on stdin, forwards SSE on stdout)
├── credential.js  credential resolution: service discovery → /api/credential → local DB fallback
├── catalog.js     model catalog: Zen /v1/models + models.opencode.ai enrichment
├── ids.js         canonical ses_ session id derivation + CLI-shaped headers
├── locale/        UI strings (en / zh)
├── icon.svg       plugin icon
├── cordis.patch.yml
└── test/          development tests (probe-one.mjs / smoke.mjs)
```

## Acknowledgments

- [**opencode2dsh**](https://github.com/FishBottle7/opencode2dsh) by
  [FishBottle7](https://github.com/FishBottle7) — the reference DSH integration
  for OpenCode Zen; this plugin keeps its adapter shape but replaces the shared
  anonymous lane with your own account's channel.
- [**opencode2api**](https://github.com/jasonxu114514/opencode2api) by
  [@jasonxu114514](https://github.com/jasonxu114514) — the legacy Go sidecar in
  `legacy/agent` is a port of its anonymous-lane implementation, and the catalog
  fallback chain and request-disguise details are derived from it. This project
  stands on its shoulders.
- [OpenCode](https://opencode.ai) — for running the free anonymous Zen lane.
- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) —
  the wire layer used by adapter mode.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and the
  [dsh-market](https://github.com/dsh-market/dsh-market) community.

## License

MIT
