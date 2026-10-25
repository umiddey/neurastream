// Plan 20261025_0640 P1: the pure rate-limit decision. What counts as a rate limit (config
// patterns on the turn's error text, stop reason "error" only) and how long to wait it out
// (retry-after parsed from the text, doubling on a repeat within the episode, a max cap, slack
// on top). The error text is the real one the provider returned at 2026-10-25 02:07:49Z.

import { describe, expect, test } from "bun:test";
import { rateLimitWait, type RateLimitConfig } from "../src/core/rate-limit.ts";
import { ConfigError, loadConfig } from "../src/core/config.ts";

const REAL_429 =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_011CgN93NGbSQ3eRQEzJS7qT"} retry-after-ms=731000';

const cfg: RateLimitConfig = {
	patterns: ["429", "rate_limit", "rate limit", "overloaded", "529"],
	default_wait_s: 300,
	max_wait_s: 3600,
	slack_s: 15,
};

describe("rateLimitWait", () => {
	test("the real 02:07Z 429 text waits retry-after-ms 731 s plus slack", () => {
		const now = 1_769_322_469_000;
		const w = rateLimitWait("error", REAL_429, now, cfg, 1);
		expect(w).not.toBeNull();
		expect(w!.waitMs).toBe((731 + 15) * 1000);
		expect(w!.untilMs).toBe(now + (731 + 15) * 1000);
	});

	test("a retry-after in seconds is parsed too", () => {
		const w = rateLimitWait("error", "429 request throttled (retry-after: 45)", 1000, cfg, 1);
		expect(w!.waitMs).toBe((45 + 15) * 1000);
	});

	test("a retry-after-ms with a colon separator (header style) is parsed", () => {
		const w = rateLimitWait("error", "529 service overloaded; retry-after-ms: 20000", 1000, cfg, 1);
		expect(w!.waitMs).toBe((20 + 15) * 1000);
	});

	test("no retry-after in the text falls back to default_wait_s", () => {
		const w = rateLimitWait("error", "429 too many requests, slow down", 1000, cfg, 1);
		expect(w!.waitMs).toBe((300 + 15) * 1000);
	});

	test("attempt 2 doubles the wait", () => {
		const w = rateLimitWait("error", "429 too many requests, slow down", 1000, cfg, 2);
		expect(w!.waitMs).toBe((600 + 15) * 1000);
	});

	test("attempt 3 doubles again", () => {
		const w = rateLimitWait("error", "429 too many requests, slow down", 1000, cfg, 3);
		expect(w!.waitMs).toBe((1200 + 15) * 1000);
	});

	test("a doubled wait above max_wait_s is clamped, then slack is added", () => {
		const w = rateLimitWait("error", "429 slow down retry-after-ms=2000000", 1000, cfg, 3);
		expect(w!.waitMs).toBe((3600 + 15) * 1000);
	});

	test("a retry-after above max_wait_s is clamped on the first attempt too", () => {
		const w = rateLimitWait("error", REAL_429.replace("731000", "99999999"), 1000, cfg, 1);
		expect(w!.waitMs).toBe((3600 + 15) * 1000);
	});

	test("matching is case-insensitive on the config patterns", () => {
		expect(rateLimitWait("error", "provider Rate Limit exceeded, try later", 1000, cfg, 1)).not.toBeNull();
		expect(rateLimitWait("error", "model is OVERLOADED right now", 1000, cfg, 1)).not.toBeNull();
	});

	test("a non-rate-limit error is null", () => {
		expect(rateLimitWait("error", '400 invalid_request: bad parameter: model', 1000, cfg, 1)).toBeNull();
	});

	test("a non-error stop reason is null, even with rate-limit words", () => {
		expect(rateLimitWait("stop", "429 talked about in the reply text", 1000, cfg, 1)).toBeNull();
		expect(rateLimitWait(null, REAL_429, 1000, cfg, 1)).toBeNull();
	});

	test("no error text is null", () => {
		expect(rateLimitWait("error", "", 1000, cfg, 1)).toBeNull();
		expect(rateLimitWait("error", null, 1000, cfg, 1)).toBeNull();
	});
});

describe("guards.rate_limit config", () => {
	test("the template defaults load without a user file", () => {
		const cfg = loadConfig({ home: "/nonexistent-rate-limit-home" });
		expect(cfg.guards.rate_limit.patterns).toEqual(["429", "rate_limit", "rate limit", "overloaded", "529"]);
		expect(cfg.guards.rate_limit.default_wait_s).toBe(300);
		expect(cfg.guards.rate_limit.max_wait_s).toBe(3600);
		expect(cfg.guards.rate_limit.slack_s).toBe(15);
	});

	test("a user override loads", () => {
		const dir = `/tmp/neurastream-home-rl-${process.pid}-${Date.now()}`;
		const { mkdirSync, writeFileSync } = require("node:fs");
		mkdirSync(`${dir}/.config/neurastream`, { recursive: true });
		writeFileSync(
			`${dir}/.config/neurastream/config.yml`,
			'guards:\n  rate_limit:\n    patterns: ["429"]\n    default_wait_s: 60\n    max_wait_s: 1200\n    slack_s: 5\n',
		);
		const cfg = loadConfig({ home: dir });
		expect(cfg.guards.rate_limit).toEqual({ patterns: ["429"], default_wait_s: 60, max_wait_s: 1200, slack_s: 5 });
	});

	test("bad values are refused", () => {
		const dir = `/tmp/neurastream-home-rl-bad-${process.pid}-${Date.now()}`;
		const { mkdirSync, writeFileSync } = require("node:fs");
		mkdirSync(`${dir}/.config/neurastream`, { recursive: true });
		writeFileSync(`${dir}/.config/neurastream/config.yml`, "guards:\n  rate_limit:\n    default_wait_s: 0\n");
		expect(() => loadConfig({ home: dir })).toThrow(ConfigError);
	});
});
