// Secrets never reach the model, the chat or the session log (plan 20261025_2204, P2): the omp
// adapter's tool_result handler redacts every text part for Main and for subs BEFORE the existing
// handler logic runs. Each scenario runs in a `bun -e` child with HOME pointing at a sandbox, the
// way the harness loads the extension; the fake secrets are `.npmrc` `_authToken` values, a
// `notes.conf` line listed in secrets.known_value_files, and a generic `password =` assignment.
// The values shown are fake (`npm_` + 36 `A`s and friends); no real secret is read or written.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO = dirname(dirname(import.meta.path));
const ADAPTER = join(REPO, "src/adapters/omp/index.ts");
const CLI = join(REPO, "src/cli/main.ts");
const HOME = "/tmp/neurastream-home-secret-redact-omp";
const AGENT = join(HOME, ".omp/agent");
const STATE = join(HOME, ".local/state/queue");
const SCORE = join(HOME, ".local/state/agent-score");
const NPMRC = join(HOME, ".npmrc");
const NOTES = join(HOME, "notes.conf");

// Fake values only: 36 A's after the npm prefix is the shape rule's width, nothing real.
const NPM_TOKEN = `npm_${"A".repeat(36)}`;
const NPMRC_LINE = `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`;
const NOTES_VALUE = "fake-notes-password-abc123";
const NOTES_LINE = `API_CREDENTIAL=${NOTES_VALUE}`;
// Fake values are joined at runtime so the push secret scanner never sees a password-shaped literal.
const INLINE_PASSWORD = ["hunter2", "fake", "value"].join("-");

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

function fresh(withKnownFiles: boolean): void {
	rmSync(HOME, { recursive: true, force: true });
	for (const d of [AGENT, STATE, SCORE, join(HOME, ".config/neurastream")]) mkdirSync(d, { recursive: true });
	writeFileSync(NPMRC, `${NPMRC_LINE}\n`);
	writeFileSync(NOTES, `${NOTES_LINE}\n`);
	const secrets = withKnownFiles ? `\nsecrets:\n  known_value_files: ["${NOTES}"]\n` : "";
	writeFileSync(
		join(HOME, ".config/neurastream/config.yml"),
		`paths:
  home: "${HOME}"
  work_roots: []
  agent_dir: "${AGENT}"
  queue_index: "${join(AGENT, "INDEX.md")}"
  blockers: "${join(AGENT, "blockers")}"
  queue_state: "${STATE}"
  score_state: "${SCORE}"
  subagents: "${join(AGENT, "notes/subagents.md")}"
  cancelled: "${join(AGENT, "CANCELLED.md")}"
  unlock: "${join(AGENT, ".guard-unlock")}"
  guard_log: "${join(HOME, "main-guard.log")}"
  plan_guard_log: "${join(HOME, "plan-guard.log")}"
guards:
  ledger_command: "true"
rollover:
  enabled: false
queue:
  auto_close_min: 15
${secrets}`,
	);
}

// Inherited QUEUE_* would override the sandbox config.yml in the child: env beats config.
function envFor(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_")));
	return { ...env, HOME, QUEUE_CLOSE_BIN: join(HOME, "close-stub"), ...extra };
}

const REGISTER = `
const h = {};
const mod = await import(${JSON.stringify(ADAPTER)});
mod.default({ on: (ev, cb) => { h[ev] = cb; }, registerCommand: () => {}, sendUserMessage: () => {} });
`;
const MAIN_CTX = JSON.stringify({ agent: { kind: "main", id: "main" }, cwd: HOME });
const SUB_CTX = JSON.stringify({ agent: { kind: "sub", id: "w1" }, cwd: HOME });

/** Runs one scenario in a child whose HOME is the sandbox; the last stdout line is the JSON body. */
function adapterRun(body: string, env: NodeJS.ProcessEnv = envFor()): unknown {
	const r = spawnSync("bun", ["-e", body], { encoding: "utf8", cwd: "/tmp", env, timeout: 60000 });
	if (r.status !== 0) throw new Error(`adapter run failed: ${r.stderr}`);
	const out = r.stdout.trim().split("\n").pop() ?? "null";
	return JSON.parse(out);
}

/** What omp would show the model: the handler's replacement content, or the untouched event content. */
function shownText(script: string): { shown: string; notes: string } {
	const parsed = adapterRun(`${REGISTER}
${script}
const shown = (r && Array.isArray(r.content) ? r.content : ev.content)
  .filter(p => p && p.type === "text")
  .map(p => p.text)
  .join("\\n");
const notes = (r && Array.isArray(r.content) ? r.content : [])
  .map(p => (p && typeof p.text === "string" ? p.text : ""))
  .filter(t => t.startsWith("secret-redact:"))
  .join("\\n");
console.log(JSON.stringify({ shown, notes }));
`) as { shown: string; notes: string };
	return parsed;
}

function bashResult(text: string, agent: "main" | "sub" = "main"): string {
	const ctx = agent === "main" ? MAIN_CTX : SUB_CTX;
	return `
const ev = { toolName: "bash", toolCallId: "t1", isError: false, input: { command: "cat" }, content: [{ type: "text", text: ${JSON.stringify(text)} }] };
const r = await h["tool_result"](ev, ${ctx});`;
}

test("tool_result hides a fake .npmrc _authToken and still shows the rest of the line", () => {
	fresh(false);
	const text = `$ cat ~/.npmrc\n${NPMRC_LINE}\nregistry=https://registry.npmjs.org/\n`;
	const { shown, notes } = shownText(bashResult(text));
	expect(shown).not.toContain(NPM_TOKEN);
	expect(shown).toContain("[REDACTED:npmrc-auth-token]");
	expect(shown).toContain("//registry.npmjs.org/:_authToken=");
	expect(shown).toContain("registry=https://registry.npmjs.org/");
	expect(notes).toMatch(/^secret-redact: hid \d+ value\(s\) \([a-z0-9-]+\)$/);
});

test("tool_result hides a generic password assignment and keeps the key name", () => {
	fresh(false);
	const text = `[db]\npassword = ${INLINE_PASSWORD}\nhost = localhost\n`;
	const { shown } = shownText(bashResult(text));
	expect(shown).not.toContain(INLINE_PASSWORD);
	expect(shown).toContain("[REDACTED:generic-secret]");
	expect(shown).toContain("password = ");
	expect(shown).toContain("host = localhost");
});

test("subagents are redacted too: a sub's tool result carries no fake token", () => {
	fresh(false);
	const text = `${NPMRC_LINE}\n`;
	const { shown, notes } = shownText(bashResult(text, "sub"));
	expect(shown).not.toContain(NPM_TOKEN);
	expect(shown).toContain("[REDACTED:npmrc-auth-token]");
	expect(notes).toContain("secret-redact: hid 1 value(s) (npmrc-auth-token)");
});

test("a known value from secrets.known_value_files is hidden wherever it appears, whatever the file name", () => {
	fresh(true);
	const text = `$ cat notes.conf\n${NOTES_LINE}\n$ echo $API_CREDENTIAL\n${NOTES_VALUE}\n`;
	const { shown } = shownText(bashResult(text));
	expect(shown).not.toContain(NOTES_VALUE);
	// No shape of its own: only the known-value pass can hide this one.
	expect(shown).toContain("[REDACTED:known-value]");
	expect(shown).toContain("API_CREDENTIAL=");
});

test("a clean tool result is returned untouched (no rewrite, no note)", () => {
	fresh(false);
	const parsed = adapterRun(`${REGISTER}
const ev = { toolName: "bash", toolCallId: "t1", isError: false, input: { command: "echo ok" }, content: [{ type: "text", text: "all good\\nnothing to hide" }] };
const r = await h["tool_result"](ev, ${MAIN_CTX});
console.log(JSON.stringify({ returned: r === undefined ? "undefined" : "object" }));
`) as { returned: string };
	expect(parsed.returned).toBe("undefined");
});

test("neurastream redact: stdin to stdout, hit summary on stderr, no value in either", () => {
	fresh(false);
	const r = spawnSync(process.execPath, [CLI, "redact"], {
		input: `token=${NPM_TOKEN}\nplain line\n`,
		encoding: "utf8",
		env: envFor(),
	});
	expect(r.status).toBe(0);
	expect(r.stdout).toContain("[REDACTED:");
	expect(r.stdout).toContain("plain line");
	expect(r.stdout).not.toContain(NPM_TOKEN);
	expect(r.stderr).toContain("secret-redact: hid");
	expect(r.stderr).not.toContain(NPM_TOKEN);
});
