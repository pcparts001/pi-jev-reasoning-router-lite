/**
 * D_08_A8 router: decision -> thinking level (design spec §3-2 / §3-3 / §4-4)
 *
 * Nothing here has side effects (pure functions only). index.ts performs the actual application.
 */

import type { EffortChoice } from "./criteria.ts";
// Type-only import (erased at runtime, so this file stays pure): the jev route ids live with the providers
import type { JevProviderId, JevProviderSource } from "./jev.ts";

/**
 * pi's ThinkingLevel.
 *
 * Note (verified against the real package, 2026-09-26 / pi-coding-agent 0.87.1):
 * `@earendil-works/pi-coding-agent`'s `dist/index.d.ts` does **not** re-export the `ThinkingLevel` type
 * (only related event types such as `ThinkingLevelSelectEvent`).
 * The real definition lives in `@earendil-works/pi-agent-core` and appears in pi's own `dist/bundle` as
 * `["off","minimal","low","medium","high","xhigh","max"]`.
 * The extension therefore defines the same literal union locally.
 */
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * §3-3 [open decision] how `none` is treated. **The default is "low" (N1, as specified).**
 *  - "low": none -> low (measured 1.000, consistent with the earlier measurement)
 *  - "off": none -> thinking disabled (the hardware none tier; measured 0.767. N2)
 * Do not switch to N2 on your own.
 */
export const NONE_POLICY: "low" | "off" = "low";

/** §3-3: the level for unknown values and the fail-safe (bias toward quality) */
export const FAIL_SAFE_LEVEL: PiThinkingLevel = "high";

/** §3-2 (2): jev's choice -> pi's thinking level */
export function choiceToLevel(choice: EffortChoice): PiThinkingLevel {
  if (choice === "high") return "high";
  if (choice === "low") return "low";
  // none: switched between §3-3 N1 / N2 by NONE_POLICY (default N1 = low)
  return NONE_POLICY === "off" ? "off" : "low";
}

/** Diagnostics (JEV_ROUTER_FORCE): the inverse map level -> choice. Level "off" corresponds to choice "none". */
export function levelToChoice(level: PiThinkingLevel): EffortChoice | undefined {
  if (level === "high") return "high";
  if (level === "low") return "low";
  if (level === "off") return "none";
  return undefined;
}

/** Where the decision came from (for auditing) */
export type DecisionSource = "jev" | "fail-safe" | "forced";

/**
 * Interpretation of the diagnostic switch `JEV_ROUTER_FORCE=off|low|high` (**verification only**. SPEC §4 T2).
 * When set, jev is not called and that level is used as is. Unset (the default) disables it.
 * A forced level yields `source: "forced"` and emits no notification (level-change message).
 */
export function parseForcedLevel(raw: string | undefined): PiThinkingLevel | undefined {
  if (!raw) return undefined;
  const value = raw.trim().toLowerCase();
  return value === "off" || value === "low" || value === "high" ? value : undefined;
}

// ============================================================================
// Model gate (for which model this extension runs)
// ============================================================================

/**
 * Environment variable that supplies the allowlist (the routing targets as `provider/id`).
 *
 * **This value alone decides the target models** (there is no hardcoded default model in the extension).
 * When it is unset or empty the allowlist is empty and no model is routed.
 *
 * Target models have prerequisites on pi's side (the extension cannot verify them, so the configurator owns them):
 *  - the model is registered in `~/.pi/agent/models.json` and has `reasoning: true`
 *  - `compat.supportsReasoningEffort: true` (a model-level value overrides a provider-level false).
 *    Without it pi never sends `reasoning_effort`, so changing the level changes nothing (no effect)
 */
export const ALLOWED_MODELS_ENV = "JEV_ROUTER_MODELS";

/** The minimal fields actually read from ctx.model */
export interface RoutedModelLike {
  provider?: string;
  id?: string;
  reasoning?: boolean;
}

export interface AllowedModelsConfig {
  /** The allowlist actually in use (`provider/id`) */
  allowed: string[];
  /** Entries that could not be parsed and were ignored (no `/`, etc.) */
  ignored: string[];
  /** `env` = read from the environment variable (empty list when unset/empty) / `unset` = the variable is unset */
  source: "env" | "unset";
}

/** Case-insensitive match that treats `*` as any string */
function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

/**
 * Resolve the allowlist configuration (by default it reads the `JEV_ROUTER_MODELS` environment variable).
 *  - unset (env is undefined / the argument is undefined|null) -> empty list (source `unset`; the extension does nothing)
 *  - empty string or only `,`                              -> empty list (= a kill switch that stops every model)
 *  - anything else                                         -> parsed on commas (entries that are not `provider/id` are ignored)
 *
 * It never falls back to a default model (the configurator states the target models explicitly).
 */
export function resolveAllowedModels(
  raw: string | null | undefined = process.env[ALLOWED_MODELS_ENV],
): AllowedModelsConfig {
  if (raw === undefined || raw === null) {
    return { allowed: [], ignored: [], source: "unset" };
  }
  const allowed: string[] = [];
  const ignored: string[] = [];
  for (const entry of raw.split(",")) {
    const value = entry.trim();
    if (!value) continue;
    // Only the first `/` separates provider from id
    // (so models whose id itself contains `/` (e.g. `deepseek/deepseek-v4.1-flash` under command-code-goat) can be listed)
    const splitAt = value.indexOf("/");
    if (splitAt > 0 && value.slice(splitAt + 1).trim()) allowed.push(value);
    else ignored.push(value);
  }
  return { allowed, ignored, source: "env" };
}

/** Split one `provider/id` entry into provider and id (the separator is the first `/`) */
function splitAllowedEntry(entry: string): { provider: string; id: string } {
  const splitAt = entry.indexOf("/");
  return { provider: entry.slice(0, splitAt), id: entry.slice(splitAt + 1) };
}

/**
 * Whether a model matches the allowlist.
 * **Only true when both provider and id match** (`*` is a wildcard).
 * When the provider differs it does not match even with the same id (registering the same id under another
 * provider makes it a different route and therefore out of scope).
 */
export function matchesAllowedModel(model: RoutedModelLike, allowed: readonly string[]): boolean {
  const provider = (model.provider ?? "").trim();
  const id = (model.id ?? "").trim();
  if (!provider || !id) return false;
  return allowed.some((entry) => {
    const parsed = splitAllowedEntry(entry);
    return wildcardMatch(parsed.provider, provider) && wildcardMatch(parsed.id, id);
  });
}

/** Why the router did not run */
export type RouteSkipReason =
  | "model-unknown"
  | "no-allowed-models"
  | "model-not-allowed"
  | "no-reasoning";

export type RouteDecision =
  | { routed: true; model: string; allowed: string[] }
  | { routed: false; reason: RouteSkipReason; model: string | undefined; allowed: string[] };

/**
 * Whether this extension runs for the current model (a pure function).
 *
 * Order: unknown model -> empty allowlist -> no allowlist match -> reasoning unsupported.
 * When `ctx.model` is unavailable it falls back to the safe side (do not run).
 */
export function routeDecision(
  model: RoutedModelLike | undefined,
  config: AllowedModelsConfig = resolveAllowedModels(),
): RouteDecision {
  if (!model) return { routed: false, reason: "model-unknown", model: undefined, allowed: config.allowed };
  const label = model.provider && model.id ? `${model.provider}/${model.id}` : undefined;
  if (!label) return { routed: false, reason: "model-unknown", model: undefined, allowed: config.allowed };
  if (config.allowed.length === 0) {
    return { routed: false, reason: "no-allowed-models", model: label, allowed: config.allowed };
  }
  if (!matchesAllowedModel(model, config.allowed)) {
    return { routed: false, reason: "model-not-allowed", model: label, allowed: config.allowed };
  }
  if (model?.reasoning === false) {
    return { routed: false, reason: "no-reasoning", model: label, allowed: config.allowed };
  }
  return { routed: true, model: label, allowed: config.allowed };
}

// ============================================================================
// In-loop gate (JEV_ROUTER_LOOP) — the SAME allowlist gate as the turn start
// ============================================================================

/** Why in-loop routing did not run (recorded for diagnostics) */
export type LoopGateBlockReason = "loop-disabled" | "no-turn" | "model-changed" | RouteSkipReason;

export type LoopGateDecision =
  | { allowed: true; model: string }
  | { allowed: false; reason: LoopGateBlockReason };

/**
 * Whether in-loop routing may rewrite this request's `reasoning_effort` (a pure function).
 *
 * It calls **the same `routeDecision`** the turn start uses, so `JEV_ROUTER_MODELS` has a single
 * source of truth and is always matched against pi's `provider/id` identity — never against the
 * provider-side wire model name (`wireModel`), which is a different string (e.g. pi's
 * `command-code-goat/deepseek/deepseek-v4.1-flash` vs the wire's `deepseek/deepseek-v4.1-flash`)
 * and cannot be mapped back reliably.
 *
 * `turnModel` is the routed identity captured when the turn was routed, so a model change in the
 * middle of a turn stops the routing instead of rewriting the effort of an unverified model.
 * Requiring it also means "this turn was routed", i.e. the model passed the gate at the turn start.
 */
export function loopGate(
  input: { enabled: boolean; model: RoutedModelLike | undefined; turnModel: string | undefined },
  config?: AllowedModelsConfig,
): LoopGateDecision {
  if (!input.enabled) return { allowed: false, reason: "loop-disabled" };
  if (!input.turnModel) return { allowed: false, reason: "no-turn" };
  // The allowlist is resolved only when the loop actually runs (the default config does no extra work)
  const route = routeDecision(input.model, config ?? resolveAllowedModels());
  if (!route.routed) return { allowed: false, reason: route.reason };
  if (route.model !== input.turnModel) return { allowed: false, reason: "model-changed" };
  return { allowed: true, model: route.model };
}

// ============================================================================
// Level-change notification (shown as one dim line in pi's UI)
// ============================================================================

/** Environment variable that changes the notification mode */
export const NOTIFY_ENV = "JEV_ROUTER_NOTIFY";

/**
 * Notification mode.
 *  - "low" (default): notify **every time** jev decides low / none (= the applied level is low)
 *  - "downgrade"    : only when the level actually went down
 *  - "change"       : whenever the level changed (up or down)
 *  - "off"          : never notify
 */
export type NotifyMode = "low" | "downgrade" | "change" | "off";

export const DEFAULT_NOTIFY_MODE: NotifyMode = "low";

/** Strength order of ThinkingLevel (used to detect a downgrade in notifications) */
const LEVEL_RANK: Record<PiThinkingLevel, number> = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

/** Interpretation of `JEV_ROUTER_NOTIFY` (unset or invalid falls back to the default "low") */
export function parseNotifyMode(raw: string | null | undefined = process.env[NOTIFY_ENV]): NotifyMode {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "low" || value === "downgrade" || value === "change" || value === "off"
    ? value
    : DEFAULT_NOTIFY_MODE;
}

export interface LevelNoticeInput {
  mode: NotifyMode;
  source: DecisionSource;
  /** The level before applying */
  previousLevel: PiThinkingLevel;
  /** The level actually applied (after pi clamped it) */
  level: PiThinkingLevel;
  /** jev's decision */
  choice: EffortChoice;
  latencyMs: number;
}

/**
 * Whether a notification should be emitted (a pure function).
 *
 * - `forced` (the diagnostic switch) is not jev's decision, so it never notifies.
 * - The "low" mode decides on **whether jev's decision was low / none**, not on whether the level actually
 *   dropped. It therefore notifies every time, even when low continues from the previous turn (no change).
 */
export function shouldNotifyLevel(input: LevelNoticeInput): boolean {
  const { mode, source, previousLevel, level, choice } = input;
  if (mode === "off" || source === "forced") return false;
  if (mode === "change") return previousLevel !== level;
  if (mode === "downgrade") return LEVEL_RANK[level] < LEVEL_RANK[previousLevel];
  return level === "low" && (choice === "low" || choice === "none");
}

/**
 * The notification text (one dim line, in the same spirit as RTK's `RTK rewrite: ... -> ...`).
 *
 *   changed:     pi-jev-reasoning-router: thinking high -> low (jev: low, 526ms)
 *   unchanged:   pi-jev-reasoning-router: thinking low (jev: low, 526ms)
 */
export function formatLevelNotice(input: LevelNoticeInput): string {
  const transition =
    input.previousLevel === input.level
      ? `thinking ${input.level}`
      : `thinking ${input.previousLevel} -> ${input.level}`;
  const reason = input.source === "fail-safe" ? `jev: ${input.choice} (fail-safe)` : `jev: ${input.choice}`;
  return `pi-jev-reasoning-router: ${transition} (${reason}, ${input.latencyMs}ms)`;
}

// ============================================================================
// Assemble run log (JSONL) records (pure functions; logger.ts does the writing)
// ============================================================================

/** Environment variable that changes the run log destination (`off` / empty string disables it) */
export const LOG_ENV = "JEV_ROUTER_LOG";

/** Shared log context (correlation info used later to join with a session) */
export interface LogContext {
  /** ISO8601 */
  ts: string;
  /** The prompt body is never recorded (only its length) */
  promptChars: number;
  sessionId?: string;
  sessionFile?: string;
  cwd?: string;
  /** `provider/id` (undefined when the model is unknown) */
  model?: string;
  provider?: string;
  id?: string;
}

/** A record of a decision that ran and applied a level */
export interface DecisionLogRecord extends LogContext {
  v: 1;
  event: "decision";
  choice: EffortChoice;
  requestedLevel: PiThinkingLevel;
  effectiveLevel: PiThinkingLevel;
  previousLevel: PiThinkingLevel;
  source: DecisionSource;
  attempts: number;
  latencyMs: number;
  notifyMode: NotifyMode;
  notified: boolean;
  /** Which jev route answered (`typesafe` = native API / `commandcode` = proxy); not the routed model's provider */
  jevProvider?: JevProviderId;
  /** How the jev provider was chosen (`default` = `JEV_ROUTER_PROVIDER` unset) */
  jevProviderSource?: JevProviderSource;
  /** Summary of why it fell back to the fail-safe (never contains the API key) */
  error?: string;
}

/** A record of a turn stopped by the model gate */
export interface SkipLogRecord extends LogContext {
  v: 1;
  event: "skip";
  reason: RouteSkipReason;
  allowed: string[];
}

export type LogRecord = DecisionLogRecord | SkipLogRecord | CacheFirstRequestLogRecord | CacheTurnLogRecord | LoopLogRecord;

export function buildDecisionLogRecord(input: LogContext & Omit<DecisionLogRecord, keyof LogContext | "v" | "event">): DecisionLogRecord {
  return { v: 1, event: "decision", ...input };
}

export function buildSkipLogRecord(input: LogContext & Omit<SkipLogRecord, keyof LogContext | "v" | "event">): SkipLogRecord {
  return { v: 1, event: "skip", ...input };
}

// ============================================================================
// Input cache (prompt cache) measurement - **reading only** the usage pi returns after a request
// ============================================================================
//
// Purpose: make it possible to verify later, from the log, whether a level change (high->low / low->high)
// breaks the input cache. Cache values only exist **after the response is received**, so they are recorded as
// separate records (`event: "cache"`) in `message_end` / `agent_end` instead of in the pre-send `decision`
// record (the JSONL is append-only; `decision` is never rewritten).
//
// **This section is measurement only** (pure functions). It never affects the context:
//  - it does not rewrite conversation messages, the system prompt, or the outgoing payload (`readPayloadModel` only reads)
//  - it does not use `pi.appendEntry` (never touches the session file)
//  - the only value source is the assistant message's `usage`
//
// pi's normalization (the real `parseChunkUsage` in `dist/bundle/chunks/openai-completions-*.js`, 0.87.1):
//   cacheRead  = prompt_tokens_details.cached_tokens ?? prompt_cache_hit_tokens ?? cached_tokens ?? 0
//   cacheWrite = prompt_tokens_details.cache_write_tokens || 0
//   input      = max(0, prompt_tokens - cacheRead - cacheWrite)   <- **excludes the cached part**
//   totalTokens= input + output + cacheRead + cacheWrite
// The total tokens put into the prompt can therefore be restored as input + cacheRead + cacheWrite (`promptTokens`).
// DeepSeek returns `prompt_cache_hit_tokens`, so cacheRead can be measured for real.
// **Note**: pi maps missing fields to 0, so `cacheRead: 0` can mean both "a real miss" and
// "the provider does not report it" (judge from real run logs that you keep locally).

/** The minimal fields read from an assistant message's usage (pi's normalized usage) */
export interface CacheUsage {
  /** Input tokens excluding the cached part */
  input?: number;
  output?: number;
  /** Input tokens read from the cache (DeepSeek's `prompt_cache_hit_tokens`) */
  cacheRead?: number;
  /** Input tokens written to the cache (usually 0 on DeepSeek) */
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
}

/** Usage keys to record (fixed order, so the log looks stable) */
export const CACHE_USAGE_KEYS: readonly (keyof CacheUsage)[] = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "totalTokens",
];

/**
 * Read an unknown value safely (only finite non-negative numbers are accepted).
 * If nothing can be read it returns `undefined` (= usage unknown: abort, or a provider that does not report usage).
 */
export function readCacheUsage(raw: unknown): CacheUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const usage: CacheUsage = {};
  let found = false;
  for (const key of CACHE_USAGE_KEYS) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      usage[key] = value;
      found = true;
    }
  }
  return found ? usage : undefined;
}

/** Total tokens put into the prompt (pi's `input` excludes the cached part, so it is added back) */
export function promptTokens(usage: CacheUsage): number | undefined {
  const parts = [usage.input, usage.cacheRead, usage.cacheWrite];
  if (parts.every((value) => value === undefined)) return undefined;
  return parts.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

/** cacheRead ratio (0..1). undefined when the prompt is 0 or unknown */
export function cacheReadRatio(usage: CacheUsage): number | undefined {
  const prompt = promptTokens(usage);
  if (prompt === undefined || prompt <= 0 || usage.cacheRead === undefined) return undefined;
  return usage.cacheRead / prompt;
}

/** Sum usage values (same keys are added; undefined keys are ignored; undefined when there is none) */
export function sumCacheUsage(list: readonly (CacheUsage | undefined)[]): CacheUsage | undefined {
  const total: CacheUsage = {};
  let found = false;
  for (const usage of list) {
    if (!usage) continue;
    for (const key of CACHE_USAGE_KEYS) {
      const value = usage[key];
      if (value === undefined) continue;
      total[key] = (total[key] ?? 0) + value;
      found = true;
    }
  }
  return found ? total : undefined;
}

/** Whether the thinking level actually changed */
export function isLevelChanged(previousLevel: PiThinkingLevel, level: PiThinkingLevel): boolean {
  return previousLevel !== level;
}

/** Whether the model changed from the previous request (undefined = undecidable when either side is unknown) */
export function isModelChanged(previousModel: string | undefined, model: string | undefined): boolean | undefined {
  if (!previousModel || !model) return undefined;
  return previousModel !== model;
}

/**
 * Read the model name from a provider request payload (**read only; the payload is never rewritten**).
 * The shape is provider-dependent, so anything that is not a string yields `undefined`.
 */
export function readPayloadModel(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>).model;
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Correlation info for one prompt's decision.
 *
 * The **shape of the volatile state** that `index.ts` creates in `before_agent_start` and that
 * `before_provider_request` / `message_end` / `agent_end` read and write (the pure-function side only uses this
 * type and holds no state).
 */
export interface PendingTurn {
  /** Context at decision time (same `sessionId` / `model` / `promptChars` / `ts` as the `decision` record) */
  log: LogContext;
  /** Decision time (ISO8601). = `log.ts` (the join key with the `decision` record) */
  decidedAt: string;
  /** Decision time (epoch ms; used to measure the time from decision to response) */
  decidedAtMs: number;
  choice: EffortChoice;
  source: DecisionSource;
  previousLevel: PiThinkingLevel;
  effectiveLevel: PiThinkingLevel;
  levelChanged: boolean;
  /** Decision latency (same value as the `decision` record; helps joining) */
  latencyMs: number;
  /** Number of jev attempts (same value as the `decision` record) */
  attempts: number;
  /** Summary of the fail-safe reason (same value as the `decision` record) */
  error?: string;
  /** Timestamp of this turn's first provider request (set by `before_provider_request`) */
  requestAt?: number;
  /** Timestamp of the last provider request before that first one (the baseline for idleMs) */
  previousRequestAt?: number;
  /** Model read from the first request's payload */
  model?: string;
  /** Model of the previous provider request */
  previousModel?: string;
  /** Whether the first request after a level change was already recorded (prevents double recording) */
  firstRequestCaptured: boolean;
}

/** The shared part of a `cache` record (correlation info with the `decision` record) */
export interface CacheLogCommon extends LogContext {
  choice: EffortChoice;
  source: DecisionSource;
  previousLevel: PiThinkingLevel;
  effectiveLevel: PiThinkingLevel;
  levelChanged: boolean;
  /** Decision time (ISO8601). Identical to the `ts` of the `decision` record */
  decidedAt: string;
  /** Decision latency (identical to the `decision` record) */
  latencyMs: number;
  /** Milliseconds since the last request before this turn's first provider request (undefined when unknown) */
  idleMs?: number;
  /** Whether the model changed from the previous request (undefined when unknown) */
  modelChanged?: boolean;
  /**
   * Whether **compaction happened** between the previous turn and this one.
   * When true the prefix itself was rewritten, so this turn cannot be compared with the previous one (reuse rate).
   * Omitted for turns with no observation (no key = false).
   */
  compacted?: boolean;
  /** What triggered the compaction (`manual` / `threshold` / `overflow`) */
  compactionReason?: string;
  /** Number of jev attempts (1 = succeeded on the first try / 2 = after a retry; same as `decision`, to separate fail-safes) */
  attempts: number;
  /** Summary of the fail-safe reason (**never contains the API key**; same value as the `decision` record) */
  error?: string;
}

/** Cache measurement of the first request after a level change (recorded in `message_end`) */
export interface CacheFirstRequestLogRecord extends CacheLogCommon {
  v: 1;
  event: "cache";
  scope: "first-request";
  /** Which assistant message of this turn this is (1 = the first one after the level change) */
  requestIndex: number;
  /** Milliseconds from the decision to this response */
  sinceDecisionMs?: number;
  usage: CacheUsage;
}

/** Turn summary (recorded in `agent_end`) */
export interface CacheTurnLogRecord extends CacheLogCommon {
  v: 1;
  event: "cache";
  scope: "turn";
  /** Whether the first request after the level change could be recorded */
  firstRequest: "recorded" | "missing";
  /** Why it is `missing` (`no-usage` = the first request's usage could not be read: no response, no usage, abort, ...) */
  firstRequestMissingReason?: "no-usage";
  /** Number of assistant messages in the turn (= number of LLM responses) */
  requestsInTurn: number;
  /** Total usage in the turn (undefined when not a single one could be read) */
  usage?: CacheUsage;
  /**
   * Usage of the **last assistant response** of the turn.
   *
   * Why it is needed: when analysis asks "how much was reused compared with the previous turn", the baseline is
   * **the previous turn's last request's prompt** (exactly the prefix of this turn's first request).
   * When tool calls cause several requests in one turn, neither the summed `usage` nor the first request works.
   */
  lastUsage?: CacheUsage;
}

/** An in-loop routing decision (per-request effort override via local rules) */
export interface LoopLogRecord extends LogContext {
  v: 1;
  event: "loop";
  /** Request index within the current turn (1-based, counted from the last user message) */
  n: number;
  /** The level this rule decided ("low" | "high") */
  level: "low" | "high";
  /** Which rule fired ("tool-error", "tool-error(text)", "streak>=N", "early-loop") */
  rule: string;
  /**
   * The provider-side model name as it appears in the outgoing payload.
   * Kept for diagnosis only: it is NOT the identity the allowlist matches (see `loopGate`),
   * and it must never be used to join a `loop` record with a `decision` / `cache` record.
   */
  wireModel?: string;
  /** The turn-start jev choice, for correlation with the decision record */
  turnChoice?: string;
  /** The turn-start REQUESTED level (before pi clamps) */
  turnRequestedLevel?: string;
}

export function buildCacheFirstRequestLogRecord(
  input: CacheLogCommon & Omit<CacheFirstRequestLogRecord, keyof CacheLogCommon | "v" | "event" | "scope">,
): CacheFirstRequestLogRecord {
  return { v: 1, event: "cache", scope: "first-request", ...input };
}

export function buildCacheTurnLogRecord(
  input: CacheLogCommon & Omit<CacheTurnLogRecord, keyof CacheLogCommon | "v" | "event" | "scope">,
): CacheTurnLogRecord {
  return { v: 1, event: "cache", scope: "turn", ...input };
}

/**
 * Idle time before this turn's first provider request (undefined when unknown or negative).
 * It is recorded to separate confounders of cache misses (TTL expiry, idleness).
 */
export function idleMsOf(pending: PendingTurn): number | undefined {
  if (pending.requestAt === undefined || pending.previousRequestAt === undefined) return undefined;
  const idle = pending.requestAt - pending.previousRequestAt;
  return idle >= 0 ? idle : undefined;
}

/** The shared part of a `cache` record (correlation with `decision` + confounders). Values are copied as is */
export function cacheCorrelationOf(pending: PendingTurn): Omit<CacheLogCommon, keyof LogContext> {
  return {
    choice: pending.choice,
    source: pending.source,
    previousLevel: pending.previousLevel,
    effectiveLevel: pending.effectiveLevel,
    levelChanged: pending.levelChanged,
    decidedAt: pending.decidedAt,
    latencyMs: pending.latencyMs,
    attempts: pending.attempts,
    ...(pending.error ? { error: pending.error } : {}),
    idleMs: idleMsOf(pending),
    modelChanged: isModelChanged(pending.previousModel, pending.model),
  };
}

/**
 * Whether a `message_end` message should be recorded as "the first request after a level change" (a pure function).
 *  - there is a pending turn (= a decision was made in the preceding `before_agent_start`)
 *  - the first request has not been recorded yet
 *  - it is an assistant message (user / toolResult are not counted)
 */
export function shouldCaptureFirstRequest(input: {
  hasPendingTurn: boolean;
  alreadyCaptured: boolean;
  role: string | undefined;
}): boolean {
  return input.hasPendingTurn && !input.alreadyCaptured && input.role === "assistant";
}

/**
 * Compaction observed in `session_compact` (**read only; never touches the context**).
 * It is put on the cache record so analysis can exclude "turns that cannot be compared with the previous one".
 */
export interface CompactionObservation {
  /** `manual` (the user's /compact) / `threshold` (automatic) / `overflow` (recovery from overflow) */
  reason: string;
}

/**
 * Expand the compaction observation into cache record fields (empty when unobserved = no extra key).
 *
 * Why it is needed: compaction rewrites the prompt prefix, so a smaller `cacheRead / previous turn's prompt`
 * is **not the fault of the level change**. Without this mark one could misread a level change as
 * "the cache broke".
 */
export function compactedFields(
  observation: CompactionObservation | undefined,
): Pick<CacheLogCommon, "compacted" | "compactionReason"> {
  return observation ? { compacted: true, compactionReason: observation.reason } : {};
}

/** Elapsed-time notation (`4.2s` / `420ms` / `65s`) */
export function formatIdle(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * The cache measurement notification (its value is only known after the request, so it is a separate line from the
 * level-change notification).
 *
 *   pi-jev-reasoning-router: cache read 18234 / prompt 18400 / hit 99.1% / write 0 (1st req after high -> low, idle 4.2s)
 */
export interface CacheNoticeInput {
  mode: NotifyMode;
  levelChanged: boolean;
  previousLevel: PiThinkingLevel;
  effectiveLevel: PiThinkingLevel;
  usage: CacheUsage;
  idleMs?: number;
  /** On a turn where compaction happened, add a note that the numbers are not comparable */
  compacted?: boolean;
}

/**
 * Whether to emit the cache notification (a pure function).
 *  - `JEV_ROUTER_NOTIFY=off` suppresses it (it follows the global notification switch)
 *  - it is emitted **only when the level actually changed** (emitting it every turn would fill the screen; the log keeps every case)
 */
export function shouldNotifyCache(input: { mode: NotifyMode; levelChanged: boolean }): boolean {
  return input.mode !== "off" && input.levelChanged;
}

export function formatCacheNotice(input: CacheNoticeInput): string {
  const prompt = promptTokens(input.usage);
  const ratio = cacheReadRatio(input.usage);
  const parts = [
    `read ${input.usage.cacheRead ?? "?"}`,
    prompt === undefined ? undefined : `prompt ${prompt}`,
    ratio === undefined ? undefined : `hit ${(ratio * 100).toFixed(1)}%`,
    `write ${input.usage.cacheWrite ?? "?"}`,
  ].filter((part): part is string => part !== undefined);
  const transition = `1st req after ${input.previousLevel} -> ${input.effectiveLevel}`;
  const idle = input.idleMs === undefined ? "" : `, idle ${formatIdle(input.idleMs)}`;
  const compacted = input.compacted ? ", compacted" : "";
  return `pi-jev-reasoning-router: cache ${parts.join(" / ")} (${transition}${idle}${compacted})`;
}

