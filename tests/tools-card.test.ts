// The owner-prompt Tools-and-limits card (plan 20261127_1005_tooling_card P1): on every real owner
// prompt checkInject shows the per-turn call cap and the open plans' deny-command blockers, at most
// three lines. Continuations never get it; tier full prints the cap as off; the unlock path never
// appears in it.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkInject } from "../src/core/guards.ts";
import type { Config } from "../src/core/config.ts";
import { loadConfig } from "../src/core/config.ts";

const roots: string[] = [];
const originalQueueEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("QUEUE_")));
afterAll(() => {
	for (const key of Object.keys(process.env)) if (key.startsWith("QUEUE_")) delete process.env[key];
	Object.assign(process.env, originalQueueEnv);
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

let root: string;
let state: string;
let agent: string;
let repo: string;
let cfg: Config;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "neurastream-tools-card-"));
	roots.push(root);
	state = join(root, "state");
	agent = join(root, "agent");
	repo = join(root, "repo");
	mkdirSync(agent, { recursive: true });
	mkdirSync(state, { recursive: true });
	mkdirSync(join(agent, "blockers"), { recursive: true });
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src/code.ts"), "export const a = 1;\n");
	writeFileSync(join(agent, "CANCELLED.md"), "");
	writeFileSync(join(agent, "subagents.md"), "## Allowed\n- `task`\n");
	const script = join(agent, "blockers", "deny-command");
	writeFileSync(script, "#!/bin/sh\nexit 0\n");
	chmodSync(script, 0o755);
	writeIndex([]);
	loadCfg("guards:\n  main_warn_calls: 2\n  main_max_calls: 3\n  main_edit_limit: 5\n  main_window_min: 15\n");
});

function loadCfg(extra: string): void {
	const configFile = join(root, ".config/neurastream/config.yml");
	mkdirSync(join(root, ".config/neurastream"), { recursive: true });
	writeFileSync(
		configFile,
		`paths:
  home: "${root}"
  agent_dir: "${agent}"
  queue_index: "${join(agent, "INDEX.md")}"
  blockers: "${join(agent, "blockers")}"
  queue_state: "${state}"
  subagents: "${join(agent, "subagents.md")}"
  cancelled: "${join(agent, "CANCELLED.md")}"
  unlock: "${join(agent, ".guard-unlock")}"
  guard_log: "${join(root, "guard.log")}"
  plan_guard_log: "${join(root, "plan-guard.log")}"
  work_roots: ["${repo}"]
${extra}`,
	);
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("QUEUE_")));
	Object.assign(env, { HOME: root });
	cfg = loadConfig({ home: root, env });
}

// A plan whose only blocker is the deny-command script with the given argument.
function planText(name: string, arg: string): string {
	return `# ${name}

Worktree: ${repo}
Branch: fix/${name}

## Goal
- Test.

## Forbidden
- None.

## Blockers
- deny-command ${arg}

## Phases
- [ ] P1 test — verify: \`true\`

## Done check
\`true\`

## Code read by Main
- \`${join(repo, "src/code.ts")}\`

## Progress
Status: open
- Started.
`;
}

function writeIndex(names: Array<[string, string]>): void {
	const files = names.map(([name, arg]) => {
		const file = join(agent, `${name}.md`);
		writeFileSync(file, planText(name, arg));
		return file;
	});
	writeFileSync(join(agent, "INDEX.md"), files.map(f => `${f}\n`).join(""));
}

const inject = (text: string): string => checkInject({ inject: text, agent: "main" } as never, cfg).inject ?? "";

// The card's lines: from its header through the lines that follow it (up to the first other line).
function card(text: string): string[] {
	const lines = text.split("\n");
	const at = lines.indexOf("Tools and limits");
	if (at < 0) return [];
	const out = ["Tools and limits"];
	for (const l of lines.slice(at + 1)) {
		if (!/^(Calls: |Deny-commands \(open plans\): )/.test(l)) break;
		out.push(l);
	}
	return out;
}

test("an owner prompt shows the call cap and the open deny-command plan", () => {
	writeIndex([["plan-a", "rm-rf"]]);
	const out = inject("please keep going");
	expect(card(out)).toEqual([
		"Tools and limits",
		"Calls: 3 per turn (warn at 2)",
		"Deny-commands (open plans): plan-a.md: rm-rf",
	]);
});

test("the card is at most three lines when four plans carry deny-commands", () => {
	writeIndex([["plan-a", "rm-rf"], ["plan-b", "drop-db"], ["plan-c", "force-push"], ["plan-d", "wipe-disk"]]);
	const lines = card(inject("please keep going"));
	expect(lines).toHaveLength(3);
	expect(lines[2]).toBe("Deny-commands (open plans): plan-a.md: rm-rf | plan-b.md: drop-db | plan-c.md: force-push | +1 more");
});

test("no open deny-command plan means no deny line", () => {
	writeIndex([]);
	expect(card(inject("please keep going"))).toEqual(["Tools and limits", "Calls: 3 per turn (warn at 2)"]);
});

test("a main-guard continuation gets no card", () => {
	writeIndex([["plan-a", "rm-rf"]]);
	expect(inject("main-guard: keep working")).not.toContain("Tools and limits");
});

test("tier full prints the call cap as off", () => {
	loadCfg("autonomy:\n  tier: full\nguards:\n  main_warn_calls: 2\n  main_max_calls: 3\n");
	writeIndex([]);
	expect(card(inject("please keep going"))).toEqual(["Tools and limits", "Calls: off"]);
});

test("the card never prints the unlock path", () => {
	writeIndex([["plan-a", "rm-rf"]]);
	const lines = card(inject("please keep going"));
	expect(lines.length).toBeGreaterThan(1);
	expect(lines.join("\n")).not.toContain(cfg.paths.unlock);
});
