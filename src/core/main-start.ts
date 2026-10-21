import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";

function bin(name: string, cfg: Config): string {
	return join(cfg.paths.home, ".local/bin", name);
}

// Main's session-start preflight as one text. The CLI prints it; the session rollover handoff
// (src/core/rollover.ts) carries the same text into the new session. Children's stdout is
// collected in order, so the printed output matches the original script line for line.
export function mainStartText(args: string[], cfg: Config): string {
	const out: string[] = [];
	const say = (line: string) => out.push(`${line}\n`);
	const h = args[0] ?? String(cfg.health.default_hours);
	say("=== machine");
	const mg = spawnSync(bin("machine-guard", cfg), [], { encoding: "utf8", env: process.env });
	const mgLines = (mg.stdout ?? "").trim().split("\n");
	say(mgLines.at(-1) ?? "");
	say(readFileSync("/proc/loadavg", "utf8").trim());
	say("");
	say(`=== agents (last ${h}h; DIED = check its worktree, relaunch FRESH with its progress file)`);
	const ledger = spawnSync(bin("agent-ledger", cfg), ["--hours", h], { encoding: "utf8", env: process.env });
	const awk = spawnSync(
		"awk",
		["NR==1 || /DIED/ {print; next} {ok[++n]=$0} END {for (i=1;i<=n;i++) print ok[i]}"],
		{ input: ledger.stdout ?? "", encoding: "utf8" },
	);
	out.push(awk.stdout ?? "");
	const cap = spawnSync(bin("agent-ledger", cfg), ["--cap"], { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "ignore"] });
	for (const line of (cap.stdout ?? "").split("\n")) {
		if (/^(PRIORITY IDLE|FULL)/.test(line)) say(line);
	}
	say("");
	say("=== main thread");
	const health = spawnSync(bin("main-health", cfg), [], { encoding: "utf8", env: process.env, stdio: ["inherit", "pipe", "inherit"] });
	out.push(health.stdout ?? "");
	say("");
	say("=== queue");
	const check = spawnSync(bin("queue-check", cfg), [], { encoding: "utf8", env: process.env, stdio: ["inherit", "pipe", "inherit"] });
	out.push(check.stdout ?? "");
	say("");
	say("=== heavy-run lock");
	try {
		const lines = readFileSync(cfg.paths.heavy_lock, "utf8").split("\n").slice(0, 2);
		while (lines.length && lines.at(-1) === "") lines.pop();
		if (lines.length) say(lines.join("\n"));
	} catch {}
	say("=== doctor");
	// The CLI file itself (shebang `#!/usr/bin/env bun`), never process.execPath: inside a host
	// harness that is the harness binary, which would start a new agent session instead.
	const cli = join(dirname(fileURLToPath(import.meta.url)), "../cli/main.ts");
	const doctor = spawnSync(cli, ["doctor"], { encoding: "utf8", env: process.env });
	const text = `${doctor.stdout ?? ""}${doctor.stderr ?? ""}`;
	out.push(text.endsWith("\n") || text === "" ? text : `${text}\n`);
	if (doctor.error) say(doctor.error.message);
	return out.join("");
}

export function mainStart(args: string[], cfg: Config): number {
	process.stdout.write(mainStartText(args, cfg));
	return 0;
}
