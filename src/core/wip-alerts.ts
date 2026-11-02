// The last snapshot and backup runs turned into the lines main-start prints, one incident per state
// and one post per NEW state. A state counts as announced once it is in wip-last.json, so the next
// main start of the same failure stays quiet; a healthy run clears it, so a recurrence posts again.
import { nowSec, strftime } from "./clock.ts";
import type { Config } from "./config.ts";
import { addIncident } from "./incidents.ts";
import { postReply } from "./notify.ts";
import { readWipLast, writeWipLast, type WipRunRec } from "./wip-fail.ts";

/** A backup run this old means the nightly job stopped running. */
const BACKUP_STALE_HOURS = 30;

interface Alert {
	rec: WipRunRec;
	key: string;
	kind: "wip-snapshot-failed" | "wip-backup-failed" | "wip-backup-refused" | "wip-stale";
	line: string;
	post: string;
}

function alertOf(cfg: Config, rec: WipRunRec, now: number): Alert | null {
	if (rec.failed.length) {
		const line = `wip: ${rec.kind} failed at ${strftime(rec.at, "%Y-%m-%d %H:%M")}: ${rec.failed[0]}`;
		const kind = rec.kind === "snapshot" ? "wip-snapshot-failed" : "wip-backup-failed";
		return { rec, key: `${kind}:${rec.failed[0]}`, kind, line, post: line };
	}
	if (rec.kind === "backup" && rec.refused) {
		const line = `wip: backup refused: ${rec.refused}`;
		return {
			rec,
			key: `wip-backup-refused:${cfg.wip.backup_url}`,
			kind: "wip-backup-refused",
			line,
			post: `Backup stopped: ${rec.refused}. Make it private; nothing was uploaded.`,
		};
	}
	// An empty wip.roots is a config choice, not a failure: the runners record it, nothing alerts on it.
	const limit = rec.kind === "snapshot" ? cfg.wip.stale_hours : BACKUP_STALE_HOURS;
	if (!rec.refused && now - rec.at > limit * 3600) {
		const line = `wip: no ${rec.kind} for ${Math.floor((now - rec.at) / 3600)} h`;
		return { rec, key: `wip-stale:${rec.kind}`, kind: "wip-stale", line, post: line };
	}
	return null;
}

/** The wip lines for main-start; raises one incident per state and posts once per new one. */
export function wipAlerts(cfg: Config, deps: { notify?: (text: string) => void; now?: number } = {}): string[] {
	const now = deps.now ?? nowSec();
	const post = deps.notify ?? ((text: string) => void postReply(text, cfg));
	const last = readWipLast(cfg);
	const alerts: Alert[] = [];
	for (const rec of [last.snapshot, last.backup]) {
		const alert = rec ? alertOf(cfg, rec, now) : null;
		if (alert) alerts.push(alert);
	}
	for (const alert of alerts) {
		if (alert.rec.notified !== alert.key) post(alert.post);
		try {
			addIncident(cfg, {
				source: "watch",
				kind: alert.kind,
				summary: alert.line,
				evidence: `wip-last.json: ${alert.rec.kind} run at ${strftime(alert.rec.at, "%Y-%m-%d %H:%M")}`,
				fingerprint: alert.key,
			});
		} catch {
			// the incident store is best effort; the line and the post still reach Main
		}
	}
	for (const rec of [last.snapshot, last.backup]) {
		if (rec) rec.notified = alerts.find((a) => a.rec === rec)?.key ?? "";
	}
	if (last.snapshot || last.backup) writeWipLast(cfg, last);
	return alerts.map((alert) => alert.line);
}
