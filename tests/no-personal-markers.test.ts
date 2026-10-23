// I-20261023-18 guard: the npm-shipped file set must not leak the machine
// layout the package was authored on (company/repo names, live session
// transcript paths, private remotes, home-dir roots). The shipped set is
// computed from package.json "files"; LICENSE is skipped on purpose because
// the copyright line is the public npm identity and must stay. Keep the
// marker list in sync with docs/plans/blockers/no-personal-markers.sh.
// Deterministic: reads the checkout only, no network, no npm pack.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const REPO = dirname(dirname(import.meta.path));

// Same list as the blocker script: case-insensitive substring regexes.
const MARKERS = [
	"ukd",
	"umiddey",
	"/home/",
	"~/Work",
	"Work/",
	"gf-testbed",
	"gateforge",
	"pm-counts",
	"aetherios",
	"EstateMind",
	"estatemind",
	"contractor",
	"clanky",
	"oi-agent",
	"sabuj",
	"amiiir",
	"100\\.70",
	"sessions/-",
	"gf-luna",
	"pm/pr01",
];

const MARKER_RE = new RegExp(MARKERS.join("|"), "i");

function walk(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.name) continue;
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) walk(abs, out);
		else out.push(abs);
	}
}

function shippedFiles(): string[] {
	const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { files: string[] };
	const out: string[] = [];
	for (const entry of pkg.files) {
		if (entry === "LICENSE") continue; // public npm identity: copyright stays
		const abs = join(REPO, entry);
		if (statSync(abs).isFile()) {
			out.push(abs);
			continue;
		}
		walk(abs, out);
	}
	return out.sort();
}

test("shipped files carry no personal markers (I-20261023-18)", () => {
	const hits: string[] = [];
	for (const file of shippedFiles()) {
		const lines = readFileSync(file, "utf8").split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line === undefined) continue;
			if (MARKER_RE.test(line)) {
				hits.push(`${relative(REPO, file)}:${i + 1}: ${line.trim().slice(0, 160)}`);
			}
		}
	}
	expect(hits).toEqual([]);
});
