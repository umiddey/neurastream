// Background queue-close for every plan Main marked complete — and (P4, plan 20261031_0911) for
// every OPEN plan whose work has landed. Ported from the original autoClose: same filter, same
// "--- auto-close attempt" log line, detached child with stdio on the per-plan close log.
// QUEUE_CLOSE_BIN overrides the binary (tests); without it the package's own executable
// bin/queue-close runs (its `#!/usr/bin/env bun` shebang picks bun).
// Never process.execPath: inside the harness that is the harness binary itself, so the child was
// a new agent session that loaded this plugin and auto-closed again — a process fork bomb
// (2026-10-21 OOMs, ~175 processes).

import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../core/config.ts";
import * as q from "../../core/queue/lib.ts";
import { adapterLog } from "./launch.ts";

export function closeChildArgs(plan: string, auto: boolean): [string, string[]] {
	const bin = process.env.QUEUE_CLOSE_BIN;
	const args = auto ? ["--auto", plan] : [plan];
	if (bin) return [bin, args];
	return [join(import.meta.dir, "..", "..", "..", "bin", "queue-close"), args];
}

export function autoClose(cfg: Config): string[] {
	const started: string[] = [];
	let plans: q.Plan[];
	try {
		// P4: landed open plans auto-close too (q.autoCloseCandidate) — the child runs queue-close
		// --auto and writes "Status: complete" itself when the done check passes.
		plans = q.activePlans(cfg.paths).filter(p => (p.status === "complete" || p.status === "cancelled" || q.autoCloseCandidate(p)) && !p.errors.length);
	} catch {
		return started;
	}
	try {
		mkdirSync(cfg.paths.queue_state, { recursive: true });
	} catch {}
	for (const p of plans) {
		try {
			const outFile = q.closeLog(p.file, cfg.paths);
			appendFileSync(outFile, `--- ${new Date().toISOString()} auto-close attempt\n`);
			const out = openSync(outFile, "a");
			const [bin, args] = closeChildArgs(p.file, p.status === "open");
			const childEnv: NodeJS.ProcessEnv = {
				...process.env,
				HOME: cfg.paths.home,
				QUEUE_AGENT: cfg.paths.agent_dir,
				QUEUE_INDEX: cfg.paths.queue_index,
				QUEUE_BLOCKERS: cfg.paths.blockers,
				QUEUE_STATE: cfg.paths.queue_state,
				QUEUE_SUBAGENTS: cfg.paths.subagents,
				QUEUE_CANCELLED: cfg.paths.cancelled,
				QUEUE_UNLOCK: cfg.paths.unlock,
			};
			const child = spawn(bin, args, { detached: true, stdio: ["ignore", out, out], env: childEnv });
			child.unref();
			closeSync(out);
			started.push(p.file);
		} catch (err) {
			adapterLog(cfg, `auto-close: could not start for ${p.file}: ${err}`);
		}
	}
	if (started.length) adapterLog(cfg, `auto-close started: ${started.join(", ")}`);
	return started;
}
