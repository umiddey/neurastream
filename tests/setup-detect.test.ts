// `neurastream setup` detection (plan 20261028_2356 P3): detect(seams) reads the machine through
// injected seams only. Every test runs against a temp HOME fixture with a fake PATH lookup, a
// fake Tailscale and fixed os facts, so nothing reads the real home, the real PATH or the tailnet.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configFile, loadConfig } from "../src/core/config.ts";
import { detect, realSeams, type SetupSeams } from "../src/core/setup-detect.ts";
import type { Tailscale, TailscaleState } from "../src/core/tailscale.ts";

const TMP = mkdtempSync(join(tmpdir(), "setup-detect-"));
afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

let fixtures = 0;
function fixtureHome(): string {
	const home = join(TMP, `home-${fixtures++}`);
	mkdirSync(home, { recursive: true });
	return home;
}

// A repo is a directory with a .git entry; mkdir -p the path and drop the .git dir in it.
function repoAt(...parts: string[]): void {
	mkdirSync(join(...parts, ".git"), { recursive: true });
}

function fakeTailscale(state: TailscaleState, logins: string[] | null = []): Tailscale {
	return { ip4: () => null, dnsName: () => null, whois: () => null, logins: () => logins, state: () => state };
}

function seams(home: string, over: Partial<SetupSeams> = {}): SetupSeams {
	return {
		home,
		onPath: () => false,
		harnesses: [],
		tailscale: fakeTailscale("running"),
		os: { cores: 8, ramMb: 16384, diskFreeGb: 200 },
		...over,
	};
}

test("(a) a HOME child with a git repo one level below is a work root", () => {
	const home = fixtureHome();
	repoAt(home, "projects", "neurastream");
	expect(detect(seams(home)).workRoots).toEqual([join(home, "projects")]);
});

test("(a) a HOME child with no git repo below is NOT a work root", () => {
	const home = fixtureHome();
	mkdirSync(join(home, "Downloads"), { recursive: true });
	writeFileSync(join(home, "Downloads", "notes.txt"), "x");
	repoAt(home, "misc", "deep", "repo"); // a repo two levels below is not one level down
	expect(detect(seams(home)).workRoots).toEqual([]);
});

test("(a) a dot-directory with a repo below is NOT a work root", () => {
	const home = fixtureHome();
	repoAt(home, ".cache", "tool");
	expect(detect(seams(home)).workRoots).toEqual([]);
});

test("(a) work roots are the sorted HOME children that hold a repo one level down", () => {
	const home = fixtureHome();
	repoAt(home, "projects", "a");
	repoAt(home, "Work", "b");
	mkdirSync(join(home, "empty"), { recursive: true });
	expect(detect(seams(home)).workRoots).toEqual([join(home, "Work"), join(home, "projects")]);
});

test("(b) an adapter whose binary is not on PATH is not listed", () => {
	const home = fixtureHome();
	const facts = detect(
		seams(home, {
			harnesses: [
				{ name: "alpha", bin: "alpha-bin" },
				{ name: "beta", bin: "beta-bin" },
			],
			onPath: bin => bin === "alpha-bin",
		}),
	);
	expect(facts.harnesses).toEqual(["alpha"]);
});

test("(b) no adapter binary on PATH lists no harness", () => {
	const home = fixtureHome();
	expect(detect(seams(home, { harnesses: [{ name: "alpha", bin: "alpha-bin" }] })).harnesses).toEqual([]);
});

test("(c) Tailscale state and login list come from the Tailscale seam", () => {
	const home = fixtureHome();
	expect(detect(seams(home, { tailscale: fakeTailscale("stopped", null) })).tailscale).toEqual({ state: "stopped", logins: null });
	expect(detect(seams(home, { tailscale: fakeTailscale("running", ["owner@example.com"]) })).tailscale).toEqual({
		state: "running",
		logins: ["owner@example.com"],
	});
	expect(detect(seams(home, { tailscale: fakeTailscale("missing", []) })).tailscale.state).toBe("missing");
});

test("(d) avail_min_mb proposes 10% of RAM", () => {
	const home = fixtureHome();
	expect(detect(seams(home, { os: { cores: 8, ramMb: 65536, diskFreeGb: 200 } })).proposed.avail_min_mb).toBe(6554);
});

test("(d) avail_min_mb proposes at least 1024 on a small machine", () => {
	const home = fixtureHome();
	expect(detect(seams(home, { os: { cores: 2, ramMb: 4096, diskFreeGb: 200 } })).proposed.avail_min_mb).toBe(1024);
});

test("(d) load_over_cores and disk_min_gb start from the shipped defaults", () => {
	const home = fixtureHome();
	const shipped = loadConfig({ home, env: {} }).machine;
	const proposed = detect(seams(home, { os: { cores: 8, ramMb: 16384, diskFreeGb: 200 } })).proposed;
	expect(proposed.load_over_cores).toBe(shipped.load_over_cores);
	expect(proposed.disk_min_gb).toBe(shipped.disk_min_gb);
});

test("(d) disk_min_gb is capped at 10% of free disk, never below 1", () => {
	const home = fixtureHome();
	const shipped = loadConfig({ home, env: {} }).machine.disk_min_gb;
	expect(shipped).toBeGreaterThan(5);
	expect(detect(seams(home, { os: { cores: 8, ramMb: 16384, diskFreeGb: 50 } })).proposed.disk_min_gb).toBe(5);
	expect(detect(seams(home, { os: { cores: 8, ramMb: 16384, diskFreeGb: 3 } })).proposed.disk_min_gb).toBe(1);
});

test("(d) the machine facts are reported as read", () => {
	const home = fixtureHome();
	expect(detect(seams(home, { os: { cores: 6, ramMb: 8192, diskFreeGb: 42 } })).machine).toEqual({
		cores: 6,
		ramMb: 8192,
		diskFreeGb: 42,
	});
});

test("(e) secretgate is reported when it is on PATH", () => {
	const home = fixtureHome();
	expect(detect(seams(home, { onPath: bin => bin === "secretgate" })).secretgate).toBe(true);
	expect(detect(seams(home)).secretgate).toBe(false);
});

test("(f) without config.yml there is no current config and the proposals are the computed defaults", () => {
	const home = fixtureHome();
	const facts = detect(seams(home));
	expect(facts.current).toBeNull();
	expect(facts.proposed.avail_min_mb).toBe(1638);
});

test("(f) a re-run with an existing config.yml proposes its values, not the defaults", () => {
	const home = fixtureHome();
	mkdirSync(dirname(configFile(home)), { recursive: true });
	writeFileSync(configFile(home), "machine:\n  avail_min_mb: 4096\n  disk_min_gb: 7\n  load_over_cores: 2\n");
	const facts = detect(seams(home, { os: { cores: 8, ramMb: 16384, diskFreeGb: 200 } }));
	expect(facts.current).not.toBeNull();
	expect(facts.proposed).toEqual({ load_over_cores: 2, avail_min_mb: 4096, disk_min_gb: 7 });
});

test("realSeams.onPath looks only in the PATH it is given", () => {
	const home = fixtureHome();
	const binDir = join(TMP, "fake-path-bin");
	mkdirSync(binDir, { recursive: true });
	const bin = join(binDir, "alpha-bin");
	writeFileSync(bin, "#!/bin/sh\n");
	chmodSync(bin, 0o755);
	const real = realSeams([{ name: "alpha", bin: "alpha-bin" }], home, { PATH: `:${binDir}:` });
	expect(real.onPath("alpha-bin")).toBe(true);
	expect(real.onPath("missing-bin")).toBe(false);
	expect(real.harnesses).toEqual([{ name: "alpha", bin: "alpha-bin" }]);
});
