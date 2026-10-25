// Recovery policy for zcode turns that end on a transient provider failure.
//
// zcode retries a dropped model stream 10 times per turn (a fixed budget that
// is never reset inside a turn) and then fails the turn with
// `model_request_failed`, even though its session is intact: finished tool
// results are persisted and a continuation prompt picks up from there. A model
// endpoint that drops about a quarter of its streams therefore kills any turn
// longer than a few dozen requests. The driver resumes the same session
// instead, a bounded number of times, so each resume gets a fresh budget.

export const ZCODE_MAX_TURN_RESUMES = 5;

const RESUME_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;

/** Delay before the given resume (1-based). */
export const zcodeResumeDelayMs = (resume: number): number =>
  RESUME_DELAYS_MS[Math.min(Math.max(resume, 1), RESUME_DELAYS_MS.length) - 1]!;

export const ZCODE_RESUME_PROMPT =
  "The previous request was interrupted by a network error. Continue the task from where you stopped.";

// Rate limits and plan quota are not here: waiting a few seconds does not lift them.
const TRANSIENT_REASONS = new Set(["network_error", "server_error", "timeout", "stream_idle_timeout"]);
const TRANSIENT_CODES = new Set(["model_network_error", "model_server_error", "model_request_timeout"]);

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

/** The reason zcode attributes to a failed turn, for the thread's notice. */
export function zcodeFailureReason(error: unknown): string | undefined {
  const reason = field(field(error, "attribution"), "reason");
  return typeof reason === "string" && reason ? reason : undefined;
}

/**
 * Whether a `turn.failed` error is a provider connection problem that
 * retrying can fix. `attribution.reason` is zcode's own classification; a 4xx
 * status other than 408 means the request itself was refused.
 */
export function isTransientZcodeFailure(error: unknown): boolean {
  const attribution = field(error, "attribution");
  const statusCode = field(attribution, "statusCode");
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 && statusCode !== 408) return false;
  const reason = zcodeFailureReason(error);
  if (reason !== undefined) return TRANSIENT_REASONS.has(reason);
  const code = field(error, "code");
  return typeof code === "string" && TRANSIENT_CODES.has(code);
}
