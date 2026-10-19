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

## What a context override actually does (measured)

The card can raise a model's declared context window. It changes **what DSH
believes** — it does not raise the upstream's ceiling.

`buildRequestBody()` never sends a context-window field, so the upstream's own
gate decides what is served. The override only removes **DSH's** guard: with a
1M declaration, DSH will assemble and send a 1M prompt, and the upstream then
refuses it — late, after the whole prompt was sent.

Needle test on `deepseek-v4.1-flash-free` with the card declaring **1,048,576**
(the metadata and the running client both say 200,000). A unique code was
buried two-thirds deep in filler text and asked back:

| Sent | Upstream reported input | Code recovered |
| --- | ---: | --- |
| ~50k | 49,878 | ✅ |
| ~150k | 149,598 | ✅ |
| ~190k | 189,486 | ✅ |
| **~210k** | 209,430 | ✅ |
| **~250k** | 249,318 | ✅ |
| ~300k | — | ❌ (request rejected) |

**Read the ceiling correctly: 200,000 and 256k are the same tier.** The upstream
advertises `200,000` — a rounded-down decimal rendering of 262,144, the
standard 256 KiB context tier (and this plugin's own
`DEFAULT_CONTEXT_WINDOW` is 262,144). The measurement confirms it: 209,430 and
249,318 tokens were **served**, so the enforced limit is demonstrably **not**
200,000. The rejection bracket is (249,318, 300,000], and 262,144 sits inside
it.

So the practical ceiling for this model is the **256k tier**, and:

- raising the declaration past ~262,144 buys nothing — the upstream refuses
  the request, so a bigger declared window only trades a larger prompt for a
  late failure;
- the useful thing the override does is **lowering** it (to cut DSH's own
  prompt budget) or restating the real 256k figure when the metadata
  advertises the rounded 200,000;
- the card shows the effective value and lets you edit it, so you can set it
  to the number that actually matches the account's tier.

The measurement itself lives in `test/needle.mjs` (re-run it after
`node test/runtime-limit.mjs` prints the running client's own `limit`).

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
| **Update models** button | Pulls the model directory from OpenCode **now** (instead of waiting for the background refresh) and reports what moved: how many models appeared, disappeared or changed their limits. It also **prunes stale settings** — the `models.<id>` entry of a model the upstream catalog dropped is deleted, so no ghost row is left in the table |
| **Free only** toggle | **Checked on a fresh install** — filters the DSH picker *and* the card's table down to the built-in free models. It writes `freeOnly` and nothing else: no model is ticked, hidden or unhidden by it. Untick it to list **every model your account can route** again (paid included — minus any row you hid yourself). The label tracks the table: `Showing N/M · filtered by free-only` or `Showing M · all` |
| **Tick free only** button | Explicitly hides every paid model (`models.<id>.hidden`) **and** turns the free-only filter on — both land in ONE atomic write, so neither can overwrite the other |
| **Tick all** button | Clears every `hidden` flag so all models show again; it leaves the free-only switch alone, and that switch still filters the picker |
| Per-model **show/hide** | Hide a model from the DSH model picker (`models.<id>.hidden`) |
| Per-model **context / max output** | Shows the effective limit; typing a value overrides it, clearing it returns to auto (`models.<id>.contextWindow`, `maxOutput`) |
| **Test** (per row) | Send a tiny streaming request to that model and report `OK` / `RATE_LIMIT` / `MODEL_UNAVAILABLE` / `REGION_BLOCKED` / `QUOTA_EXCEEDED` / `IP_LANE_BLOCKED` with latency. The test sends **real** requests, and a standing warning says so — see [Availability tests and the IP block](#availability-tests-and-the-ip-block) |
| **Test all** | Probe the **free models only** (a paid probe spends the account balance); results stream in **one row at a time** (SSE). The batch **stops at the first IP-level block** and the rest of the rows are reported as skipped |
| **Refresh** / **Save** | Re-read the live lane status / commit the edited model map (`models.<id>.hidden`, `contextWindow`, `maxOutput`). The button is labelled **Save**; *Saved.* is the note it prints afterwards |
| Lane status line | Credential source, account, catalog counts (free / paid), last update time |

### Filtering vs. hiding

The switch and the two bulk buttons do **not** write the same thing:

- **Free only** toggle → `freeOnly` only. It filters both the DSH model picker
  and the card's table; it never writes `models.<id>.hidden`, so no row gets
  ticked, hidden or restored as a side effect.
- **Tick free only** → `freeOnly: true` **plus** `models.<id>.hidden` for every
  paid model (paid rows stay in the map as hidden, so clearing the flag brings
  them back). Both are submitted as **one operation list**, so they take effect
  together or not at all — they cannot overwrite each other.
- **Tick all** → `models.<id>.hidden = false` for every model, so every row is
  ticked again. It does **not** touch `freeOnly`: with the switch still on, the
  picker and the table keep listing the free models only.
- Per-row checkbox / **Save** → the `models.<id>.hidden` (and context/output)
  map exactly as you edited it.

The checkbox reads the **live lane** state over the loopback bridge
(`/status`), not the settings page's stored snapshot, so a click takes effect
immediately and no longer snaps back to its old value.

That snapshot is only a frame captured at render time — it refreshes two async
hops after a write, so it is a first-paint fallback only. What makes the choice
survive a restart is the settings page's official write path (`form.mutate`):
the bridge moves the **running** adapter at once, the official transport makes
the choice **stick across restarts**.

### Updating the model list

The model directory has three sources: Zen's `/v1/models` (which models exist),
`models.opencode.ai` (each model's context/output limits), and the **running
OpenCode client's own `/api/model`** (the authoritative limits). The plugin
refreshes in the background every `refreshSeconds` (300 by default), but
**Update models** pulls a round **right now** instead of making you wait.

Pressing it does three things:

1. Re-fetches the upstream directory (both `/api/model` and
   `models.opencode.ai`).
2. Compares before and after and reports how many models were **added**,
   **removed**, or **changed their limits** — when nothing moved it says
   "Model list is up to date."
3. **Prunes stale settings**: the `models.<id>` entry of a model the upstream
   catalog dropped is deleted (`op: unset`), so the table no longer keeps a
   ghost row for a model that no longer exists. This also fixes the case where
   upstream changed a model's limits while the card still showed the old
   values — the limits are re-read on every refresh now.

Step 3 writes settings (only when there IS a leftover entry for a model that
left the catalog), so it counts as a settings change.

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

Live state and writes ride a loopback-only bridge
(`/api/opencode-local/settings/status`, `/filter`, `/refresh`, `/probe` — the
latter is an SSE stream): the card applies filter/visibility changes straight
to the running adapter and only then persists them through the official
settings transport (when the host serves a writable form). A click therefore
always takes effect, even when that form cannot be written.

The bridge is also usable from a script (it is loopback-only and needs no
token). `POST /api/opencode-local/settings/filter` with
`{"freeOnly": true, "persist": true}` applies the change to the running
adapter **and** stores it in the profile, so it survives a restart. Without
`persist` the change only moves the live adapter — which is what the card
wants, because the card persists through the official transport itself (that
path applies an operation list atomically; two separate mutations of the same
entry race and the later one drops the earlier half).

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

## Availability tests and the IP block

The card's **test** button sends a real request per model. The upstream's
answer to repeated requests from one address is to block that address:

> OpenCode's free models aren't available from your current network because
> we've detected abusive traffic from this IP address. This isn't related to
> your account. If you're on a VPN or proxy, turn it off and try again, or
> subscribe to OpenCode Go at https://opencode.ai/go to keep building.

That refusal is **not** a per-model failure and **not** an account problem —
it closes the whole free lane for the address, so every model behind it
answers identically. Since the block IS the answer to repeated requests, the
plugin does the opposite of retrying:

- the refusal gets its own code, `IP_LANE_BLOCKED`, so it is never confused
  with a model that merely happens to be unavailable;
- the probe batch **stops at the first block** — the models it never reached
  are reported as `SKIPPED_IP_BLOCKED` instead of being asked anyway;
- a **30-minute cooldown** then keeps the test off: a click during the
  cooldown sends nothing at all, so a user who clicks "test all" five times
  in a row is not the reason the block persists;
- the card shows the upstream's own wording, because it says the three things
  that matter: it is the network address, a VPN or proxy is the likely
  cause, and the way out is to turn it off or subscribe.

The card also carries a standing warning that the test sends real requests.
If you hit the block, turning off the proxy/VPN is the fix; the plugin cannot
unblock an address from the client side.

## Error codes

- `429 FreeUsageLimitError`: per-account free-tier throttling; DSH retries
  automatically — switch models if it persists (quotas are per-model).
- `403 RegionError`: the model is not offered in your region; switch models.
- `403 FreeTierError` (IP-level): the upstream blocked this address's free
  lane — see [Availability tests and the IP block](#availability-tests-and-the-ip-block).
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
