/**
 * pi-jev-reasoning-router-lite: in-loop effort rules (optional, opt-in).
 *
 * When JEV_ROUTER_LOOP=1, these local heuristics run on EVERY provider request
 * inside a tool loop and override the turn's thinking level per request.
 * No jev calls, no network — the rules are pure functions of the outgoing payload.
 *
 * Rules (ordered, first hit wins):
 *   1. tool-error      the latest tool result looks like an error          -> high
 *   2. streak >= N     N+ consecutive successful tool results              -> low
 *   3. early-loop      request <= 2 and a fresh tool result arrived         -> high
 *   4. ambiguous       none of the above                                    -> keep the turn's level
 *
 * The rules read the WIRE messages (already provider-shaped) from the outgoing
 * payload, so they work on any OpenAI-completions route (DeepSeek, zai, ...).
 */

/** Environment variable that enables in-loop routing (unset/empty = off, the default) */
export const LOOP_ENV = "JEV_ROUTER_LOOP";
/** Streak length that triggers a downgrade to low (default 4) */
export const LOOP_STREAK_ENV = "JEV_ROUTER_LOOP_STREAK";

export interface LoopFacts {
  requestIndex: number;
  lastToolError: boolean;
  consecutiveOk: number;
  hasRecentToolResult: boolean;
  lastResultChars: number;
}

export type LoopDecision = { level: "low" | "high"; rule: string } | undefined;

/** Detect error-looking tool results (the wire shape lacks isError on some routes) */
function looksLikeError(text: string): boolean {
  return /error|failed|not found|exception|traceback|permission denied|enoent|enoent|cannot find|no such file|syntaxerror|typeerror|referenceerror/i.test(text.slice(0, 400));
}

/** Extract loop facts from provider-shaped messages (role: user/assistant/tool) */
export function extractLoopFacts(messages: readonly unknown[]): LoopFacts {
  let requestIndex = 0;
  let lastToolError = false;
  let consecutiveOk = 0;
  let lastResultChars = 0;
  let hasRecentToolResult = false;
  for (const raw of messages) {
    const m = raw as Record<string, unknown> | null;
    if (!m || typeof m !== "object") continue;
    if (m.role === "assistant") {
      requestIndex += 1;
    } else if (m.role === "tool") {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      const isErr = looksLikeError(text);
      lastResultChars = text.length;
      lastToolError = isErr;
      hasRecentToolResult = true;
      consecutiveOk = isErr ? 0 : consecutiveOk + 1;
    } else if (m.role === "user") {
      hasRecentToolResult = false;
    }
  }
  return { requestIndex, lastToolError, consecutiveOk, hasRecentToolResult, lastResultChars };
}

/**
 * The ordered rules. Returns undefined when no rule fires (keep the turn's level).
 * `streakThreshold` defaults to 4 (override with JEV_ROUTER_LOOP_STREAK).
 */
export function loopDecision(facts: LoopFacts, streakThreshold = 4): LoopDecision {
  if (facts.lastToolError) return { level: "high", rule: "tool-error" };
  if (facts.consecutiveOk >= streakThreshold) return { level: "low", rule: `streak>=${streakThreshold}` };
  if (facts.requestIndex <= 2 && facts.hasRecentToolResult && facts.lastResultChars > 0) {
    return { level: "high", rule: "early-loop" };
  }
  return undefined;
}

/** Whether in-loop routing is enabled (JEV_ROUTER_LOOP=1, "true" or "on") */
export function loopEnabled(raw: string | null | undefined = process.env[LOOP_ENV]): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

/** Resolve the streak threshold (default 4; 0 or invalid falls back to 4) */
export function loopStreakThreshold(raw: string | null | undefined = process.env[LOOP_STREAK_ENV]): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 2 && n <= 20 ? Math.floor(n) : 4;
}
