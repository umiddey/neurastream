import { spawnSync } from "node:child_process";
import type { Config } from "./config.ts";

function shDate(tz: string, spec: string, fmt?: string): { ok: boolean; status: number; out: string } {
	const args = fmt ? ["-d", spec, `+${fmt}`] : ["-d", spec, "+%s"];
	// stderr inherited: the original's set -e lets date's own message reach the terminal.
	const r = spawnSync("date", args, { encoding: "utf8", env: { ...process.env, TZ: tz }, stdio: ["ignore", "pipe", "inherit"] });
	return { ok: r.status === 0, status: r.status ?? 1, out: (r.stdout ?? "").trim() };
}

export function glmReset(args: string[], cfg: Config): number {
	if (args.length < 1) {
		process.stderr.write('usage: glm-reset "YYYY-MM-DD HH:MM[:SS]" (time from the GLM 429 message)\n');
		return 2;
	}
	const when = args.join(" ");
	const epochR = shDate(cfg.glm.reset_tz, when);
	if (!epochR.ok) return epochR.status;
	const epoch = Number(epochR.out);
	const nowR = spawnSync("date", ["+%s"], { encoding: "utf8" });
	const now = Number((nowR.stdout ?? "").trim());
	const localR = spawnSync("date", ["-d", `@${epoch}`, "+%Y-%m-%d %H:%M:%S %Z"], { encoding: "utf8" });
	const local_t = (localR.stdout ?? "").trim();
	const label = cfg.glm.label;
	if (epoch <= now) {
		console.log(`${label} reset (local): ${local_t} — ALREADY BACK (${Math.floor((now - epoch) / 60)} min ago). Use GLM now.`);
	} else {
		const d = epoch - now;
		console.log(`${label} reset (local): ${local_t} — in ${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m`);
	}
	return 0;
}
