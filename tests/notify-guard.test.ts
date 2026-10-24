// Plan 20261024_2155 (P1): the notify webhook files are secrets — any tool call whose touched
// paths hit a configured secret file, its directory, or a glob over it is refused for main and
// subagents, unlock or not; the neurastream config file and the secret files are protected writes
// (owner unlock). Decisions run through the guard CLI, the path any harness reaches them by.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO = dirname(dirname(import.meta.path));
const CLI = join(REPO, "src/cli/main.ts");
const HOME = "/tmp/neurastream-home-notify-guard";
const TOY = join(HOME, "projects/toy");
const CONFIG_DIR = join(HOME, ".config/neurastream");
const SECRETS = join(CONFIG_DIR, "secrets");
const DISCORD = join(SECRETS, "discord-webhook");
const SLACK = join(SECRETS, "slack-webhook");
const AGENT = join(HOME, ".omp/agent");
const UNLOCK = join(AGENT, ".guard-unlock");

function fresh(): void {
	rmSync(HOME, { recursive: true, force: true });
	for (const d of [TOY, SECRETS, join(AGENT, "notes")]) mkdirSync(d, { recursive: true });
	writeFileSync(DISCORD, "local-test-only\n");
	writeFileSync(SLACK, "local-test-only\n");
	writeFileSync(
		join(CONFIG_DIR, "config.yml"),
		`paths:
  home: "${HOME}"
  work_roots: ["${TOY}"]
  agent_dir: "${AGENT}"
  queue_index: "${join(AGENT, "INDEX.md")}"
  blockers: "${join(AGENT, "blockers")}"
  queue_state: "${join(HOME, ".local/state/queue")}"
  subagents: "${join(AGENT, "notes/subagents.md")}"
  cancelled: "${join(AGENT, "CANCELLED.md")}"
  unlock: "${UNLOCK}"
  guard_log: "${join(HOME, "main-guard.log")}"
  plan_guard_log: "${join(HOME, "plan-guard.log")}"
notify:
  discord_webhook_file: "~/.config/neurastream/secrets/discord-webhook"
  slack_webhook_file: "~/.config/neurastream/secrets/slack-webhook"
`,
	);
}

// Inherited QUEUE_* would override the sandbox config in the child (env beats config.yml).
function envFor(): NodeJS.ProcessEnv {
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_")));
	return {
		...env,
		HOME,
		QUEUE_AGENT: AGENT,
		QUEUE_INDEX: join(AGENT, "INDEX.md"),
		QUEUE_BLOCKERS: join(AGENT, "blockers"),
		QUEUE_STATE: join(HOME, ".local/state/queue"),
		QUEUE_SUBAGENTS: join(AGENT, "notes/subagents.md"),
		QUEUE_CANCELLED: join(AGENT, "CANCELLED.md"),
		QUEUE_UNLOCK: UNLOCK,
	};
}

function unlock(): void {
	writeFileSync(UNLOCK, "");
	utimesSync(UNLOCK, Date.now() / 1000, Date.now() / 1000);
}

interface Decision {
	allow: boolean;
	reason: string;
}

function guard(tool: string, input: Record<string, unknown>, agent: "main" | "sub" = "sub"): Decision {
	const payload = { tool, input, cwd: TOY, agent, agentId: agent === "main" ? "main" : "w1", calls: 0, paths: [], writes: [] };
	const r = spawnSync("bun", [CLI, "guard", "pre-tool", "--json"], {
		input: JSON.stringify(payload),
		encoding: "utf8",
		env: envFor(),
	});
	if (!r.stdout.trim()) throw new Error(`guard printed nothing (exit ${r.status}): ${r.stderr}`);
	return JSON.parse(r.stdout.trim()) as Decision;
}

const after = (): void => {
	rmSync(HOME, { recursive: true, force: true });
};
afterAll(after);

test("a read tool call on a configured secret is refused, locked or unlocked, main or sub", () => {
	fresh();
	for (const agent of ["main", "sub"] as const) {
		for (const secret of [DISCORD, SLACK]) {
			const locked = guard("read", { path: secret }, agent);
			expect(locked.allow).toBe(false);
			expect(locked.reason).toContain(secret);
			unlock();
			const fresh = guard("read", { path: secret }, agent);
			expect(fresh.allow).toBe(false);
			expect(fresh.reason).toContain(secret);
		}
	}
});

test("grep, bash cat and eval reads of the secrets are refused", () => {
	fresh();
	const grep = guard("grep", { pattern: "hook", path: DISCORD });
	expect(grep.allow).toBe(false);
	expect(grep.reason).toContain(DISCORD);
	const cat = guard("bash", { command: `cat ${DISCORD}` });
	expect(cat.allow).toBe(false);
	expect(cat.reason).toContain(DISCORD);
	const evalRead = guard("eval", { code: `readFileSync("${SLACK}", "utf8")` });
	expect(evalRead.allow).toBe(false);
	expect(evalRead.reason).toContain(SLACK);
});

test("listing the secrets directory and globs over it are refused", () => {
	fresh();
	const ls = guard("bash", { command: `ls ${SECRETS}` });
	expect(ls.allow).toBe(false);
	expect(ls.reason).toContain(SECRETS);
	const glob = guard("bash", { command: `cat ${SECRETS}/*` });
	expect(glob.allow).toBe(false);
	const parentGlob = guard("bash", { command: `ls ${CONFIG_DIR}/*` });
	expect(parentGlob.allow).toBe(false);
	const cd = guard("bash", { command: `cd ${SECRETS} && cat discord-webhook` });
	expect(cd.allow).toBe(false);
});

test("reading the neurastream config file and other files beside it stays allowed", () => {
	fresh();
	const cfgRead = guard("read", { path: join(CONFIG_DIR, "config.yml") }, "main");
	expect(cfgRead.allow).toBe(true);
	const other = guard("read", { path: join(CONFIG_DIR, "notes.md") }, "main");
	expect(other.allow).toBe(true);
	const lsParent = guard("bash", { command: `ls ${CONFIG_DIR}` });
	expect(lsParent.allow).toBe(true);
});

test("a write to the neurastream config file is refused locked, allowed with a fresh unlock", () => {
	fresh();
	const cfg = join(CONFIG_DIR, "config.yml");
	const locked = guard("write", { path: cfg, content: "notify: {}" });
	expect(locked.allow).toBe(false);
	expect(locked.reason).toContain(cfg);
	unlock();
	const open = guard("write", { path: cfg, content: "notify: {}" });
	expect(open.allow).toBe(true);
});

test("a write to a configured secret file needs the owner's unlock", () => {
	fresh();
	const locked = guard("write", { path: DISCORD, content: "x" });
	expect(locked.allow).toBe(false);
	unlock();
	expect(guard("write", { path: DISCORD, content: "x" }).allow).toBe(true);
});
