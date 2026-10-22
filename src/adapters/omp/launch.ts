// `neurastream main [args…]`: runs the harness in a loop. Under this launcher (env
// NEURASTREAM_MAIN_LAUNCHER=1) a session that is over the rollover size and idle writes
// relaunch.json just before it exits; the launcher then starts a fresh harness whose only argument
// is the handoff. Plain `omp` never gets the flag, so it never relaunches.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Config } from "../../core/config.ts";
import { mainStartText } from "../../core/main-start.ts";
import { applyQueueEnv } from "../../core/queue/env.ts";
import * as q from "../../core/queue/lib.ts";
import { buildHandoff, holdsBlock, relaunchPath } from "../../core/rollover.ts";
import { adapterLog } from "./index.ts";

/** The harness the launcher runs. Tests pass another path through LaunchOptions. */
export const OMP_BIN = "omp";

/** Handoffs up to this many bytes go in the first message; larger ones go to a file. */
const MAX_INLINE_HANDOFF = 100_000;

const OWNER_AWAY =
	"Owner away (automatic rollover). Continue the work in the note and the queue; the owner reads results later.";

export interface LaunchOptions {
	harness?: string;
}

interface RelaunchRequest {
	previousSessionFile: string;
	notePath: string;
	draft: string;
}

/** Runs the harness until a run ends without a fresh relaunch request; returns the last run's code. */
export async function runMainLauncher(args: string[], cfg: Config, opts: LaunchOptions = {}): Promise<number> {
	applyQueueEnv(cfg);
	const harness = opts.harness ?? OMP_BIN;
	let runArgs = args;
	for (;;) {
		rmSync(relaunchPath(), { force: true });
		const started = Date.now();
		const code = await runChild(harness, runArgs);
		const req = takeRequest(started, cfg);
		if (req === null) return code;
		const next = await nextArgs(req, cfg);
		if (next === null) return code;
		runArgs = next;
	}
}

function runChild(harness: string, args: string[]): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	const child = spawn(harness, args, {
		stdio: "inherit",
		env: { ...process.env, NEURASTREAM_MAIN_LAUNCHER: "1" },
	});
	child.on("error", err => {
		console.error(`neurastream main: cannot start ${harness}: ${err.message}`);
		resolve(127);
	});
	child.on("close", code => resolve(code ?? 1));
	return promise;
}

/** The request the last run left behind, only if it was written during that run; consumed on read. */
function takeRequest(since: number, cfg: Config): RelaunchRequest | null {
	const path = relaunchPath();
	let mtimeMs: number;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		return null;
	}
	if (mtimeMs < since) return null;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RelaunchRequest>;
		rmSync(path, { force: true });
		if (typeof raw.previousSessionFile !== "string" || typeof raw.notePath !== "string") {
			adapterLog(cfg, `rollover: relaunch request ignored, missing fields in ${path}`);
			return null;
		}
		return { previousSessionFile: raw.previousSessionFile, notePath: raw.notePath, draft: raw.draft ?? "" };
	} catch (err) {
		adapterLog(cfg, `rollover: relaunch request ignored, unreadable ${path}: ${String(err)}`);
		return null;
	}
}

/** The next run's arguments: the handoff inline, or a file the inline argument points at. */
async function nextArgs(req: RelaunchRequest, cfg: Config): Promise<string[] | null> {
	let note: string;
	try {
		note = readFileSync(req.notePath, "utf8");
	} catch (err) {
		adapterLog(cfg, `rollover: relaunch stopped, note unreadable ${req.notePath}: ${String(err)}`);
		return null;
	}
	const generated = [await mainStartText([], cfg, { inheritStdin: false }), holdsBlock(q.ownerHolds())].join("\n");
	const draft = req.draft.trim() === "" ? "" : `\nOwner's unsent draft: ${req.draft}`;
	const handoff = buildHandoff({
		generated,
		note,
		previousSessionFile: req.previousSessionFile,
		ownerMessage: `${OWNER_AWAY}${draft}`,
	});
	const bytes = Buffer.byteLength(handoff);
	if (bytes <= MAX_INLINE_HANDOFF) {
		adapterLog(cfg, `rollover: relaunch from ${req.previousSessionFile} with the handoff inline (${bytes} bytes)`);
		return [handoff];
	}
	const file = join(dirname(req.notePath), `${basename(req.notePath, ".md")}.handoff.md`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, handoff);
	adapterLog(cfg, `rollover: relaunch from ${req.previousSessionFile} with the handoff in ${file} (${bytes} bytes)`);
	return [
		`Read ${file} first: it is the handoff from your previous session (too long for one message).`,
	];
}
