import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Config } from "./config.ts";
import { briefBudget, briefNamesPending } from "./guards.ts";
import { exitText, helpDoc, printText } from "./help.ts";
import { sections } from "./queue/lib.ts";

const OUTPUT_HINT = /(report|progress|review|handoff|log|brief)[\w-]*\.(md|log|txt|json)$|\.log$/;
const TICKED_PHASE = /^\s*[-*]\s+\[[xX]\]/;

// A plan's paths are live work only in the header lines, Goal, Forbidden, Blockers, unticked phase
// lines and Done check. Ticked phases and the history sections (Code read by Main, Progress,
// Background) cite worktrees removed after their work landed, so the path check skips them. A plain
// brief (no `## Phases`) is checked whole.
function liveText(text: string): string {
	const secs = sections(text);
	if (!secs.has("phases")) return text;
	const header = text.slice(0, text.search(/^## /m));
	const unticked = (secs.get("phases") ?? "")
		.split("\n")
		.filter(l => !TICKED_PHASE.test(l))
		.join("\n");
	return [
		header,
		secs.get("goal") ?? "",
		secs.get("forbidden") ?? "",
		secs.get("blockers") ?? "",
		unticked,
		secs.get("done check") ?? "",
	].join("\n");
}

function escapeReg(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A scanned path without its trailing sentence punctuation (the path loop's cleaning). */
const clean = (raw: string): string => raw.replace(/[.,)]+$/, "");

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

	// The method read is opt-in: only a config that sets brief.method_marker requires it.
	if (cfg.brief.method_marker) need(text.includes(cfg.brief.method_marker), `missing: 'Read ${cfg.brief.method_read} first'`);
	need(
		/^#+[^\n]*(acceptance|done|report)|acceptance:|^done\s*=|^\d+\.\s*report\b/im.test(text),
		"missing: Acceptance/Done/Report section (observable result on the real target)",
	);
	need(/never push|no push|not push|never `?git push/.test(low), "missing: 'never push' line");

	const heavy = /pytest|vitest|playwright|full suite|\bsuite\b/.test(low);
	if (heavy) need(text.includes(cfg.brief.heavy_marker), `runs tests/suites but never names ${cfg.brief.heavy_path}`);

	// Repo-specific rules are config-driven (brief.repo_rules); the shipped default list is empty.
	for (const rule of cfg.brief.repo_rules) {
		if (!new RegExp(rule.match, "i").test(low)) continue;
		if (rule.first && !new RegExp(rule.first, "i").test(first)) continue;
		if (rule.unless && new RegExp(rule.unless, "i").test(first)) continue;
		need(new RegExp(rule.require, "i").test(low), rule.message);
	}


	const paths = new Set<string>();
	const scan = liveText(text);
	for (const prefix of cfg.brief.path_prefixes) {
		const re = new RegExp(`(${escapeReg(prefix)}[\\w./\\-]+)`, "g");
		for (const hit of scan.matchAll(re)) paths.add(hit[1]!);
	}
	for (const raw of [...paths].toSorted()) {
		const p = clean(raw);
		if (p.endsWith("-") || p.endsWith("_")) continue;
		if (existsSync(p) || OUTPUT_HINT.test(p)) continue;
		const parent = dirname(p);
		if (existsSync(parent) && statSync(parent).isDirectory() && basename(p).includes(".")) {
			warns.push(`path not found (new file?): ${p}`);
		} else {
			errs.push(`path does not exist: ${p}`);
		}
	}

	// P4 (plan 20261028_1600): a spawn brief naming an open MR/PR in prose must carry the pending-work
	// line for it, else the prose alone redoes the MR's work (INCIDENT I-20261028-125). Plans are
	// exempt: the spawn-side gate (guards pendingWorkProblem) matches the brief's line against the
	// plan's own MRs and branches instead.
	if (!sections(text).has("progress")) {
		const toks = new Set<string>();
		for (const m of text.matchAll(/[!#]\d+/g)) toks.add(m[0]);
		for (const tok of toks) {
			need(
				briefNamesPending(text, "MR", tok),
				`MR ${tok} is named in prose; a spawn on its plan must carry the line "MR ${tok}: <what it holds> — this task: <why not overlapping>"`,
			);
		}
	}

	// P4b (INCIDENT I-20261028-149): a helper wrote its Progress into the worktree copy of the plan
	// and committed it there. A brief that works a plan must name the plan's absolute path in its
	// main checkout; naming only a worktree copy is that incident again. (INCIDENT I-20261028-153):
	// the plan's scope blocker did not allow a file the brief told the helper to change — when a
	// plan blocker script carries ALLOWED='…', every src/tests path the brief names must be inside it.
	if (cfg.paths.work_roots.length && /\bplans?\b/i.test(text)) {
		const noPlanLine = "no line names the plan's absolute path in its main checkout (paths.work_roots)";
		const planPaths = [...paths].map(clean).filter(p => /\/docs\/plans\/[\w.-]+\.md$/.test(p));
		const inRoot = planPaths.filter(p => cfg.paths.work_roots.some(r => p.startsWith(r.replace(/\/+$/, "") + "/")));
		if (!inRoot.length) {
			const copy = planPaths[0];
			if (copy) {
				const main = cfg.paths.work_roots
					.map(r => `${r.replace(/\/+$/, "")}/docs/plans/${basename(copy)}`)
					.find(p => existsSync(p));
				errs.push(
					main
						? `worktree path ${copy} is the plan's copy; name the main checkout's copy ${main} (paths.work_roots)`
						: noPlanLine,
				);
			} else errs.push(noPlanLine);
		}
		const planFile = inRoot.find(p => existsSync(p));
		if (planFile) {
			const blockersDir = cfg.paths.blockers.replace(/\/+$/, "");
			for (const line of (sections(readFileSync(planFile, "utf8")).get("blockers") ?? "").split("\n")) {
				const name = /^[-*]\s+(\S+)\s*$/.exec(line.trim())?.[1];
				if (!name) continue;
				const script = `${blockersDir}/${name}`;
				if (!existsSync(script)) continue;
				const m = /^ALLOWED=['"](.+)['"]\s*$/m.exec(readFileSync(script, "utf8"));
				if (!m) continue;
				let allowed: RegExp;
				try {
					allowed = new RegExp(m[1]!);
				} catch {
					continue; // a blocker with a broken ALLOWED regex is that blocker's bug, not this brief's
				}
				for (const raw of paths) {
					const rel = /\/((?:src|tests)\/[\w./-]+)$/.exec(clean(raw))?.[1];
					if (rel && !allowed.test(rel)) errs.push(`plan blocker ${name} does not allow ${rel} (its ALLOWED regex rejects it)`);
				}
			}
		}
	}

	// The brief's call-budget rule: either the classic "stop within ~N calls" line or a Main-set
	// per-spawn `Call budget: <N>` line counts.
	need(
		/\b\d{1,3}\s*(tool\s*)?calls\b/.test(low) || briefBudget(text) !== null,
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
	for (const p of [...keys].toSorted()) {
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
