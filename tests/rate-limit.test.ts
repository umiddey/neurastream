// Plan 20261025_0640 P1 / 20261027_1500 P2: pure rate-limit decisions. Configured patterns match the
// turn's error text (stop reason "error" only). A named retry-after is returned as given; without one
// the adapter probes the provider every probe_interval_s (src/core/limit-probe.ts).
// The error text below is the real one returned by the provider at 2026-10-25 02:07:49Z.

import { describe, expect, test } from "bun:test";
import { rateLimited, type RateLimitConfig } from "../src/core/rate-limit.ts";
import { ConfigError, loadConfig } from "../src/core/config.ts";

const REAL_429 =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_011CgN93NGbSQ3eRQEzJS7qT"} retry-after-ms=731000';

const cfg: RateLimitConfig = {
	patterns: ["429", "rate_limit", "rate limit", "overloaded", "529"],
};

describe("rateLimited", () => {
	test("the real 02:07Z 429 text names a retry-after of 731 s", () => {
		expect(rateLimited("error", REAL_429, cfg)).toEqual({ retryAfterMs: 731_000 });
	});

	test("a retry-after in seconds is parsed too", () => {
		expect(rateLimited("error", "429 request throttled (retry-after: 45)", cfg)).toEqual({ retryAfterMs: 45_000 });
	});

	test("a retry-after-ms with a colon separator (header style) is parsed", () => {
		expect(rateLimited("error", "529 service overloaded; retry-after-ms: 20000", cfg)).toEqual({ retryAfterMs: 20_000 });
	});

	test("no retry-after in the text is a limit with no named reset (retryAfterMs null)", () => {
		expect(rateLimited("error", "429 too many requests, slow down", cfg)).toEqual({ retryAfterMs: null });
	});

	test("a retry-after is kept as given: the adapter adds the slack, not this function", () => {
		expect(rateLimited("error", REAL_429.replace("731000", "99999999"), cfg)).toEqual({ retryAfterMs: 99_999_999 });
	});

	test("matching is case-insensitive on the config patterns", () => {
		expect(rateLimited("error", "provider Rate Limit exceeded, try later", cfg)).not.toBeNull();
		expect(rateLimited("error", "model is OVERLOADED right now", cfg)).not.toBeNull();
	});

	test("a non-rate-limit error is null", () => {
		expect(rateLimited("error", "400 invalid_request: bad parameter: model", cfg)).toBeNull();
	});

	test("a non-error stop reason is null, even with rate-limit words", () => {
		expect(rateLimited("stop", "429 talked about in the reply text", cfg)).toBeNull();
		expect(rateLimited(null, REAL_429, cfg)).toBeNull();
	});

	test("no error text is null", () => {
		expect(rateLimited("error", "", cfg)).toBeNull();
		expect(rateLimited("error", null, cfg)).toBeNull();
	});
});

describe("guards.rate_limit config", () => {
	test("the template defaults load without a user file", () => {
		const loaded = loadConfig({ home: "/nonexistent-rate-limit-home" });
		expect(loaded.guards.rate_limit.patterns).toEqual(["429", "rate_limit", "rate limit", "overloaded", "529"]);
		expect(loaded.guards.rate_limit.probe_interval_s).toBe(300);
		expect(loaded.guards.rate_limit.max_probes).toBe(288);
		expect(loaded.guards.rate_limit.probe_timeout_s).toBe(90);
		expect(loaded.guards.rate_limit.probe_cmd).toContain("{model}");
		expect(loaded.guards.rate_limit.slack_s).toBe(15);
	});

	test("the retired wait keys are gone from the loaded config", () => {
		const loaded = loadConfig({ home: "/nonexistent-rate-limit-home" });
		expect("default_wait_s" in loaded.guards.rate_limit).toBe(false);
		expect("max_wait_s" in loaded.guards.rate_limit).toBe(false);
	});

	test("a user override loads", () => {
		const dir = `/tmp/neurastream-home-rl-${process.pid}-${Date.now()}`;
		const { mkdirSync, writeFileSync } = require("node:fs");
		mkdirSync(`${dir}/.config/neurastream`, { recursive: true });
		writeFileSync(
			`${dir}/.config/neurastream/config.yml`,
			'guards:\n  rate_limit:\n    patterns: ["429"]\n    probe_interval_s: 60\n    max_probes: 10\n    probe_timeout_s: 30\n    probe_cmd: "echo {model}"\n    slack_s: 5\n',
		);
		const loaded = loadConfig({ home: dir });
		expect(loaded.guards.rate_limit).toEqual({
			patterns: ["429"],
			probe_interval_s: 60,
			max_probes: 10,
			probe_timeout_s: 30,
			probe_cmd: "echo {model}",
			slack_s: 5,
		});
	});

	test("bad values are refused", () => {
		const dir = `/tmp/neurastream-home-rl-bad-${process.pid}-${Date.now()}`;
		const { mkdirSync, writeFileSync } = require("node:fs");
		mkdirSync(`${dir}/.config/neurastream`, { recursive: true });
		writeFileSync(`${dir}/.config/neurastream/config.yml`, "guards:\n  rate_limit:\n    probe_interval_s: 0\n");
		expect(() => loadConfig({ home: dir })).toThrow(ConfigError);
	});
});
