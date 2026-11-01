import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treeHash } from "../src/cli/init.ts";
import { runSetup, templateComments } from "../src/cli/setup.ts";
import { leafKeys } from "../src/core/config-edit.ts";
import type { SetupSeams } from "../src/core/setup-detect.ts";
import type { Tailscale, TailscaleState } from "../src/core/tailscale.ts";

const TMP = mkdtempSync(join(tmpdir(), "setup-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
const WT = join(import.meta.dir, "..");
let seq = 0;

function fixtureHome(): string {
	const home = join(TMP, `home-${seq++}`);
	mkdirSync(join(home, "projects", "app", ".git"), { recursive: true });
	return home;
}

const cfg = (home: string) => join(home, ".config", "neurastream", "config.yml");

function tailscale(state: TailscaleState, logins: string[] | null): Tailscale {
	return {
		state: () => state,
		logins: () => logins,
		ip4: () => null,
		dnsName: () => null,
		whois: () => null,
	} as unknown as Tailscale;
}

function seams(home: string, state: TailscaleState = "running"): SetupSeams {
	return {
		home,
		onPath: () => false,
		harnesses: [{ name: "omp", bin: "omp" }],
		tailscale: tailscale(state, ["ukd@example.com"]),
		os: { cores: 8, ramMb: 16384, diskFreeGb: 200 },
	};
}

// Answers are matched by the key the prompt starts with ("autonomy.tier: ..."; a yes/no offer
// keys on its whole text, "send a test message now? [y/N]"). A prompt with no matching queue gets
// Enter (keep the proposal). notifyTest is the injected `neurastream notify test`: no real post.
async function run(
	args: string[],
	home: string,
	opts: {
		terminal?: boolean;
		answers?: Record<string, string[]>;
		state?: TailscaleState;
		install?: () => number;
		doctor?: () => number;
		notifyTest?: () => Promise<number>;
	} = {},
) {
	const out: string[] = [];
	const asked: string[] = [];
	const rules: Record<string, string[]> = {};
	for (const [key, list] of Object.entries(opts.answers ?? {})) rules[key] = [...list];
	const code = await runSetup(args, {
		home,
		env: {},
		invoked: "",
		terminal: opts.terminal ?? true,
		ask: (question) => {
			asked.push(question);
			const key = Object.keys(rules).find((k) => question.startsWith(`${k}:`) && (rules[k]?.length ?? 0) > 0);
			return key ? (rules[key]?.shift() ?? "") : "";
		},
		seams: seams(home, opts.state),
		install: opts.install ?? (() => 0),
		doctor: opts.doctor ?? (() => 0),
		notifyTest: opts.notifyTest ?? (async () => 0),
		say: (line) => out.push(line),
	});
	return { code, out: out.join("\n"), asked };
}

test("fresh HOME with --yes: init layout, adapter install and doctor run, protected list and agent-dir keys kept", async () => {
	const home = fixtureHome();
	let installs = 0;
	let doctors = 0;
	const result = await run(["--yes"], home, {
		terminal: false,
		install: () => {
			installs++;
			return 0;
		},
		doctor: () => {
			doctors++;
			return 0;
		},
	});
	expect(result.code).toBe(0);
	expect(installs).toBe(1);
	expect(doctors).toBe(1);
	expect(result.asked).toEqual([]);
	expect(existsSync(cfg(home))).toBe(true);
	const text = readFileSync(cfg(home), "utf8");
	expect(text).toMatch(/^  protected:/m);
	expect(text).not.toMatch(/^  protected: \[\]/m);
	expect(text).toMatch(/^  agent_dir: /m);
});

test("scripted answers change exactly the answered config lines", async () => {
	const home = fixtureHome();
	await run(["--yes"], home, { terminal: false });
	const before = readFileSync(cfg(home), "utf8").split("\n");
	const result = await run([], home, { answers: { "autonomy.tier": ["strict"] } });
	expect(result.code).toBe(0);
	const after = readFileSync(cfg(home), "utf8").split("\n");
	expect(after.length).toBe(before.length);
	const changed = after.filter((line, i) => line !== before[i]);
	expect(changed).toHaveLength(1);
	expect(changed[0]).toMatch(/^  tier: "strict"/);
});

test("a bad answer is asked again and nothing is written for that answer", async () => {
	const home = fixtureHome();
	await run(["--yes"], home, { terminal: false });
	const result = await run([], home, { answers: { "autonomy.tier": ["bogus", ""] } });
	expect(result.code).toBe(0);
	expect(result.asked.filter((q) => q.startsWith("autonomy.tier:"))).toHaveLength(2);
	expect(result.out).toContain("opinionated");
	expect(readFileSync(cfg(home), "utf8")).toMatch(/^  tier: opinionated/m);
});

test("a second run with every Enter changes no byte", async () => {
	const home = fixtureHome();
	await run(["--yes"], home, { terminal: false });
	const first = treeHash(home);
	const result = await run([], home);
	expect(result.code).toBe(0);
	expect(treeHash(home)).toBe(first);
});

test("without a terminal and without --yes setup refuses with exit 2", async () => {
	const home = fixtureHome();
	const result = await run([], home, { terminal: false });
	expect(result.code).toBe(2);
	expect(result.out).toContain("setup needs a terminal or --yes");
	expect(existsSync(cfg(home))).toBe(false);
});

test("phone page on with Tailscale stopped prints the message and keeps ui.enabled false", async () => {
	const home = fixtureHome();
	const result = await run([], home, { state: "stopped", answers: { "ui.enabled": ["y"] } });
	expect(result.code).toBe(0);
	expect(result.out).toMatch(/Tailscale/);
	expect(result.asked.some((q) => q.startsWith("ui.owner_login:"))).toBe(false);
	expect(readFileSync(cfg(home), "utf8")).toMatch(/^  enabled: false/m);
});

test("secretgate is refused as a proxy answer when it is not on PATH", async () => {
	const home = fixtureHome();
	const result = await run([], home, { answers: { "secrets.proxy": ["secretgate", "none"] } });
	expect(result.code).toBe(0);
	expect(result.asked.filter((q) => q.startsWith("secrets.proxy:"))).toHaveLength(2);
	expect(result.out).toContain("not on PATH");
	expect(readFileSync(cfg(home), "utf8")).toMatch(/^  proxy: "none"/m);
});

test("a set webhook file offers the notify test: yes runs it through the seam, no and --yes do not", async () => {
	const hook = join(TMP, "discord.url");
	// A home whose Discord webhook file is already set (the --yes run lays the template down first).
	const setHook = async (home: string) => {
		await run(["--yes"], home, { terminal: false });
		writeFileSync(cfg(home), readFileSync(cfg(home), "utf8").replace('discord_webhook_file: ""', `discord_webhook_file: "${hook}"`));
	};
	const offer = "send a test message now? [y/N]";
	let posts = 0;
	const notifyTest = async () => {
		posts++;
		return 0;
	};

	const yesHome = fixtureHome();
	await setHook(yesHome);
	const yes = await run([], yesHome, { answers: { [offer]: ["y"] }, notifyTest });
	expect(yes.code).toBe(0);
	expect(yes.asked.some((q) => q.startsWith("send a test message now?"))).toBe(true);
	expect(posts).toBe(1);

	const noHome = fixtureHome();
	await setHook(noHome);
	const no = await run([], noHome, { answers: { [offer]: ["n"] }, notifyTest });
	expect(no.code).toBe(0);
	expect(posts).toBe(1);

	const autoHome = fixtureHome();
	await setHook(autoHome);
	const auto = await run(["--yes"], autoHome, { terminal: false, notifyTest });
	expect(auto.code).toBe(0);
	expect(auto.asked).toEqual([]);
	expect(posts).toBe(1);
});

test("every key setup can ask has a non-empty trailing comment in templates/config.yml", () => {
	const template = readFileSync(join(WT, "templates", "config.yml"), "utf8");
	const comments = templateComments(template);
	const missing = leafKeys(Bun.YAML.parse(template)).filter((key) => !comments[key]);
	expect(missing).toEqual([]);
});

test("the summary lists changed keys old -> new and ends with Next: neurastream main", async () => {
	const home = fixtureHome();
	const result = await run([], home, { answers: { "autonomy.tier": ["strict"] } });
	expect(result.code).toBe(0);
	expect(result.out).toContain('autonomy.tier: "opinionated" → "strict"');
	expect(result.out).toContain("Next: neurastream main");
});

test("a failing doctor exits with its code and prints no Next line", async () => {
	const home = fixtureHome();
	const result = await run(["--yes"], home, { terminal: false, doctor: () => 1 });
	expect(result.code).toBe(1);
	expect(result.out).not.toContain("Next: neurastream main");
});
