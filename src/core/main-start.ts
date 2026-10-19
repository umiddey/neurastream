import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";

function bin(name: string, cfg: Config): string {
	return join(cfg.paths.home, ".local/bin", name);
}

export function mainStart(args: string[], cfg: Config): number {
	const h = args[0] ?? String(cfg.health.default_hours);
	console.log("=== machine");
	const mg = spawnSync(bin("machine-guard", cfg), [], { encoding: "utf8", env: process.env });
	const mgLines = (mg.stdout ?? "").trim().split("\n");
	console.log(mgLines.at(-1) ?? "");
	console.log(readFileSync("/proc/loadavg", "utf8").trim());
	console.log("");
	console.log(`=== agents (last ${h}h; DIED = check its worktree, relaunch FRESH with its progress file)`);
	const ledger = spawnSync(bin("agent-ledger", cfg), ["--hours", h], { encoding: "utf8", env: process.env });
	const awk = spawnSync(
		"awk",
		["NR==1 || /DIED/ {print; next} {ok[++n]=$0} END {for (i=1;i<=n;i++) print ok[i]}"],
		{ input: ledger.stdout ?? "", encoding: "utf8" },
	);
	process.stdout.write(awk.stdout ?? "");
	const cap = spawnSync(bin("agent-ledger", cfg), ["--cap"], { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "ignore"] });
	for (const line of (cap.stdout ?? "").split("\n")) {
		if (/^(PRIORITY IDLE|FULL)/.test(line)) console.log(line);
	}
	console.log("");
	console.log("=== main thread");
	spawnSync(bin("main-health", cfg), [], { stdio: "inherit", env: process.env });
	console.log("");
	console.log("=== queue");
	spawnSync(bin("queue-check", cfg), [], { stdio: "inherit", env: process.env });
	console.log("");
	console.log("=== heavy-run lock");
	try {
		const lines = readFileSync(cfg.paths.heavy_lock, "utf8").split("\n").slice(0, 2);
		while (lines.length && lines.at(-1) === "") lines.pop();
		if (lines.length) console.log(lines.join("\n"));
	} catch {}
	console.log("=== doctor");
	const cli = join(dirname(fileURLToPath(import.meta.url)), "../cli/main.ts");
	const doctor = spawnSync(process.execPath, [cli, "doctor"], { encoding: "utf8", env: process.env });
	const text = `${doctor.stdout ?? ""}${doctor.stderr ?? ""}`;
	process.stdout.write(text.endsWith("\n") || text === "" ? text : `${text}\n`);
	if (doctor.error) console.log(doctor.error.message);
	return 0;
}
