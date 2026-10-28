import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installOmp } from "../src/adapters/omp/install.ts";
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
