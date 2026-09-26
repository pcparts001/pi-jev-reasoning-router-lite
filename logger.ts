/**
 * pi-jev-reasoning-router: writing the run log (JSONL)
 *
 * Purpose: make it possible to analyze later how often this router actually ran, what it decided,
 * and which level it applied (joinable with a session transcript via sessionId / sessionFile).
 *
 * Record kinds (assembled by pure functions in router.ts):
 *  - `decision` = a decision was made and a level was applied / `skip` = the model gate stopped it
 *  - `cache`    = a measurement of the input cache (prompt cache) (`scope: "first-request" | "turn"`).
 *                It only reads the usage pi returns **after** the request, so it cannot affect the context.
 *
 * Specification:
 *  - Append only (1 record = 1 line of JSON). The default destination is ~/.pi/agent/jev-router/runs.jsonl
 *  - `JEV_ROUTER_LOG` changes the destination. `off` or an empty string disables it (nothing is written)
 *  - Once it exceeds 5MB, it is rotated one generation to `runs.jsonl.1`
 *  - **Write failures are swallowed** (logging must never stop a request)
 *  - The prompt body is never written (only its length; no conversation content is kept in the log)
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LOG_ENV, type LogRecord } from "./router.ts";

/** Default destination */
export const DEFAULT_LOG_PATH = join(homedir(), ".pi/agent/jev-router/runs.jsonl");
/** Rotation threshold (bytes) */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Resolve the destination.
 *  - unset (env is undefined) -> the default path
 *  - `off` / empty string     -> undefined (logging disabled)
 *  - anything else            -> that path
 */
export function resolveLogPath(raw: string | null | undefined = process.env[LOG_ENV]): string | undefined {
  const value = raw === undefined || raw === null ? DEFAULT_LOG_PATH : raw.trim();
  if (!value || value.toLowerCase() === "off") return undefined;
  return value;
}

/**
 * Rotate the log when it exceeds the limit (`<path>.1`, one generation only).
 * @returns true when it rotated
 */
export function rotateIfNeeded(path: string, maxBytes: number = LOG_MAX_BYTES): boolean {
  try {
    if (!existsSync(path)) return false;
    if (statSync(path).size < maxBytes) return false;
    // An existing .1 is overwritten (POSIX rename replaces it)
    renameSync(path, `${path}.1`);
    return true;
  } catch {
    // Keep appending even if the rotation fails (worst case one file just grows)
    return false;
  }
}

/**
 * Append one record. Never throws.
 *
 * @param path Destination. If omitted/undefined, `JEV_ROUTER_LOG` or the default path is resolved.
 *             Passing an explicit `null` means "logging disabled" and nothing is written.
 * @returns true when the record was written
 */
export function appendLogRecord(record: LogRecord, path: string | null | undefined = resolveLogPath()): boolean {
  if (!path) return false;
  try {
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path);
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
