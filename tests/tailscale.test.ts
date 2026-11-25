import { expect, test } from "bun:test";
import { clearWhoisCache, createCachedWhois, WHOIS_MAX_ENTRIES, WHOIS_TTL_MS } from "../src/core/tailscale.ts";

test("createCachedWhois caches positive lookups within TTL and expires after TTL", () => {
	let nowMs = 1_000_000;
	let calls = 0;
	let currentLogin = "ada@example.com";
	const cached = createCachedWhois(
		(peer) => {
			calls++;
			return peer === "100.64.1.1" ? currentLogin : null;
		},
		{ ttlMs: WHOIS_TTL_MS, now: () => nowMs },
	);

	expect(cached.whois("100.64.1.1")).toBe("ada@example.com");
	expect(calls).toBe(1);

	// Within TTL: cached hit does not re-invoke lookup.
	nowMs += WHOIS_TTL_MS - 1;
	currentLogin = "bob@example.com";
	expect(cached.whois("100.64.1.1")).toBe("ada@example.com");
	expect(calls).toBe(1);

	// At/after TTL: entry is evicted and re-fetched.
	nowMs += 1;
	expect(cached.whois("100.64.1.1")).toBe("bob@example.com");
	expect(calls).toBe(2);

	// clear() forces a fresh lookup even inside TTL.
	cached.clear();
	expect(cached.whois("100.64.1.1")).toBe("bob@example.com");
	expect(calls).toBe(3);
});

test("createCachedWhois never caches null failures so transient errors recover immediately", () => {
	let nowMs = 1_000_000;
	let calls = 0;
	let answer: string | null = null;
	const cached = createCachedWhois(
		() => {
			calls++;
			return answer;
		},
		{ ttlMs: 30_000, now: () => nowMs },
	);

	expect(cached.whois("100.64.2.1")).toBeNull();
	expect(calls).toBe(1);

	// Second call at the exact same timestamp still retries the lookup.
	expect(cached.whois("100.64.2.1")).toBeNull();
	expect(calls).toBe(2);

	// Once whois recovers, the positive login is cached.
	answer = "ada@example.com";
	expect(cached.whois("100.64.2.1")).toBe("ada@example.com");
	expect(calls).toBe(3);

	nowMs += 5_000;
	expect(cached.whois("100.64.2.1")).toBe("ada@example.com");
	expect(calls).toBe(3);
});

test("createCachedWhois enforces maxEntries by evicting the oldest entry", () => {
	const nowMs = 1_000_000;
	const calls: string[] = [];
	const cached = createCachedWhois(
		(peer) => {
			calls.push(peer);
			return `user-${peer}`;
		},
		{ ttlMs: 30_000, maxEntries: 2, now: () => nowMs },
	);

	expect(WHOIS_TTL_MS).toBe(30_000);
	expect(WHOIS_MAX_ENTRIES).toBe(256);

	expect(cached.whois("p1")).toBe("user-p1");
	expect(cached.whois("p2")).toBe("user-p2");
	// Both p1 and p2 are cached.
	expect(cached.whois("p1")).toBe("user-p1");
	expect(cached.whois("p2")).toBe("user-p2");
	expect(calls).toEqual(["p1", "p2"]);

	// Inserting p3 evicts p1 (the oldest entry), while p2 remains cached.
	expect(cached.whois("p3")).toBe("user-p3");
	expect(cached.whois("p2")).toBe("user-p2");
	expect(calls).toEqual(["p1", "p2", "p3"]);

	// Querying p1 again misses and triggers a fresh lookup (evicting p2).
	expect(cached.whois("p1")).toBe("user-p1");
	expect(calls).toEqual(["p1", "p2", "p3", "p1"]);

	// clearWhoisCache is callable without throwing.
	expect(() => clearWhoisCache()).not.toThrow();
});
