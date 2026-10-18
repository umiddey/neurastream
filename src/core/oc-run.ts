import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { Config } from "./config.ts";
import { nowSec } from "./clock.ts";
import { exitText, helpDoc } from "./help.ts";
import { PyFloat, pyDumps } from "./pyjson.ts";

function isIdent(s: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

export async function ocRun(args: string[], cfg: Config): Promise<number> {
	if (args.length < 3 || args[1] !== "--") return exitText(helpDoc("oc-run"));
	const agent = args[0]!;
	const cmd = args.slice(2);
	const env: NodeJS.ProcessEnv = { ...process.env };
	while (cmd.length && cmd[0]!.includes("=") && !cmd[0]!.startsWith("-")) {
		const [k, v] = cmd[0]!.split("=", 2) as [string, string];
		if (!isIdent(k)) break;
		cmd.shift();
		env[k] = v ?? "";
	}
	if (cmd.length === 0) return exitText("no command");

	const mi = cmd.indexOf("-m");
	let model = mi >= 0 && mi + 1 < cmd.length ? cmd[mi + 1]! : "?";
	const bare = cfg.oc.model_prefix.endsWith("/") ? cfg.oc.model_prefix.slice(0, -1) : cfg.oc.model_prefix;
	if (!model.startsWith(bare)) model = cfg.oc.model_prefix + model;

	const log = join(cfg.paths.score_state, "oc-runs.jsonl");
	mkdirSync(dirname(log), { recursive: true });
	const start = JSON.parse(pyDumps(new PyFloat(nowSec()))) as number;
	const rec: Record<string, unknown> = {
		agent,
		model,
		plan: env.PLAN ?? "",
		cwd: process.cwd(),
		start: new PyFloat(start),
	};
	appendFileSync(log, `${pyDumps(rec)}\n`);

	const tail: string[] = [];
	const code = await new Promise<number>(resolve => {
		const child = spawn(cmd[0]!, cmd.slice(1), { env, stdio: ["inherit", "pipe", "pipe"] });
		const dec = new TextDecoder("utf-8", { fatal: false });
		let pending = "";
		const pushLine = (line: string) => {
			tail.push(line);
			while (tail.length > cfg.oc.tail_lines) tail.shift();
		};
		const pushText = (s: string) => {
			if (!s) return;
			process.stdout.write(s);
			pending += s;
			const parts = pending.split("\n");
			pending = parts.pop() ?? "";
			for (const part of parts) pushLine(`${part}\n`);
		};
		const onData = (buf: Buffer) => pushText(dec.decode(buf, { stream: true }));
		let exitCode = 1;
		let closed = false;
		let outEnded = false;
		let errEnded = false;
		const finish = () => {
			if (!closed || !outEnded || !errEnded) return;
			pushText(dec.decode());
			if (pending) pushLine(pending);
			resolve(exitCode);
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.stdout?.on("end", () => {
			outEnded = true;
			finish();
		});
		child.stderr?.on("end", () => {
			errEnded = true;
			finish();
		});
		if (!child.stdout) outEnded = true;
		if (!child.stderr) errEnded = true;
		child.on("close", (c, signal) => {
			exitCode = c === null ? (signal ? 1 : 0) : c;
			closed = true;
			finish();
		});
		child.on("error", () => {
			exitCode = 1;
			closed = true;
			outEnded = true;
			errEnded = true;
			resolve(1);
		});
	});

	const text = tail.join("").trim();
	rec.end = new PyFloat(JSON.parse(pyDumps(new PyFloat(nowSec()))) as number);
	rec.exit = code;
	rec.final = Boolean(text) && code === 0;
	rec.tail = text.slice(-cfg.oc.tail_chars);

	const lines = readFileSync(log, "utf8").split("\n").filter(l => l.trim());
	const finished = pyDumps(rec);
	writeFileSync(
		log,
		lines
			.map(l => {
				const r = JSON.parse(l) as { agent?: string; start?: number };
				return r.agent === agent && r.start === start ? finished : pyDumps(JSON.parse(l));
			})
			.join("\n") + "\n",
	);
	return code;
}
