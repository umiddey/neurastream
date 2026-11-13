// `neurastream workspace on|off` (plan 20261025_0300_ui_on_off, renamed from `ui`): one command
// sets the config, installs the systemd user unit, starts it and prints the phone link; `off`
// undoes it. Every test runs against a temp HOME with a fake runner that only records argv and a
// Tailscale fixture, so nothing here calls systemctl, the real tailscale binary, or touches the
// live config.

import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { uiOff, uiOn, type Runner } from "../src/core/ui-setup.ts";
import { runWorkspace } from "../src/cli/workspace.ts";
import { run } from "../src/cli/dispatch.ts";
import type { OwnerUiServer } from "../src/core/owner-ui.ts";
import { parseBackendState, type Tailscale } from "../src/core/tailscale.ts";

const TMP = mkdtempSync(join(tmpdir(), "workspace-on-off-"));
const HOME = join(TMP, "home");
const CONFIG_FILE = join(HOME, ".config/neurastream/config.yml");
const UNIT_FILE = join(HOME, ".config/systemd/user/neurastream-workspace.service");
const OLD_UNIT_FILE = join(HOME, ".config/systemd/user/neurastream-ui.service");
const UNIT_TEMPLATE = join(import.meta.dir, "..", "templates/systemd/neurastream-workspace.service");
const LOGIN = "a@b.c";
const DNS_NAME = "ukd.tailc0aee7.ts.net";
const OTHER_LOGINS = ["someoneelse@example.com", "third@example.com"];

// The caller's shell may export live QUEUE_* (omp's plugin does, to every child); save and
// delete them up front so loadConfig sees no live overrides, and put them back at the end
// (same pattern as tests/owner-ui.test.ts:31-36 and tests/guards-scope.test.ts:107-111).
const queueEnvBefore = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("QUEUE_")));
for (const k of Object.keys(queueEnvBefore)) delete process.env[k];

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
	Object.assign(process.env, queueEnvBefore);
});

beforeEach(() => {
	rmSync(HOME, { recursive: true, force: true });
	mkdirSync(HOME, { recursive: true });
});

function fakeRunner(fail: { call?: number; stderr?: string } = {}): { runner: Runner; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		runner: args => {
			calls.push(args);
			const failing = fail.call !== undefined && calls.length === fail.call;
			return { status: failing ? 1 : 0, stderr: failing ? (fail.stderr ?? "systemctl: failed") : "" };
		},
	};
}

function fixtureTailscale(over: Partial<Tailscale> = {}): Tailscale {
	return {
		ip4: () => "100.64.0.9",
		state: () => "running",
		dnsName: () => DNS_NAME,
		whois: () => null,
		logins: () => [LOGIN, ...OTHER_LOGINS],
		...over,
	};
}

function writeConfig(text: string): void {
	mkdirSync(dirname(CONFIG_FILE), { recursive: true });
	writeFileSync(CONFIG_FILE, text);
}

function readConfig(): string | null {
	return existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, "utf8") : null;
}

interface OnResult {
	code: number;
	out: string[];
	err: string[];
	calls: string[][];
}

function doOn(opts: { port?: number | null; tailscale?: Tailscale; fail?: { call?: number; stderr?: string } } = {}): OnResult {
	const { runner, calls } = fakeRunner(opts.fail);
	const out: string[] = [];
	const err: string[] = [];
	const code = uiOn({
		login: LOGIN,
		port: opts.port ?? null,
		home: HOME,
		runner,
		tailscale: opts.tailscale ?? fixtureTailscale(),
		print: l => out.push(l),
		error: l => err.push(l),
	});
	return { code, out, err, calls };
}

// --- (a) a config with no workspace block gets one appended, byte-identical otherwise ---

test("workspace on: appends a workspace block to a config that has none and keeps every other line", () => {
	const before = `paths:\n  queue_state: "q"\n\n# a comment the owner wrote\n`;
	writeConfig(before);
	const r = doOn();
	expect(r.code).toBe(0);
	expect(readConfig()).toBe(`${before}workspace:\n  enabled: true\n  owner_login: ${LOGIN}\n`);
});

// --- (b) an existing workspace block: only enabled/owner_login change, port and the rest stay ---

test("workspace on: rewrites only enabled and owner_login inside an existing workspace block", () => {
	const before = [
		"paths:",
		'  queue_state: "q"',
		"# the owner page",
		"workspace:",
		"  # off until the owner runs the command",
		"  enabled: false",
		"  port: 7787",
		'  owner_login: ""',
		"",
		"quota:",
		'  label: "quota"',
		"",
	].join("\n");
	writeConfig(before);
	const r = doOn();
	expect(r.code).toBe(0);
	expect(readConfig()).toBe(
		[
			"paths:",
			'  queue_state: "q"',
			"# the owner page",
			"workspace:",
			"  # off until the owner runs the command",
			"  enabled: true",
			"  port: 7787",
			`  owner_login: ${LOGIN}`,
			"",
			"quota:",
			'  label: "quota"',
			"",
		].join("\n"),
	);
});

// --- (c) --port writes the port line ---

test("workspace on: --port rewrites the port line and leaves the rest of the block alone", () => {
	const before = `workspace:\n  enabled: false\n  port: 7787\n  owner_login: ""\n`;
	writeConfig(before);
	const r = doOn({ port: 7790 });
	expect(r.code).toBe(0);
	expect(readConfig()).toBe(`workspace:\n  enabled: true\n  port: 7790\n  owner_login: ${LOGIN}\n`);
});

// --- (d) the unit file is the package template ---

test("workspace on: installs the user unit from the package template", () => {
	writeConfig(`workspace:\n  enabled: false\n`);
	const r = doOn();
	expect(r.code).toBe(0);
	expect(readFileSync(UNIT_FILE, "utf8")).toBe(readFileSync(UNIT_TEMPLATE, "utf8"));
});

// --- (e) the systemctl calls, in order; the pre-rename neurastream-ui unit is retired first ---

test("workspace on: disables the old neurastream-ui unit, then daemon-reload, enable, restart of neurastream-workspace — in that order", () => {
	writeConfig(`workspace:\n  enabled: false\n`);
	const r = doOn();
	expect(r.code).toBe(0);
	expect(r.calls).toEqual([
		["systemctl", "--user", "disable", "--now", "neurastream-ui"],
		["systemctl", "--user", "daemon-reload"],
		["systemctl", "--user", "enable", "neurastream-workspace"],
		["systemctl", "--user", "restart", "neurastream-workspace"],
	]);
});

test("workspace on: removes a left-over pre-rename neurastream-ui unit file", () => {
	writeConfig(`workspace:\n  enabled: false\n`);
	mkdirSync(dirname(OLD_UNIT_FILE), { recursive: true });
	writeFileSync(OLD_UNIT_FILE, "old unit");
	const r = doOn();
	expect(r.code).toBe(0);
	expect(existsSync(OLD_UNIT_FILE)).toBe(false);
});

// The old unit usually is not installed (or systemctl already forgot it): the disable is best
// effort — a failure there never fails the command.
test("workspace on: a failing old-unit disable does not fail the command", () => {
	writeConfig(`workspace:\n  enabled: false\n  owner_login: ""\n`);
	const r = doOn({ fail: { call: 1 } });
	expect(r.code).toBe(0);
	expect(readConfig()).toBe(`workspace:\n  enabled: true\n  owner_login: ${LOGIN}\n`);
});

// An installed old unit that cannot be stopped would keep running beside the new one: refuse, and change nothing.
test("workspace on: a failing old-unit disable refuses the command when the old unit file is installed", () => {
	writeConfig(`workspace:\n  enabled: false\n`);
	mkdirSync(dirname(OLD_UNIT_FILE), { recursive: true });
	writeFileSync(OLD_UNIT_FILE, "old unit");
	const r = doOn({ fail: { call: 1 } });
	expect(r.code).toBe(1);
	expect(r.err.join("\n")).toMatch(/neurastream-ui/);
	expect(r.calls).toHaveLength(1);
	expect(existsSync(OLD_UNIT_FILE)).toBe(true);
	expect(existsSync(UNIT_FILE)).toBe(false);
	expect(readConfig()).toBe(`workspace:\n  enabled: false\n`);
});

// --- (f) stdout prints the phone link ---

test("workspace on: prints http://<MagicDNS name>:<port>", () => {
	writeConfig(`workspace:\n  enabled: false\n`);
	const r = doOn();
	expect(r.code).toBe(0);
	expect(r.out).toContain(`http://${DNS_NAME}:7787`);
});

// --- (g) a missing --login is refused before anything happens ---

test("workspace on without --login exits 1, writes nothing and runs nothing", async () => {
	let started = 0;
	const { runner, calls } = fakeRunner();
	const code = await runWorkspace(["on", "--port", "7790"], {
		runner,
		tailscale: fixtureTailscale(),
		home: HOME,
		start: (): OwnerUiServer => {
			started++;
			throw new Error("workspace on must not start the page");
		},
	});
	expect(code).toBe(1);
	expect(started).toBe(0);
	expect(calls).toEqual([]);
	expect(readConfig()).toBe(null);
});

// --- (h) a login the tailnet does not know ---

test("workspace on: an unknown login exits 1 naming the logins seen, and writes and runs nothing", () => {
	const before = `workspace:\n  enabled: false\n  owner_login: ""\n`;
	writeConfig(before);
	const r = doOn({ tailscale: fixtureTailscale({ logins: () => OTHER_LOGINS }) });
	expect(r.code).toBe(1);
	for (const login of OTHER_LOGINS) expect(r.err.join("\n")).toContain(login);
	expect(readConfig()).toBe(before);
	expect(r.calls).toEqual([]);
});

// --- (i) a systemctl failure leaves the config exactly as it was (P5e: the config is written
// only after systemctl succeeds; a leftover unit file is fine) ---

test("workspace on: a failed restart exits 1 with its stderr and leaves the config as it was", () => {
	const stderr = "Failed to restart neurastream-workspace.service: Unit neurastream-workspace.service not found.";
	const before = `workspace:\n  enabled: false\n  owner_login: ""\n`;
	writeConfig(before);
	const r = doOn({ fail: { call: 4, stderr } });
	expect(r.code).toBe(1);
	expect(r.err.join("\n")).toContain(stderr);
	expect(readConfig()).toBe(before);
});

test("workspace on: a failed systemctl writes no config when there was none (the unit file may stay)", () => {
	const r = doOn({ fail: { call: 4 } });
	expect(r.code).toBe(1);
	expect(readConfig()).toBe(null);
	expect(existsSync(UNIT_FILE)).toBe(true);
});

// --- (j) off stops the unit and flips enabled back ---

test("workspace off: disables the unit and sets enabled false, keeping owner_login", () => {
	const before = `workspace:\n  enabled: true\n  port: 7787\n  owner_login: ${LOGIN}\n`;
	writeConfig(before);
	const { runner, calls } = fakeRunner();
	const err: string[] = [];
	const code = uiOff({
		home: HOME,
		runner,
		error: l => err.push(l),
	});
	expect(code).toBe(0);
	expect(err).toEqual([]);
	expect(calls).toEqual([["systemctl", "--user", "disable", "--now", "neurastream-workspace"]]);
	expect(readConfig()).toBe(`workspace:\n  enabled: false\n  port: 7787\n  owner_login: ${LOGIN}\n`);
});

// --- (k) a config the edited text cannot load: exit 1, file untouched ---

test("workspace on: a config that cannot load exits 1 and leaves the file byte-for-byte", () => {
	const before = `bogus_key: 1\nworkspace:\n  enabled: false\n  owner_login: ""\n`;
	writeConfig(before);
	const r = doOn();
	expect(r.code).toBe(1);
	expect(readConfig()).toBe(before);
	expect(r.calls).toEqual([]);
});

// --- (l) tailscale state is checked first: missing or stopped writes and runs nothing and names the fix ---

const OFF_CONFIG = `workspace:\n  enabled: false\n  owner_login: ""\n`;

test("workspace on: tailscale missing exits 1 with the install command, writes and runs nothing", () => {
	writeConfig(OFF_CONFIG);
	const r = doOn({ tailscale: fixtureTailscale({ state: () => "missing" }) });
	expect(r.code).toBe(1);
	expect(r.err.join("\n")).toContain("curl -fsSL https://tailscale.com/install.sh | sh");
	expect(readConfig()).toBe(OFF_CONFIG);
	expect(r.calls).toEqual([]);
});

test("workspace on: tailscale installed but stopped exits 1 with the connect command, writes and runs nothing", () => {
	writeConfig(OFF_CONFIG);
	const r = doOn({ tailscale: fixtureTailscale({ state: () => "stopped" }) });
	expect(r.code).toBe(1);
	expect(r.err.join("\n")).toContain("sudo tailscale up");
	expect(readConfig()).toBe(OFF_CONFIG);
	expect(r.calls).toEqual([]);
});

test("workspace on: tailscale running but the login is not on the tailnet exits 1 naming the logins, writes and runs nothing", () => {
	writeConfig(OFF_CONFIG);
	const r = doOn({ tailscale: fixtureTailscale({ state: () => "running", logins: () => OTHER_LOGINS }) });
	expect(r.code).toBe(1);
	for (const login of OTHER_LOGINS) expect(r.err.join("\n")).toContain(login);
	expect(readConfig()).toBe(OFF_CONFIG);
	expect(r.calls).toEqual([]);
});

test("workspace on: tailscale running with the owner's login writes the config, runs the unit and prints the link", () => {
	writeConfig(OFF_CONFIG);
	const r = doOn({ tailscale: fixtureTailscale({ state: () => "running" }) });
	expect(r.code).toBe(0);
	expect(readConfig()).toContain(LOGIN);
	expect(r.calls.length).toBe(4);
	expect(r.out.join("\n")).toContain(`http://${DNS_NAME}:`);
});

test("workspace on: missing tailscale on a terminal asks, and y opens the download page; nothing is written", () => {
	writeConfig(OFF_CONFIG);
	const asked: string[] = [];
	const opened: string[] = [];
	const err: string[] = [];
	const code = uiOn({
		login: LOGIN,
		home: HOME,
		runner: fakeRunner().runner,
		tailscale: fixtureTailscale({ state: () => "missing" }),
		print: () => {},
		error: l => err.push(l),
		terminal: { ask: q => { asked.push(q); return "y"; }, open: url => { opened.push(url); } },
	});
	expect(code).toBe(1);
	expect(asked).toEqual(["Open the Tailscale download page now? [y/N] "]);
	expect(opened).toEqual(["https://tailscale.com/download"]);
	expect(err.join("\n")).toContain("curl -fsSL https://tailscale.com/install.sh | sh");
	expect(readConfig()).toBe(OFF_CONFIG);
});

test("workspace on: a answer other than y on the missing-tailscale prompt opens nothing", () => {
	writeConfig(OFF_CONFIG);
	const opened: string[] = [];
	const code = uiOn({
		login: LOGIN,
		home: HOME,
		runner: fakeRunner().runner,
		tailscale: fixtureTailscale({ state: () => "missing" }),
		print: () => {},
		error: () => {},
		terminal: { ask: () => "", open: url => { opened.push(url); } },
	});
	expect(code).toBe(1);
	expect(opened).toEqual([]);
	expect(readConfig()).toBe(OFF_CONFIG);
});

// --- (m) clean cutover: the pre-rename command is an unknown command, bad args are a usage error ---

test("the pre-rename `neurastream ui` command is unknown (exit 2)", async () => {
	const err: string[] = [];
	const original = console.error;
	console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
	try {
		expect(await run("ui", [])).toBe(2);
	} finally {
		console.error = original;
	}
	expect(err.join("\n")).toContain("unknown command ui");
});

test("workspace with an unknown argument is a usage error (exit 2)", async () => {
	const err: string[] = [];
	const original = console.error;
	console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
	try {
		expect(await runWorkspace(["start"], { runner: fakeRunner().runner, tailscale: fixtureTailscale(), home: HOME })).toBe(2);
	} finally {
		console.error = original;
	}
	expect(err.join("\n")).toContain("usage: neurastream workspace");
});

test("tailscale status: only BackendState Running counts as running; everything else is stopped", () => {
	expect(parseBackendState(JSON.stringify({ BackendState: "Running" }))).toBe("running");
	expect(parseBackendState(JSON.stringify({ BackendState: "NeedsLogin" }))).toBe("stopped");
	expect(parseBackendState("not json")).toBe("stopped");
	expect(parseBackendState("null")).toBe("stopped");
});
