// `neurastream setup [--yes]` (plan 20261028_2356 P4): the guided first run. It shows what this
// machine has (src/core/setup-detect.ts), lays out the home (initHome), asks in groups, writes each
// group's answers through the one config editor (src/core/config-edit.ts), then runs the adapter
// install and doctor. Every answer is proven to load before it is kept; --yes takes the proposals
// without asking. SetupDeps carries the terminal, the seams, and the install/doctor runs, so tests
// drive the whole flow without a real terminal, systemctl or Tailscale.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { getAdapter, harnessBins } from "../adapters/index.ts";
import { TEMPLATE_PATH, configFile } from "../core/config.ts";
import { checkEdited, leafKeys, setConfigKeys, valueAt, yamlValue } from "../core/config-edit.ts";
import { pagesDoctor } from "../core/pages-doctor.ts";
import { detect, realSeams, type SetupFacts, type SetupSeams } from "../core/setup-detect.ts";
import { invalidSlugs } from "../core/subagents.ts";
import { TAILSCALE_MISSING, TAILSCALE_STOPPED } from "../core/ui-setup.ts";
import { askLine, initHome } from "./init.ts";

export interface SetupDeps {
	home: string;
	env: NodeJS.ProcessEnv;
	invoked: string;
	terminal: boolean;
	ask: (question: string) => string;
	seams: SetupSeams;
	install: () => number;
	doctor: () => number;
	say: (line: string) => void;
}

/** The production deps: the real home, terminal, PATH, Tailscale, adapter install and doctor. */
export function realSetupDeps(): SetupDeps {
	const home = homedir();
	return {
		home,
		env: process.env,
		invoked: process.argv[1] ?? "",
		terminal: process.stdin.isTTY === true,
		ask: askLine,
		seams: realSeams(harnessBins(), home, process.env),
		install: () => getAdapter().install(["install", getAdapter().name]),
		doctor: () => {
			for (const warning of pagesDoctor(home)) console.warn(`warning: ${warning}`);
			return getAdapter().doctor();
		},
		say: (line) => console.log(line),
	};
}

// Trailing `# comment` of each leaf key, by dotted path. The indentation stack gives a key's path
// from its parents' keys, so a nested key never takes a neighbour's comment.
export function templateComments(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	const stack: { indent: number; key: string }[] = [];
	for (const line of text.split("\n")) {
		const m = /^( *)([A-Za-z_][\w-]*):(.*)$/.exec(line);
		if (!m) continue;
		const indent = m[1]!.length;
		while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
		stack.push({ indent, key: m[2]! });
		const comment = /#\s*(.*)$/.exec(m[3]!)?.[1]?.trim() ?? "";
		if (comment !== "") out[stack.map((s) => s.key).join(".")] = comment;
	}
	return out;
}

const TEMPLATE_TEXT = readFileSync(TEMPLATE_PATH, "utf8");
const TEMPLATE = Bun.YAML.parse(TEMPLATE_TEXT);
const COMMENTS = templateComments(TEMPLATE_TEXT);
const VALID_KEYS = leafKeys(TEMPLATE);
const TIERS = ["strict", "opinionated", "full"];

// The asked groups, in order. Keys outside them form the advanced walk.
const GROUPS: { name: string; keys: string[] }[] = [
	{ name: "Paths", keys: ["paths.work_roots"] },
	{ name: "Harness", keys: ["harness"] },
	{ name: "Autonomy", keys: ["autonomy.tier", "autonomy.strict_edit_limit", "autonomy.go_minutes", "autonomy.go_phrase"] },
	{ name: "Phone page", keys: ["ui.enabled", "ui.owner_login"] },
	{ name: "Static pages", keys: ["pages.enabled", "pages.port", "pages.dir"] },
	{ name: "Notify", keys: ["notify.discord_webhook_file", "notify.slack_webhook_file"] },
	{ name: "Secrets", keys: ["secrets.redact", "secrets.known_value_files", "secrets.proxy"] },
	{ name: "Machine", keys: ["machine.load_over_cores", "machine.avail_min_mb", "machine.disk_min_gb"] },
	{ name: "Session rollover", keys: ["rollover.enabled", "rollover.max_session_mb", "rollover.exit_grace_s"] },
];

type Kind = "bool" | "num" | "list" | "str";
interface Change {
	key: string;
	old: unknown;
	next: unknown;
}
interface Ctx {
	deps: SetupDeps;
	facts: SetupFacts;
	fresh: boolean;
	file: string;
	text: string;
	changed: Change[];
	// none: ask every key. group: accept proposals until this group ends (s). all: accept every proposal (q, --yes).
	auto: "none" | "group" | "all";
}

export function runSetup(args: string[], deps: SetupDeps = realSetupDeps()): number {
	const yes = args.includes("--yes");
	if (!yes && !deps.terminal) {
		deps.say("neurastream setup needs a terminal or --yes");
		return 2;
	}
	const facts = detect(deps.seams);
	printFacts(deps, facts);
	const ctx: Ctx = {
		deps,
		facts,
		fresh: facts.current === null,
		file: configFile(deps.home),
		text: "",
		changed: [],
		auto: yes ? "all" : "none",
	};
	const allow = yes ? [] : askSubagents(deps);
	const made = initHome(deps.home, { invoked: deps.invoked, env: deps.env, allow: allow.length > 0 ? allow : undefined });
	deps.say(`layout: created ${made.created.length}, kept ${made.unchanged.length}`);
	ctx.text = readFileSync(ctx.file, "utf8");
	for (const group of GROUPS) {
		if (runGroup(ctx, group.name, group.keys) !== 0) return 1;
	}
	if (ctx.auto === "none") {
		const advanced = VALID_KEYS.filter((k) => !GROUPS.some((g) => g.keys.includes(k)));
		const open = deps.ask(`Show the ${advanced.length} advanced settings? [y/N]: `).trim();
		if (/^y(es)?$/i.test(open) && runGroup(ctx, "Advanced", advanced) !== 0) return 1;
	}
	const installed = deps.install();
	if (installed !== 0) {
		deps.say("adapter install failed");
		return installed;
	}
	const doctor = deps.doctor();
	printChanges(deps, ctx.changed);
	if (doctor === 0) deps.say("Next: neurastream main");
	return doctor;
}

function printFacts(deps: SetupDeps, facts: SetupFacts): void {
	deps.say("Detected on this machine:");
	deps.say(`  work roots: ${facts.workRoots.join(", ") || "none"}`);
	deps.say(`  harnesses on PATH: ${facts.harnesses.join(", ") || "none"}`);
	deps.say(`  tailscale: ${facts.tailscale.state}`);
	deps.say(`  secretgate: ${facts.secretgate ? "on PATH" : "not on PATH"}`);
	deps.say(`  machine: ${facts.machine.cores} cores, ${facts.machine.ramMb} MB RAM, ${facts.machine.diskFreeGb} GB free disk`);
}

function askSubagents(deps: SetupDeps): string[] {
	for (;;) {
		const names = deps.ask("Subagents allowed to spawn (comma-separated names, empty = none): ")
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s !== "");
		const bad = invalidSlugs(names);
		if (bad.length === 0) return names;
		deps.say(`  not a valid name: ${bad.join(", ")}`);
	}
}

function printChanges(deps: SetupDeps, changed: Change[]): void {
	if (changed.length === 0) {
		deps.say("No settings changed.");
		return;
	}
	deps.say("Changed:");
	for (const c of changed) deps.say(`  ${c.key}: ${JSON.stringify(c.old)} → ${JSON.stringify(c.next)}`);
}

// Asks one group, then writes the changed keys once through the editor. Returns non-zero only
// when the edited file would not load (nothing is written then).
function runGroup(ctx: Ctx, name: string, keys: string[]): number {
	ctx.deps.say(`\n${name}`);
	const now = Bun.YAML.parse(ctx.text);
	const picks: Record<string, unknown> = {};
	for (const key of keys) {
		if (key === "ui.owner_login" && picks["ui.enabled"] !== true) continue;
		const proposed = proposal(ctx, key, valueAt(now, key));
		let value = askKey(ctx, key, kindOf(key), proposed);
		if (key === "ui.enabled" && value === true && !phoneReady(ctx)) value = false;
		if (key.startsWith("notify.") && value !== "") ctx.deps.say("  send a test with: neurastream notify test");
		picks[key] = value;
	}
	if (ctx.auto === "group") ctx.auto = "none";
	const changes: Record<string, string> = {};
	for (const key of Object.keys(picks)) {
		const old = valueAt(now, key);
		if (JSON.stringify(old) === JSON.stringify(picks[key])) continue;
		changes[key] = yamlValue(picks[key]);
		ctx.changed.push({ key, old, next: picks[key] });
	}
	if (Object.keys(changes).length === 0) return 0;
	const edited = setConfigKeys(ctx.text, changes);
	if (!checkEdited(edited, ctx.deps.home, (line) => ctx.deps.say(line))) return 1;
	writeFileSync(ctx.file, edited);
	ctx.text = edited;
	return 0;
}

// The value offered for Enter. A fresh home offers what this machine has; a re-run offers the
// current config, so a setting the owner already chose never moves on its own.
function proposal(ctx: Ctx, key: string, current: unknown): unknown {
	if (!ctx.fresh) return current;
	const fromFacts: Record<string, unknown> = {
		"paths.work_roots": ctx.facts.workRoots,
		harness: ctx.facts.harnesses[0],
		"machine.load_over_cores": ctx.facts.proposed.load_over_cores,
		"machine.avail_min_mb": ctx.facts.proposed.avail_min_mb,
		"machine.disk_min_gb": ctx.facts.proposed.disk_min_gb,
	};
	return fromFacts[key] ?? current;
}

function kindOf(key: string): Kind {
	const t = valueAt(TEMPLATE, key);
	if (typeof t === "boolean") return "bool";
	if (typeof t === "number") return "num";
	if (Array.isArray(t)) return "list";
	return "str";
}

function askKey(ctx: Ctx, key: string, kind: Kind, proposed: unknown): unknown {
	if (ctx.auto !== "none") return proposed;
	const comment = COMMENTS[key] ?? "";
	for (;;) {
		const raw = ctx.deps
			.ask(`${key}: ${comment} [${yamlValue(proposed)}] (Enter keeps; s keeps the rest of this group; q keeps the rest): `)
			.trim();
		if (raw === "") return proposed;
		if (raw === "s" || raw === "q") {
			ctx.auto = raw === "s" ? "group" : "all";
			return proposed;
		}
		const parsed = parseAnswer(kind, raw);
		if ("error" in parsed) {
			ctx.deps.say(`  ${parsed.error}`);
			continue;
		}
		const problem = validate(ctx, key, parsed.value);
		if (problem !== null) {
			ctx.deps.say(`  ${problem}`);
			continue;
		}
		return parsed.value;
	}
}

function parseAnswer(kind: Kind, raw: string): { value: unknown } | { error: string } {
	if (kind === "bool") {
		if (/^(true|yes|y|on)$/i.test(raw)) return { value: true };
		if (/^(false|no|n|off)$/i.test(raw)) return { value: false };
		return { error: "answer yes or no" };
	}
	if (kind === "num") {
		const n = Number(raw);
		return Number.isFinite(n) ? { value: n } : { error: "answer a number" };
	}
	if (kind === "list") {
		if (!raw.startsWith("[")) return { value: raw.split(",").map((s) => s.trim()).filter((s) => s !== "") };
		try {
			const list: unknown = Bun.YAML.parse(raw);
			if (Array.isArray(list) && list.every((x) => typeof x === "string")) return { value: list };
		} catch {
			// not YAML: reported below
		}
		return { error: "answer a list of strings, e.g. [\"a\", \"b\"] or a, b" };
	}
	return { value: raw };
}

// Why an answer is refused, or null. The file must load with the answer in place (checkEdited),
// and the named keys must hold values the setup understands.
function validate(ctx: Ctx, key: string, value: unknown): string | null {
	const problem = rule(ctx, key, value);
	if (problem !== null) return problem;
	const messages: string[] = [];
	const candidate = setConfigKeys(ctx.text, { [key]: yamlValue(value) });
	return checkEdited(candidate, ctx.deps.home, (line) => messages.push(line)) ? null : messages.join("\n");
}

function rule(ctx: Ctx, key: string, value: unknown): string | null {
	if (key === "autonomy.tier" && !TIERS.includes(String(value))) return `autonomy.tier must be ${TIERS.join(", ")}`;
	if (key === "harness" && !ctx.deps.seams.harnesses.some((h) => h.name === value)) {
		return `harness must be one of: ${ctx.deps.seams.harnesses.map((h) => h.name).join(", ")}`;
	}
	if (key === "secrets.proxy" && value === "secretgate" && !ctx.facts.secretgate) return "secretgate is not on PATH";
	if (key === "secrets.proxy" && value !== "none" && value !== "secretgate") return "secrets.proxy must be none or secretgate";
	return null;
}

// The phone page needs a running tailnet. Without one the page stays off and the setup says why.
function phoneReady(ctx: Ctx): boolean {
	const tailscale = ctx.deps.seams.tailscale;
	const state = tailscale.state();
	if (state === "missing") {
		ctx.deps.say(TAILSCALE_MISSING);
		return false;
	}
	if (state === "stopped") {
		ctx.deps.say(TAILSCALE_STOPPED);
		return false;
	}
	const logins = tailscale.logins() ?? [];
	if (logins.length > 0) ctx.deps.say(`  logins on this tailnet: ${logins.join(", ")}`);
	return true;
}
