// Plan 20261024_2155 (P2): `neurastream doctor` audits the notify setup. Problems: a secret file
// readable by group/others, a raw webhook URL in the config file, a secret file sitting next to
// config.yml. Warning: a configured secret file that is missing. Findings are matched by their
// "notify:" prefix and the file or host they name — never by wording.

import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doctorReport, type DoctorReport } from "../src/adapters/omp/doctor.ts";

const HOME = "/tmp/neurastream-home-notify-doctor";
const CONFIG_DIR = join(HOME, ".config/neurastream");
const SECRETS = join(CONFIG_DIR, "secrets");
const DISCORD = join(SECRETS, "discord-webhook");
const SLACK = join(SECRETS, "slack-webhook");
const CONFIG = join(CONFIG_DIR, "config.yml");

// No npm on PATH: the registry check degrades to its offline warning, deterministic and unrelated.
const ENV: NodeJS.ProcessEnv = { PATH: "/nonexistent" };
for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];

function fresh(): void {
	rmSync(HOME, { recursive: true, force: true });
	mkdirSync(SECRETS, { recursive: true });
	writeConfig("");
}

function writeConfig(notifyBody: string): void {
	writeFileSync(
		CONFIG,
		`paths:
  home: "${HOME}"
notify:
  discord_webhook_file: "${DISCORD}"
  slack_webhook_file: "${SLACK}"
${notifyBody}`,
	);
}

function seedSecrets(): void {
	writeFileSync(DISCORD, "local-test-only\n");
	writeFileSync(SLACK, "local-test-only\n");
	chmodSync(DISCORD, 0o600);
	chmodSync(SLACK, 0o600);
}

function report() {
	return doctorReport(HOME, ENV);
}

const notifyProblems = (r: DoctorReport): string[] => r.problems.filter(p => p.includes("notify:"));
const notifyWarnings = (r: DoctorReport): string[] => r.warnings.filter(w => w.includes("notify:"));

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});

test("mode 600 secret files in their own directory produce no notify finding", () => {
	fresh();
	seedSecrets();
	const r = report();
	expect(notifyProblems(r)).toEqual([]);
	expect(notifyWarnings(r)).toEqual([]);
});

test("a secret file readable by group/others is a problem", () => {
	fresh();
	seedSecrets();
	chmodSync(DISCORD, 0o644);
	const r = report();
	expect(notifyProblems(r).some(p => p.includes(DISCORD))).toBe(true);
});

test("a raw webhook URL in the config file is a problem, one per provider", () => {
	fresh();
	seedSecrets();
	// The URL rides in the *_webhook_file value itself — the shape a hand-edit produces.
	writeFileSync(
		CONFIG,
		`paths:
  home: "${HOME}"
notify:
  discord_webhook_file: "https://discord.com/api/webhooks/000000/test-only"
  slack_webhook_file: "${SLACK}"
`,
	);
	const r1 = report();
	expect(notifyProblems(r1).length).toBe(1);
	expect(notifyProblems(r1)[0]).toContain("discord");

	writeFileSync(
		CONFIG,
		`paths:
  home: "${HOME}"
notify:
  discord_webhook_file: "https://discord.com/api/webhooks/000000/test-only"
  slack_webhook_file: "https://hooks.slack.com/services/T000/B000/test-only"
`,
	);
	const r2 = report();
	expect(notifyProblems(r2).length).toBe(2);
	expect(notifyProblems(r2)[0]).toContain("discord");
	expect(notifyProblems(r2)[1]).toContain("slack");
});

test("a secret file next to config.yml is a problem", () => {
	fresh();
	const beside = join(CONFIG_DIR, "discord-webhook");
	writeFileSync(beside, "local-test-only\n");
	writeFileSync(SLACK, "local-test-only\n");
	chmodSync(beside, 0o600);
	chmodSync(SLACK, 0o600);
	writeFileSync(
		CONFIG,
		`paths:
  home: "${HOME}"
notify:
  discord_webhook_file: "${beside}"
  slack_webhook_file: "${SLACK}"
`,
	);
	const r = report();
	expect(notifyProblems(r).some(p => p.includes(beside))).toBe(true);
});

test("a configured secret file that is missing is a warning, not a problem", () => {
	fresh();
	writeFileSync(
		CONFIG,
		`paths:
  home: "${HOME}"
notify:
  discord_webhook_file: "${DISCORD}"
  slack_webhook_file: ""
`,
	);
	const r = report();
	expect(notifyProblems(r)).toEqual([]);
	expect(notifyWarnings(r).some(w => w.includes(DISCORD))).toBe(true);
});
