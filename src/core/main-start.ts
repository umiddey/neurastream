import { existsSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";

function bin(name: string, cfg: Config): string {
	return join(cfg.paths.home, ".local/bin", name);
}

interface RunOpts {
	stdin?: "inherit" | "ignore" | "pipe";
	/** Written to the child's stdin when stdin is "pipe". */
	input?: string;
	stderr?: "inherit" | "pipe" | "ignore";
}

interface RunResult {
	stdout: string;
	stderr: string;
	/** Set when the child could not start (e.g. ENOENT). */
	error?: Error;
}

// Runs a child without blocking the caller's event loop. Resolves once the child has closed its
// streams, or immediately when it fails to start. The handoff runs inside a live agent session,
// which must keep handling events while Main's state is gathered.
function run(file: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
	const { promise, resolve } = Promise.withResolvers<RunResult>();
	const child = spawn(file, args, {
		stdio: [opts.stdin ?? "ignore", "pipe", opts.stderr ?? "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8").on("data", chunk => {
		stdout += chunk;
	});
	child.stderr?.setEncoding("utf8").on("data", chunk => {
		stderr += chunk;
	});
	// A filter such as awk may exit before it has read all its input.
	child.stdin?.on("error", () => {});
	if (opts.stdin === "pipe") child.stdin?.end(opts.input ?? "");
	child.on("error", error => resolve({ stdout, stderr, error }));
	child.on("close", () => resolve({ stdout, stderr }));
	return promise;
}

// Main's session-start preflight as one text. The CLI prints it; the session rollover handoff
// (src/core/rollover.ts) carries the same text into the new session. Children's stdout is
// collected in order, so the printed output matches the original script line for line.
// inheritStdin: the CLI passes its terminal to the children that ask the operator something;
// an agent host passes false, because its stdin is the session's input.
// stderr: the CLI lets a child's stderr reach the terminal. An agent host captures it and appends it
// after that child's stdout, because a write to the terminal would draw over the session's UI.
export async function mainStartText(args: string[], cfg: Config, opts: { inheritStdin: boolean }): Promise<string> {
	const out: string[] = [];
	const say = (line: string) => out.push(`${line}\n`);
	const h = args[0] ?? String(cfg.health.default_hours);
	const childStdin = opts.inheritStdin ? "inherit" : "ignore";
	const childStderr = opts.inheritStdin ? "inherit" : "pipe";
	// Weekly self-metrics: nudge the owner's report when notes/metrics.md is missing or older than the window.
	const reportFile = join(cfg.paths.notes, "metrics.md");
	const stamp = existsSync(reportFile) ? statSync(reportFile).mtime : null;
	if (!stamp || Date.now() - stamp.getTime() > cfg.metrics.report_days * 86400 * 1000) {
		const last = stamp ? stamp.toISOString().slice(0, 10) : "never";
		say(`metrics: report due (last: ${last}) — run neurastream metrics report, then propose ONE rule change to the owner`);
	}
	say("=== machine");
	const mg = await run(bin("machine-guard", cfg), [], { stderr: "ignore" });
	const mgLines = mg.stdout.trim().split("\n");
	say(mgLines.at(-1) ?? "");
	say(readFileSync("/proc/loadavg", "utf8").trim());
	say("");
	say(`=== agents (last ${h}h; DIED = check its worktree, relaunch FRESH with its progress file)`);
	const ledger = await run(bin("agent-ledger", cfg), ["--hours", h], { stderr: "ignore" });
	const awk = await run(
		"awk",
		["NR==1 || /DIED/ {print; next} {ok[++n]=$0} END {for (i=1;i<=n;i++) print ok[i]}"],
		{ stdin: "pipe", input: ledger.stdout, stderr: "ignore" },
	);
	out.push(awk.stdout);
	const cap = await run(bin("agent-ledger", cfg), ["--cap"], { stderr: "ignore" });
	for (const line of cap.stdout.split("\n")) {
		if (/^(PRIORITY IDLE|FULL)/.test(line)) say(line);
	}
	say("");
	say("=== main thread");
	const health = await run(bin("main-health", cfg), [], { stdin: childStdin, stderr: childStderr });
	out.push(health.stdout + health.stderr);
	say("");
	say("=== queue");
	const check = await run(bin("queue-check", cfg), [], { stdin: childStdin, stderr: childStderr });
	out.push(check.stdout + check.stderr);
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
	const doctor = await run(cli, ["doctor"]);
	const text = `${doctor.stdout}${doctor.stderr}`;
	out.push(text.endsWith("\n") || text === "" ? text : `${text}\n`);
	if (doctor.error) say(doctor.error.message);
	return out.join("");
}

export async function mainStart(args: string[], cfg: Config): Promise<number> {
	process.stdout.write(await mainStartText(args, cfg, { inheritStdin: true }));
	return 0;
}
