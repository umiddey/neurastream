import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import type { Run, RunSource } from "./adapter.ts";
import { nowSec, strftime } from "./clock.ts";
import { exitText, helpDoc, printText } from "./help.ts";
import { formatG, pyFixed, pyPercent0 } from "./pyfmt.ts";
import { PyFloat, pyDumps } from "./pyjson.ts";
import { gitRaw } from "./proc.ts";

function opt(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	if (i < 0) return undefined;
	if (i + 1 >= args.length) return exitText(`${name} needs a value`) as unknown as undefined;
	return args[i + 1];
}

function needOpt(args: string[], name: string): string {
	const i = args.indexOf(name);
	if (i < 0 || i + 1 >= args.length) {
		exitText(`${name} needs a value`);
		throw new Error("stop");
	}
	return args[i + 1]!;
}

function eventsPath(cfg: Config): string {
	return join(cfg.paths.score_state, "events.jsonl");
}

function readEvents(cfg: Config): Record<string, unknown>[] {
	const path = eventsPath(cfg);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(l => l.trim())
		.map(l => JSON.parse(l) as Record<string, unknown>);
}

function record(ev: Record<string, unknown>, cfg: Config): void {
	ev.ts = new PyFloat(nowSec());
	const path = eventsPath(cfg);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${pyDumps(ev)}\n`);
	printText(`recorded: ${pyDumps(ev)}`);
}

function expandCommits(repo: string, spec: string): string[] {
	const out: string[] = [];
	for (const raw of spec.split(",")) {
		const part = raw.trim();
		if (!part) continue;
		if (part.includes("..")) {
			const r = gitRaw(repo, ["rev-list", "--no-merges", part]);
			if (r.code) {
				exitText(`bad range ${part}: ${r.stderr.trim()}`);
				throw new Error("stop");
			}
			out.push(...r.stdout.split(/\s+/).filter(Boolean));
		} else {
			const r = gitRaw(repo, ["rev-parse", "--verify", `${part}^{commit}`]);
			if (r.code) {
				exitText(`unknown commit ${part}`);
				throw new Error("stop");
			}
			out.push(r.stdout.trim());
		}
	}
	if (out.length === 0) {
		exitText("no commits given");
		throw new Error("stop");
	}
	return out;
}

function phaseDifficulty(plan: string, phase: string): number | null {
	if (!existsSync(plan)) {
		exitText(`plan not found: ${plan}`);
		throw new Error("stop");
	}
	const re = new RegExp(`^- \\[[ xX]\\] ${phase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
	for (const line of readFileSync(plan, "utf8").split("\n")) {
		if (!re.test(line)) continue;
		const m = line.match(/difficulty:\s*(\d+)/);
		return m ? Number(m[1]) : null;
	}
	exitText(`phase ${phase} not found in ${plan}`);
	throw new Error("stop");
}

/** True when the plan's phase line exists and is ticked `- [x]`/`- [X]` (ticking = reviewed by Main). */
function phaseTicked(plan: string, phase: string): boolean {
	if (!existsSync(plan)) {
		exitText(`plan not found: ${plan}`);
		throw new Error("stop");
	}
	const re = new RegExp(`^- \\[[ xX]\\] ${phase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
	for (const line of readFileSync(plan, "utf8").split("\n")) {
		if (re.test(line)) return /^- \[[xX]\]/.test(line);
	}
	return false;
}

/**
 * Body of the first heading whose text starts with `section` and ends at end-of-line, space or `(`,
 * so `## CP` matches `## CP (P5, ...)` but not `## CPX`. The body runs to the next heading of the
 * same or higher level. Null when no heading matches.
 */
function sectionBody(text: string, section: string): string | null {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!/^#{1,6} /.test(line)) continue;
		if (!(line === section || line.startsWith(`${section} `) || line.startsWith(`${section}(`))) continue;
		const level = (line.match(/^#+/) ?? ["#"])[0]!.length;
		const body: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j]!;
			const m = next.match(/^#+(?= )/);
			if (m && m[0].length <= level) break;
			body.push(next);
		}
		return body.join("\n");
	}
	return null;
}

/** Labels from the heavy-run log's `END   <agent> | <label> | exit <n>` lines (START lines never match). */
function heavyEndLabels(log: string, agent: string): string[] {
	if (!existsSync(log)) return [];
	const re = new RegExp(`END\\s+${agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\| (.*) \\| exit \\d+$`);
	const out: string[] = [];
	for (const line of readFileSync(log, "utf8").split("\n")) {
		const m = line.match(re);
		if (m) out.push(m[1]!);
	}
	return out;
}

function weightFor(args: string[], plan: string, phase: string, cfg: Config, fallback: number | null): { w: number; src: string } {
	if (args.includes("--weight")) return { w: Number(needOpt(args, "--weight")), src: "flag" };
	const d = phaseDifficulty(plan, phase);
	if (d !== null) return { w: d, src: "plan" };
	if (fallback !== null) return { w: fallback, src: "default" };
	exitText(`${phase} in ${plan} has no \`difficulty: N\`; pass --weight N (1 mechanical, 2 rules, 3 new spec, 4 root-cause, 5 product fix, 8 engine)`);
	throw new Error("stop");
}

interface Row {
	model: string;
	runs: number;
	done: number;
	running: number;
	cost: number;
	steer: number;
	hours: number;
	pts: number;
	acc: number;
	first: number;
	pen: number;
	diag: number;
	val: number;
	net: number;
	total: number;
	ppd: number | null;
	pph: number | null;
	surv: number | null;
	fp: number | null;
}

function ocRuns(cfg: Config, cut: number): { agent: string; model: string; cost: number; hours: number; survived: boolean; running: boolean; end: string }[] {
	const path = join(cfg.paths.score_state, "oc-runs.jsonl");
	if (!existsSync(path)) return [];
	const out = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		const r = JSON.parse(line) as Record<string, unknown>;
		const end = typeof r.end === "number" ? r.end : undefined;
		const start = Number(r.start);
		if ((end ?? start) < cut) continue;
		const running = !("end" in r);
		out.push({
			agent: String(r.agent),
			model: String(r.model),
			cost: 0,
			hours: ((end ?? nowSec()) - start) / 3600,
			survived: r.exit === 0 && r.final === true,
			running,
			end: running ? "running" : `exit ${String(r.exit)}`,
		});
	}
	return out;
}

function steering(runs: Run[], names: string[]): Record<string, number> {
	const ordered = names.slice().sort((a, b) => b.length - a.length);
	const out: Record<string, number> = {};
	for (const n of names) out[n] = 0;
	for (const run of runs) {
		if (run.kind !== "main") continue;
		let prev = "";
		for (const msg of run.messages) {
			if (msg.role === "assistant" && msg.cost) {
				const hit = ordered.filter(n => msg.text.includes(n) || prev.includes(n));
				for (const n of hit) out[n] = (out[n] ?? 0) + msg.cost / hit.length;
			}
			if (msg.role !== "assistant") prev = msg.text;
		}
	}
	return out;
}

function table(days: number, cfg: Config, source: RunSource): { rows: Row[]; byAgent: Map<string, { model: string }> } {
	const cut = nowSec() - days * 86400;
	const listed = source.listRuns(cut);
	const subs = listed.filter(r => r.kind === "sub");
	const byAgent = new Map<string, { model: string; cost: number; hours: number; survived: boolean; running: boolean }>();
	for (const r of subs) {
		byAgent.set(r.id, {
			model: r.scoreModel,
			cost: r.scoreCost,
			hours: r.scoreHours,
			survived: r.scoreSurvived,
			running: r.scoreRunning,
		});
	}
	for (const r of ocRuns(cfg, cut)) {
		byAgent.set(r.agent, { model: r.model, cost: 0, hours: r.hours, survived: r.survived, running: r.running });
	}
	const steer = steering(listed, [...byAgent.keys()]);
	const evs = readEvents(cfg).filter(e => Number(e.ts) >= cut);
	const agentModel = new Map<string, string>();
	for (const [n, r] of byAgent) agentModel.set(n, r.model);
	const rows = new Map<string, Row>();
	const blank = (model: string): Row => ({
		model, runs: 0, done: 0, running: 0, cost: 0, steer: 0, hours: 0, pts: 0, acc: 0, first: 0, pen: 0, diag: 0, val: 0,
		net: 0, total: 0, ppd: null, pph: null, surv: null, fp: null,
	});
	for (const r of byAgent.values()) {
		const m = rows.get(r.model) ?? blank(r.model);
		m.runs += 1;
		m.running += r.running ? 1 : 0;
		m.done += r.survived ? 1 : 0;
		m.cost += r.cost;
		m.hours += Math.max(r.hours, 0);
		rows.set(r.model, m);
	}
	for (const [n, r] of byAgent) {
		const m = rows.get(r.model)!;
		m.steer += steer[n] ?? 0;
	}
	for (const e of evs) {
		const agent = String(e.agent ?? "");
		const model = (typeof e.model === "string" && e.model) || agentModel.get(agent) || "?";
		const m = rows.get(model) ?? blank(model);
		if (e.type === "accept" || e.type === "diagnose" || e.type === "validate") {
			m.pts += Number(e.weight);
			m.acc += 1;
			m.first += e.rework ? 0 : 1;
			m.diag += e.type === "diagnose" ? 1 : 0;
			m.val += e.type === "validate" ? 1 : 0;
		} else if (e.type === "penalty") {
			m.pen += cfg.score.penalties[String(e.kind)] ?? 0;
		}
		rows.set(model, m);
	}
	const out: Row[] = [];
	for (const m of rows.values()) {
		m.net = m.pts - m.pen;
		m.total = m.cost + m.steer;
		const finished = m.runs - m.running;
		m.surv = finished ? m.done / finished : null;
		m.ppd = m.total > cfg.score.min_dollars ? m.net / m.total : null;
		m.pph = m.hours > cfg.score.min_hours ? m.net / m.hours : null;
		m.fp = m.acc ? m.first / m.acc : null;
		out.push(m);
	}
	out.sort((a, b) => {
		const ap = a.ppd !== null ? a.ppd : -1e9;
		const bp = b.ppd !== null ? b.ppd : -1e9;
		if (bp !== ap) return bp - ap;
		return (b.pph || 0) - (a.pph || 0);
	});
	return { rows: out, byAgent };
}

function fmt(v: number | null, kind: "pct" | "1f"): string {
	if (v === null) return "-";
	return kind === "pct" ? pyPercent0(v) : pyFixed(v, 1);
}

function board(days: number, cfg: Config, source: RunSource): void {
	const { rows } = table(days, cfg, source);
	const lines = [
		`# Subagent ranking board (GENERATED by \`agent-score board --days ${formatG(days)}\`; do not hand-edit)`,
		`Updated ${strftime(nowSec(), "%Y-%m-%d %H:%M")}. Rank = net points per $ (worker list cost + Main steering cost), then points per run-hour.`,
		"Points = accepted work x plan difficulty (1 mechanical, 2 rules, 3 new spec, 4 root-cause, 5 product fix, 8 engine) minus penalties "
			+ "(false-claim 5, rule-break 2, escaped-defect 8). Survival = finished runs that ended with a final result. Steering is approximate "
			+ "(Main turns naming the agent).",
		"",
		"| # | Worker model | Runs (live) | Survival | Accepted (diag/val) | First-pass | Net pts | $ worker | $ steering | pts/$ | pts/h |",
		"|---|---|---|---|---|---|---|---|---|---|---|",
	];
	rows.forEach((r, i) => {
		lines.push(
			`| ${i + 1} | ${r.model} | ${r.runs} (${r.running}) | ${fmt(r.surv, "pct")} | ${r.acc} (${r.diag}/${r.val}) | ${fmt(r.fp, "pct")} | ${r.net} | ${pyFixed(r.cost, 2)} | ${pyFixed(r.steer, 2)} | ${fmt(r.ppd, "1f")} | ${fmt(r.pph, "1f")} |`,
		);
	});
	const text = `${lines.join("\n")}\n`;
	mkdirSync(dirname(cfg.paths.ranking_board), { recursive: true });
	writeFileSync(cfg.paths.ranking_board, text);
	printText(text);
}

export function agentScore(args: string[], cfg: Config, source: RunSource): number {
	mkdirSync(cfg.paths.score_state, { recursive: true });
	if (args.length < 1 || args[0] === "-h" || args[0] === "--help") {
		printText(helpDoc("agent-score"));
		return 0;
	}
	const cmd = args[0]!;
	const rest = args.slice(1);
	const repo = rest.includes("--repo") ? needOpt(rest, "--repo") : cfg.score.default_repo;
	const branch = rest.includes("--branch") ? needOpt(rest, "--branch") : cfg.score.default_branch;
	try {
		if (cmd === "accept") {
			const agent = rest[0];
			const plan = opt(rest, "--plan");
			const phase = opt(rest, "--phase");
			if (!agent || !plan || !phase || !rest.includes("--commits")) return exitText("accept needs --plan, --phase, --commits");
			if (!repo) return exitText("accept needs --repo");
			const commits = expandCommits(repo, needOpt(rest, "--commits"));
			const bad = commits.filter(c => gitRaw(repo, ["merge-base", "--is-ancestor", c, branch]).code).map(c => c.slice(0, 10));
			if (bad.length) return exitText(`refused: not on ${branch} yet (merge first): ${bad.join(" ")}`);
			const { w, src } = weightFor(rest, plan, phase, cfg, null);
			const units = Number(rest.includes("--units") ? needOpt(rest, "--units") : "1");
			record({
				type: "accept", agent, plan, phase, weight: w * units, unit_weight: w, units, weight_src: src,
				repo, branch, commits, rework: rest.includes("--rework"), note: opt(rest, "--note") ?? "",
			}, cfg);
			return 0;
		}
		if (cmd === "diagnose") {
			const agent = rest[0];
			const plan = opt(rest, "--plan");
			const phase = opt(rest, "--phase");
			const ev = opt(rest, "--evidence");
			if (!agent || !plan || !phase || !ev || !existsSync(ev)) return exitText("diagnose needs --plan, --phase and an existing --evidence file");
			const weighted = rest.includes("--weight") ? weightFor(rest, plan, phase, cfg, cfg.score.diagnose_weight) : { w: cfg.score.diagnose_weight, src: "default" };
			record({
				type: "diagnose", agent, plan, phase, weight: weighted.w, weight_src: weighted.src, evidence: ev, note: opt(rest, "--note") ?? "",
			}, cfg);
			return 0;
		}
		if (cmd === "validate") {
			const agent = rest[0];
			const plan = opt(rest, "--plan");
			const phase = opt(rest, "--phase");
			const ev = opt(rest, "--evidence");
			const section = opt(rest, "--section");
			if (!agent || !plan || !phase || !ev || !section) return exitText("validate needs --plan, --phase, --evidence and --section");
			if (!phaseTicked(plan, phase)) return exitText(`refused: ${phase} not ticked in ${plan}`);
			const { w, src } = weightFor(rest, plan, phase, cfg, null);
			if (!existsSync(ev)) return exitText(`refused: evidence file not found: ${ev}`);
			const body = sectionBody(readFileSync(ev, "utf8"), section);
			if (body === null) return exitText(`refused: no heading starting with ${section} in ${ev}`);
			if (!body.split("\n").some(l => l.trim())) return exitText(`refused: section ${section} has no body in ${ev}`);
			const labels = heavyEndLabels(cfg.paths.heavy_log, agent).filter(l => body.includes(l));
			if (labels.length === 0) return exitText(`refused: section cites no heavy-run label run by ${agent}`);
			const scored = readEvents(cfg).some(e => (e.type === "accept" || e.type === "validate") && e.agent === agent && e.plan === plan && e.phase === phase);
			if (scored) return exitText("refused: already scored");
			record({
				type: "validate", agent, plan, phase, weight: w, weight_src: src, evidence: ev, section,
				labels, rework: rest.includes("--rework"), note: opt(rest, "--note") ?? "",
			}, cfg);
			return 0;
		}
		if (cmd === "penalty") {
			const kind = opt(rest, "--kind");
			const note = opt(rest, "--note");
			const kinds = Object.keys(cfg.score.penalties);
			if (!kind || !kinds.includes(kind) || !note) return exitText(`penalty needs --kind ${kinds.join("|")} and --note`);
			record({ type: "penalty", agent: rest[0], kind, plan: opt(rest, "--plan") ?? "", note }, cfg);
			return 0;
		}
		if (cmd === "exempt") {
			if (!opt(rest, "--note")) return exitText("exempt needs --note");
			if (!repo) return exitText("exempt needs --repo");
			record({ type: "exempt", agent: "MAIN", repo, commits: expandCommits(repo, rest[0] ?? ""), note: needOpt(rest, "--note") }, cfg);
			return 0;
		}
		if (cmd === "base") {
			if (!repo) return exitText("base needs --repo");
			const sha = expandCommits(repo, rest[0] ?? "")[0]!;
			record({ type: "base", agent: "MAIN", repo, branch, base: sha }, cfg);
			return 0;
		}
		if (cmd === "check") {
			if (!repo) return exitText(`no base for ${repo} ${branch}: run \`agent-score base <sha> --repo ${repo} --branch ${branch}\` once`);
			const bases = readEvents(cfg).filter(e => e.type === "base" && e.repo === repo && e.branch === branch);
			if (bases.length === 0) return exitText(`no base for ${repo} ${branch}: run \`agent-score base <sha> --repo ${repo} --branch ${branch}\` once`);
			const base = String(bases[bases.length - 1]!.base);
			const r = gitRaw(repo, ["rev-list", "--no-merges", `${base}..${branch}`]);
			if (r.code) return exitText(r.stderr.trim());
			const cov = new Set<string>();
			for (const e of readEvents(cfg)) {
				if (e.repo === repo && Array.isArray(e.commits)) for (const c of e.commits) cov.add(String(c));
			}
			const all = r.stdout.split(/\s+/).filter(Boolean);
			const miss = all.filter(c => !cov.has(c));
			for (const c of miss) printText(`UNSCORED ${gitRaw(repo, ["log", "-1", "--format=%h %s", c]).stdout.trim()}`);
			printText(`${branch}: ${all.length} commits since base, ${miss.length} unscored`);
			return miss.length ? 1 : 0;
		}
		if (cmd === "board") {
			board(Number(rest.includes("--days") ? needOpt(rest, "--days") : cfg.score.board_days), cfg, source);
			return 0;
		}
		if (cmd === "gate") {
			const who = rest[0] ?? "";
			const { rows, byAgent } = table(cfg.score.gate_days, cfg, source);
			const target = byAgent.get(who)?.model ?? who;
			const ranked = rows.filter(r => r.acc).map(r => r.model);
			const mine = ranked.findIndex(m => m.includes(target));
			if (mine < 0) printText(`gate: ${target} has no accepted work in ${cfg.score.gate_days} days (unrated)`);
			else if (mine > 0) printText(`WARN gate: ${ranked[mine]} ranks #${mine + 1}; better-ranked: ${ranked.slice(0, mine).join(", ")}. Use one of those if available, or say why not.`);
			else printText(`gate: ${ranked[mine]} ranks #1`);
			return 0;
		}
		return exitText(`unknown command ${cmd}; see agent-score --help`);
	} catch (err) {
		if (err instanceof Error && err.message === "stop") return 1;
		throw err;
	}
}
