import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { doctorReport, pagesServiceStartMs } from "../src/adapters/omp/doctor.ts";
import { installOmp } from "../src/adapters/omp/install.ts";
import { configFile } from "../src/core/config.ts";
import { initHome } from "../src/cli/init.ts";

const HOME = "/tmp/neurastream-home-doctor";
const REPO = join(import.meta.dir, "..");
const CLI = join(REPO, "src/cli/main.ts");
// The live session exports QUEUE_* paths (QUEUE_INDEX ...); drop them so install and doctor use HOME only.
for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];

afterAll(() => {
	rmSync(HOME, { recursive: true, force: true });
});
const INSTALLED = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version as string;

function npmStub(body: string): string {
	const dir = join(HOME, "stub-bin");
	mkdirSync(dir, { recursive: true });
	const bin = join(dir, "npm");
	writeFileSync(bin, body);
	chmodSync(bin, 0o755);
	return dir;
}

function doctor(pathDir: string) {
	return spawnSync(process.execPath, [CLI, "doctor"], {
		encoding: "utf8",
		env: { ...process.env, HOME, PATH: `${pathDir}:${process.env.PATH ?? ""}` },
	});
}

function install(): void {
	rmSync(HOME, { recursive: true, force: true });
	initHome(HOME, { env: {} });
	installOmp(HOME);
}

test("clean install is ok", () => {
	install();
	const ran = doctor(npmStub(`#!/bin/sh\necho ${INSTALLED}\n`));
	expect(ran.stdout).toContain("neurastream doctor: ok");
	expect(ran.status).toBe(0);
});

test("a missing bin names the install step and exits 1", () => {
	install();
	const live = join(HOME, ".local/bin/queue-check");
	unlinkSync(live);
	const ran = doctor(npmStub(`#!/bin/sh\necho ${INSTALLED}\n`));
	expect(ran.status).toBe(1);
	expect(ran.stdout).toContain(`missing: ${live} — run: neurastream adapter install omp`);
});

test("an edited bin is named and exits 1", () => {
	install();
	const live = join(HOME, ".local/bin/queue-check");
	unlinkSync(live);
	writeFileSync(live, "#!/bin/sh\necho edited\n");
	chmodSync(live, 0o755);
	const ran = doctor(npmStub(`#!/bin/sh\necho ${INSTALLED}\n`));
	expect(ran.status).toBe(1);
	expect(ran.stdout).toContain(`hand-edited: ${live}`);
});

test("an older installed version exits 1", () => {
	install();
	const ran = doctor(npmStub("#!/bin/sh\necho 9.9.9\n"));
	expect(ran.status).toBe(1);
	expect(ran.stdout).toContain("stale version:");
	expect(ran.stdout).toContain("registry 9.9.9");
});

test("offline registry is a warning and does not fail a clean install", () => {
	install();
	const ran = doctor(npmStub("#!/bin/sh\necho offline >&2\nexit 1\n"));
	expect(ran.status).toBe(0);
	expect(ran.stdout).toContain("warning: offline:");
});

test("a removed shipped skill file is named and exits 1", () => {
	install();
	const skill = join(HOME, ".agents/skills/architecture-drilldown/SKILL.md");
	unlinkSync(skill);
	const ran = doctor(npmStub(`#!/bin/sh\necho ${INSTALLED}\n`));
	expect(ran.status).toBe(1);
	expect(ran.stdout).toContain(skill);
});

// P6 (plan 20261031_0917): a pages server started before the installed package changed keeps old
// code — the owner's tap hit the pre-0.2.57 handler and the approval was lost (2026-10-31 09:34).
const NO_TS = { ip4: () => "", dnsName: () => null, whois: () => null, logins: () => [] };

test("pagesServiceStartMs reads systemctl's local wall clock", () => {
	expect(pagesServiceStartMs(() => ({ status: 0, stderr: "", stdout: "Tue 2026-10-30 12:14:03 CET\n" }))).toBe(new Date(2026, 9, 30, 12, 14, 3).getTime());
	expect(pagesServiceStartMs(() => ({ status: 1, stderr: "" }))).toBe(null);
	expect(pagesServiceStartMs(() => ({ status: 0, stderr: "", stdout: "inactive\n" }))).toBe(null);
});

test("a pages server older than the installed package fails doctor", () => {
	install();
	const cfgFile = configFile(HOME);
	writeFileSync(cfgFile, `${readFileSync(cfgFile, "utf8")}\npages:\n  enabled: true\n`);
	const pkg = join(HOME, "stub-pkg", "package.json");
	mkdirSync(join(HOME, "stub-pkg"), { recursive: true });
	writeFileSync(pkg, JSON.stringify({ name: "neurastream", version: INSTALLED }));
	process.env.NEURASTREAM_PACKAGE_JSON = pkg;
	try {
		const stale = doctorReport(HOME, process.env, NO_TS, () => ({ status: 0, stderr: "", stdout: "Thu 2020-01-02 03:04:05 CET\n" }));
		expect(stale.problems.some(p => p.includes("systemctl --user restart neurastream-pages.service"))).toBe(true);
		const fresh = doctorReport(HOME, process.env, NO_TS, () => ({ status: 0, stderr: "", stdout: "Sun 2037-06-05 04:03:02 CEST\n" }));
		expect(fresh.problems.some(p => p.includes("neurastream-pages.service"))).toBe(false);
	} finally {
		delete process.env.NEURASTREAM_PACKAGE_JSON;
	}
});
