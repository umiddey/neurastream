import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Run, RunSource } from "./adapter.ts";
import { nowSec, strftime } from "./clock.ts";
import { exitText } from "./help.ts";
import { formatG, pyFixed, pyFixedWidth } from "./pyfmt.ts";
import { pyDictInt } from "./pyjson.ts";
import { cmd } from "./proc.ts";

function opt(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	if (i < 0) return undefined;
	if (i + 1 >= args.length) return undefined;
	return args[i + 1];
}

function rowLine(r: Run): string {
	const pct = r.tokens ? (100 * r.cacheRead) / r.tokens : 0;
	const perCall = r.calls ? r.prefillTokens / r.calls : 0;
	const when = strftime(r.lastWriteAt, "%m-%d %H:%M");
	return [
		r.id.slice(0, 28).padEnd(28, " "),
		r.model.slice(0, 38).padEnd(38, " "),
		String(r.calls).padStart(5, " "),
		pyFixedWidth(r.tokens / 1e6, 1, 7),
		pyFixedWidth(perCall, 0, 8),
		`${pyFixedWidth(pct, 0, 5)}%`,
		pyFixedWidth(r.cost, 2, 7),
		when,
		r.statusDetail,
	].join(" ");
}

export function agentLedger(args: string[], cfg: Config, source: RunSource): number {
	const hoursRaw = opt(args, "--hours");
	const hours = hoursRaw !== undefined ? Number(hoursRaw) : cfg.ledger.default_hours;
	const cut = nowSec() - hours * 3600;
	const rows = source.listRuns(cut).slice().sort((a, b) => {
		if (a.lastWriteAt !== b.lastWriteAt) return a.lastWriteAt - b.lastWriteAt;
		if (a.id !== b.id) return a.id < b.id ? -1 : 1;
		if (a.model !== b.model) return a.model < b.model ? -1 : 1;
		if (a.calls !== b.calls) return a.calls - b.calls;
		if (a.tokens !== b.tokens) return a.tokens - b.tokens;
		if (a.cacheRead !== b.cacheRead) return a.cacheRead - b.cacheRead;
		if (a.cost !== b.cost) return a.cost - b.cost;
		return a.statusDetail < b.statusDetail ? -1 : a.statusDetail > b.statusDetail ? 1 : 0;
	});
	const tt = rows.reduce((s, r) => s + r.tokens, 0);
	const tc = rows.reduce((s, r) => s + r.cost, 0);
	const header = [
		"agent".padEnd(28, " "),
		"model".padEnd(38, " "),
		"calls".padStart(5, " "),
		"Mtok".padStart(7, " "),
		"tok/call".padStart(8, " "),
		"cache%".padStart(6, " "),
		"$list".padStart(7, " "),
		"last-write  ended",
	].join(" ");
	process.stdout.write(`${header}\n`);
	const showAll = args.includes("--all");
	for (const r of rows) {
		if (r.calls === 0 && !showAll) continue;
		process.stdout.write(`${rowLine(r)}\n`);
	}
	process.stdout.write(`TOTAL ${pyFixed(tt / 1e6, 1)} Mtok, $${pyFixed(tc, 2)} list: whole-run totals of sessions active in the last ${formatG(hours)}h\n`);

	if (!args.includes("--cap")) return 0;
	// --incident <id>: the cap check runs while Main is spawning the fix for a recorded incident;
	// then OVER-BUDGET lines must not fail the cap (a ledger bug cannot block its own fix).
	// Provider slots and the priority check stay binding.
	const incident = opt(args, "--incident");
	const live: Record<string, string[]> = {};
	const notLive: string[] = [];
	for (const r of rows) {
		if ((r.statusDetail.startsWith("RUNNING") || r.statusDetail.startsWith("WAITING")) && !r.id.startsWith("MAIN")) {
			if ((nowSec() - r.lastWriteAt) / 60 >= cfg.ledger.idle_not_live_min) {
				notLive.push(r.id);
				continue;
			}
			const provider = r.model.split("/")[0] ?? "";
			(live[provider] ??= []).push(r.id);
		}
	}
	process.stdout.write(`running per provider: ${pyDictInt(Object.fromEntries(Object.entries(live).map(([k, v]) => [k, v.length])))}\n`);
	if (notLive.length) {
		process.stdout.write(`NOT LIVE (no write for ≥ ${cfg.ledger.idle_not_live_min}m, not counted): ${notLive.join(", ")}\n`);
	}
	let full = Object.entries(live).filter(([, v]) => v.length >= cfg.ledger.max_running_per_provider).map(([k]) => k);
	for (const k of full) process.stdout.write(`FULL ${k}: ${live[k]!.join(", ")}\n`);
	const over = rows.filter(r => r.statusDetail.includes("OVER-BUDGET"));
	if (over.length) {
		// Each run reports the cap it was spawned with (its own per-spawn budget, else the global
		// one); the cap is part of the statusDetail the session parser wrote. When every cap is the
		// global one the line stays exactly the original's (golden parity).
		const caps = over.map(r => /OVER-BUDGET\(\d+>(\d+) calls\)/.exec(r.statusDetail)?.[1] ?? String(cfg.guards.sub_max_calls));
		const list = caps.every(c => c === String(cfg.guards.sub_max_calls))
			? `${over.map(r => r.id).join(", ")} past ${cfg.guards.sub_max_calls} calls`
			: `${over.map((r, i) => `${r!.id} (past ${caps[i]} calls)`).join(", ")}`;
		process.stdout.write(`OVER-BUDGET: ${list}: stop them (report + fresh agent with tight brief) before spawning more\n`);
	}
	if (args.includes("--provider")) {
		const provider = opt(args, "--provider");
		const slotsRaw = args.includes("--slots") ? opt(args, "--slots") : "1";
		const slots = slotsRaw === undefined ? NaN : Number(slotsRaw);
		if (!provider || !Number.isFinite(slots)) return exitText("Invalid --provider/--slots arguments");
		if (!cfg.ledger.providers.includes(provider) || !(1 <= slots && slots <= cfg.ledger.max_slots)) {
			return exitText("Invalid provider or slot count");
		}
		full = (live[provider]?.length ?? 0) + slots > cfg.ledger.max_running_per_provider ? [provider] : [];
		process.stdout.write(`planned provider: ${provider}, current=${live[provider]?.length ?? 0}, slots=${slots}, allowed=${full.length ? "False" : "True"}\n`);
	}
	const qc = cmd([join(cfg.paths.home, ".local", "bin", "queue-check"), "--priority-ids"]);
	if (qc.code !== 0) return exitText(`queue-check --priority-ids failed: ${qc.stderr.trim()}`);
	const ids = qc.stdout.split(/\s+/).filter(Boolean);
	const names = Object.values(live).flat();
	const idleIds = [...new Set(ids)].filter(id => !names.some(n => n.includes(id)));
	const prioIdle = idleIds.length > 0 && !args.includes("--priority");
	if (prioIdle) {
		process.stdout.write(`PRIORITY IDLE: no running agent for ${idleIds.join(", ")} (owner queue PRIORITY-ID). Start it first (name must contain the ID), or spawn it with --priority.\n`);
	}
	return full.length || prioIdle || (over.length > 0 && incident === undefined) ? 1 : 0;
}
