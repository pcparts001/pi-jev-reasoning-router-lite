/**
 * D_08_A8 router: calling jev (TypeSafe System One)
 *
 * Specification: design spec §6 (endpoint, auth, UA, model, timeout)
 *  - POST https://api.commandcode.ai/provider/v1/systemone (Command Code only. OpenRouter is forbidden)
 *  - Authorization: Bearer $COMMANDCODE_API_KEY / User-Agent: pi-jev-reasoning-router/1.0 (required to get past Cloudflare)
 *  - model: typesafe/jev / timeout 3 seconds / 1 retry / fail-safe on failure (high)
 *
 * The API key is only read from the environment; its value never appears in logs, artifacts, or exception messages.
 */

import {
  CRITERIA,
  DEFAULT_ANSWER_FORMAT,
  INSTRUCTIONS,
  QUESTION_NAME,
  QUESTION_TYPE,
  type EffortChoice,
} from "./criteria.ts";

export const JEV_ENDPOINT = "https://api.commandcode.ai/provider/v1/systemone";
export const JEV_MODEL = "typesafe/jev";
export const JEV_USER_AGENT = "pi-jev-reasoning-router/1.0";
export const JEV_API_KEY_ENV = "COMMANDCODE_API_KEY";

/** §6: the timeout is 3 seconds (exceeding it is a fail-safe) */
export const JEV_TIMEOUT_MS = 3000;
/** §3-2 (1): timeout/5xx/invalid response gets 1 retry -> at most 2 attempts */
export const JEV_MAX_ATTEMPTS = 2;
/** §9-8: the state is truncated at 6000 characters */
export const STATE_PROMPT_MAX_CHARS = 6000;
/** §3-3: the fail-safe on failure is high (bias toward quality) */
export const FAIL_SAFE_CHOICE: EffortChoice = "high";

export interface JevBody {
  model: string;
  state: string;
  questions: Record<string, unknown>;
}

export interface JevResult {
  /** The decision. On failure this is FAIL_SAFE_CHOICE. */
  choice: EffortChoice;
  /** Number of attempts made (1 = first try succeeded, 2 = succeeded after 1 retry) */
  attempts: number;
  /** Total elapsed time in milliseconds (including retries) */
  latencyMs: number;
  /** Whether it fell back to the fail-safe */
  failed: boolean;
  /** Summary of the failure reason (never contains the API key) */
  error?: string;
}

/**
 * Build the state body of §3-1.
 *
 * A coding assistant will answer the task below. It may or may not use internal reasoning.
 * Required answer format: not specified; answer as the task requires.
 *
 * Task:
 * <prompt[:6000]>
 *
 * The family name, difficulty, and correct answer are never included (to prevent oracle leakage, §3-1).
 */
export function buildState(prompt: string, answerFormat: string = DEFAULT_ANSWER_FORMAT): string {
  return [
    "A coding assistant will answer the task below. It may or may not use internal reasoning.",
    `Required answer format: ${answerFormat}.`,
    "",
    "Task:",
    prompt.slice(0, STATE_PROMPT_MAX_CHARS),
  ].join("\n");
}

/** The request body of §3-1 (the key order is §3-1's as well) */
export function buildJevBody(prompt: string, answerFormat: string = DEFAULT_ANSWER_FORMAT): JevBody {
  return {
    model: JEV_MODEL,
    state: buildState(prompt, answerFormat),
    questions: {
      [QUESTION_NAME]: {
        type: QUESTION_TYPE,
        instructions: INSTRUCTIONS,
        criteria: CRITERIA,
      },
    },
  };
}

/**
 * Extract the choice from the response format of §6.
 * A missing or unknown value yields `undefined` (the caller falls back to the fail-safe, §3-3).
 */
export function parseJevChoice(payload: unknown): EffortChoice | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const answers = (payload as { answers?: unknown }).answers;
  if (typeof answers !== "object" || answers === null) return undefined;
  const answer = (answers as Record<string, unknown>)[QUESTION_NAME];
  if (typeof answer !== "object" || answer === null) return undefined;
  const choice = (answer as { choice?: unknown }).choice;
  return choice === "none" || choice === "low" || choice === "high" ? choice : undefined;
}

function errorSummary(error: unknown): string {
  if (error instanceof Error) {
    // For AbortSignal.timeout, name === "TimeoutError"
    return error.name && error.name !== "Error" ? `${error.name}: ${error.message}` : error.message;
  }
  return String(error);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ask jev for one decision (timeout 3s, 1 retry, fail-safe high).
 *
 * @param prompt  The user's prompt (embedded into the state, truncated at 6000 characters)
 * @param signal  The caller's abort signal (used to cancel when the session ends)
 * @returns       choice / attempts / latencyMs / failed (never throws)
 */
export async function askJev(prompt: string, signal?: AbortSignal): Promise<JevResult> {
  const startedAt = Date.now();
  const apiKey = process.env[JEV_API_KEY_ENV];
  let attempts = 0;
  let lastError = "unknown error";
  let lastStatus: number | undefined;

  if (!apiKey) {
    return {
      choice: FAIL_SAFE_CHOICE,
      attempts: 0,
      latencyMs: Date.now() - startedAt,
      failed: true,
      error: `${JEV_API_KEY_ENV} is not set`,
    };
  }

  for (let attempt = 1; attempt <= JEV_MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) {
      lastError = "aborted";
      break;
    }
    attempts = attempt;
    try {
      // §3-2: each attempt gets a 3 second timeout (combined with the caller's signal)
      const timeoutSignal = AbortSignal.timeout(JEV_TIMEOUT_MS);
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const response = await fetch(JEV_ENDPOINT, {
        method: "POST",
        headers: {
          // The value itself is never logged
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          // §6: the UA is required (Cloudflare blocks default UAs such as python-urllib)
          "User-Agent": JEV_USER_AGENT,
        },
        body: JSON.stringify(buildJevBody(prompt)),
        signal: requestSignal,
      });
      lastStatus = response.status;
      if (!response.ok) throw new Error(`jev HTTP ${response.status}`);
      const payload: unknown = await response.json();
      const choice = parseJevChoice(payload);
      if (!choice) throw new Error("jev response did not contain a valid choice");
      return { choice, attempts, latencyMs: Date.now() - startedAt, failed: false };
    } catch (error) {
      lastError = errorSummary(error);
      // Wait a little before retrying (there is only one retry)
      if (attempt < JEV_MAX_ATTEMPTS) await sleep(100);
    }
  }

  return {
    choice: FAIL_SAFE_CHOICE,
    attempts,
    latencyMs: Date.now() - startedAt,
    failed: true,
    error: lastStatus === undefined ? lastError : `${lastError} (last status ${lastStatus})`,
  };
}
