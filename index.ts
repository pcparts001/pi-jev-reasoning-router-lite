/**
 * D_08_A8 router (pi agent extension entry point)
 *
 * Behavior (design spec §3-2 / §3-3 / §4-4):
 *   before_agent_start (receives event.prompt)
 *     -> call jev (3s timeout, 1 retry)
 *          +- success: choice in {none, low, high}
 *          +- failure: fail-safe = high
 *     -> decide the level: none -> NONE_POLICY (default low) | low -> low | high -> high
 *     -> pi.setThinkingLevel(level)
 *     -> pi.appendEntry("pi-jev-reasoning-router", { choice, level, at, latencyMs, ... })
 *     -> when low is applied, one dim line is shown in the UI (JEV_ROUTER_NOTIFY, default "low")
 *
 *   message_end (after an assistant response) / agent_end (end of turn)
 *     -> record input cache (prompt cache) measurements in the log (`event: "cache"`)
 *        - cache values only exist **after** the request, so they are separate records from the pre-send decision
 *        - **read-only**: only reads usage, never rewrites messages, the system prompt, or the payload
 *        - (session_compact is read too: a turn where compaction happened gets `compacted: true`, which marks
 *           that it cannot be compared with the previous turn)
 *
 * Model gate: when ctx.model does not match the allowlist (the `provider/id` list in the `JEV_ROUTER_MODELS`
 * environment variable), nothing happens (jev is not called and the level is not changed). The allowlist has no
 * built-in default: when it is unset the list is empty, so no model is routed.
 *
 * §4-1: the factory only registers handlers here; it starts no sockets/timers (and no fetch). It holds no
 *       long-lived resources; it only tracks in-flight fetches inside a session and aborts them idempotently
 *       on session_shutdown.
 * §4-1: UI-dependent code is guarded by ctx.hasUI.
 *
 * Diagnostics (**verification only**; nothing happens during normal use):
 *   JEV_ROUTER_DUMP=<path>         ... write the outgoing payload to that path as JSON in before_provider_request (T2)
 *   JEV_ROUTER_FORCE=off|low|high  ... force that level without calling jev (T2's three-level check)
 *   JEV_ROUTER_NOTIFY=low|downgrade|change|off ... how level-change messages are emitted (default low = on every low decision)
 *   JEV_ROUTER_PROVIDER=typesafe|commandcode|auto ... which jev route answers (default typesafe = TypeSafe's own
 *                                    API; auto = typesafe when TYPESAFE_API_KEY is set, otherwise commandcode).
 *                                    The choice is recorded as jevProvider in the entry and the run log
 *   JEV_ROUTER_LOG=<path|off>      ... destination of the run log (JSONL). Default ~/.pi/agent/jev-router/runs.jsonl
 *                                    event: decision / skip / cache (input cache measurements; read-only)
 *                                    the prompt body is never written (length only). off/empty string disables it
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askJev, FAIL_SAFE_CHOICE, JEV_PROVIDER_ENV, resolveJevProvider } from "./jev.ts";
import type { JevProviderId, JevProviderSource } from "./jev.ts";
import { appendLogRecord, resolveLogPath } from "./logger.ts";
import {
  ALLOWED_MODELS_ENV,
  buildCacheFirstRequestLogRecord,
  buildCacheTurnLogRecord,
  buildDecisionLogRecord,
  buildSkipLogRecord,
  cacheCorrelationOf,
  choiceToLevel,
  compactedFields,
  formatCacheNotice,
  formatLevelNotice,
  isLevelChanged,
  readCacheUsage,
  readPayloadModel,
  shouldCaptureFirstRequest,
  shouldNotifyCache,
  sumCacheUsage,
  levelToChoice,
  NONE_POLICY,
  NOTIFY_ENV,
  LOG_ENV,
  parseForcedLevel,
  parseNotifyMode,
  resolveAllowedModels,
  routeDecision,
  shouldNotifyLevel,
  type CacheUsage,
  type CompactionObservation,
  type DecisionSource,
  type LevelNoticeInput,
  type LogContext,
  type PendingTurn,
  type PiThinkingLevel,
} from "./router.ts";
import type { EffortChoice } from "./criteria.ts";
import {
  extractLoopFacts,
  loopDecision,
  loopEnabled,
  loopStreakThreshold,
} from "./loop-rules.ts";

/** appendEntry customType (never enters the model context, §3-3) */
export const ENTRY_TYPE = "pi-jev-reasoning-router";
export const DUMP_ENV = "JEV_ROUTER_DUMP";
export const FORCE_ENV = "JEV_ROUTER_FORCE";

interface Decision {
  /** The 4 fields required by §3 */
  choice: EffortChoice;
  level: PiThinkingLevel;
  at: number;
  latencyMs: number;
  /** Extra fields (for auditing; documented in README) */
  source: DecisionSource;
  attempts: number;
  nonePolicy: typeof NONE_POLICY;
  /** Which jev route answered (typesafe = native API / commandcode = proxy) */
  jevProvider: JevProviderId;
  /** How that route was chosen (default / explicit JEV_ROUTER_PROVIDER / auto key detection) */
  jevProviderSource: JevProviderSource;
  /** Set when JEV_ROUTER_PROVIDER had an unrecognized value (the default was used instead) */
  jevProviderWarning?: string;
  error?: string;
}

/** Log context for one prompt (sessionId / sessionFile are used to join with the session) */
function logContext(ctx: ExtensionContext, prompt: string, model: string | undefined): LogContext {
  const base: LogContext = { ts: new Date().toISOString(), promptChars: prompt.length };
  try {
    base.sessionId = ctx.sessionManager.getSessionId();
    const file = ctx.sessionManager.getSessionFile();
    if (file) base.sessionFile = file;
    base.cwd = ctx.cwd;
  } catch {
    // Keep the log even in an environment that cannot expose session info (e.g. a test stub)
    base.cwd = ctx.cwd;
  }
  if (model) {
    // Only the first / separates provider from id (models whose id contains / are supported)
    const splitAt = model.indexOf("/");
    base.model = model;
    base.provider = model.slice(0, splitAt);
    base.id = model.slice(splitAt + 1);
  }
  return base;
}

/**
 * Context recorded after a response.
 * `sessionId` / `sessionFile` / `model` etc. are reused from decision time, and only `ts` becomes the record time
 * (correlation is taken via `decidedAt`). **No conversation content is added** (`promptChars` is the user prompt
 * length only).
 */
function observedContext(base: LogContext): LogContext {
  return { ...base, ts: new Date().toISOString() };
}

/** Count assistant messages after the LAST user message (per-turn request index) */
function countRequestsSinceLastUser(messages: readonly unknown[]): number {
  let count = 0;
  let seenLastUser = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: string } | null;
    if (!m || typeof m !== "object") continue;
    if (m.role === "user") { seenLastUser = true; break; }
    if (m.role === "assistant") count += 1;
  }
  return count;
}

/** Minimal shape of the messages observed in `message_end` / `agent_end` (usage is only read) */
interface MessageLike {
  role?: string;
  usage?: unknown;
}

/** Walk an array safely (in case agent_end's messages is not an array) */
function asMessageList(messages: unknown): MessageLike[] {
  return Array.isArray(messages) ? (messages as MessageLike[]) : [];
}

export default function jevReasoningRouter(pi: ExtensionAPI) {
  // §4-1: only register handlers here (start no socket / timer / fetch)
  const inFlight = new Set<AbortController>();
  let lastDecision: Decision | undefined;
  let released = false;

  // --- Volatile state for input cache measurement (read-only; cannot affect the context) ---
  /** Correlation info of the last decision (read by `message_end` / `agent_end`) */
  let pendingTurn: PendingTurn | undefined;
  /** Timestamp of the previous provider request (used to compute idleMs) */
  let lastRequestAt: number | undefined;
  /** Model of the previous provider request (used to compute modelChanged) */
  let lastRequestModel: string | undefined;
  /** Compaction observed between the previous turn and this one (**read-only**; marks the cache record) */
  let compactionObserved: CompactionObservation | undefined;
  /** In-loop routing: request counter within the session (reset at session_start) */
  let turnFirstRequestPending = false;

  pi.on("session_start", () => {
    released = false;
    pendingTurn = undefined;
    lastRequestAt = undefined;
    lastRequestModel = undefined;
    compactionObserved = undefined;
    turnFirstRequestPending = false;
  });

  // Observation of compaction (read-only). It never touches the context (it only marks the log).
  pi.on("session_compact", (event) => {
    const reason = (event as { reason?: unknown })?.reason;
    compactionObserved = { reason: typeof reason === "string" ? reason : "unknown" };
  });

  // §4-1: release idempotently when the session ends
  pi.on("session_shutdown", () => {
    if (released) return;
    released = true;
    for (const controller of inFlight) controller.abort(new Error("session_shutdown"));
    inFlight.clear();
    lastDecision = undefined;
    pendingTurn = undefined;
    compactionObserved = undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Model gate: for a model that does not match the allowlist (`JEV_ROUTER_MODELS`)
    // jev is not called and the thinking level is not changed (so neither billing nor latency happens).
    // When the variable is unset the allowlist is empty, so every model stops here.
    const route = routeDecision(ctx.model);
    if (!route.routed) {
      // A non-routed model's turn is excluded from cache measurement (do not carry over correlation info)
      pendingTurn = undefined;
      pi.appendEntry(ENTRY_TYPE, {
        skipped: route.reason,
        model: route.model ?? null,
        allowed: route.allowed,
        at: Date.now(),
      });
      // Run log (so that "how often it did not run" can be analyzed later too)
      appendLogRecord(
        buildSkipLogRecord({
          ...logContext(ctx, event.prompt, route.model),
          reason: route.reason,
          allowed: route.allowed,
        }),
      );
      return;
    }

    const previousLevel = pi.getThinkingLevel();
    const decision = await decide(event.prompt, ctx.signal, inFlight);
    lastDecision = decision;
    pi.setThinkingLevel(decision.level);
    // pi clamps according to model capabilities, so record the value that was actually adopted too
    const effectiveLevel = pi.getThinkingLevel();
    const context = logContext(ctx, event.prompt, route.model);
    // Prepare the correlation info for input cache measurement (**nothing sent yet**; written after the response)
    pendingTurn = {
      log: context,
      decidedAt: context.ts,
      decidedAtMs: decision.at,
      choice: decision.choice,
      source: decision.source,
      previousLevel,
      effectiveLevel,
      levelChanged: isLevelChanged(previousLevel, effectiveLevel),
      latencyMs: decision.latencyMs,
      attempts: decision.attempts,
      ...(decision.error ? { error: decision.error } : {}),
      previousRequestAt: lastRequestAt,
      firstRequestCaptured: false,
    };
    // ④ mark that the next provider request is the turn's first (local rules skip it)
    turnFirstRequestPending = true;

    // §3-3: the decision is recorded with appendEntry instead of entering the model context
    pi.appendEntry(ENTRY_TYPE, {
      choice: decision.choice,
      level: decision.level,
      at: decision.at,
      latencyMs: decision.latencyMs,
      source: decision.source,
      attempts: decision.attempts,
      nonePolicy: decision.nonePolicy,
      jevProvider: decision.jevProvider,
      jevProviderSource: decision.jevProviderSource,
      model: route.model,
      previousLevel,
      requestedLevel: decision.level,
      effectiveLevel,
      ...(decision.jevProviderWarning ? { jevProviderWarning: decision.jevProviderWarning } : {}),
      ...(decision.error ? { error: decision.error } : {}),
    });

    // Level-change notification (like RTK, ctx.ui.notify(..., "info") = one dim line in the UI)
    const notice: LevelNoticeInput = {
      mode: parseNotifyMode(),
      source: decision.source,
      previousLevel,
      level: effectiveLevel,
      choice: decision.choice,
      latencyMs: decision.latencyMs,
    };
    if (ctx.hasUI && shouldNotifyLevel(notice)) ctx.ui.notify(formatLevelNotice(notice), "info");

    // Run log (the record that this router actually applied a level, for later analysis of the effect)
    appendLogRecord(
      buildDecisionLogRecord({
        ...context,
        choice: decision.choice,
        requestedLevel: decision.level,
        effectiveLevel,
        previousLevel,
        source: decision.source,
        attempts: decision.attempts,
        latencyMs: decision.latencyMs,
        notifyMode: notice.mode,
        notified: ctx.hasUI && shouldNotifyLevel(notice),
        jevProvider: decision.jevProvider,
        jevProviderSource: decision.jevProviderSource,
        ...(decision.jevProviderWarning ? { jevProviderWarning: decision.jevProviderWarning } : {}),
        ...(decision.error ? { error: decision.error } : {}),
      }),
    );

    if (ctx.hasUI && decision.source === "fail-safe") {
      ctx.ui.notify(
        `pi-jev-reasoning-router: jev (${decision.jevProvider}) decision failed -> fail-safe ${effectiveLevel}`,
        "warning",
      );
    }
  });

  // In-loop routing (opt-in, JEV_ROUTER_LOOP=1): local heuristics override the
  // turn's thinking level on each request inside a tool loop. No jev calls.
  // The payload IS rewritten here (reasoning_effort only) — this is the one place
  // the original "never rewrite" contract is consciously broken, and only when the
  // user opts in. The reasoning_effort parameter is NOT part of the DeepSeek prefix
  // cache key (measured), so this does not affect cache hit rates on that route.
  // On zai (glm-5.3) each effort change costs one full cache-miss request.
  pi.on("before_provider_request", (event, ctx) => {
    const now = Date.now();
    const payloadModel = readPayloadModel(event.payload);
    if (pendingTurn && pendingTurn.requestAt === undefined) {
      // The first request of this turn. The baseline for idleMs is the timestamp of the request before it
      pendingTurn.requestAt = now;
      pendingTurn.previousModel = lastRequestModel;
      pendingTurn.model = payloadModel;
    }
    lastRequestAt = now;
    if (payloadModel) lastRequestModel = payloadModel;

    // --- in-loop routing (the only payload-rewriting path, opt-in via JEV_ROUTER_LOOP=1) ---
    // Fixes applied (code review 2026-09-27):
    //   ① buildLoopLogRecord removed — appendLogRecord is called with a plain object
    //   ② model gate: only routes when the payload model matches the allowlist
    //   ③ requestIndex counts from the LAST user message (per-turn, not session-wide)
    //   ④ consecutiveOk resets at user messages; the FIRST request of a turn keeps the
    //      turn-start jev decision (local rules only fire from the second request on)
    //   ⑨ loop log records carry sessionId / cwd / model
    if (loopEnabled() && pendingTurn && payloadModel && pendingTurn.model && payloadModel === pendingTurn.model) {
      const payload = event.payload as Record<string, unknown> | null;
      if (payload && typeof payload === "object" && Array.isArray(payload.messages)) {
        const currentTurnRequestIndex = countRequestsSinceLastUser(payload.messages);
        const firstOfTurn = turnFirstRequestPending;
        turnFirstRequestPending = false; // consume the flag
        if (!firstOfTurn) {
          const facts = extractLoopFacts(payload.messages);
          facts.requestIndex = currentTurnRequestIndex; // per-turn index (③)
          const streak = loopStreakThreshold();
          const decision = loopDecision(facts, streak);
          if (decision) {
            const next = { ...payload, reasoning_effort: decision.level };
            // ⑨ proper log context from the actual handler ctx
            const loopCtx: Record<string, unknown> = {
              v: 1,
              event: "loop",
              ts: new Date().toISOString(),
              n: currentTurnRequestIndex,
              level: decision.level,
              rule: decision.rule,
              model: payloadModel,
              ...(ctx?.cwd ? { cwd: ctx.cwd } : {}),
            };
            try { loopCtx.sessionId = ctx?.sessionManager?.getSessionId?.(); } catch { /* tests */ }
            appendLogRecord(loopCtx as never);
            return next;
          }
        }
      }
    }

    // The following is diagnostics only (T2): nothing happens while JEV_ROUTER_DUMP is unset.
    const dumpPath = process.env[DUMP_ENV];
    if (!dumpPath) return;
    try {
      const record = {
        router: {
          at: Date.now(),
          thinkingLevel: pi.getThinkingLevel(),
          dumpEnv: DUMP_ENV,
          forceEnv: process.env[FORCE_ENV] ?? null,
          lastDecision: lastDecision ?? null,
        },
        // event.payload is the real object (the request body pi sends)
        payload: event.payload,
      };
      mkdirSync(dirname(dumpPath), { recursive: true });
      writeFileSync(dumpPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    } catch {
      // Diagnostics only. A failed write never stops the request
    }
    return undefined;
  });

  // Measurement of the input cache (the first request right after a level change). The value only exists
  // **after** the response, so it is recorded here.
  // §4-1 read-only: only reads `usage` and never replaces a message (the return value is always undefined).
  pi.on("message_end", (event, ctx) => {
    const pending = pendingTurn;
    const message = event.message as MessageLike | undefined;
    if (
      !shouldCaptureFirstRequest({
        hasPendingTurn: pending !== undefined,
        alreadyCaptured: pending?.firstRequestCaptured ?? true,
        role: message?.role,
      })
    ) {
      return;
    }
    const usage = readCacheUsage(message?.usage);
    // No usage (abort / provider does not report usage) -> do not record it; the turn summary will note it was unmeasurable
    if (!usage) return;
    pending!.firstRequestCaptured = true;

    const record = buildCacheFirstRequestLogRecord({
      ...observedContext(pending!.log),
      ...cacheCorrelationOf(pending!),
      ...compactedFields(compactionObserved),
      requestIndex: 1,
      sinceDecisionMs: Math.max(0, Date.now() - pending!.decidedAtMs),
      usage,
    });
    appendLogRecord(record);

    // One line in the UI as well (separate from the pre-send level-change notice; only on a level change,
    // and not emitted when `JEV_ROUTER_NOTIFY=off`)
    const mode = parseNotifyMode();
    if (ctx.hasUI && shouldNotifyCache({ mode, levelChanged: pending!.levelChanged })) {
      ctx.ui.notify(
        formatCacheNotice({
          mode,
          levelChanged: pending!.levelChanged,
          previousLevel: pending!.previousLevel,
          effectiveLevel: pending!.effectiveLevel,
          usage,
          idleMs: cacheCorrelationOf(pending!).idleMs,
          compacted: compactionObserved !== undefined,
        }),
        "info",
      );
    }
    return undefined;
  });

  // Turn summary of the input cache (`agent_end`). It sums the usage within the turn, records it, and releases
  // the correlation info.
  // §4-1 read-only: it adds neither entries nor messages (the return value is undefined).
  pi.on("agent_end", (event) => {
    const pending = pendingTurn;
    // Do not carry over to the next decision (clear first; later message_end calls do nothing)
    pendingTurn = undefined;
    if (!pending) return;

    const usages: CacheUsage[] = [];
    let requestsInTurn = 0;
    let lastUsage: CacheUsage | undefined;
    for (const message of asMessageList(event.messages)) {
      if (message.role !== "assistant") continue;
      requestsInTurn += 1;
      const usage = readCacheUsage(message.usage);
      if (usage) {
        usages.push(usage);
        lastUsage = usage; // usage of the last assistant response (the comparison baseline for analysis)
      }
    }
    const turnUsage = sumCacheUsage(usages);
    const compacted = compactedFields(compactionObserved);
    compactionObserved = undefined; // do not carry over to the next turn (the mark is per turn)
    appendLogRecord(
      buildCacheTurnLogRecord({
        ...observedContext(pending.log),
        ...cacheCorrelationOf(pending),
        ...compacted,
        firstRequest: pending.firstRequestCaptured ? "recorded" : "missing",
        ...(pending.firstRequestCaptured ? {} : { firstRequestMissingReason: "no-usage" as const }),
        requestsInTurn,
        ...(turnUsage ? { usage: turnUsage } : {}),
        ...(lastUsage ? { lastUsage } : {}),
      }),
    );
    return undefined;
  });

  pi.registerCommand("jev-router", {
    description:
      "pi-jev-reasoning-router status (current model, allowlist, last decision, NONE_POLICY, diagnostics switches)",
    handler: async (_args, ctx) => {
      const config = resolveAllowedModels();
      const route = routeDecision(ctx.model, config);
      const jev = resolveJevProvider();
      const keyPresent = process.env[jev.provider.apiKeyEnv] ? "set" : "MISSING";
      const lines = [
        `model: ${route.model ?? "(unknown)"} -> routed: ${route.routed ? "yes" : `no (${route.reason})`}`,
        `allowedModels: ${config.allowed.length ? config.allowed.join(", ") : "(empty = stopped for every model)"} (${ALLOWED_MODELS_ENV}: ${config.source}${config.ignored.length ? ` / ignored: ${config.ignored.join(", ")}` : ""})`,
        `jev provider: ${jev.provider.id} (${jev.provider.label}) [${jev.source}${jev.warning ? ` / ${jev.warning}` : ""}] (${JEV_PROVIDER_ENV}=${process.env[JEV_PROVIDER_ENV] ?? "unset"}. typesafe | commandcode | auto)`,
        `jev route: ${jev.provider.endpoint} / model ${jev.provider.model} / key ${jev.provider.apiKeyEnv}=${keyPresent} (the value is never logged)`,
        `NONE_POLICY: ${NONE_POLICY} ("low" = §3-3 N1 / "off" = N2)`,
        `notify: ${parseNotifyMode()} (${NOTIFY_ENV}=${process.env[NOTIFY_ENV] ?? "unset"}. low=every low decision / downgrade / change / off)`,
        `thinkingLevel: ${pi.getThinkingLevel()}`,
        `lastDecision: ${lastDecision ? JSON.stringify(lastDecision) : "(no decision yet)"}`,
        `diagnostics: ${DUMP_ENV}=${process.env[DUMP_ENV] ? "set" : "unset"} / ${FORCE_ENV}=${
          process.env[FORCE_ENV] ?? "unset"
        }`,
        `log: ${resolveLogPath() ?? "(disabled)"} (${LOG_ENV}=${process.env[LOG_ENV] ?? "unset"}. off/empty disables. event: decision/skip/cache)`,
        `cache: records = first request after a level change (message_end/sinceDecisionMs) + turn summary (agent_end/requestsInTurn). notifications only on a level change (none when ${NOTIFY_ENV}=off)`,
        `pendingTurn: ${pendingTurn ? JSON.stringify({ ...pendingTurn, log: "..." }) : "(none)"}`,
        `lastRequestAt: ${lastRequestAt ? new Date(lastRequestAt).toISOString() : "(none)"} / lastRequestModel: ${lastRequestModel ?? "(none)"}`,
        `level mapping: none -> ${choiceToLevel("none")} / low -> ${choiceToLevel("low")} / high -> ${choiceToLevel("high")} (choice -> pi thinking level)`,
        "wire payload: this extension never builds a payload (pi itself sends the request).",
        "  Whether thinking / reasoning_effort is actually sent depends on the target model in models.json (compat.supportsReasoningEffort / thinkingLevelMap).",
        "  Dump the outgoing payload with JEV_ROUTER_DUMP=<path> to confirm.",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

/** One decision for one prompt. It never lets an exception escape (it always returns the fail-safe). */
async function decide(
  prompt: string,
  sessionSignal: AbortSignal | undefined,
  inFlight: Set<AbortController>,
): Promise<Decision> {
  // Which jev route this run uses (metadata for the audit entry / log; the call itself re-resolves it)
  const resolved = resolveJevProvider();
  const providerFields = {
    jevProvider: resolved.provider.id,
    jevProviderSource: resolved.source,
    ...(resolved.warning ? { jevProviderWarning: resolved.warning } : {}),
  };
  const forcedLevel = parseForcedLevel(process.env[FORCE_ENV]);
  if (forcedLevel) {
    return {
      choice: levelToChoice(forcedLevel) ?? "high",
      level: forcedLevel,
      at: Date.now(),
      latencyMs: 0,
      source: "forced",
      attempts: 0,
      nonePolicy: NONE_POLICY,
      ...providerFields,
    };
  }

  const controller = new AbortController();
  const signal = sessionSignal ? AbortSignal.any([controller.signal, sessionSignal]) : controller.signal;
  inFlight.add(controller); // aborted on session_shutdown (§4-1)
  try {
    const result = await askJev(prompt, signal);
    return {
      choice: result.choice,
      level: choiceToLevel(result.choice),
      at: Date.now(),
      latencyMs: result.latencyMs,
      source: result.failed ? "fail-safe" : "jev",
      attempts: result.attempts,
      nonePolicy: NONE_POLICY,
      jevProvider: result.provider,
      jevProviderSource: resolved.source,
      ...(resolved.warning ? { jevProviderWarning: resolved.warning } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (error) {
    // askJev is designed not to throw, but guarantee the fail-safe even for the unexpected
    return {
      choice: FAIL_SAFE_CHOICE,
      level: choiceToLevel(FAIL_SAFE_CHOICE),
      at: Date.now(),
      latencyMs: 0,
      source: "fail-safe",
      attempts: 0,
      nonePolicy: NONE_POLICY,
      ...providerFields,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    inFlight.delete(controller);
  }
}
