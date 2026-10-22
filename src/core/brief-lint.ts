import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Config } from "./config.ts";
import { exitText, helpDoc, printText } from "./help.ts";

const OUTPUT_HINT = /(report|progress|review|handoff|log|brief)[\w\-]*\.(md|log|txt|json)$|\.log$/;

function escapeReg(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lint(path: string, cfg: Config): { errs: string[]; warns: string[] } {
	const text = readFileSync(path, "utf8");
	const low = text.toLowerCase();
	const lines = text.split(/\r?\n/);
	const first = lines[0] ?? "";
	const errs: string[] = [];
	const warns: string[] = [];
	const need = (cond: boolean, msg: string) => {
		if (!cond) errs.push(msg);
	};

	need(text.includes(cfg.brief.method_marker), `missing: 'Read ${cfg.brief.method_read} first'`);
	need(
		/^#+[^\n]*(acceptance|done|report)|acceptance:|^done\s*=|^\d+\.\s*report\b/im.test(text),
		"missing: Acceptance/Done/Report section (observable result on the real target)",
	);
	need(/never push|no push|not push|never `?git push/.test(low), "missing: 'never push' line");
	need(low.includes("find") && low.includes("broken"), "missing: '`find` is broken: use grep/glob/read' note");

	const heavy = /pytest|vitest|playwright|run-raw|run-batch|full suite|\bsuite\b/.test(low);
	if (heavy) need(text.includes(cfg.brief.heavy_marker), `runs tests/suites but never names ${cfg.brief.heavy_path}`);

	const vitestLines = low.split(/\r?\n/).filter(l => l.includes("vitest") && !/not needed|no vitest/.test(l));
	if (vitestLines.length && /gateforge|witness|\bgf-/i.test(first)) {
		need(low.includes("typecheck"), "Gateforge green = vitest exit 0 AND `npm run typecheck` exit 0: typecheck missing");
	}

	const planOnly = /plan only|read-only review|CI fix|\bdelete\b/i.test(first);
	if (low.includes("test-map") && !planOnly) {
		const m = text.match(/^Probe:\s*(\S+)/m);
		if (/^#+\s*probe first/im.test(text) && !m) {
			// the agent runs the probe itself and must stop on 0 satisfied
		} else if (!m) {
			errs.push("coverage batch without 'Probe: <log>' line: run ONE witnessed probe that SATISFIES its claims first (lesson 2026-10-10: 0/255)");
		} else if (!existsSync(m[1]!)) {
			errs.push(`Probe log does not exist: ${m[1]}`);
		} else if (!readFileSync(m[1]!, "utf8").toLowerCase().includes("satisfied")) {
			errs.push(`Probe log shows no 'satisfied' claim: ${m[1]}`);
		}
	}

	if (
		/aetherios-property-management|pm-pr01|\bPR01\b|contractor.portal|cp-/.test(text) &&
		!planOnly &&
		/test-map|obligation|gateforge check|coverage/.test(low)
	) {
		need(
			/^Gate before:\s*\d+\s+missing/im.test(text),
			"PM/CP coverage brief without 'Gate before: <N> missing' line from `gateforge check` (green tests are not progress)",
		);
		need(
			/gate missing.*before.*after|before\s*->\s*after/.test(low),
			"report must state gate missing before->after; a round that does not lower it stops",
		);
	}

	const paths = new Set<string>();
	for (const prefix of cfg.brief.path_prefixes) {
		const re = new RegExp(`(${escapeReg(prefix)}[\\w./\\-]+)`, "g");
		for (const hit of text.matchAll(re)) paths.add(hit[1]!);
	}
	for (const raw of [...paths].sort()) {
		let p = raw.replace(/[.,)]+$/, "");
		if (p.endsWith("-") || p.endsWith("_")) continue;
		if (existsSync(p) || OUTPUT_HINT.test(p)) continue;
		const parent = dirname(p);
		if (existsSync(parent) && statSync(parent).isDirectory() && basename(p).includes(".")) {
			warns.push(`path not found (new file?): ${p}`);
		} else {
			errs.push(`path does not exist: ${p}`);
		}
	}

	need(
		/\b\d{1,3}\s*(tool\s*)?calls\b/.test(low),
		"missing: call budget line ('stop and report within ~100 calls'); long agents reread huge contexts",
	);

	// An incident fix plan (plan 20261022_2330 P5) must ship its regression test fail-before:
	// some phase's text has to say the test failed on the old code.
	if (/\bINCIDENT\s+I-\d{8}-\d+\b/.test(text)) {
		need(/fail-before/i.test(low), "plan cites INCIDENT <id> but no phase says 'fail-before': its regression test must fail on the old code");
	}

	const keys = new Set<string>();
	for (const prefix of cfg.brief.path_prefixes) {
		const re = new RegExp(`(${escapeReg(prefix)}[\\w./\\-]*keys[\\w.\\-]*\\.txt)`, "g");
		for (const hit of text.matchAll(re)) keys.add(hit[1]!);
	}
	for (const p of [...keys].sort()) {
		if (!existsSync(p)) continue;
		const n = readFileSync(p, "utf8").split(/\r?\n/).filter(l => l.trim()).length;
		if (n > cfg.brief.max_keys) {
			errs.push(`key batch ${p} has ${n} keys; max ${cfg.brief.max_keys} per agent (split into fresh agents)`);
		}
	}

	if (text.length > cfg.brief.warn_chars) {
		warns.push(`brief is ${text.length} chars; long briefs cost every agent call (aim < ${cfg.brief.aim_chars})`);
	}
	return { errs, warns };
}

export function briefLint(args: string[], cfg: Config): number {
	if (args.length === 0) return exitText(helpDoc("brief-lint"));
	let rc = 0;
	for (const path of args) {
		const { errs, warns } = lint(path, cfg);
		for (const w of warns) printText(`WARN ${path}: ${w}`);
		for (const e of errs) printText(`FAIL ${path}: ${e}`);
		printText(`${errs.length ? "FAIL" : "OK  "} ${path}: ${errs.length} errors, ${warns.length} warnings`);
		if (errs.length) rc = 1;
	}
	return rc;
}
