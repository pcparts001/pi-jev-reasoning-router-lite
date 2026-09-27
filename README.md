# pi-jev-reasoning-router-lite

**Jev decision-based thinking-level routing** for Pi Agent.

> **Requirements:** the routing decision itself needs a **Jev API key** — TypeSafe's own API by default
> (`TYPESAFE_API_KEY`, billed per input token, output free) or the Command Code proxy (`COMMANDCODE_API_KEY`, whose
> usage counts against the GOAT plan's token count). Everything else is provider-independent: the routed model can
> be any model registered in pi. See "Jev provider" below.
>
> **Upgrading from the first release?** The Jev route changed from the Command Code proxy to TypeSafe's own API. Set
> `TYPESAFE_API_KEY` to use the new default, or pin `JEV_ROUTER_PROVIDER=commandcode` to keep the previous behavior.
> With neither, nothing breaks but every decision fails safe to `high` (no cost saving, no quality loss).

> **⚠️ Experimental software.** This extension is in an experimental stage and is provided "as is", without warranty of any kind. **The author assumes no responsibility whatsoever** for any damage or loss arising from its use, including billing on your model provider, on TypeSafe, or on Command Code.

## Install

### Option 1: `pi install` (recommended)

```sh
pi install https://github.com/pcparts001/pi-jev-reasoning-router-lite
```

**Uninstall:**

```sh
pi remove https://github.com/pcparts001/pi-jev-reasoning-router-lite
```

This removes the entry from `settings.json` **and** deletes the cloned directory
(`~/.pi/agent/git/github.com/pcparts001/pi-jev-reasoning-router-lite`), so the extension is gone completely.

The package declares **no dependencies and no peer dependencies** — the extension imports only types from
`@earendil-works/pi-coding-agent`, and pi resolves its own API at runtime — so `pi install` downloads just the
repository files, with no `node_modules` in the clone.

### Option 2: manual placement

```sh
git clone https://github.com/pcparts001/pi-jev-reasoning-router-lite.git \
  ~/.pi/agent/extensions/pi-jev-reasoning-router-lite
```

`package.json` declares the entry point via `pi.extensions` (and pi would also find `index.ts` at the repository
root), so no file renaming is required. Either way only the repository files are installed: the package has no
dependencies, so there is nothing for `npm install` to add (a manual clone just skips the step).

**Uninstall** — a manual clone has no `settings.json` entry, so `pi remove` reports
`No matching package found` and changes nothing. Delete the directory instead:

```sh
rm -rf ~/.pi/agent/extensions/pi-jev-reasoning-router-lite
```

**Update** with `git pull` (this clone is not managed by `pi update`):

```sh
git -C ~/.pi/agent/extensions/pi-jev-reasoning-router-lite pull
```

Note that an installed extension is auto-loaded, so **a jev decision runs on every prompt** (restricted to the
routed models — see "Requirements"). To try it without auto-loading, load it explicitly instead:

```sh
pi -ne -e /path/to/pi-jev-reasoning-router-lite/index.ts \
   --model command-code-goat/deepseek/deepseek-v4.1-flash
```

## About this extension

### The problem with a fixed thinking level

Reasoning effort is a per-model setting, and it decides both quality and cost. A single fixed value means one of
two compromises:

**1. Paying for deep reasoning on prompts that do not need it.**
Most prompts in a session are routine: continue the plan, read a file, apply the obvious fix. Running them at a
high reasoning level buys nothing but tokens and latency.

**2. Losing reasoning exactly where it matters.**
Lower the level once and the hard prompts — compare two designs, explain a bounded behavior, pick a diagnostic
step — lose the deliberation they need. Recovering from that costs more than the tokens it saved.

Deciding this by hand per prompt is a chore, and prompt length or vocabulary is a poor proxy: a one-line
question can demand deep reasoning while a long paste of logs may not.

### How Jev routing addresses this

The prompt is sent to **Jev (TypeSafe System One)**, which is asked one question — *how much reasoning does the
work ahead need?* — and answers with `none`, `low` or `high`. Only the **thinking level** of the routed model is
changed; nothing else about the session is touched.

- **The judgement is per prompt** — a trivial prompt runs cheap, a design question runs deep, with no manual switching.
- **It fails toward quality** — no key, timeout, 5xx or an invalid answer all fall back to `high`, so the routing
  can never quietly drop reasoning from a hard task.
- **It is read-only for the session** — the extension never rewrites the conversation, the system prompt, the
  outgoing payload, or the transcript; it sets a level and appends an audit entry.

#### In-loop effort routing (optional, opt-in)

Set `JEV_ROUTER_LOOP=1` to additionally route **every request inside a tool loop** (not just the
turn start). This uses local heuristics only — no jev calls, no network, no added latency:

| Rule | Condition | Level |
|---|---|---|
| tool-error | the latest tool result looks like an error | high |
| streak ≥ N | 4+ (configurable) consecutive successful tool results | low |
| early-loop | request ≤ 2 and a fresh tool result arrived | high |
| ambiguous | none of the above | keeps the turn-start level |

**Cache safety** (measured 2026-09-27): changing `reasoning_effort` between requests has **no impact
on the DeepSeek prefix cache** (command-code-goat / deepseek-v4.1-flash: 87-95% hit maintained across
all switch patterns — turn-boundary and in-loop). On zai (glm-5.3-flash with Preserved Thinking),
each effort change costs one full cache-miss request before re-stabilizing; see
[the research repository](https://github.com/pcparts001/pi-jev-reasoning-router-lite-research) for
the full measurement matrix.

| Variable | Default | Meaning |
|---|---|---|
| `JEV_ROUTER_LOOP` | *(unset = off)* | `1`/`true`/`on` enables in-loop routing |
| `JEV_ROUTER_LOOP_STREAK` | `4` | streak threshold that triggers the downgrade to low (2-20) |

## What the extension adds around the decision

1. **An environment-driven model gate.** Only the `provider/id` entries in `JEV_ROUTER_MODELS` are routed. When
   the variable is unset or empty the extension does nothing at all — no jev call, no level change — so cost and
   latency can never appear by surprise.
2. **A visible switch.** One dim line reports the change (`thinking high -> low (jev: low, 526ms)`), so the
   routing is observable instead of invisible. The mode is configurable (every low / only downgrades / any change / off).
3. **A run log you can analyze.** Every decision and skip is appended to a JSONL log with the session id, model,
   prompt length (never the prompt body) and latency, so the effect can be measured after the fact.
4. **Read-only input-cache measurement.** Because a level change could in principle invalidate the provider's
   prompt cache, the extension also records the real cache figures after the request. This measurement never
   alters the context.

### Measured results

Costs and latencies below come from real requests. The routing-quality numbers come from the pre-port benchmark
on the DeepSeek direct route (see the note under "What the routing saves").

#### What a decision costs

| Item | Rate | Cost per decision |
|---|---|---|
| Jev (`jev-latest` on TypeSafe / `typesafe/jev` on Command Code — the same model behind both routes) | input **$0.042/M**, **output free** | **~$0.00005** |

The state Jev reads is a fixed template plus at most 6,000 characters of the prompt (`STATE_PROMPT_MAX_CHARS`),
so the cost per decision is essentially constant regardless of how long the prompt is.

For comparison, the routed model request itself is billed at the model's own rates; the level it runs at decides
how many reasoning tokens that request produces.

#### How long a decision takes

| Measurement | Value |
|---|---|
| jev decision latency (real runs) | 409–856 ms (typically ~500 ms) |
| timeout | 3 s, with 1 retry (at most 2 attempts) |
| fallback on failure | `high` |

The decision happens before the model request, so it adds this latency to routed prompts.

#### What the routing saves

On the pre-port benchmark (30 tasks, DeepSeek direct route, the routing baseline being "always high"):

| Comparison | Routing | Baseline | Difference |
|---|---|---|---|
| Per-task cost, corrected to the same max_tokens | **$0.2844** | **$0.3352** | **−15.2%** |
| Per-task cost, uncorrected | $0.2685 | $0.3193 | −15.9% |
| Accuracy of the routing judgement | Spearman rho = +0.504 (p = 0.0040, n = 30) | — | moderate |

The same run also measured the honest counter-case:

| Comparison | Routing | Always low | Difference |
|---|---|---|---|
| Per-task cost | $0.2845 | **$0.2112** | routing is **more expensive** |
| Answer quality | equal | equal | — |

> These numbers come from a small benchmark and a specific model. **Your results will differ** with your mix of
> prompts, models and prompt-cache hit rates. They illustrate the mechanism, not a guarantee for your workload.

That is why the routing is worth it when your baseline is `high` — which is the usual case, because pi's built-in
`DEFAULT_THINKING_LEVEL` is `medium` and models without a medium tier clamp that **up** to `high`, and the Command
Code API treats `medium` as high effort. If you have explicitly lowered your baseline (for example
`defaultThinkingLevel: "low"` in `settings.json`, or a per-model `thinkingLevel`), the router adds cost and
latency for nothing. Check which level you actually run at before enabling it.

## Requirements

### API key (required)

**Jev runs on TypeSafe's own API by default**, so the default requirement is a TypeSafe API key
([dashboard](https://console.typesafe.ai/keys)):

```sh
export TYPESAFE_API_KEY="..."
```

If you route through Command Code instead (`JEV_ROUTER_PROVIDER=commandcode` — see "Jev provider"), set that key
instead:

```sh
export COMMANDCODE_API_KEY="..."
```

On the Command Code route this key is used for **both** the Jev decision and the model request itself; on the
TypeSafe route it is used only for the Jev decision.

**This extension never stores your API key.** For security it keeps no credential file and writes no credential
anywhere — the key is read from the environment at request time and used only in the `Authorization` header, and
it is never logged, never written to the run log or the payload dump. **Always set it as an environment variable**
in your shell profile (or via pi's own provider auth), not in a file inside this repository.

**If the key of the selected provider is unset**, every routed prompt fails safe to `high` (quality side) and the
extension reports the failure in its notification.

### Routed model (required)

```sh
export JEV_ROUTER_MODELS="command-code-goat/deepseek/deepseek-v4.1-flash"
```

**If it is unset or empty, the extension does nothing at all** (no jev call, no level change, safe by design).
The value is a comma-separated list of `provider/id` entries, matched exactly (case-insensitive); `*` works as a
wildcard per element (`deepseek/*`, `*/glm-5.3-flash`, `*/*`).

The target model also needs pi-side settings that the extension cannot verify:

| Requirement | Where | Why |
|---|---|---|
| The model is registered | `~/.pi/agent/models.json` | pi must know the model |
| `reasoning: true` on the model | same file | otherwise the extension does not run (`no-reasoning`) |
| `compat.supportsReasoningEffort: true` on the model | same file | without it pi never sends `reasoning_effort`, so changing the level changes nothing |
| The route accepts the effort values | the provider | on the Command Code route `none` is rejected with HTTP 400, so the lowest usable level is `low` |

### Jev provider (route to jev)

Both routes ask **the same question with the same wording** (`criteria.ts`) and answer with the same shape
(`answers["effort"].choice`), so switching routes does not change the criteria or the parser. Only the endpoint,
the model name and the key variable differ.

| Item | `typesafe` (**default**) | `commandcode` |
|---|---|---|
| Endpoint | `https://api.typesafe.ai/v1/systemone` | `https://api.commandcode.ai/provider/v1/systemone` |
| Model | `jev-latest` (= `jev-1.13.0`) | `typesafe/jev` (a provider-scoped name) |
| Auth | `Authorization: Bearer $TYPESAFE_API_KEY` | `Authorization: Bearer $COMMANDCODE_API_KEY` (a `User-Agent` is required to pass Cloudflare) |
| Billing | TypeSafe usage ($42/Btok input, output free) | your Command Code account (GOAT token count) |
| Latency observed in real runs | 156–432 ms | 372–612 ms |
| Response to the same state | `low` (p 0.72) | `low` (p 0.73) |

Selection (`JEV_ROUTER_PROVIDER`):

| Value | Behavior |
|---|---|
| `typesafe` | TypeSafe's own API (the default; also used when the variable is unset or unrecognized — an unrecognized value adds a warning to the audit entry and the log) |
| `commandcode` | The Command Code proxy (the original route, unchanged) |
| `auto` | TypeSafe when `TYPESAFE_API_KEY` is set, otherwise Command Code |

- Request, timeout and fail-safe are identical on both routes: one `choice` question (`none` / `low` / `high`) with
  fixed criteria, 3 s per attempt, 1 retry, then fail-safe `high`.
- **The model names are not interchangeable**: `typesafe/jev` on the native API returns `400 Unknown model`, and
  `jev-latest` is not a model id registered by the Command Code provider (the proxy rewrites it to `typesafe/jev`).
  The extension therefore sends the correct name per route.
- The endpoints and models are defined in `JEV_PROVIDERS` in `jev.ts` (OpenRouter is deliberately not supported).
- The route actually used is recorded per decision (`jevProvider` in the audit entry and in the run log), and
  `/jev-router` prints the resolved route, endpoint, model and whether the key is present (never its value).

## Privacy & data flow

This extension sends part of your prompt to your selected Jev provider so that Jev can judge it.

| Direction | Content |
|---|---|
| **Sent to Jev** | A fixed state template plus **the first 6,000 characters of your prompt** |
| **Not sent to Jev** | The system prompt, the conversation history, tool calls and results, file contents, images/attachments, the cwd, the session id, and your API key |
| **Destination** | `api.typesafe.ai` by default; `api.commandcode.ai` when `JEV_ROUTER_PROVIDER=commandcode` |
| **Written locally** | `~/.pi/agent/jev-router/runs.jsonl`: timestamp, prompt **length** (never the body), session id, session file path, cwd, model, jev provider, decision, latency, and the post-request cache figures. Disable with `JEV_ROUTER_LOG=off` |

Do not use this extension on sessions whose content you are not permitted to send to the selected provider
(TypeSafe's own API by default, Command Code if you select that route).

## Experimental — no warranty

This extension is **experimental software** and is provided "as is", without warranty of any kind. **The author
assumes no responsibility whatsoever** for any damage or loss arising from its use (including billing on your
model provider or on Command Code, incorrect reasoning levels, or changes to the endpoints it depends on). Use at
your own risk.

## Usage

The extension activates on every prompt (`before_agent_start`), and the model gate decides whether that prompt is
routed.

### Automatic triggering

No user action is needed. For each prompt:

```
ctx.model matches JEV_ROUTER_MODELS
  -> jev decision (none / low / high)
  -> pi.setThinkingLevel(...)          # low or high
  -> one dim line in the UI + one appendEntry + one log record
```

- This is a **per-prompt** step, not a background job: routed prompts pay the jev latency (~0.5 s).
- pi's thinking level is **session state**, so the level chosen for one prompt persists into the following
  prompts until the next decision changes it.
- A model that is not in the allowlist is left completely alone (its own level setting stays as you set it).

### Commands

| Command | Behavior | Gate |
|---|---|---|
| `/jev-router` | show the current model, whether it is routed and why not, the allowlist, the Jev provider (route, endpoint, model, whether the key is set), the last decision, `NONE_POLICY`, and the choice -> level mapping | — |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `JEV_ROUTER_PROVIDER` | `typesafe` | Jev route: `typesafe` (TypeSafe's own API) / `commandcode` (Command Code proxy) / `auto` (TypeSafe when `TYPESAFE_API_KEY` is set, otherwise Command Code). An unrecognized value falls back to `typesafe` and is recorded as a warning |
| `TYPESAFE_API_KEY` | — | **required by default**: the Jev decision on TypeSafe's own API |
| `COMMANDCODE_API_KEY` | — | required only for `JEV_ROUTER_PROVIDER=commandcode`: the Jev decision and, on that route, the model request |
| `JEV_ROUTER_MODELS` | *(unset)* | **required to route anything**. Comma-separated `provider/id` allowlist. Unset or empty = nothing runs |
| `JEV_ROUTER_NOTIFY` | `low` | Level-change messages: `low` (every low decision) / `downgrade` / `change` / `off` |
| `JEV_ROUTER_LOG` | `~/.pi/agent/jev-router/runs.jsonl` | Run log destination. `off` or empty disables it |

## How it works

Jev is asked one question per prompt, with fixed criteria (the wording is fixed in `criteria.ts`, which must not
be edited — the accuracy numbers below were measured against exactly that wording):

| Choice | Meaning (abbreviated) | Applied level |
|---|---|---|
| `none` | the next step can be completed without deliberation | `low` (with `NONE_POLICY="low"`, the default) |
| `low` | routine exploration or a continuation whose next move is clear | `low` |
| `high` | focused reasoning over a few connected facts: compare local alternatives, explain a bounded behavior, choose a well-scoped step | `high` |

What pi then sends depends on the routed model. On the Command Code route only `reasoning_effort` is sent:

| Applied level | Payload on the Command Code route |
|---|---|
| `low` | `reasoning_effort:"low"` |
| `high` | `reasoning_effort:"high"` |

- The extension **never builds a payload** — pi does. Whether `thinking` / `reasoning_effort` appears at all
  depends on the model's `models.json` settings (see "Requirements").
- Any failure (no key, timeout, 5xx, unparsable answer) applies `high`.
- The decision is also appended to the session as an audit entry (`appendEntry`), which **never enters the model context**.
- The route that answered is recorded with the decision (`jevProvider` / `jevProviderSource` in the audit entry and
  in the run log), so a log can be split by route after the fact. The routing criterion itself is route-independent.
- The cache measurement is **strictly read-only**: it reads the `usage` pi reports, returns `undefined`, and
  writes neither session entries nor messages.

## Known limitations

- **Moderate discrimination.** The judgement correlates with difficulty at rho = +0.504 (n = 30, offline
  threshold), and `none` was never returned in that set, so in practice it is a **low / high two-way router**.
  Unseen tasks may be misjudged; the fail-safe (`high`) bounds the damage to cost, not quality.
- **Only worth it if your baseline is high.** "Always low" measured cheaper with equal quality, so adding this
  router to a session that already runs low adds cost and latency for nothing. With pi's built-in default
  (`medium`, which clamps up to `high` on this route) the baseline is high, so the default configuration is the
  case where the router pays off; an explicit `defaultThinkingLevel` in `settings.json` can change that.
- **`low` is flaky.** Re-running the same payload splits the outcome (measured 71–90% on one model family); treat
  any effect measurement as needing ~10 repetitions.
- **The routing gain is unverified on the Command Code route.** The quality/cost numbers above come from the
  pre-port DeepSeek direct benchmark; only the mechanics (the field is sent, the API honors it) are confirmed here.
- **`none`/N2 is unusable on the Command Code route** (`reasoning_effort:"none"` returns HTTP 400 and
  `thinking:{type:"disabled"}` is ignored), so the floor is `low`.
- **A decision adds ~0.5 s to every routed prompt** (3 s timeout, 1 retry).
- **The thinking level is session state**, so a level applied for one prompt persists into the next.
- **`max_tokens` is the model default (384,000);** measurements elsewhere showed 32,768 truncating hard tasks.
- **The allowlist is the only safety valve.** If you point it at a model whose `models.json` lacks
  `compat.supportsReasoningEffort`, the extension will run but the level changes will have no effect.

## License

MIT
