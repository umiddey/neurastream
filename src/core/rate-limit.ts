// Provider rate limits (plan 20261025_0640, reshaped by 20261027_1500 P2): a turn that ended on a
// rate limit is recognised here; what happens next (a named wait or probing the provider) is decided
// by the adapter and src/core/limit-probe.ts. Pure: what counts as a rate limit, and the retry-after
// the provider names. The words come from config (guards.rate_limit); the adapter supplies the turn's
// stop reason and error text.

export interface RateLimitConfig {
	/** Case-insensitive substrings in the error text that mark a rate limit. */
	patterns: string[];
}

export interface RateLimited {
	/** The provider's named retry-after in ms, or null when the error text names none. */
	retryAfterMs: number | null;
}

const RETRY_AFTER_MS = /retry-after-ms[=:]\s*(\d+)/i;
const RETRY_AFTER_S = /retry-after[=:]\s*(\d+)/i;

function namedRetryAfterMs(errorText: string): number | null {
	const ms = RETRY_AFTER_MS.exec(errorText);
	if (ms) return Number(ms[1]);
	const s = RETRY_AFTER_S.exec(errorText);
	if (s) return Number(s[1]) * 1000;
	return null;
}

/**
 * The rate limit a turn ended on, or null when it did not: the stop reason must be "error" and the
 * error text must contain one of the configured patterns (case-insensitive).
 */
export function rateLimited(stopReason: string | null, errorText: string | null, cfg: RateLimitConfig): RateLimited | null {
	if (stopReason !== "error" || !errorText) return null;
	const text = errorText.toLowerCase();
	if (!cfg.patterns.some(p => text.includes(p.toLowerCase()))) return null;
	return { retryAfterMs: namedRetryAfterMs(errorText) };
}
