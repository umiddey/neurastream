import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { type Claim, fileClaimStore, type Held } from "../src/core/claims.ts";

const ROOT = join(import.meta.dir, "..");
// A full `bun test` must leave nothing under os.tmpdir() (plan 20261029_1530 P3): every
// sandbox dir goes away when this file's tests are done.
const DIRS: string[] = [];
afterAll(() => {
	for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

// Injected clock in unix seconds (the src/core/clock.ts convention): tests move `now`, never sleep.
let now = 1_000_000;
const store = (stateDir: string) => fileClaimStore(stateDir, () => now, 30);

function sandbox(): string {
	const d = mkdtempSync(join(tmpdir(), "claims-"));
	DIRS.push(d);
	return d;
}

const PLAN = "/tmp/neurastream-test-plans/0101_demo.md";
const claimFile = (stateDir: string, plan: string) =>
	join(stateDir, "claims", `${createHash("sha256").update(plan).digest("hex")}.json`);

function asClaim(c: Claim | Held): Claim {
	if ("heldBy" in c) throw new Error(`expected a Claim, got Held by ${c.heldBy.main}`);
	return c;
}

function asHeld(c: Claim | Held): Claim {
	if (!("heldBy" in c)) throw new Error("expected Held, got a Claim");
	return c.heldBy;
}

// The race children: real separate processes (plan Forbidden: races run with Bun.spawn)
// running the same store code against a shared state dir.
function writeChild(dir: string): string {
	const child = join(dir, "claims-child.ts");
	writeFileSync(
		child,
		`import { fileClaimStore } from ${JSON.stringify(join(ROOT, "src", "core", "claims.ts"))};
const [stateDir, plan, main] = process.argv.slice(2);
const store = fileClaimStore(stateDir!, () => Date.now() / 1000);
process.stdout.write(JSON.stringify(store.claim(plan!, main!)));
`,
	);
	return child;
}

async function claimViaChild(child: string, stateDir: string, plan: string, main: string): Promise<Claim | Held> {
	const p = Bun.spawn([process.execPath, child, stateDir, plan, main], { stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
	const code = await p.exited;
	if (code !== 0) throw new Error(`child ${main} exited ${code}: ${err}`);
	return JSON.parse(out);
}

test("claim writes a Claim file; a second main is Held with the holder named; release frees", () => {
	const dir = sandbox();
	const s = store(dir);
	const c = asClaim(s.claim(PLAN, "a"));
	expect(c).toEqual({ plan: PLAN, main: "a", host: hostname(), pid: process.pid, since: 1_000_000, beat: 1_000_000 });
	expect(readdirSync(join(dir, "claims")).filter(f => f.endsWith(".json"))).toEqual([`${createHash("sha256").update(PLAN).digest("hex")}.json`]);
	const held = asHeld(s.claim(PLAN, "b"));
	expect(held.main).toBe("a");
	expect(s.list()).toEqual([c]);
	s.release(PLAN, "a");
	expect(existsSync(claimFile(dir, PLAN))).toBe(false);
	const taken = asClaim(s.claim(PLAN, "b"));
	expect(taken.main).toBe("b");
});

test("the same main claiming twice gets the same Claim back: since unchanged, beat refreshed", () => {
	now = 1_000_000;
	const dir = sandbox();
	const s = store(dir);
	const first = asClaim(s.claim(PLAN, "a"));
	now += 120;
	const second = asClaim(s.claim(PLAN, "a"));
	expect(second.since).toBe(first.since);
	expect(second.beat).toBe(1_000_120);
	expect(s.list()).toEqual([{ ...first, beat: 1_000_120 }]);
});

test("a claim frees at 30 minutes without a heartbeat, not at 29", () => {
	now = 1_000_000;
	const dir = sandbox();
	const s = store(dir);
	s.claim(PLAN, "a");
	now += 29 * 60;
	expect("heldBy" in s.claim(PLAN, "b")).toBe(true);
	now += 60;
	const takeover = asClaim(s.claim(PLAN, "b"));
	expect(takeover.main).toBe("b");
	expect(takeover.since).toBe(1_000_000 + 30 * 60);
});

test("a non-holder's heartbeat is false and its release is a no-op", () => {
	now = 1_000_000;
	const dir = sandbox();
	const s = store(dir);
	s.claim(PLAN, "a");
	now += 45;
	expect(s.heartbeat(PLAN, "b")).toBe(false);
	expect(s.heartbeat("/tmp/neurastream-test-plans/never-claimed.md", "b")).toBe(false);
	expect(JSON.parse(readFileSync(claimFile(dir, PLAN), "utf8")).beat).toBe(1_000_000);
	s.release(PLAN, "b");
	expect(existsSync(claimFile(dir, PLAN))).toBe(true);
	expect(s.heartbeat(PLAN, "a")).toBe(true);
	expect(JSON.parse(readFileSync(claimFile(dir, PLAN), "utf8")).beat).toBe(1_000_045);
	s.release(PLAN, "a");
	expect(existsSync(claimFile(dir, PLAN))).toBe(false);
});

// Five independent rounds; every round's eight children spawn together (no await inside a
// loop), so up to 40 processes race and each round's state dir must still end with exactly
// one Claim and seven Held.
test("race: eight processes claiming one plan at once leave exactly one Claim and seven Held, five times", async () => {
	now = 1_000_000;
	const dir = sandbox();
	const child = writeChild(dir);
	const ROUNDS = [0, 1, 2, 3, 4];
	const rounds = ROUNDS.map(round => {
		const stateDir = join(dir, `race-${round}`);
		return { stateDir, kids: Array.from({ length: 8 }, (_, i) => claimViaChild(child, stateDir, "/tmp/neurastream-test-plans/race.md", `m${i}`)) };
	});
	const settled = await Promise.all(rounds.flatMap(r => r.kids));
	ROUNDS.forEach((round, i) => {
		const stateDir = rounds[i]!.stateDir;
		const results = settled.slice(i * 8, i * 8 + 8);
		const winners = results.filter((r): r is Claim => !("heldBy" in r));
		const held = results.filter((r): r is Held => "heldBy" in r);
		expect(winners.length).toBe(1);
		expect(held.length).toBe(7);
		const winner = winners[0]!;
		expect(held.every(h => h.heldBy.main === winner.main && h.heldBy.since === winner.since)).toBe(true);
		expect(readdirSync(join(stateDir, "claims")).filter(f => f.endsWith(".json")).length).toBe(1);
	});
});

test("takeover race: eight processes taking an expired claim leave exactly one winner", async () => {
	now = 1_000_000;
	const dir = sandbox();
	const child = writeChild(dir);
	const stateDir = join(dir, "takeover");
	// A dead main's claim at the pinned test clock (1970-era): long expired for every real-clock child.
	store(stateDir).claim("/tmp/neurastream-test-plans/takeover.md", "dead");
	const results = await Promise.all(
		Array.from({ length: 8 }, (_, i) => claimViaChild(child, stateDir, "/tmp/neurastream-test-plans/takeover.md", `t${i}`)),
	);
	const winners = results.filter((r): r is Claim => !("heldBy" in r));
	const held = results.filter((r): r is Held => "heldBy" in r);
	expect(winners.length).toBe(1);
	expect(held.length).toBe(7);
	expect(winners[0]!.main).not.toBe("dead");
	expect(held.every(h => h.heldBy.main === winners[0]!.main)).toBe(true);
	expect(readdirSync(join(stateDir, "claims")).filter(f => f.endsWith(".json")).length).toBe(1);
});
