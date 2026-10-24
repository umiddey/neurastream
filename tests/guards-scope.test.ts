// Blocker scope: plan blockers must not leak across worktrees of one repo (the 0.2.0 one-index
// regression). Two open plans A and B live in one main checkout, each naming its own linked
// worktree; B has `deny-path tests/**`. A subagent write of tests/x.spec.js inside A's worktree
// is A's ground and must be allowed; the same write inside B's worktree, in the main checkout
// and in a worktree no plan names stays refused.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO = dirname(dirname(import.meta.path));
// realpath: macOS /tmp is a symlink to /private/tmp, and git reports worktrees by real path.
const HOME = join(realpathSync("/tmp"), "neurastream-home-scope");
const AGENT = join(HOME, ".omp/agent");
const TOY = join(HOME, "projects/toy");
const WT_A = join(HOME, "projects/toy-wt-a");
const WT_B = join(HOME, "projects/toy-wt-b");
const WT_C = join(HOME, "projects/toy-wt-c");
const PLAN_A = join(TOY, "docs/plans/20261019_plan_a.md");
const PLAN_B = join(TOY, "docs/plans/20261019_plan_b.md");
const STATE = join(HOME, ".local/state/queue");
const SUBAGENTS = join(AGENT, "notes/subagents.md");
const UNLOCK = join(AGENT, ".guard-unlock");

interface Decision {
	allow: boolean;
	reason: string;
}

const planText = (goal: string, worktree: string, branch: string, blockers: string) => `# ${goal}

Worktree: ${worktree}
Branch: ${branch}

## Goal
- ${goal}.

## Forbidden
- Never skip tests.

## Blockers
${blockers}

## Phases
- [ ] P1 do the thing — verify: \`test -f src/a.ts\`

## Done check
\`test -f src/a.ts\`

## Progress
Status: open

- Started.
`;

const PLAN_A_TEXT = planText("Plan A ground", WT_A, "feat/a", "- no-push");
const PLAN_B_TEXT = planText("Plan B ground", WT_B, "feat/b", "- deny-path tests/**");

function git(args: string[], cwd: string): void {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

function fresh(): void {
	rmSync(HOME, { recursive: true, force: true });
	for (const d of [join(TOY, "docs/plans"), join(TOY, "src"), join(AGENT, "blockers"), join(AGENT, "notes"), join(HOME, ".config/neurastream"), STATE])
		mkdirSync(d, { recursive: true });
	writeFileSync(PLAN_A, PLAN_A_TEXT);
	writeFileSync(PLAN_B, PLAN_B_TEXT);
	writeFileSync(join(AGENT, "INDEX.md"), `${PLAN_A}\n${PLAN_B}\n`);
	writeFileSync(SUBAGENTS, "## Allowed\n\n- `toy-worker`\n");
	writeFileSync(join(AGENT, "CANCELLED.md"), "");
	writeFileSync(join(TOY, "src/a.ts"), "export const a = 1;\n");
	for (const b of ["deny-path", "no-push"]) {
		// the wrapper's relative import must survive the copy: point it at the package
		const text = readFileSync(join(REPO, "blockers", b), "utf8").replace("../src/core/blockers.ts", join(REPO, "src/core/blockers.ts"));
		writeFileSync(join(AGENT, "blockers", b), text);
		chmodSync(join(AGENT, "blockers", b), 0o755);
	}
	writeFileSync(
		join(HOME, ".config/neurastream/config.yml"),
		`paths:
  home: "${HOME}"
  work_roots: ["${HOME}/projects"]
  agent_dir: "${AGENT}"
  queue_index: "${join(AGENT, "INDEX.md")}"
  blockers: "${join(AGENT, "blockers")}"
  queue_state: "${STATE}"
  subagents: "${SUBAGENTS}"
  cancelled: "${join(AGENT, "CANCELLED.md")}"
  unlock: "${UNLOCK}"
  guard_log: "${join(HOME, "main-guard.log")}"
  plan_guard_log: "${join(HOME, "plan-guard.log")}"
`,
	);
	git(["init", "-q"], TOY);
	git(["add", "-A"], TOY);
	git(["-c", "user.email=toy@local", "-c", "user.name=toy", "commit", "-qm", "init"], TOY);
	git(["worktree", "add", "-q", "-b", "feat/a", WT_A], TOY);
	git(["worktree", "add", "-q", "-b", "feat/b", WT_B], TOY);
	git(["worktree", "add", "-q", "-b", "feat/c", WT_C], TOY);
}

// Inherited QUEUE_* would override the sandbox config in the child (env beats config.yml).
function guardCli(event: string, payload: unknown): { code: number; d: Decision } {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("QUEUE_")) env[k] = v;
	// HOME after the copy: the real HOME must not win over the sandbox home, or the child guard
	// CLI writes its BLOCK lines to the real plan-guard log (INCIDENT I-20261024-26).
	Object.assign(env, {
		HOME,
		QUEUE_AGENT: AGENT,
		QUEUE_INDEX: join(AGENT, "INDEX.md"),
		QUEUE_BLOCKERS: join(AGENT, "blockers"),
		QUEUE_STATE: STATE,
		QUEUE_SUBAGENTS: SUBAGENTS,
		QUEUE_CANCELLED: join(AGENT, "CANCELLED.md"),
		QUEUE_UNLOCK: UNLOCK,
	});
	const r = spawnSync("bun", [join(REPO, "src/cli/main.ts"), "guard", event, "--json"], {
		input: JSON.stringify(payload),
		encoding: "utf8",
		env,
	});
	if (!r.stdout.trim()) throw new Error(`guard ${event} printed nothing: ${r.stderr}`);
	return { code: r.status ?? 1, d: JSON.parse(r.stdout.trim()) as Decision };
}

function toolEvent(tool: string, input: Record<string, unknown>, agent: "main" | "sub", calls = 0) {
	return { tool, input, cwd: TOY, agent, agentId: agent === "main" ? "main" : "w1", calls, paths: [], writes: [], command: String(input.command ?? "") };
}

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

test("blocker scope: B's deny-path tests/** does not reach A's worktree; B's worktree, the main checkout and an unnamed worktree stay guarded", () => {
	fresh();
	const edit = (path: string) => guardCli("pre-tool", toolEvent("write", { path, content: "x" }, "sub"));
	// A's own worktree: only A covers it, and A has no tests/** blocker.
	const a = edit(join(WT_A, "tests/x.spec.js"));
	expect([a.code, a.d.reason]).toEqual([0, ""]);
	// B's own worktree: B's deny-path fires.
	const b = edit(join(WT_B, "tests/x.spec.js"));
	expect(b.code).toBe(2);
	expect(b.d.reason).toContain("deny-path tests/**");
	// The main checkout: both plans cover it, B's deny-path fires.
	const main = edit(join(TOY, "tests/x.spec.js"));
	expect(main.code).toBe(2);
	expect(main.d.reason).toContain("deny-path tests/**");
	// A worktree no plan names keeps the safe default: covered by both, B's deny-path fires.
	const unnamed = edit(join(WT_C, "tests/x.spec.js"));
	expect(unnamed.code).toBe(2);
	expect(unnamed.d.reason).toContain("deny-path tests/**");
});
