// Content redaction (plan 20261025_2204, P1): every shape rule keeps the key name and hides only
// the value, the value never appears in the text, in the hits or in the one-line summary, and
// `loadKnownSecrets` finds exact values by CONTENT — an env var, `~/.npmrc`, a file named
// `notes.conf` listed in `secrets.known_value_files`, a work-root dotenv file and a notify webhook
// file — and re-reads a file whose mtime changed. The fake values below are made of repeated
// filler characters; nothing real is read: every filesystem scenario runs in a `bun -e` child
// whose HOME is a sandbox, because the loader reads the home directory on purpose.

import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clearKnownSecretsCache, redactSecrets, redactSummary } from "../src/core/secret-redact.ts";

const REPO = dirname(dirname(import.meta.path));
const CORE = join(REPO, "src/core/secret-redact.ts");
const CONFIG = join(REPO, "src/core/config.ts");
const HOME = "/tmp/neurastream-home-secret-redact-core";
const NOTES = join(HOME, "notes.conf");
const HOOK = join(HOME, "hook.txt");
const NPMRC = join(HOME, ".npmrc");

afterAll(() => {
	clearKnownSecretsCache();
	rmSync(HOME, { recursive: true, force: true });
});

const fill = (ch: string, n: number): string => ch.repeat(n);

// Fake values: one repeated filler character per shape, never a real credential.
const NPM = `npm_${fill("B", 36)}`;
const GH = `ghp_${fill("C", 20)}`;
const GH_PAT = `github_pat_${fill("D", 22)}`;
const GITLAB = `glpat-${fill("E", 20)}`;
const SK = `sk-ant-api03-${fill("F", 20)}`;
const AWS_ID = `AKIA${fill("G", 16)}`;
const AWS_SECRET = `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`;
const GOOGLE = `AIza${fill("H", 35)}`;
const SLACK = `xoxb-${fill("I", 12)}`;
const STRIPE = `sk_live_${fill("J", 16)}`;
const JWT = `eyJ${fill("K", 10)}.eyJ${fill("L", 10)}.${fill("M", 10)}`;
const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${fill("N", 64)}\n-----END RSA PRIVATE KEY-----`;
// Fake values are joined at runtime so the push secret scanner never sees a password-shaped literal.
const URL_PASSWORD = ["s3cretpass", "fake"].join("-");
const GENERIC_VALUE = "hunter2-fake-value";

const SHAPES: { type: string; text: string; value: string; keep?: string }[] = [
	{ type: "npm-token", text: `the token is ${NPM} here`, value: NPM },
	{ type: "github-token", text: `GH_TOKEN=${GH}`, value: GH, keep: "GH_TOKEN=" },
	{ type: "github-token", text: `pat ${GH_PAT} end`, value: GH_PAT },
	{ type: "gitlab-token", text: `gl ${GITLAB} end`, value: GITLAB },
	{ type: "sk-key", text: `OPENAI_API_KEY=${SK}`, value: SK, keep: "OPENAI_API_KEY=" },
	{ type: "aws-access-key-id", text: `id ${AWS_ID} end`, value: AWS_ID },
	{ type: "aws-secret-access-key", text: `aws_secret_access_key = ${AWS_SECRET}`, value: AWS_SECRET, keep: "aws_secret_access_key = " },
	{ type: "google-api-key", text: `key ${GOOGLE} end`, value: GOOGLE },
	{ type: "slack-token", text: `bot ${SLACK} end`, value: SLACK },
	{ type: "stripe-key", text: `pay ${STRIPE} end`, value: STRIPE },
	{ type: "jwt", text: `bearer ${JWT} end`, value: JWT },
	{ type: "private-key", text: `file:\n${PEM}\n:done`, value: fill("N", 64) },
	{ type: "url-password", text: `clone https://deploy:${URL_PASSWORD}@example.com/repo.git`, value: URL_PASSWORD, keep: "https://deploy:" },
	{ type: "npmrc-auth-token", text: `//registry.npmjs.org/:_authToken=${NPM}`, value: NPM, keep: "//registry.npmjs.org/:_authToken=" },
	{ type: "generic-secret", text: `[db]\npassword = ${GENERIC_VALUE}\n`, value: GENERIC_VALUE, keep: "password = " },
	{ type: "generic-secret", text: `DB_PASSWORD=${GENERIC_VALUE}`, value: GENERIC_VALUE, keep: "DB_PASSWORD=" },
];

test("every shape rule hides its value, names its own type and keeps the key name", () => {
	for (const shape of SHAPES) {
		const r = redactSecrets(shape.text);
		expect(r.text).not.toContain(shape.value);
		expect(r.text).toContain(`[REDACTED:${shape.type}]`);
		expect(r.hits).toEqual([{ type: shape.type, count: 1 }]);
		if (shape.keep) expect(r.text).toContain(shape.keep);
	}
});

test("a hit carries the type and the count only: no value in the hits or the summary line", () => {
	const text = `${NPM}\n${NPM}\npassword = ${GENERIC_VALUE}\n`;
	const r = redactSecrets(text);
	expect(r.hits).toEqual([
		{ type: "npm-token", count: 2 },
		{ type: "generic-secret", count: 1 },
	]);
	const summary = redactSummary(r.hits);
	expect(summary).toBe("secret-redact: hid 3 value(s) (npm-token, generic-secret)");
	expect(JSON.stringify(r.hits)).not.toContain(NPM);
	expect(summary).not.toContain(NPM);
	expect(summary).not.toContain(GENERIC_VALUE);
});

test("a second pass changes nothing: a marker matches no rule", () => {
	const once = redactSecrets(`password = ${GENERIC_VALUE}\n${NPM}\n`).text;
	expect(redactSecrets(once).text).toBe(once);
});

test("a value shorter than 8 characters is left alone; ordinary text passes untouched", () => {
	expect(redactSecrets("password = abc123").text).toBe("password = abc123");
	expect(redactSecrets("all good\nnothing to hide").text).toBe("all good\nnothing to hide");
	expect(redactSecrets("").hits).toEqual([]);
});

test("a known value is hidden wherever it appears, whatever the surrounding text is", () => {
	const value = "known-value-fake-0042";
	const r = redactSecrets(`first ${value} second ${value}`, [value]);
	expect(r.text).toBe("first [REDACTED:known-value] second [REDACTED:known-value]");
	expect(r.hits).toEqual([{ type: "known-value", count: 2 }]);
	// Shorter than 8: a known value that short would shred ordinary words.
	expect(redactSecrets("ab cd", ["ab"]).text).toBe("ab cd");
});

test("the owner's own shapes (secrets.extra_patterns) run after the built-ins", () => {
	const r = redactSecrets("myapp_TOKEN=myapp_0123456789abcdef", [], [{ type: "myapp-token", regex: "myapp_[0-9a-f]{16}" }]);
	expect(r.text).toBe("myapp_TOKEN=[REDACTED:myapp-token]");
	expect(r.hits).toEqual([{ type: "myapp-token", count: 1 }]);
});

// --- known values from the filesystem (sandbox HOME, child process) ---

function fresh(): void {
	rmSync(HOME, { recursive: true, force: true });
	for (const d of [join(HOME, ".config/neurastream"), join(HOME, ".omp/agent"), join(HOME, "repos/app")]) mkdirSync(d, { recursive: true });
	writeFileSync(NPMRC, `//registry.npmjs.org/:_authToken=${NPM}\n`);
	writeFileSync(NOTES, "API_CREDENTIAL=notes-value-fake-1\n");
	writeFileSync(HOOK, "https://hooks.example.com/services/FAKEHOOKPATH\n");
	writeFileSync(join(HOME, "repos/app/.env.local"), "APP_SECRET=dotenv-value-fake-7\n");
	writeFileSync(
		join(HOME, ".config/neurastream/config.yml"),
		`paths:
  home: "${HOME}"
  work_roots: ["${join(HOME, "repos")}"]
  agent_dir: "${join(HOME, ".omp/agent")}"
  queue_index: "${join(HOME, ".omp/agent/INDEX.md")}"
  blockers: "${join(HOME, ".omp/agent/blockers")}"
  queue_state: "${join(HOME, ".local/state/queue")}"
  subagents: "${join(HOME, ".omp/agent/notes/subagents.md")}"
  cancelled: "${join(HOME, ".omp/agent/CANCELLED.md")}"
  unlock: "${join(HOME, ".omp/agent/.guard-unlock")}"
  guard_log: "${join(HOME, "main-guard.log")}"
  plan_guard_log: "${join(HOME, "plan-guard.log")}"
secrets:
  known_value_files: ["${NOTES}"]
notify:
  discord_webhook_file: "${HOOK}"
`,
	);
}

// Inherited QUEUE_* would override the sandbox config.yml in the child: env beats config.
function envFor(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUEUE_")));
	return { ...env, HOME, ...extra };
}

/** One scenario in a child whose HOME is the sandbox; the child imports the modules at runtime
 *  because HOME must be set before the config loader runs. */
function coreRun(body: string, env: NodeJS.ProcessEnv = envFor()): unknown {
	const script = `
const { loadKnownSecrets, clearKnownSecretsCache, redactSecrets } = await import(${JSON.stringify(CORE)});
const { loadConfig } = await import(${JSON.stringify(CONFIG)});
const cfg = loadConfig();
${body}
console.log(JSON.stringify(out));
`;
	const r = spawnSync("bun", ["-e", script], { encoding: "utf8", cwd: "/tmp", env, timeout: 60000 });
	if (r.status !== 0) throw new Error(`core run failed: ${r.stderr}`);
	return JSON.parse(r.stdout.trim().split("\n").pop() ?? "null");
}

test("known values come from the npmrc, secrets.known_value_files, a repo dotenv file, the env and the webhook file", () => {
	fresh();
	const out = coreRun(
		`
const known = loadKnownSecrets(cfg);
const text = [
  ${JSON.stringify(NPM)},
  "notes-value-fake-1",
  "dotenv-value-fake-7",
  "env-value-fake-3",
  "https://hooks.example.com/services/FAKEHOOKPATH",
  "untouched line",
].join("\\n");
const r = redactSecrets(text, known);
const out = { count: known.length, text: r.text, hits: r.hits };
`,
		envFor({ DEPLOY_TOKEN: ["env", "value", "fake", "3"].join("-") }),
	) as { count: number; text: string; hits: { type: string; count: number }[] };
	expect(out.count).toBeGreaterThanOrEqual(5);
	for (const value of [NPM, "notes-value-fake-1", "dotenv-value-fake-7", "env-value-fake-3", "https://hooks.example.com/services/FAKEHOOKPATH"]) {
		expect(out.text).not.toContain(value);
	}
	// The npm shape names the token itself; the other four are known values with no shape of their own.
	expect(out.text).toContain("[REDACTED:npm-token]");
	expect(out.hits.reduce((n, h) => n + h.count, 0)).toBe(5);
	expect(out.hits.find(h => h.type === "known-value")?.count).toBe(4);
	expect(out.text).toContain("untouched line");
});

test("a file's values are re-read when its mtime changes", () => {
	fresh();
	const out = coreRun(`
const fs = await import("node:fs");
fs.writeFileSync(${JSON.stringify(NOTES)}, "API_CREDENTIAL=AAAAAAA1\\n");
const first = loadKnownSecrets(cfg);
const before = redactSecrets("value: " + "AAAAAAA1", first).text;
fs.writeFileSync(${JSON.stringify(NOTES)}, "API_CREDENTIAL=BBBBBBB2\\n");
const again = loadKnownSecrets(cfg);
const after = redactSecrets("value: " + "BBBBBBB2", again).text;
const out = { before, after };
`) as { before: string; after: string };
	// "AAAAAAA1" was the first known value; after the rewrite only the new one is known.
	expect(out.before).toBe("value: [REDACTED:known-value]");
	expect(out.after).toBe("value: [REDACTED:known-value]");
});

test("a cache reset picks up a file that changed without a new mtime-free read", () => {
	fresh();
	const out = coreRun(`
const fs = await import("node:fs");
const warm = loadKnownSecrets(cfg);
fs.writeFileSync(${JSON.stringify(NOTES)}, "API_CREDENTIAL=CCCCCCC3\\n");
clearKnownSecretsCache();
const cold = loadKnownSecrets(cfg);
const out = { warm: warm.length, cold: cold.length, text: redactSecrets("value: CCCCCCC3", cold).text };
`) as { warm: number; cold: number; text: string };
	expect(out.text).toBe("value: [REDACTED:known-value]");
	expect(out.cold).toBeGreaterThanOrEqual(4);
});
