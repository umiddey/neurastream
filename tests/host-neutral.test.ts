// Host neutrality (plan 20261026_0010 P1): src/core stays harness-free by test — it imports
// nothing from src/adapters or src/cli and names no harness, comments included; src/cli reaches
// adapters only through the registry in src/adapters/index.ts. A core change a new harness needs
// means the interface is wrong (docs/adapter.md), and this file is where that stays true.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CORE = join(ROOT, "src", "core");
const CLI = join(ROOT, "src", "cli");

function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...tsFiles(p));
		else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(p);
	}
	return out.sort();
}

// Static `import/export … from "…"`, side-effect `import "…"`, dynamic `import("…")`.
const SPEC_RE = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g;

function specs(text: string): { spec: string; line: number }[] {
	const out: { spec: string; line: number }[] = [];
	for (const m of text.matchAll(SPEC_RE)) {
		const spec = m[1] ?? m[2] ?? m[3]!;
		out.push({ spec, line: text.slice(0, m.index).split("\n").length });
	}
	return out;
}

const ADAPTERS_DIR = `${join(ROOT, "src", "adapters")}/`;
const CLI_DIR = `${join(ROOT, "src", "cli")}/`;

test("src/core imports nothing from src/adapters or src/cli", () => {
	const bad: string[] = [];
	for (const file of tsFiles(CORE)) {
		for (const { spec, line } of specs(readFileSync(file, "utf8"))) {
			if (!spec.startsWith(".")) continue;
			const target = resolve(dirname(file), spec);
			if (target === ADAPTERS_DIR.slice(0, -1) || target.startsWith(ADAPTERS_DIR) || target === CLI_DIR.slice(0, -1) || target.startsWith(CLI_DIR)) {
				bad.push(`${file}:${line} imports ${spec}`);
			}
		}
	}
	expect(bad).toEqual([]);
});

// Whole words, case-insensitive, comments included — so core docs stay neutral too.
const HARNESS_WORD = /\b(omp|opencode|codex|claude|cursor)\b/gi;

test("src/core names no harness", () => {
	const bad: string[] = [];
	for (const file of tsFiles(CORE)) {
		const text = readFileSync(file, "utf8");
		for (const m of text.matchAll(HARNESS_WORD)) bad.push(`${file}:${text.slice(0, m.index).split("\n").length} names ${m[0]}`);
	}
	expect(bad).toEqual([]);
});

// P1 (c): the CLI has exactly one door to the adapters — the registry.
test("src/cli imports adapters only via src/adapters/index.ts", () => {
	const bad: string[] = [];
	for (const file of tsFiles(CLI)) {
		for (const { spec, line } of specs(readFileSync(file, "utf8"))) {
			if (spec.includes("adapters") && spec !== "../adapters/index.ts") bad.push(`${file}:${line} imports ${spec}`);
		}
	}
	expect(bad).toEqual([]);
});
