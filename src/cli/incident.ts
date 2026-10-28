// `neurastream incident …`: the incident list Main must act on (store: src/core/incidents.ts).
// `list` prints incidents (--open: only the ones with no plan/dismiss/fixed yet; --json: the full
// records); `add` records Main's own finding (source "main"); `plan` records the plan that fixes
// an incident; `dismiss` records why an incident is not a bug; `propose` records Main's written reason
// (file:line proof) for a finding, which leaves the incident open.

import { ConfigError, loadConfig, type Config } from "../core/config.ts";
import {
	addIncident,
	dismissIncident,
	openIncidents,
	planIncident,
	proposeIncident,
	readIncidents,
	type IncidentView,
} from "../core/incidents.ts";

export const INCIDENT_USAGE = [
	"usage: neurastream incident list [--open] [--json]",
	'       neurastream incident add "<summary>" --kind <k> [--evidence <text>]',
	'       neurastream incident propose <id> --why "<file:line and reason>"',
	"       neurastream incident plan <id> <plan.md>",
	'       neurastream incident dismiss <id> --why "<text>" [--owner "<quote>"]',
].join("\n");

function flagValue(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

/** OPEN, or the last resolution as a past-tense label. */
const STATE_LABEL = { plan: "PLANNED", dismiss: "DISMISSED", fixed: "FIXED" } as const;

function stateOf(v: IncidentView): "OPEN" | "PLANNED" | "DISMISSED" | "FIXED" {
	return v.resolution ? STATE_LABEL[v.resolution.type] : "OPEN";
}

export function listIncidents(cfg: Config, args: string[]): number {
	const views = args.includes("--open") ? openIncidents(cfg) : readIncidents(cfg);
	if (args.includes("--json")) {
		console.log(JSON.stringify(views, null, 2));
		return 0;
	}
	for (const v of views) console.log(`${v.id} ${stateOf(v)} [${v.source}/${v.kind}] x${v.count} ${v.summary}`);
	return 0;
}

export function addIncidentCmd(cfg: Config, args: string[]): number {
	const summary = args[0];
	const kind = flagValue(args, "--kind");
	if (!summary || summary.startsWith("-") || !kind) {
		console.error(INCIDENT_USAGE);
		return 2;
	}
	const { incident, deduped } = addIncident(cfg, {
		source: "main",
		kind,
		summary,
		evidence: flagValue(args, "--evidence"),
	});
	if (deduped)
		console.log(
			`${incident.id} already open (seen x${incident.count}, last ${new Date(incident.lastSeen * 1000).toISOString()}): count and last seen updated, no new incident`,
		);
	else console.log(`${incident.id} recorded (open) [main/${incident.kind}]: ${incident.summary}`);
	return 0;
}

export function planIncidentCmd(cfg: Config, id: string, planPath: string): number {
	if (!id || !planPath) {
		console.error(INCIDENT_USAGE);
		return 2;
	}
	const why = planIncident(cfg, id, planPath);
	if (why) {
		console.error(why);
		return 1;
	}
	console.log(`incident ${id}: plan recorded (${planPath})`);
	return 0;
}

export function dismissIncidentCmd(cfg: Config, id: string, why: string | undefined, owner: string | undefined): number {
	if (!id || why === undefined) {
		console.error(INCIDENT_USAGE);
		return 2;
	}
	const problem = dismissIncident(cfg, id, why, owner);
	if (problem) {
		console.error(problem);
		return 1;
	}
	console.log(`incident ${id}: dismissed`);
	return 0;
}

export function proposeIncidentCmd(cfg: Config, id: string, why: string | undefined): number {
	if (!id || why === undefined) {
		console.error(INCIDENT_USAGE);
		return 2;
	}
	const problem = proposeIncident(cfg, id, why);
	if (problem) {
		console.error(problem);
		return 1;
	}
	console.log(`incident ${id}: proposal recorded (still open)`);
	return 0;
}

export async function runIncident(args: string[]): Promise<number> {
	let cfg: Config;
	try {
		cfg = loadConfig();
	} catch (err) {
		console.error(err instanceof ConfigError ? err.message : String(err));
		return 1;
	}
	const [sub = "", ...rest] = args;
	if (sub === "list") return listIncidents(cfg, rest);
	if (sub === "add") return addIncidentCmd(cfg, rest);
	if (sub === "plan") return planIncidentCmd(cfg, rest[0] ?? "", rest[1] ?? "");
	if (sub === "dismiss") return dismissIncidentCmd(cfg, rest[0] ?? "", flagValue(rest, "--why"), flagValue(rest, "--owner"));
	if (sub === "propose") return proposeIncidentCmd(cfg, rest[0] ?? "", flagValue(rest, "--why"));
	console.error(INCIDENT_USAGE);
	return 2;
}
