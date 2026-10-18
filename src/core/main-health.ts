import { basename } from "node:path";
import type { Config } from "./config.ts";
import type { RunSource } from "./adapter.ts";
import { pyFixed } from "./pyfmt.ts";
import { cmd } from "./proc.ts";

export function mainHealth(args: string[], cfg: Config, source: RunSource): number {
	const sess = source.mainSession(args[0]);
	if (!sess) {
		process.stderr.write("no main session\n");
		return 1;
	}
	process.stdout.write(`session: ${basename(sess.file)}\n`);
	const ctx = sess.calls.map(c => c.inputPlusCache);
	if (ctx.length) {
		const tail = ctx.slice(-cfg.health.tail_calls);
		const now = ctx[ctx.length - 1]!;
		const flag = now > cfg.health.warn_ctx ? "BLOATED" : "ok";
		process.stdout.write(
			`context per call: now ${pyFixed(now / 1000, 0)}k, last-50 min ${pyFixed(Math.min(...tail) / 1000, 0)}k max ${pyFixed(Math.max(...tail) / 1000, 0)}k (warn > ${pyFixed(cfg.health.warn_ctx / 1000, 0)}k) -> ${flag}\n`,
		);
	}
	if (sess.lastUser) {
		process.stdout.write(`last owner message: ${sess.lastUser.at.slice(0, 19)}  ${sess.lastUser.text.slice(0, 160)}\n`);
	}
	const wip = cmd(["wip-check"]);
	const summary = wip.stdout.split("\n").filter(l => l.startsWith("UNLANDED") || l.startsWith("DIRTY"));
	const joined = summary.join("; ").slice(0, 200);
	process.stdout.write(`open work: ${joined || "wip-check gave no summary"}\n`);
	return 0;
}
