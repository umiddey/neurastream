// Provider rate limits (plan 20261025_0640): a turn that ended on one waits it out instead of
// asking again straight into the limit. Pure decisions only: what counts as a rate limit, and how
// long to wait. The words and the waits come from config (guards.rate_limit); the adapter supplies
// the turn's stop reason and error text and arms the timer.

export interface RateLimitConfig {
	/** Case-insensitive substrings in the error text that mark a rate limit. */
	patterns: string[];
	/** Wait when the error text names no retry-after. */
	default_wait_s: number;
	/** Cap for the parsed (or doubled) wait, before slack. */
	max_wait_s: number;
	/** Added on top of every wait. */
	slack_s: number;
}

export interface RateLimitWait {
	/** Epoch ms when the next turn should start. */
	untilMs: number;
	/** Total wait in ms, slack included. */
	waitMs: number;
}

const RETRY_AFTER_MS = /retry-after-ms[=:]\s*(\d+)/i;
const RETRY_AFTER_S = /retry-after[=:]\s*(\d+)/i;

function retryAfterMs(errorText: string, cfg: RateLimitConfig): { ms: number; named: boolean } {
	const ms = RETRY_AFTER_MS.exec(errorText);
	if (ms) return { ms: Number(ms[1]), named: true };
	const s = RETRY_AFTER_S.exec(errorText);
	if (s) return { ms: Number(s[1]) * 1000, named: true };
	return { ms: cfg.default_wait_s * 1000, named: false };
}

/**
 * The wait for a turn that ended on a provider rate limit, or null when it did not: the stop
 * reason must be "error" and the error text must contain one of the configured patterns
 * (case-insensitive). A named retry-after is used as-is; otherwise default_wait_s is doubled
 * for each later attempt. The resulting wait is clamped to max_wait_s, then slack_s is added.
 */
export function rateLimitWait(
	stopReason: string | null,
	errorText: string | null,
	now: number,
	cfg: RateLimitConfig,
	attempt: number,
): RateLimitWait | null {
	if (stopReason !== "error" || !errorText) return null;
	const text = errorText.toLowerCase();
	if (!cfg.patterns.some(p => text.includes(p.toLowerCase()))) return null;
	const capMs = cfg.max_wait_s * 1000;
	const retryAfter = retryAfterMs(errorText, cfg);
	let baseMs = retryAfter.ms;
	if (!retryAfter.named) {
		for (let i = 1; i < Math.max(1, attempt); i++) {
			baseMs *= 2;
			if (baseMs >= capMs) {
				baseMs = capMs;
				break;
			}
		}
	}
	const waitMs = Math.min(baseMs, capMs) + cfg.slack_s * 1000;
	return { untilMs: now + waitMs, waitMs };
}
