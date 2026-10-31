// Write-time lint checks: an edit that adds a lint finding or a suppression comment to a file is
// refused, and the caller puts the file back. Linters run as argv arrays, never through a shell.
// `after` is what is on disk now; `before` is what the file held before the edit (null: new file).

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

import { gitTop } from "./queue/lib.ts";

export interface WriteCheckLinter {
	ext: string[];
	argv: string[];
	pattern: string;
	only_with_config?: string[];
}

export interface WriteCheckConfig {
	enabled: boolean;
	applies_to: "sub" | "all";
	timeout_ms: number;
	suppress: string;
	/** Rules whose new findings do not refuse an edit (I-20261028-166): allowed with a note, reported at turn end. */
	defer_rules: string[];
	linters: WriteCheckLinter[];
}

export type WriteCheckResult = { allow: true; note?: string; deferred?: true } | { allow: false; reason: string };

// Counts per (rule, message) pair, so a rule's old debt never masquerades as the reason for a
// refusal (I-20261028-150); suppression comments count per matching line under SUPPRESSION.
interface Findings {
	counts: Map<string, number>;
	samples: Map<string, string>;
	rules: Map<string, string>;
}

const SUPPRESSION = "suppression";
const REASON_MAX = 2000;
const SAMPLE_MAX = 300;
const TAIL = "The file was restored to its state before this edit; fix it and edit again — do not add suppression comments.";

// A pattern with a `message` group keys findings by (rule, message), so only a finding whose text
// is new counts as new; without it, counting stays per rule (the older config format).
function findingKey(rule: string, message: string | undefined): string {
	return message === undefined ? rule : `${rule}\u0000${message}`;
}

function add(f: Findings, k: string, rule: string, sample: string): void {
	f.counts.set(k, (f.counts.get(k) ?? 0) + 1);
	if (!f.samples.has(k)) f.samples.set(k, sample.trim().slice(0, SAMPLE_MAX));
	if (!f.rules.has(k)) f.rules.set(k, rule);
}

// Walks up from dirname(file) to the git top (inclusive: a repo-root config counts), looking for one
// of `names`; never above it. Outside a git repo only the file's own directory is checked.
function hasConfig(file: string, names: string[]): boolean {
	const start = resolve(dirname(file));
	const top = gitTop(start)?.top;
	for (let dir = start; ; dir = dirname(dir)) {
		if (names.some((name) => existsSync(join(dir, name)))) return true;
		if (top === undefined || dir === top || dir === dirname(dir)) return false;
	}
}

// Runs each linter on `path` and counts its findings. Throws when a linter did not finish
// (missing binary, timeout, signal); the caller turns that into an allowed edit with a note.
function lint(path: string, linters: WriteCheckLinter[], wc: WriteCheckConfig, f: Findings): void {
	for (const l of linters) {
		if (l.only_with_config && !hasConfig(path, l.only_with_config)) continue;
		const argv = l.argv.map((a) => (a === "{file}" ? path : a));
		const [cmd = "", ...args] = argv;
		const r = spawnSync(cmd, args, {
			cwd: dirname(path),
			encoding: "utf8",
			timeout: wc.timeout_ms,
			maxBuffer: 16 * 1024 * 1024,
		});
		if (r.error || r.signal) throw new Error(`${cmd} did not finish (${r.error?.message ?? r.signal})`);
		const re = new RegExp(l.pattern);
		for (const line of r.stdout.split("\n")) {
			const m = re.exec(line);
			const rule = m?.groups?.rule;
			if (rule) add(f, findingKey(rule, m?.groups?.message), rule, line);
		}
	}
}

// Lints `text` as if it were `file`: written to a scratch file beside it (same extension, so the
// repo's own lint config applies) and removed afterwards.
function lintText(file: string, text: string, linters: WriteCheckLinter[], wc: WriteCheckConfig, f: Findings): void {
	const ext = extname(file);
	const scratch = join(dirname(file), `.${basename(file, ext)}.wc-${randomBytes(4).toString("hex")}${ext}`);
	writeFileSync(scratch, text);
	try {
		lint(scratch, linters, wc, f);
	} finally {
		rmSync(scratch, { force: true });
	}
}

function suppressions(text: string, re: RegExp, f: Findings): void {
	for (const line of text.split("\n")) if (re.test(line)) add(f, findingKey(SUPPRESSION, line), SUPPRESSION, line);
}

function refusal(file: string, now: Findings, old: Findings, newKeys: string[]): string {
	const head = `write-check: this edit adds lint problems to ${file}:`;
	const rows = newKeys.map((k) => `- ${now.rules.get(k)} (+${(now.counts.get(k) ?? 0) - (old.counts.get(k) ?? 0)}): ${now.samples.get(k)}`);
	const room = REASON_MAX - head.length - TAIL.length - 2;
	let body = rows.join("\n");
	if (body.length > room) body = `${body.slice(0, room - 4)}\n...`;
	return `${head}\n${body}\n${TAIL}`;
}

export function checkWrite(file: string, before: string | null, after: string | null, wc: WriteCheckConfig): WriteCheckResult {
	if (after === null || before === after) return { allow: true };
	if (typeof before === "string" && /^(<<<<<<<|>>>>>>>)/m.test(before)) {
		return { allow: true, note: `write-check: ${file} had conflict markers in the before text; the edit was allowed` };
	}
	const linters = wc.linters.filter((l) => l.ext.includes(extname(file)));
	if (linters.length === 0) return { allow: true };
	const old: Findings = { counts: new Map(), samples: new Map(), rules: new Map() };
	const now: Findings = { counts: new Map(), samples: new Map(), rules: new Map() };
	try {
		const re = new RegExp(wc.suppress);
		if (before !== null) {
			suppressions(before, re, old);
			lintText(file, before, linters, wc, old);
		}
		suppressions(after, re, now);
		lint(file, linters, wc, now);
	} catch (err) {
		return { allow: true, note: `write-check: ${file} not checked (${(err as Error).message}); the edit was allowed` };
	}
	// A new finding of a deferred rule rides along mid-turn (I-20261028-166): declare-then-use
	// refactors stay possible; the adapter reports what is still there at the turn's end (deferSteer).
	const added = [...now.counts].filter(([k, n]) => n > (old.counts.get(k) ?? 0));
	const real = added.filter(([k]) => !wc.defer_rules.includes(now.rules.get(k) ?? ""));
	if (real.length > 0) return { allow: false, reason: refusal(file, now, old, real.map(([k]) => k)) };
	if (added.length === 0) return { allow: true };
	return {
		allow: true,
		deferred: true,
		note: `write-check: ${file} adds findings under a deferred rule, allowed until turn end:\n${added
			.map(([k]) => `- ${now.rules.get(k)}: ${now.samples.get(k)}`)
			.join("\n")}`,
	};
}

// Turn-end follow-up for deferred findings (I-20261028-166): the adapter holds each file's text from
// before the turn's first deferred finding and calls this at agent_end; a non-null return becomes
// one steer listing what is still there. Fixed, deleted, no matching linter, or a linter that did
// not finish: null — the edit-time rule holds, a missing or crashed linter never blocks.
export function deferSteer(file: string, before: string | null, after: string | null, wc: WriteCheckConfig): string | null {
	if (after === null || before === after || wc.defer_rules.length === 0) return null;
	const linters = wc.linters.filter((l) => l.ext.includes(extname(file)));
	if (linters.length === 0) return null;
	const old: Findings = { counts: new Map(), samples: new Map(), rules: new Map() };
	const now: Findings = { counts: new Map(), samples: new Map(), rules: new Map() };
	try {
		if (before !== null) lintText(file, before, linters, wc, old);
		lint(file, linters, wc, now);
	} catch {
		return null;
	}
	const rows = [...now.counts].flatMap(([k, n]) =>
		n > (old.counts.get(k) ?? 0) && wc.defer_rules.includes(now.rules.get(k) ?? "")
			? [`- ${now.rules.get(k)}: ${now.samples.get(k)}`]
			: [],
	);
	if (rows.length === 0) return null;
	return `write-check: ${file} still holds deferred findings added this turn:\n${rows.join("\n")}`;
}
