// `neurastream main [args…]`: runs the harness in a loop. Under this launcher (env
// NEURASTREAM_MAIN_LAUNCHER=1) a session that is over the rollover size and idle writes
// relaunch.json just before it exits; the launcher then starts a fresh harness with the owner's
// flags (carriedArgs) and the handoff as its message. Plain `omp` never gets the flag, so it never relaunches.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { LaunchOptions } from "../../core/adapter.ts";
import type { Config } from "../../core/config.ts";
import { readOwnerAnswers, readOwnerMessages } from "../../core/incidents.ts";
import { mainStartText } from "../../core/main-start.ts";
import { appendMetric } from "../../core/metrics.ts";
import { applyQueueEnv } from "../../core/queue/env.ts";
import { tryLock } from "../../core/file-lock.ts";
import { MAIN_ID_RE, mainStateDir } from "../../core/guards.ts";
import * as q from "../../core/queue/lib.ts";
import { buildHandoff, holdsBlock, MAX_NOTE_AGE_MS, OWNER_AWAY, relaunchPath, unansweredOwnerMessages } from "../../core/rollover.ts";
import { PROXY_BIN, proxyOnPath } from "../../core/secret-redact.ts";
import { PACKAGE_ROOT, packageJsonPath, packageVersion } from "./package-root.ts";
import { defaultCompletedResults, defaultRunSource } from "./sessions.ts";

/** One line in the guard log: the adapter's own trace of what it did (relaunches, detectors). */
export function adapterLog(cfg: Config, line: string): void {
	try {
		appendFileSync(cfg.paths.guard_log, `${new Date().toISOString()} ${line}\n`);
	} catch {}
}

/** The harness the launcher runs. Tests pass another path through LaunchOptions. */
export const OMP_BIN = "omp";

/**
 * The one main-only switch, and why an env var and not a flag or config key: children inherit
 * the environment, so a tool starting `omp` from inside a Main session stays guarded — a flag
 * would not travel. The adapter is dead without it (ompExtension in ./index.ts).
 */
export const MAIN_ENV = "NEURASTREAM_MAIN_LAUNCHER";

export interface ProxyPlan {
	/** The command to spawn. */
	cmd: string;
	/** Arguments that come before the harness's own: `wrap -- <harness>` when proxied. */
	prefix: string[];
	/** One stderr line when the proxy was asked for but cannot run; empty otherwise. */
	warning: string;
}

/**
 * `secretgate wrap -- <harness>` when `secrets.proxy: secretgate`, so everything the harness sends
 * leaves through the proxy's own redaction net. A missing binary never blocks the owner: the
 * harness starts normally and one warning says why the second net is off.
 */
export function proxyPlan(harness: string, cfg: Config, onPath: boolean = proxyOnPath()): ProxyPlan {
	if (cfg.secrets.proxy !== "secretgate") return { cmd: harness, prefix: [], warning: "" };
	if (!onPath) {
		return {
			cmd: harness,
			prefix: [],
			warning: `neurastream: secrets.proxy is secretgate but ${PROXY_BIN} is not on PATH; starting ${harness} without the proxy`,
		};
	}
	return { cmd: PROXY_BIN, prefix: ["wrap", "--", harness], warning: "" };
}

/** Flags that take the next argument as their value (omp 18.11.1 --help shows them as `--flag=<value>`). */
export const VALUE_FLAGS: Record<string, true> = {
	"--model": true, "--smol": true, "--slow": true, "--plan": true, "--goal": true, "--prewalk-into": true,
	"--plan-yolo-into": true, "--provider": true, "--api-key": true, "--system-prompt": true,
	"--system-prompt-template": true, "--append-system-prompt": true, "--profile": true, "--alias": true,
	"--cwd": true, "--mode": true, "--config": true, "--add-dir": true, "--restore": true, "--session-dir": true,
	"--models": true, "--tools": true, "--thinking": true, "--service-tier": true, "--hook": true, "-e": true,
	"--extension": true, "--skills": true, "--export": true, "--max-time": true, "--approval-mode": true,
	"--plugin-dir": true,
};

/** Session-picking and one-shot flags: a relaunch never carries them, with their value if they take one. */
const DROPPED_FLAGS: Record<string, true> = {
	"-r": true, "--resume": true, "--restore": true, "-c": true, "--continue": true, "--goal": true,
	"--from-claude": true, "--from-codex": true, "--export": true, "--alias": true, "-p": true, "--print": true,
};

/** Whether `flag` takes `next` as its value: VALUE_FLAGS always do; `-r` only when `next` is not a flag. */
function takesValue(flag: string, next: string | undefined): boolean {
	if (next === undefined) return false;
	if (VALUE_FLAGS[flag] === true) return true;
	return (flag === "-r" || flag === "--resume") && !next.startsWith("-");
}

/**
 * The owner's flags for a relaunch, from the first run's args. Positional arguments (the first
 * message) and session-picking or one-shot flags, with their values, are dropped; every other flag
 * keeps its value. Everything after a bare `--` is positional.
 */
export function carriedArgs(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (arg === "--") break;
		if (!arg.startsWith("-")) continue;
		const eq = arg.indexOf("=");
		const flag = eq === -1 ? arg : arg.slice(0, eq);
		const valued = eq === -1 && takesValue(flag, args[i + 1]);
		if (DROPPED_FLAGS[flag] !== true) {
			out.push(arg);
			if (valued) out.push(args[i + 1] ?? "");
		}
		if (valued) i++;
	}
	return out;
}

/**
 * Splits `--name <id>` / `--name=<id>` — this launcher's Main identity — out of the args; the rest
 * is what the harness gets on the first run and what a relaunch carries. The last --name wins.
 */
export function stripNameFlag(args: string[]): { args: string[]; name: string | undefined } {
	const rest: string[] = [];
	let name: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (arg === "--name") {
			const next = args[i + 1];
			// A bare `--name` with no value (next token missing or another flag) has none: fall back
			// to the env/default id instead of eating the next flag as the id (I-20261031-225).
			if (next !== undefined && !next.startsWith("-")) {
				name = next;
				i++;
			}
		} else if (arg.startsWith("--name=")) {
			name = arg.slice("--name=".length);
		} else {
			rest.push(arg);
		}
	}
	return { args: rest, name };
}

/** Handoffs up to this many bytes go in the first message; larger ones go to a file. */
const MAX_INLINE_HANDOFF = 100_000;

/** Printed before the launcher builds a handoff: main-start collects state, which takes about a minute. */
const HANDOFF_PENDING_LINE = "neurastream: starting a new session from the handoff (collecting state, about a minute)…";

/** Whether `args` carry a positional (the first message): flags with their values do not count. */
function hasPositional(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (arg === "--") return true;
		if (!arg.startsWith("-")) return true;
		const eq = arg.indexOf("=");
		const flag = eq === -1 ? arg : arg.slice(0, eq);
		if (eq === -1 && takesValue(flag, args[i + 1])) i++;
	}
	return false;
}

interface RelaunchRequest {
	previousSessionFile: string;
	notePath: string;
	draft: string;
}

/**
 * Runs the harness until a run ends without a fresh relaunch request; returns the last run's code.
 * The launcher keeps the version it loaded. When the package on disk has another version (or either
 * is unreadable) by the time a run leaves a request, that request goes to a fresh launcher started
 * from the package on disk: the handoff is then built with the installed code, not the old code.
 */
export async function runMainLauncher(args: string[], cfg: Config, opts: LaunchOptions = {}): Promise<number> {
	applyQueueEnv(cfg);
	// --name names this launcher's Main and never reaches the harness: stripped before the first
	// run's args and a relaunch's carriedArgs are built.
	const { args: harnessArgs, name } = stripNameFlag(args);
	const id = name ?? process.env.NEURASTREAM_MAIN_ID ?? "main";
	if (!MAIN_ID_RE.test(id)) {
		console.error(`neurastream: bad main id "${id}": must match [a-z0-9-]{1,24}`);
		return 2;
	}
	// The env, not a flag: the omp child and every relaunch inherit it, and the guards running in
	// this process store this Main's state under it.
	process.env.NEURASTREAM_MAIN_ID = id;
	const stateDir = mainStateDir(cfg);
	mkdirSync(stateDir, { recursive: true });
	// Set only in a fresh launcher the previous one started: its first step is the request that run
	// left. It replaces the launcher that holds the lock, so it skips the lock.
	const handedOver = process.env.NEURASTREAM_RELAUNCH_SINCE;
	delete process.env.NEURASTREAM_RELAUNCH_SINCE;
	// One live launcher per id: the kernel frees the flock when the launcher dies, so there is no
	// pid file and no takeover code.
	const running = handedOver === undefined ? tryLock(join(stateDir, "running.lock")) : { release: () => {} };
	if (!running) {
		console.error(`Main ${id} is already running`);
		return 1;
	}
	try {
		const harness = opts.harness ?? OMP_BIN;
		const proxy = proxyPlan(harness, cfg);
		if (proxy.warning) console.error(proxy.warning);
		const mainStart = opts.mainStart ?? mainStartText;
		const carried = carriedArgs(harnessArgs);
		const loaded = packageVersion(packageJsonPath());
		let runArgs = harnessArgs;
		const since = handedOver === undefined ? Number.NaN : Number(handedOver);
		if (Number.isFinite(since)) {
			const req = readRequest(since, cfg);
			if (req !== null) {
				console.error(HANDOFF_PENDING_LINE);
				const message = await nextMessage(req, cfg, mainStart);
				if (message === null) return 1;
				// The request is removed only once its message exists: a kill during main-start
				// (I-20261024-4) must leave it for the next launcher to continue.
				rmSync(relaunchPath(), { force: true });
				runArgs = [...carried, message];
			}
		} else if (!hasPositional(harnessArgs)) {
			// A fresh start with no message of its own continues a rollover a killed launcher left
			// behind: the request counts while it is at most MAX_NOTE_AGE_MS old, like a note. An
			// older or unreadable one is left alone.
			const req = readRequest(Date.now() - MAX_NOTE_AGE_MS, cfg);
			if (req !== null) {
				console.error(`neurastream: continuing the interrupted rollover from ${req.previousSessionFile}`);
				console.error(HANDOFF_PENDING_LINE);
				const message = await nextMessage(req, cfg, mainStart);
				if (message !== null) {
					rmSync(relaunchPath(), { force: true });
					runArgs = [...carried, message];
				}
			}
		}
		for (;;) {
			const started = Date.now();
			// The env, not a flag: the child inherits it, so an omp started from inside Main stays guarded.
			const code = await runChild(proxy.cmd, [...proxy.prefix, ...runArgs], { ...process.env, [MAIN_ENV]: "1" });
			const req = readRequest(started, cfg);
			if (req === null) return code;
			const installed = packageVersion(packageJsonPath());
			const changed = loaded === null || installed === null || loaded !== installed;
			if (changed && noteReadable(req.notePath)) {
				adapterLog(cfg, `rollover: relaunch handed to a fresh launcher (${loaded ?? "unknown"} → ${installed ?? "unknown"})`);
				// P11: one version-change ledger event per relaunch on a version change; the release verdict reads a to < from event as a downgrade.
				appendMetric(cfg, { type: "version-change", from: loaded ?? "unknown", to: installed ?? "unknown", ts: Math.floor(Date.now() / 1000) });
				return runChild(process.execPath, [join(PACKAGE_ROOT, "src", "cli", "main.ts"), "main", ...carried], {
					...process.env,
					NEURASTREAM_RELAUNCH_SINCE: String(started),
				});
			}
			console.error(HANDOFF_PENDING_LINE);
			const message = await nextMessage(req, cfg, mainStart);
			if (message === null) return code;
			rmSync(relaunchPath(), { force: true });
			runArgs = [...carried, message];
		}
	} finally {
		running.release();
	}
}

/** Runs a command with inherited stdio; resolves to its exit code (127 when it cannot start). */
function runChild(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	const child = spawn(cmd, args, { stdio: "inherit", env });
	child.on("error", err => {
		console.error(`neurastream main: cannot start ${cmd}: ${err.message}`);
		resolve(127);
	});
	child.on("close", code => resolve(code ?? 1));
	return promise;
}

/**
 * The request the last run left behind, only if it was written during that run (mtime at or after
 * `since`). Not consumed: the caller removes it once it has decided to use it. A request without the
 * required fields is removed and logged; an unreadable one is logged and left in place.
 */
function readRequest(since: number, cfg: Config): RelaunchRequest | null {
	const path = relaunchPath();
	let mtimeMs: number;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		return null;
	}
	if (mtimeMs < since) return null;
	let raw: Partial<RelaunchRequest>;
	try {
		raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RelaunchRequest>;
	} catch (err) {
		adapterLog(cfg, `rollover: relaunch request ignored, unreadable ${path}: ${String(err)}`);
		return null;
	}
	if (typeof raw.previousSessionFile !== "string" || typeof raw.notePath !== "string") {
		rmSync(path, { force: true });
		adapterLog(cfg, `rollover: relaunch request ignored, missing fields in ${path}`);
		return null;
	}
	return { previousSessionFile: raw.previousSessionFile, notePath: raw.notePath, draft: raw.draft ?? "" };
}

/** Whether the handoff note can be read now: a launcher cannot relaunch without it. */
function noteReadable(path: string): boolean {
	try {
		readFileSync(path, "utf8");
		return true;
	} catch {
		return false;
	}
}

/** The next run's message: the handoff inline, or the pointer to a file that holds it. */
async function nextMessage(req: RelaunchRequest, cfg: Config, mainStart: typeof mainStartText): Promise<string | null> {
	let note: string;
	try {
		note = readFileSync(req.notePath, "utf8");
	} catch (err) {
		adapterLog(cfg, `rollover: relaunch stopped, note unreadable ${req.notePath}: ${String(err)}`);
		return null;
	}
	let generated: string;
	try {
		generated = [
			await mainStart([], cfg, { inheritStdin: false }, { source: defaultRunSource(cfg), results: defaultCompletedResults(cfg) }),
			holdsBlock(q.ownerHolds()),
		].join("\n");
	} catch (err) {
		// A failing main-start must not cost the owner the note: the handoff says it failed.
		const first = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
		adapterLog(cfg, `rollover: main-start failed: ${first}`);
		generated = `main-start failed during the rollover (${first}); run main-start yourself.`;
	}
	const draft = req.draft.trim() === "" ? "" : `\nOwner's messages during the rollover (and any unsent draft): ${req.draft}`;
	const handoff = buildHandoff({
		generated,
		note,
		previousSessionFile: req.previousSessionFile,
		ownerMessage: `${OWNER_AWAY}${draft}`,
		unanswered: unansweredOwnerMessages(readOwnerMessages(), readOwnerAnswers()),
	});
	const bytes = Buffer.byteLength(handoff);
	if (bytes <= MAX_INLINE_HANDOFF) {
		adapterLog(cfg, `rollover: relaunch from ${req.previousSessionFile} with the handoff inline (${bytes} bytes)`);
		return handoff;
	}
	const file = join(dirname(req.notePath), `${basename(req.notePath, ".md")}.handoff.md`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, handoff);
	adapterLog(cfg, `rollover: relaunch from ${req.previousSessionFile} with the handoff in ${file} (${bytes} bytes)`);
	return `Read ${file} first: it is the handoff from your previous session (too long for one message).`;
}
