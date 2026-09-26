/**
 * D_08_A8 router: calling jev (TypeSafe System One)
 *
 * Specification: design spec §6 (endpoint, auth, UA, model, timeout)
 *  - default provider: the native TypeSafe endpoint
 *      POST https://api.typesafe.ai/v1/systemone
 *      Authorization: Bearer $TYPESAFE_API_KEY / model: jev-latest (resolves to jev-1.13.0)
 *  - optional provider: the Command Code proxy (unchanged from the original release)
 *      POST https://api.commandcode.ai/provider/v1/systemone (Command Code only. OpenRouter is forbidden)
 *      Authorization: Bearer $COMMANDCODE_API_KEY / User-Agent: pi-jev-reasoning-router/1.0
 *      (the UA is required to get past Cloudflare) / model: typesafe/jev
 *  - the provider is chosen with `JEV_ROUTER_PROVIDER` = typesafe (default) | commandcode | auto
 *  - both providers return the same response shape (`answers["effort"].choice`), because the native API is
 *    what the proxy forwards; only the endpoint / model name / key variable names differ.
 *  - timeout 3 seconds / 1 retry / fail-safe on failure (high)
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

export const JEV_USER_AGENT = "pi-jev-reasoning-router/1.0";

// ============================================================================
// Providers (the same question, two routes to jev)
// ============================================================================

export type JevProviderId = "typesafe" | "commandcode";

export interface JevProvider {
  id: JevProviderId;
  /** Name used in logs, notifications and `/jev-router` */
  label: string;
  endpoint: string;
  /** The model name **as that endpoint expects it** (the two providers differ here) */
  model: string;
  /** Environment variable holding the API key for this provider */
  apiKeyEnv: string;
  /** User-Agent to send when the endpoint requires one (the proxy's Cloudflare blocks default UAs, §6) */
  userAgent?: string;
}

export const JEV_PROVIDERS: Readonly<Record<JevProviderId, JevProvider>> = {
  /** TypeSafe's own API (§6 replaced by the native route; the model is `jev-latest` = `jev-1.13.0`) */
  typesafe: {
    id: "typesafe",
    label: "TypeSafe (native)",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    apiKeyEnv: "TYPESAFE_API_KEY",
  },
  /** The Command Code proxy (the original route; `typesafe/jev` is a provider-scoped model name) */
  commandcode: {
    id: "commandcode",
    label: "Command Code (proxy)",
    endpoint: "https://api.commandcode.ai/provider/v1/systemone",
    model: "typesafe/jev",
    apiKeyEnv: "COMMANDCODE_API_KEY",
    userAgent: JEV_USER_AGENT,
  },
};

/** Selector environment variable: `typesafe` (default) | `commandcode` | `auto` */
export const JEV_PROVIDER_ENV = "JEV_ROUTER_PROVIDER";
/** §6: the native TypeSafe endpoint is the default route */
export const DEFAULT_JEV_PROVIDER_ID: JevProviderId = "typesafe";
/** `auto` = prefer TypeSafe when `TYPESAFE_API_KEY` is set, otherwise fall back to Command Code */
export const JEV_PROVIDER_AUTO = "auto";

/**
 * Compatibility aliases: the endpoint / model / key variable of the **default provider**.
 * They are kept so that existing references keep working; new code should read `JEV_PROVIDERS`.
 */
export const JEV_ENDPOINT = JEV_PROVIDERS[DEFAULT_JEV_PROVIDER_ID].endpoint;
export const JEV_MODEL = JEV_PROVIDERS[DEFAULT_JEV_PROVIDER_ID].model;
export const JEV_API_KEY_ENV = JEV_PROVIDERS[DEFAULT_JEV_PROVIDER_ID].apiKeyEnv;

/** The subset of the environment this module reads (a plain object is accepted so tests can stub it) */
export type JevEnvLike = Record<string, string | undefined>;

export type JevProviderSource = "default" | "env" | "auto";

export interface ResolvedJevProvider {
  provider: JevProvider;
  /** `env` = explicit selector / `auto` = key detection / `default` = unset or unrecognized */
  source: JevProviderSource;
  /** Set only when `JEV_ROUTER_PROVIDER` had an unrecognized value (a note for the log, never fatal) */
  warning?: string;
}

/**
 * Resolve which provider answers the jev question.
 *  - unset / empty            -> the default (`typesafe`)
 *  - `typesafe` / `commandcode` -> that provider (source `env`)
 *  - `auto`                   -> TypeSafe when `TYPESAFE_API_KEY` is set, otherwise Command Code (source `auto`)
 *  - anything else            -> the default, with a warning (a typo must not stop the routing)
 *
 * It never throws and never reads the key value (only whether it is present).
 */
export function resolveJevProvider(env: JevEnvLike = process.env): ResolvedJevProvider {
  const raw = (env[JEV_PROVIDER_ENV] ?? "").trim().toLowerCase();
  if (!raw) return { provider: JEV_PROVIDERS[DEFAULT_JEV_PROVIDER_ID], source: "default" };
  if (raw === JEV_PROVIDER_AUTO) {
    // auto: the native route wins when its key is available; otherwise the proxy keeps working
    const id: JevProviderId = env[JEV_PROVIDERS.typesafe.apiKeyEnv] ? "typesafe" : "commandcode";
    return { provider: JEV_PROVIDERS[id], source: "auto" };
  }
  if (raw === "typesafe" || raw === "commandcode") return { provider: JEV_PROVIDERS[raw], source: "env" };
  return {
    provider: JEV_PROVIDERS[DEFAULT_JEV_PROVIDER_ID],
    source: "default",
    warning: `unknown ${JEV_PROVIDER_ENV}="${raw}" -> using ${DEFAULT_JEV_PROVIDER_ID}`,
  };
}

// ============================================================================
// §6: timeout / retry / fail-safe
// ============================================================================

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
  /** Which provider was asked (on a failure too: the provider that was tried) */
  provider: JevProviderId;
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
export function buildJevBody(
  prompt: string,
  answerFormat: string = DEFAULT_ANSWER_FORMAT,
  model: string = JEV_MODEL,
): JevBody {
  return {
    model,
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
 *
 * Both providers answer with the same shape (`{"answers":{"effort":{"choice":"low",...}}}`), so this single
 * parser serves both routes.
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

/** Build the request headers for one provider (the key value is never logged) */
function buildHeaders(provider: JevProvider, apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    // §6: the proxy's UA is required (Cloudflare blocks default UAs such as python-urllib).
    // The native TypeSafe endpoint does not need one, so none is sent there.
    ...(provider.userAgent ? { "User-Agent": provider.userAgent } : {}),
  };
}

/**
 * Ask jev for one decision (timeout 3s, 1 retry, fail-safe high).
 *
 * @param prompt  The user's prompt (embedded into the state, truncated at 6000 characters)
 * @param signal  The caller's abort signal (used to cancel when the session ends)
 * @param env     Environment to read (`JEV_ROUTER_PROVIDER` + the provider's key variable); defaults to process.env
 * @returns       choice / attempts / latencyMs / failed / provider (never throws)
 */
export async function askJev(
  prompt: string,
  signal?: AbortSignal,
  env: JevEnvLike = process.env,
): Promise<JevResult> {
  const startedAt = Date.now();
  const { provider } = resolveJevProvider(env);
  const apiKey = env[provider.apiKeyEnv];
  let attempts = 0;
  let lastError = "unknown error";
  let lastStatus: number | undefined;

  if (!apiKey) {
    return {
      choice: FAIL_SAFE_CHOICE,
      attempts: 0,
      latencyMs: Date.now() - startedAt,
      failed: true,
      provider: provider.id,
      error: `${provider.apiKeyEnv} is not set (provider: ${provider.id})`,
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
      const response = await fetch(provider.endpoint, {
        method: "POST",
        headers: buildHeaders(provider, apiKey),
        body: JSON.stringify(buildJevBody(prompt, DEFAULT_ANSWER_FORMAT, provider.model)),
        signal: requestSignal,
      });
      lastStatus = response.status;
      if (!response.ok) throw new Error(`jev HTTP ${response.status}`);
      const payload: unknown = await response.json();
      const choice = parseJevChoice(payload);
      if (!choice) throw new Error("jev response did not contain a valid choice");
      return {
        choice,
        attempts,
        latencyMs: Date.now() - startedAt,
        failed: false,
        provider: provider.id,
      };
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
    provider: provider.id,
    error: lastStatus === undefined ? lastError : `${lastError} (last status ${lastStatus})`,
  };
}
