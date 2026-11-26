// `neurastream reuse` (plan 20261122_1828_reuse_map P3): the opt-in Graphify code map CLI.
// The routines live in src/core/reuse-map.ts (uninstall runs the off routine too); this file
// speaks to the user: args, the real deps (HOME, env, terminal), exit codes, streams.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { loadConfig } from "../core/config.ts";
import { MAX_TERMS, NONE_TERMS_MIN, SLOW_RETRY, freshGraph, mapLine, noneLine, optionTermProblems, realGraphify, reuseOff, reuseOn, reuseStatus, searchTerms, versionProblem, type ReuseDeps, type ReuseOutcome } from "../core/reuse-map.ts";
import { planRoots } from "../core/guards/plan-edit.ts";
import { expandHome } from "../core/queue/lib.ts";
import { askLine } from "./init.ts";

const USAGE = "usage: neurastream reuse on [<repo>...] | off [--purge] | status [--json] | map <plan.md> <term>...";

/** The production deps: the real home, env, terminal, askLine. */
function realDeps(): ReuseDeps {
	return {
		home: homedir(),
		env: process.env,
		terminal: process.stdin.isTTY === true && process.stdout.isTTY === true,
		ask: askLine,
	};
}

function emit(r: ReuseOutcome): number {
	for (const l of r.out) console.log(l);
	for (const l of r.err) console.error(l);
	return r.code;
}

/**
 * `reuse map <plan.md> <term>...`: freshens the plan repo's map, then prints the ## Reuse line —
 * the - map: line when any term hits, else the none line (which needs >= NONE_TERMS_MIN terms) —
 * plus up to 5 `path:line "text"` candidates per matched file for the `new:` citations. The
 * plan's repo is resolved exactly like the write gate resolves it (planRoots' last root). The
 * command writes nothing but the map's own graph and stamp.
 */
function runMap(plan: string, terms: string[], deps: ReuseDeps): ReuseOutcome {
	const out: string[] = [];
	const err: string[] = [];
	if (!plan || !terms.length) return { code: 2, out, err: ['usage: neurastream reuse map <plan.md> "<term>"...'] };
	if (terms.length > MAX_TERMS) return { code: 1, out, err: [`reuse map: ${terms.length} terms (at most ${MAX_TERMS} — each term is one graphify query)`] };
	const options = optionTermProblems(terms);
	if (options.length) return { code: 1, out, err: options };
	const planPath = path.resolve(plan);
	const repo = planRoots(planPath, existsSync(planPath) ? readFileSync(planPath, "utf8") : "").at(-1)!;
	const cfg = loadConfig({ home: deps.home, env: deps.env }).reuse_map;
	if (!cfg.enabled) return { code: 1, out, err: [`reuse map: the reuse map is off — run \`neurastream reuse on ${repo}\` first`] };
	if (!cfg.repos.map((r) => path.resolve(expandHome(r))).includes(repo))
		return { code: 1, out, err: [`reuse map: ${repo} is not mapped — run \`neurastream reuse on ${repo}\` first`] };
	const vp = versionProblem();
	if (vp) return { code: 1, out, err: [`reuse map: ${vp}`] };
	const fresh = freshGraph(repo, cfg.exclude);
	if (fresh.length) return { code: 1, out, err: fresh.map((p) => `reuse map: ${p}`) };
	const res = searchTerms(realGraphify, repo, terms);
	if (res.some((r) => r.status === "slow")) return { code: 1, out, err: [SLOW_RETRY] };
	const bad = res.filter((r) => r.problem);
	if (bad.length) return { code: 1, out, err: bad.map((r) => `reuse map: ${r.problem}`) };
	const files = [...new Set(res.flatMap((r) => r.files))];
	if (!files.length) {
		if (terms.length < NONE_TERMS_MIN)
			return { code: 1, out, err: [`reuse map: nothing matched — a none line needs ${NONE_TERMS_MIN} distinct terms, search more and rerun`] };
		out.push(noneLine(terms));
		return { code: 0, out, err };
	}
	out.push(mapLine(terms, files, cfg.min_cited));
	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(path.join(repo, file), "utf8");
		} catch {
			out.push(`${file}: unreadable`);
			continue;
		}
		let shown = 0;
		const lower = terms.map((t) => t.toLowerCase());
		for (const [i, line] of text.split("\n").entries()) {
			if (!lower.some((t) => line.toLowerCase().includes(t))) continue;
			out.push(`${file}:${i + 1} "${line.trim()}"`);
			if (++shown >= 5) break;
		}
		if (!shown) out.push(`${file}: no line names the terms (cite its defining line anyway)`);
	}
	return { code: 0, out, err };
}

/** `neurastream reuse <sub> ...` — exits: 0 ok, 1 failure, 2 usage. */
export function runReuse(args: string[]): number {
	const [sub, ...rest] = args;
	try {
		switch (sub) {
			case "on":
				return emit(reuseOn(rest, realDeps()));
			case "off":
				return emit(reuseOff(rest, realDeps()));
			case "status":
				return emit(reuseStatus(rest, realDeps()));
			case "map":
				return emit(runMap(rest[0] ?? "", rest.slice(1), realDeps()));
			default:
				console.error(USAGE);
				return 2;
		}
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		return 1;
	}
}
