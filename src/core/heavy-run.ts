import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import type { Config } from "./config.ts";

function flock(lock: string, opts: string[], cmd: string): boolean {
	const r = spawnSync("flock", [...opts, lock, cmd], { encoding: "utf8" });
	return r.status === 0;
}

export function heavyRun(args: string[], cfg: Config): number {
	const lock = cfg.paths.heavy_lock;
	const owner = cfg.paths.heavy_owner;
	const log = cfg.paths.heavy_log;
	if (args[0] === "--status") {
		// The original cats the owner file with 2>/dev/null: missing/unreadable is just an empty name.
		if (flock(lock, ["-n"], "true")) console.log("free");
		else {
			let name = "";
			try {
				name = readFileSync(owner, "utf8").trimEnd();
			} catch {}
			console.log(`busy: ${name}`);
		}
		return 0;
	}
	if (args.length < 4 || args[2] !== "--") {
		process.stderr.write(`usage: heavy-run <who> <what> -- <command...>\n`);
		return 2;
	}
	const who = args[0]!;
	const what = args[1]!;
	const cmdArgs = args.slice(3);
	if (!flock(lock, ["-n"], "true")) {
		let name = "";
		try {
			name = readFileSync(owner, "utf8").trimEnd();
		} catch {}
		process.stderr.write(`[heavy-run] waiting — busy: ${name}\n`);
		if (!flock(lock, [], "true")) return 1;
	}
	const stamp = spawnSync("date", ["+%F %T"], { encoding: "utf8" }).stdout?.trim() ?? "";
	writeFileSync(owner, `${who} | ${what} | since ${stamp} | pid ${process.pid}\n`);
	appendFileSync(log, `${stamp} START ${who} | ${what}\n`);
	const r = spawnSync(cmdArgs[0]!, cmdArgs.slice(1), { stdio: "inherit" });
	const rc = r.status ?? 1;
	const end = spawnSync("date", ["+%F %T"], { encoding: "utf8" }).stdout?.trim() ?? "";
	appendFileSync(log, `${end} END   ${who} | ${what} | exit ${rc}\n`);
	writeFileSync(owner, "");
	return rc;
}
