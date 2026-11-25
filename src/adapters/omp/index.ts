// omp adapter: one extension translating the harness events the originals used into the core
// guard calls (src/core/guards.ts), plus the auto-close scheduler from main-guard. The harness
// name appears only here; core never imports this file.
//
// Event map (docs/adapter.md, docs/inventory.md):
//   session_start          (main only) auto-close now + every queue.auto_close_min minutes
//   before_agent_start     (main only) checkInject: queue summary + cancel flag, reset counters
//   before_subagent_spawn  allow-list + task-kind gate (the plan gate runs at the task tool call)
//   tool_call              checkTool for everyone: protected files, sub budget/blockers/plan
//                          snapshots, main spawn gates, main edit window
//   tool_result            checkPlanEdit for snapshotted plan writes (applies `restore` itself,
//                          like the original), auto-close after a main push/merge
//   session_stop           checkStop fed with `guards.ledger_command` output
//
// The decision JSON, thresholds and refusal texts come from core; this file only moves shapes.
// Harness payloads are untyped at the boundary: every field read goes through a runtime check.

import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { TraceEvent } from "../../core/adapter.ts";
import { AGENTS_TEMPLATE, renderBlock } from "../../core/agents-md.ts";
import { currentPlanner, plannerPin, stampPlannerMode, verifyPlannerMode } from "../../core/autonomy.ts";
import { briefPaths } from "../../core/brief-lint.ts";
import { fileClaimStore, type ClaimStore } from "../../core/claims.ts";
import { nowSec } from "../../core/clock.ts";
import { configFile, loadConfig, reloadingConfig, type Config } from "../../core/config.ts";
import { tryLock, type HeldLock } from "../../core/file-lock.ts";
import { checkInject, checkPlanEdit, checkStop, checkTool, findingsValue, MAIN_PLAN_FILE, mainId, mainStateDir, newProgressEntries, planReadNote, plannerSpawnPlan, recordMainResult, rekeySpawnFile, resetMainCalls, revertMainEdit, reviewSpawnEnd, STOP_PLAN_OFFER_REFUSAL } from "../../core/guards.ts";
import { runDetectors, type DetectorInput } from "../../core/incident-detectors.ts";
import { appendOwnerAnswer } from "../../core/incidents.ts";
import { mainDetectors } from "../../core/main-start.ts";
import { notifyProviders, ownerAnswerHandback, ownerAnswerSteer, postReply } from "../../core/notify.ts";
import { appendedSinceSpawn, markTopicsSpawned, ownerLogDir, recordOwnerLog } from "../../core/owner-log.ts";
import { topicsDue, topicsLogFile } from "../../core/owner-topics.ts";
import { readPressure } from "../../core/pressure.ts";
import * as q from "../../core/queue/lib.ts";
import { burdenRule, repoRules, rulesChanged } from "../../core/repo-rules.ts";
import { notePath, ownerText, spawnRefusal } from "../../core/rollover.ts";
import { loadKnownSecrets, redactSecrets, redactSummary } from "../../core/secret-redact.ts";
import { realTailscale } from "../../core/tailscale.ts";
import { remoteStoreFor } from "../../core/team-client.ts";
import { actionsRules, ownedRepoOf, suspiciousActions, unreportedFindings } from "../../core/trace-actions.ts";
import { checkWrite, deferSteer, type WriteCheckConfig } from "../../core/write-check.ts";
import { autoClose } from "./auto-close.ts";
import { registerChatCommands } from "./chat-commands.ts";
import { CLAIM_BEAT_MS, deliverOwnerInbox, OWNER_INBOX_POLL_MS, ownerInboxCursorPath, ownerInboxMessage, pendingInboxRecords, pressureTick, seedInboxFloor } from "./inbox.ts";
import { adapterLog, MAIN_ENV } from "./launch.ts";
// Registers the plugin-command matcher into core's writeTargets (side effect).
import "./package-ops.ts";
import { createRateLimitController, limitProbeSpawn, recordProviderOutFromRateLimit, recordProviderOutFromTask } from "./rate-limit-controller.ts";
import { createRolloverController } from "./rollover-controller.ts";
import { defaultCompletedResults, defaultRunSource, runIdOf } from "./sessions.ts";
import { parseTraceFile } from "./traces.ts";
import { asCtx, asRecord, asRolloverCtx, asString, call, isMain, lastAssistantIn, toExtensionResult, type EventReply, type ExtensionHost, type RolloverCtx } from "./types.ts";

export { adapterLog, autoClose, CLAIM_BEAT_MS, deliverOwnerInbox, limitProbeSpawn, OWNER_INBOX_POLL_MS, ownerInboxCursorPath, ownerInboxMessage, pendingInboxRecords, pressureTick, recordProviderOutFromRateLimit, toExtensionResult, type ExtensionHost };

/** Optional test/caller seams for `createOmpAdapter`. */
export interface OmpAdapterOptions {
	/** Overrides the `doctor` runner passed into `mainStartText` during in-process rollover fallback. */
	doctor?: () => Promise<string> | string;
}

/**
 * Re-reads the config, then holds the planner mode facts to the owner's baseline (P2 d): a
 * non-owner write of the state file or of a mode key is reverted and the reverted config is
 * re-read, so no handler ever acts on the dirt.
 */
export function freshPlannerConfig(freshConfig: () => Config): Config {
	const next = freshConfig();
	const held = verifyPlannerMode(plannerPin(next));
	if (!held.reverted) return next;
	adapterLog(next, `planner mode: reverted a non-owner change (${held.hint ?? "config dirt"})`);
	return freshConfig();
}

/** A clean shutdown stamps the state the verify pass just confirmed (P2 d). */
export function stampPlannerState(freshConfig: () => Config): void {
	const cfg = freshPlannerConfig(freshConfig);
	stampPlannerMode(plannerPin(cfg));
}

/** TraceEvents of the newest Main session file (D8's input); [] when there is none or it cannot be read. */
function defaultMainEvents(cfg: Config): TraceEvent[] {
	try {
		const s = defaultRunSource(cfg).mainSession();
		return s ? parseTraceFile(s.file, runIdOf(s.file)) : [];
	} catch {
		return [];
	}
}

// A push or merge by Main may have landed a completed plan: try closing right away.
const PUSH_MERGE = /\bgit\b[^\n;|&]*\bpush\b|\b(glab\s+mr|gh\s+pr)\s+merge\b/;

/**
 * Paths named inside the one configured method doc (brief.method_read): Main-owned and outside
 * every run's write scope, so its named paths are trusted one hop past the brief text (P10c).
 * Unset or unreadable doc allows nothing.
 */
const methodDocPaths = (cfg: Config): string[] => {
	if (!cfg.brief.method_read) return [];
	try {
		return briefPaths(readFileSync(q.expandHome(cfg.brief.method_read), "utf8"), cfg);
	} catch {
		return [];
	}
};

/**
 * D6 + D7 over a subagent's own trace, right after an allowed Progress edit (plan
 * 20261024_0301 P6): the sub's session file (its harness session manager hands it out) is
 * parsed as the run's trace, every high suspicious action folds as a D6 incident, and when the
 * new Progress bullet claims `Findings: none` the cross-product reads hidden behind that claim
 * fold as D7 (`unreported-finding`) with the agent-score penalty — the bullet is the claim
 * source the owner named, so it replaces the final-text check. The newest added bullet decides
 * (Progress runs newest-first). Best effort: a failure is logged, never thrown — a broken
 * detector must not break the verified edit.
 */
function subActionDetectors(cfg: Config, ctx: unknown, planFile: string, before: string, after: string, allowedText: string): void {
	try {
		const entries = newProgressEntries(before, after);
		if (entries.length === 0) return;
		const sessionFile = call(asRecord(asRecord(ctx).sessionManager), "getSessionFile");
		if (typeof sessionFile !== "string" || sessionFile === "") return;
		const events = parseTraceFile(sessionFile, runIdOf(sessionFile));
		const rules = actionsRules(cfg);
		const input: DetectorInput = { actions: suspiciousActions(events, rules) };
		if (/^none\.?$/i.test(findingsValue(entries[0]!) ?? "")) {
			// The plan's repo spelled like its owned_repos entry: a checkout named "pm-mr196" is "pm",
			// so the run's reads of its own repo never count as another product's.
			const repoDir = q.planRepo(planFile);
			// P10c: reads the brief or the method doc names are exempt — the detector stays pure,
			// the adapter extracts both lists.
			const allowedPaths = [...(allowedText ? briefPaths(allowedText, cfg) : []), ...methodDocPaths(cfg)];
			input.unreported = unreportedFindings(events, rules, {
				repo: ownedRepoOf(`${repoDir}/`, rules.owned_repos) ?? basename(repoDir),
				plan: planFile,
				claimedNone: true,
				allowed: allowedPaths,
			});
		}
		runDetectors(cfg, input);
	} catch (err) {
		adapterLog(cfg, `sub action detectors failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// Main's stop gate needs the ledger output (original: `agent-ledger --hours 12` through bash -lc,
// errors folded into empty output).
function ledgerText(cfg: Config): string {
	try {
		return execFileSync("bash", ["-lc", cfg.guards.ledger_command], { encoding: "utf8", timeout: 20000 });
	} catch (err) {
		if (err && typeof err === "object" && "stdout" in err && typeof err.stdout === "string") return err.stdout;
		return "";
	}
}

// Write-time checks (plan 20261028_1228): the text of each file a call names that a configured linter
// covers, read before the call runs; null when the file does not exist yet.
function writeCheckSnapshot(tool: string, input: Record<string, unknown>, cwd: string, wc: WriteCheckConfig, cfg: Config): Map<string, string | null> {
	const exts = wc.linters.flatMap((l) => l.ext);
	const snap = new Map<string, string | null>();
	for (const file of q.writeTargets(tool, input, cwd, cfg.paths)) {
		if (!exts.includes(extname(file))) continue;
		try {
			snap.set(file, readFileSync(file, "utf8"));
		} catch (err) {
			if (err instanceof Error && "code" in err && err.code === "ENOENT") snap.set(file, null);
		}
	}
	return snap;
}

// Plan files a subagent write/edit may touch: snapshot before the call so tool_result can verify
// and restore (the original snapshotted inside checkCall; core returns pure decisions now).
function snapshotPlans(tool: string, input: Record<string, unknown>, cwd: string, snap: Map<string, string>, main: boolean, plannerPlan: string | null, cfg: Config): void {
	if (tool !== "write" && tool !== "edit") return;
	const delegated = currentPlanner(cfg) === "delegated";
	const plans = q.activePlans(cfg.paths);
	for (const p of q.writeTargets(tool, input, cwd, cfg.paths)) {
		if (snap.has(p)) continue;
		if (main) {
			// Main's own plan text is checked too; a plan that did not exist yet snapshots as "".
			if (!MAIN_PLAN_FILE.test(p)) continue;
			try {
				snap.set(p, readFileSync(p, "utf8"));
			} catch {
				snap.set(p, "");
			}
			continue;
		}
		if (!q.isOrchestrationPath(p, plans, cfg.paths.queue_index) || !q.planAt(p, plans)) {
			// planner mode P2 (b): the brief's named plan snapshots before its create/edit so
			// checkPlanEdit judges it (Planner header, Main-only lines) — a new plan file is not
			// an indexed path yet, and every other plan write is refused pre-tool while delegated.
			if (!(delegated && p === plannerPlan)) continue;
		}
		try {
			snap.set(p, readFileSync(p, "utf8"));
		} catch {}
	}
}

// Secrets never reach the model, the chat or the session log (plan 20261025_2204): every tool
// result of every agent — Main and subs both fire tool_result — is redacted here before the rest of
// the handler, the model, the chat and the session file see it. The rewritten content goes back
// with one line naming what was hidden; a clean result keeps its original shape and returns nothing.
function redactToolResult(content: unknown[], cfg: Config): { content: unknown[]; note: string } {
	if (!cfg.secrets.redact || content.length === 0) return { content, note: "" };
	const known = loadKnownSecrets(cfg);
	const hits = new Map<string, number>();
	let changed = false;
	const out = content.map(part => {
		const p = asRecord(part);
		if (p.type !== "text" || typeof p.text !== "string" || p.text === "") return part;
		const r = redactSecrets(p.text, known, cfg.secrets.extra_patterns);
		if (r.hits.length === 0) return part;
		changed = true;
		for (const hit of r.hits) hits.set(hit.type, (hits.get(hit.type) ?? 0) + hit.count);
		return { ...p, text: r.text };
	});
	if (!changed) return { content, note: "" };
	return { content: out, note: redactSummary([...hits].map(([type, count]) => ({ type, count }))) };
}

// Owner topics (plan P8): one detached, niced `recall` child, as the limit probe is. The child env drops
// MAIN_ENV so the child is not Main. Its stdout and stderr append to owner-topics.log (stats and `topics: fail`
// lines only). A context that injects `spawnTopics` (tests) gets the call instead.
function spawnTopics(cfg: Config, ctx: unknown, args: string[]): void {
	const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== MAIN_ENV));
	const injected = asRecord(ctx).spawnTopics;
	if (typeof injected === "function") {
		(injected as (a: string[], e: NodeJS.ProcessEnv) => void).call(ctx, args, env);
		return;
	}
	let out: number | undefined;
	try {
		mkdirSync(ownerLogDir(cfg.paths), { recursive: true, mode: 0o700 });
		out = openSync(topicsLogFile(cfg.paths), "a", 0o600);
		const child = spawn("nice", ["-n", "19", "bun", join(import.meta.dir, "../../cli/main.ts"), ...args], { detached: true, stdio: ["ignore", out, out], env });
		child.on("error", err => adapterLog(cfg, `OWNER-TOPICS: could not start: ${err.message}`));
		child.unref();
	} catch (err) {
		adapterLog(cfg, `OWNER-TOPICS: could not start: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		if (out !== undefined) closeSync(out);
	}
}

/** The most recently registered createOmpAdapter cleanup, for the exported reset(). */
let activeAdapterReset: (() => void) | null = null;

/** This process's held Main session lock (plan 20261103_1146 P2): the first main session_start
 * locks `<queue_state>/mains/<id>/session.lock` for the process lifetime — the kernel frees it
 * when the process dies. A factory re-run must not release it (P4): dropping it lets another
 * process take the id, and a new flock of the same file in this process is busy. reset() is the
 * only release, so tests do not leak the flock into the next file. */
let heldSessionLock: HeldLock | null = null;

/** Register the guard handlers on one extension host. `initial` is injectable for tests; `freshConfig` re-reads the config per guarded call. */
export function createOmpAdapter(pi: ExtensionHost, initial: Config, freshConfig: () => Config = () => initial, opts: OmpAdapterOptions = {}): void {
	// Guarded handlers take `cfg = freshConfig()` first, so an edited config.yml reaches the next call (P4e).
	let cfg = initial;
	// P2 d: the first seam — a mode fact another writer left behind is reverted before any handler runs.
	cfg = freshPlannerConfig(freshConfig);
	const getCfg = (): Config => cfg;
	seedInboxFloor(cfg);
	// Main's rules ride its system prompt each turn; they are never written into the owner's AGENTS.md.
	const mainRules = renderBlock(cfg);

	const rateLimit = createRateLimitController(pi, getCfg);
	const rollover = createRolloverController(pi, getCfg, { doctor: opts.doctor });

	// Clear the previous adapter's armed grace timer before this one overwrites the pointer (P3c).
	// Do not release heldSessionLock: this runs on every factory re-entry, and the lock is
	// process-lifetime (plan 20261103_1146 P4). reset() still releases it.
	activeAdapterReset?.();
	activeAdapterReset = (): void => {
		rollover.clearState();
		rateLimit.stopTick();
	};

	let callsSinceStop = 0;
	let idleStops = 0;
	let timer: unknown;
	const calls = new Map<string, number>(); // subagent call budget, by agent id
	const pending = new Map<string, Map<string, string>>(); // toolCallId -> plan snapshots
	const pendingWrite = new Map<string, Map<string, string | null>>(); // toolCallId -> write-check snapshots; null: the file did not exist
	const deferredWrite = new Map<string, Map<string, string | null>>(); // agent id -> files that added deferred findings this turn -> text before the first one (null: new file); judged at that session's own agent_end
	const pendingRules = new Set<string>(); // repos Main worked in, rules to hand over at the next prompt
	const pendingReviewNotes: string[] = []; // P4k: review spawns that ended with no verdict; Main hears at its next prompt
	const subBriefs = new Map<string, string>(); // task spawn name -> its brief text (P10c)
	// Chat notify (plans 20261024_2155, 20261025_0130): the text a hand-back already posted
	// (attempted) — one post per distinct text, never a retry loop. The reply itself comes from
	// the stop/agent_end event, never the session file (session_stop fires BEFORE agent_end, and
	// omp skips it entirely while an async job is pending, so a file read lags a whole turn).
	let postedReply: string | null = null;
	// Set by every session_stop path that returns block; the willContinue agent_end that omp then
	// emits (sessionStopWillContinue) consumes it and posts nothing — a blocked stop's reply is a
	// mid-work report, never a hand-back.
	let stopBlocked = false;

	// P5b: a real turn end answers every owner message it followed — the answer (the turn's own
	// reply, the page's lastAnswerFor shape) rides the same owner-message store. Rate-limited,
	// blocked and mid-run ends are not turn ends: nothing is recorded.
	const recordTurnAnswer = (reply: EventReply | null): void => {
		if (!reply?.text) return;
		try {
			recordOwnerLog(cfg, "main", reply.text);
		} catch (err) {
			adapterLog(cfg, `RECALL-LOG record failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		try {
			appendOwnerAnswer(reply.text, cfg.paths);
		} catch (err) {
			adapterLog(cfg, `OWNER-ANSWER record failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	// One guard-log line per notify decision: `notify: posted|skipped (<why>)`. Fire-and-forget:
	// the decision never awaits the post; a failed or slow post logs one line and never blocks
	// or retries.
	const notifyHandback = (reply: EventReply | null, why: string): void => {
		if (!reply || !reply.text) {
			adapterLog(cfg, `notify: skipped (no reply text, ${why})`);
			return;
		}
		if (reply.text === postedReply) {
			adapterLog(cfg, `notify: skipped (duplicate, ${why})`);
			return;
		}
		postedReply = reply.text;
		adapterLog(cfg, `notify: posted (${why})`);
		void postReply(reply.text, cfg).then(results => {
			for (const r of results) if (!r.posted) adapterLog(cfg, `notify: ${r.provider}: ${r.error}`);
		});
	};

	// "Needs you" pings (P3b): the owner learns on Discord that a decision or an unlock is his —
	// deterministic, no model call, Main session only, the same webhook path, fire-and-forget, one
	// guard-log line per decision (`notify: needs-you posted|skipped (<why>)`).
	const needsYouPost = (text: string, why: string): void => {
		if (notifyProviders(cfg).length === 0) {
			adapterLog(cfg, `notify: needs-you skipped (notify off, ${why})`);
			return;
		}
		adapterLog(cfg, `notify: needs-you posted (${why})`);
		void postReply(text, cfg).then(results => {
			for (const r of results) if (!r.posted) adapterLog(cfg, `notify: ${r.provider}: ${r.error}`);
		});
	};
	// The phone-page link only when the page is on and this machine's MagicDNS name is known;
	// computed at most once per process (tailscale status is a subprocess call).
	let phonePageSuffix: string | null = null;
	const phonePage = (): string => {
		if (!cfg.workspace.enabled) return "";
		if (phonePageSuffix === null) {
			const dns = realTailscale.dnsName();
			phonePageSuffix = dns ? ` Answer on the phone page: http://${dns}:${cfg.workspace.port}` : "";
		}
		return phonePageSuffix;
	};
	// WAITING: every Main turn end asks whether an open plan now waits on the owner (the same
	// source the owner page lists). Keys are `plan file|waiting line`, remembered in
	// <queue_state>/notify-waiting.json; a key whose line is gone is dropped, so the same question
	// asked again later posts again. No waiting plans: no decision, no log line.
	const notifyWaitingPlans = (): void => {
		const waitingKeysFile = join(cfg.paths.queue_state, "notify-waiting.json");
		const waiting = q.activePlans(cfg.paths).filter(p => p.waiting && p.status === "open" && p.waitingLine);
		let stored: string[] = [];
		try {
			const parsed: unknown = JSON.parse(readFileSync(waitingKeysFile, "utf8"));
			if (Array.isArray(parsed)) stored = parsed.filter((k): k is string => typeof k === "string");
		} catch {}
		// Persist after reading: a key whose WAITING line is gone is dropped, so the same question
		// asked again later posts again. No waiting plans: the set prunes to empty, no decision,
		// no line.
		const current: string[] = [];
		const fresh: typeof waiting = [];
		for (const p of waiting) {
			const key = `${p.file}|${p.waitingLine}`;
			current.push(key);
			if (!stored.includes(key)) fresh.push(p);
		}
		try {
			mkdirSync(cfg.paths.queue_state, { recursive: true });
			writeFileSync(waitingKeysFile, JSON.stringify(current));
		} catch {}
		if (current.length === 0) return;
		if (fresh.length === 0) {
			adapterLog(cfg, "notify: needs-you skipped (no new waiting lines)");
			return;
		}
		const lines = fresh.map(p => {
			const title = p.text.match(/^# (.+)$/m)?.[1] ?? basename(p.file);
			return `- ${title}: ${p.waitingLine}`;
		});
		needsYouPost(`🔔 Needs you (${fresh.length}):\n${lines.join("\n")}${phonePage()}`, `waiting: ${fresh.length} plans`);
	};
	// UNLOCK: a protected-file refusal of a Main tool call means Main sits blocked until the owner
	// unlocks — ping, at most once per 30 min.
	let unlockPingMs = -Infinity;
	const notifyUnlockNeeded = (reason: string): void => {
		if (Date.now() - unlockPingMs < 30 * 60_000) {
			adapterLog(cfg, "notify: needs-you skipped (unlock ping sent recently)");
			return;
		}
		unlockPingMs = Date.now();
		const target = basename(asString(reason.match(/plan-guard: (.+) is a protected guard file/)?.[1] ?? "guard file"));
		needsYouPost(
			`🔓 Main needs an unlock to continue (${target}). Tap "unlock ${cfg.guards.unlock_minutes}" on the phone page.`,
			"protected-file refusal",
		);
	};

	pi.on("session_start", (_e, ctx) => {
		const c = asCtx(ctx);
		// Original: proceed only when no agent is set or it is the main session.
		if (c.hasAgent && c.kind !== "main") return;
		// One live Main session per id (plan 20261103_1146 P2): the first session_start in this
		// process locks mains/<id>/session.lock for the process lifetime. A second session_start
		// in the SAME process is the rollover fallback re-entering (newSession) — its own lock
		// reads as fine. Busy means a DIFFERENT process holds it: another live Main with this id.
		if (heldSessionLock === null) {
			const held = tryLock(join(mainStateDir(cfg), "session.lock"));
			if (!held) {
				const id = mainId();
				adapterLog(cfg, `second Main ${id} refused: a Main session with this id is live`);
				console.error(`Main ${id} is already running`);
				// omp defers shutdown (:1328-1332), so a clean exit would end 0 and the refusal
				// would look like success: end directly, before anything arms.
				process.exit(1);
			}
			heldSessionLock = held;
		}
		autoClose(cfg);
		if (timer) return;
		const every = cfg.queue.auto_close_min * 60_000;
		const t: unknown = c.setInterval
			? c.setInterval(() => autoClose(cfg), every)
			: setInterval(() => autoClose(cfg), every);
		if (t && typeof t === "object" && "unref" in t && typeof t.unref === "function") t.unref();
		timer = t;
		// The owner-inbox poll (P3b): Main's session only — this handler returned for every other.
		const it: unknown = c.setInterval
			? c.setInterval(() => deliverOwnerInbox(pi, cfg), OWNER_INBOX_POLL_MS)
			: setInterval(() => deliverOwnerInbox(pi, cfg), OWNER_INBOX_POLL_MS);
		if (it && typeof it === "object" && "unref" in it && typeof it.unref === "function") it.unref();
		// Pressure alerts (P2): sample the machine every sample_sec; tell Main only on a RED or GREEN fire.
		const sample = (): void => pressureTick(pi, cfg, readPressure(), nowSec());
		const sampleMs = cfg.machine.pressure.sample_sec * 1000;
		const pt: unknown = c.setInterval ? c.setInterval(sample, sampleMs) : setInterval(sample, sampleMs);
		if (pt && typeof pt === "object" && "unref" in pt && typeof pt.unref === "function") pt.unref();
		// Multi-main P3: every held claim heartbeats once a minute while this Main session lives,
		// so a live Main never loses a plan to queue.claim_ttl_min. session_shutdown releases
		// nothing: the TTL frees a crashed or restarted Main's claims the same way.
		const beat = (): void => {
			const id = mainId();
			// P3 (plan 20261027_1305): the file store lists only personal claims (the chooser
			// never sends a team plan to it); each team's remote store lists that team's claims
			// with ids mapped to local paths. Every claim is beaten through the store that
			// listed it; a team whose list() is Unreachable is skipped for this tick (its
			// claims lapse at the TTL) and the file beats still run.
			const stores: ClaimStore[] = [
				fileClaimStore(cfg.paths.queue_state, nowSec, cfg.queue.claim_ttl_min),
				...(cfg.teams ?? []).map(team => remoteStoreFor(team, cfg)),
			];
			for (const store of stores) {
				const rows = store.list();
				if (!Array.isArray(rows)) continue;
				// `mine !== false`: never beat another login's row that happens to share the
				// main string; the server would answer 403 (P2b (7c)).
				for (const claim of rows) if (claim.main === id && claim.mine !== false) store.heartbeat(claim.plan, id);
			}
		};
		const hb: unknown = c.setInterval ? c.setInterval(beat, CLAIM_BEAT_MS) : setInterval(beat, CLAIM_BEAT_MS);
		if (hb && typeof hb === "object" && "unref" in hb && typeof hb.unref === "function") hb.unref();
	});

	// What a subagent is still missing (plan 20261027_1530 P2): the rules of the repo its plan is
	// worked in, then the owner's burden rule — each once per session, and again only after the
	// file changes (rulesChanged holds the hash). Empty when there is nothing new to say.
	const unhanded = (session: string, plan: string | null): string => {
		const parts: string[] = [];
		const rules = plan ? repoRules(cfg, plan) : null;
		if (rules && rulesChanged(cfg, session, rules.path, rules.text)) parts.push(`Repo rules (${rules.path}):\n${rules.text}`);
		const rule = burdenRule();
		if (rule && rulesChanged(cfg, session, AGENTS_TEMPLATE, rule)) parts.push(rule);
		return parts.join("\n\n");
	};

	// The repos one Main call works in (plan 20261027_1530 P3): its cwd, the file it reads, what it
	// writes (a shell `cd` included), and — for a task spawn — the repo of the plan each brief
	// names. Rules ride on the next prompt, never on every one, so nothing is said before a repo
	// is actually worked in.
	const touchedRepos = (tool: string, input: Record<string, unknown>, cwd: string): string[] => {
		const out = new Set<string>();
		const add = (p: string): void => {
			const repo = p ? q.repoRoot(p) : null;
			if (repo) out.add(repo);
		};
		add(cwd);
		if (cfg.guards.read_tools.includes(tool) && typeof input.path === "string") add(resolve(cwd, q.expandHome(input.path)));
		for (const p of q.writeTargets(tool, input, cwd, cfg.paths)) add(p);
		if (tool === "task") {
			const plans = q.readIndex(cfg.paths.queue_index);
			for (const t of Array.isArray(input.tasks) ? input.tasks : []) {
				const plan = plans.find(file => String(asRecord(t).task ?? "").includes(file));
				if (plan) add(plan);
			}
		}
		return [...out];
	};

	pi.on("before_agent_start", (event, ctx) => {
		cfg = freshPlannerConfig(freshConfig);
		const c = asCtx(ctx);
		const prompt = asString(asRecord(event).prompt);
		if (c.kind !== "main") {
			if (c.kind !== "sub") return undefined;
			// A subagent's first turn is the only one carrying its brief, and the plan the brief
			// names is the repo whose rules it needs — the same index match the plan gate makes.
			const plans = q.readIndex(cfg.paths.queue_index);
			const content = unhanded(asString(c.id) || "sub", plans.find(file => prompt.includes(file)) ?? null);
			return content ? { message: { customType: "main-guard.rules", content, display: false } } : undefined;
		}
		rateLimit.onOwnerPrompt();
		const d = checkInject({ inject: prompt, agent: "main" }, cfg);
		callsSinceStop = d.state?.callsSinceStop ?? callsSinceStop;
		idleStops = d.state?.idleStops ?? idleStops;
		const notice = rollover.notice(ctx);
		// A turn the harness starts from the guard's own stop continuation is not an owner
		// message: D4 (owner-correction) only sees real prompts; D1/D3 run either way.
		// Machine prompts (guard continuation, rollover note request, handoff note) are not owner messages.
		mainDetectors(cfg, { runSource: defaultRunSource, completedResults: defaultCompletedResults, mainEvents: defaultMainEvents }, { prompt: ownerText(prompt) });
		// The rules of a repo this session has just worked in (P3): one hand-over per repo per file
		// version — rulesChanged holds the hash, and the set holds only what was touched.
		const rules: string[] = [];
		for (const repo of pendingRules) {
			const r = repoRules(cfg, repo);
			if (r && rulesChanged(cfg, asString(c.id) || "main", r.path, r.text)) rules.push(`Repo rules (${r.path}):\n${r.text}`);
		}
		pendingRules.clear();
		const reviewNotes = isMain(ctx) ? pendingReviewNotes.splice(0) : [];
		const hostPrompt = asRecord(event).systemPrompt;
		return {
			systemPrompt: [...(Array.isArray(hostPrompt) ? hostPrompt : []), mainRules],
			message: {
				customType: "main-guard.queue",
				content: [d.inject, notice, ...reviewNotes, ...rules].filter(Boolean).join("\n\n"),
				display: false,
			},
		};
	});

	// The spawn event carries no brief, so the plan gate runs at the task tool call (original
	// behaviour); here only the allow-list and the task-only rule apply, with the original texts.
	pi.on("before_subagent_spawn", (event, _ctx) => {
		cfg = freshPlannerConfig(freshConfig);
		const agent = asString(asRecord(event).agent);
		const kind = asString(asRecord(event).invocationKind);
		if (!q.allowedAgents(cfg.paths.subagents).has(agent))
			return { block: true, reason: `main-guard: agent "${agent}" is not in "## Allowed" of ${cfg.paths.subagents}.` };
		if (kind !== "task")
			return { block: true, reason: "main-guard: spawn implementers with the task tool (the plan gate checks its brief)." };
		return undefined;
	});

	let lastMainRc: RolloverCtx | null = null;

	pi.on("tool_call", (event, ctx) => {
		cfg = freshPlannerConfig(freshConfig);
		const c = asCtx(ctx);
		const e = asRecord(event);
		const tool = asString(e.toolName);
		const input = asRecord(e.input);
		const isSub = c.kind === "sub";
		const agent: "main" | "sub" = isSub ? "sub" : "main";
		const id = c.id ?? "main";
		let n = 0;
		if (isSub && !cfg.guards.skip_tools.includes(tool)) n = (calls.get(id) ?? 0) + 1;
		if (isSub) calls.set(id, n);
		if (!isSub) callsSinceStop++;
		const cwd = c.cwd ?? process.cwd();
		// planner mode P2 (plan 20261102_1515): the plan a sub's approved spawn bound to it (the
		// brief's `Planner role for <plan path>` line) — the gates check it against plan-path writes.
		const plannerPlan = isSub ? plannerSpawnPlan(id, cfg.paths) : null;
		const snap = new Map<string, string>();
		snapshotPlans(tool, input, cwd, snap, !isSub, plannerPlan, cfg);
		// Drain (src/core/rollover.ts): while a rollover is pending no new subagent starts; the
		// running ones finish first. Subagents' own tool calls are unaffected. Main's task calls
		// also carry the running job labels for the priority gate (20261025_0215 P2).
		let runningJobs: string[] | undefined;
		if (!isSub) lastMainRc = asRolloverCtx(ctx);
		if (tool === "task") {
			// A subagent's task call drains and labels by Main's rollover context: its own ctx has none.
			const rc = lastMainRc;
			runningJobs = rc?.runningJobs();
			if (cfg.rollover.enabled && rc) {
				const why = spawnRefusal(rollover.snapshot(rc).state, runningJobs ?? []);
				if (why) {
					const tasks = Array.isArray(input.tasks) ? input.tasks : [];
					adapterLog(cfg, `BLOCK spawn ${String(asRecord(tasks[0]).agent ?? "task")}: rollover pending`);
					return { block: true, reason: why };
				}
			}
		}
		// P10c: remember each spawn's brief text by its spawn name — tasks[].name, which is the
		// sub's ctx.agent.id (tasks[].agent is the agent type, never the key) — so D7 can skip
		// reads the owner deliberately named in the brief (paths extracted via briefPaths).
		if (!isSub && tool === "task") {
			for (const t of Array.isArray(input.tasks) ? input.tasks : []) {
				const name = asString(asRecord(t).name);
				const brief = asString(asRecord(t).task);
				if (name && brief) subBriefs.set(name, brief);
			}
		}
		const d = checkTool(
			{ tool, input, cwd, agent, agentId: id, calls: n - 1, paths: [], writes: [], command: asString(input.command), runningJobs },
			cfg,
			defaultRunSource(cfg),
		);
		if (!d.allow) {
			// P3b: Main refused on a protected guard file sits blocked until the owner unlocks.
			if (!isSub && d.reason.includes("is a protected guard file. Only the owner changes it")) notifyUnlockNeeded(d.reason);
			return { block: true, reason: d.reason };
		}
		if (snap.size) pending.set(asString(e.toolCallId), snap);
		const wc = cfg.write_check;
		if (wc.enabled && (wc.applies_to === "all" || isSub)) {
			const ws = writeCheckSnapshot(tool, input, cwd, wc, cfg);
			if (ws.size) pendingWrite.set(asString(e.toolCallId), ws);
		}
		// An allowed Main call inside a repo queues that repo's rules for the next prompt (P3).
		if (!isSub) for (const repo of touchedRepos(tool, input, cwd)) pendingRules.add(repo);
		// The originals return nothing on a clean call; only warn injects carry an object.
		const out = toExtensionResult(d);
		return Object.keys(out).length > 0 ? out : undefined;
	});

	// Main ticked a phase: keep the newest Progress entries in the plan and move older ones to its archive.
	const trimProgress = (file: string): string | undefined => {
		const t = q.trimPlanProgress(file, cfg.queue.progress_keep);
		if (!t) return undefined;
		rekeySpawnFile(file, t.before, t.after, cfg.paths);
		return `plan-guard: moved ${t.count} older Progress entries to ${t.archive}; re-read the plan before editing it again.`;
	};

	pi.on("tool_result", (event, ctx) => {
		cfg = freshPlannerConfig(freshConfig);
		// P9: an owner message past notify.answer_within_min with no hand-back steers once per
		// message; sendUserMessage reaches Main mid-turn through the steer queue.
		if (isMain(ctx)) {
			const steer = ownerAnswerSteer(cfg, nowSec());
			if (steer) pi.sendUserMessage(steer);
		}
		rollover.onSizeCheck("tool_result", event, ctx);
		const e = asRecord(event);
		const c = asCtx(ctx);
		const id = asString(e.toolCallId);
		const snap = pending.get(id);
		const wsnap = pendingWrite.get(id);
		pendingWrite.delete(id);
		// Redact first: everything below (plan checks, detectors, the returned content, the model,
		// the chat and the session log) then works on text that holds markers, never values.
		const redacted = redactToolResult(Array.isArray(e.content) ? e.content : [], cfg);
		const content = redacted.content;
		const notes: string[] = redacted.note ? [redacted.note] : [];
		// Provider out-until from a task result that quotes a reset time (plan 20261025_1700 P1):
		// recorded from the redacted text before anything else, never thrown.
		try {
			recordProviderOutFromTask(e, content, cfg);
		} catch (err) {
			adapterLog(cfg, `PROVIDER-OUT record failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (snap) {
			pending.delete(id);
			for (const [file, before] of snap) {
				let after = before;
				try {
					after = readFileSync(file, "utf8");
				} catch {}
				// agentId must be the agent identity (ctx.agent.id = spawn name for subs), not the
				// tool-call id: matchReviewSpawn compares it with the registered review spawn name,
				// and a toolCallId there made every named reviewer's verdict restore (2026-10-29).
				const d = checkPlanEdit({ path: file, before, after, agent: c.kind === "sub" ? "sub" : "main", agentId: c.id ?? "main" }, cfg);
				if (!d.allow && d.restore) {
					try {
						if (d.restore.text === null) rmSync(d.restore.path, { force: true });
						else writeFileSync(d.restore.path, d.restore.text);
					} catch {}
					revertMainEdit(asString(e.toolName), asRecord(e.input), c.cwd ?? process.cwd(), cfg);
					return { isError: true, content: [{ type: "text", text: d.reason }] };
				}
				// Plan-guard auto-listing (I-20261025-208): the allowed edit's file is amended to name
				// the cited files Main did read; the note tells Main what moved into the list.
				if (d.allow && d.rewrite) {
					try {
						writeFileSync(d.rewrite.path, d.rewrite.text);
					} catch {}
					if (d.note) notes.push(d.note);
				}
				if (d.allow && (!c.hasAgent || c.kind === "main") && q.doneCount(after) > q.doneCount(before) && q.planAt(file, q.activePlans(cfg.paths))) {
					const note = trimProgress(file);
					if (note) notes.push(note);
				}
				// Live D6+D7 over the sub's own session as soon as it reports into the plan (P6).
				if (d.allow && c.kind === "sub") subActionDetectors(cfg, ctx, file, before, after, subBriefs.get(c.id ?? "main") ?? "");
			}
		}
		// Write-time checks (plan 20261028_1228): a lint finding the call added is undone here, file by file.
		if (wsnap && !e.isError) {
			const refusals: string[] = [];
			for (const [file, before] of wsnap) {
				let after: string | null = null;
				try {
					after = readFileSync(file, "utf8");
				} catch {}
				const r = checkWrite(file, before, after, cfg.write_check);
				if (r.allow) {
					if (r.note) adapterLog(cfg, r.note);
					// Per session (Main's review): the turn-end follow-up judges this session's files from
					// the state before the first deferred addition, and the note rides the result so the
					// agent that made the edit learns of the deferral in-band.
					if (r.deferred) {
						const key = c.id ?? "main";
						let files = deferredWrite.get(key);
						if (!files) deferredWrite.set(key, files = new Map());
						if (!files.has(file)) files.set(file, before);
						if (r.note) notes.push(r.note);
					}
					// Parallel calls on one file: their "before" becomes this allowed result, so a later refusal restores to it.
					for (const other of pendingWrite.values()) if (other.has(file)) other.set(file, after);
					continue;
				}
				try {
					if (before === null) rmSync(file, { force: true });
					else writeFileSync(file, before);
				} catch {}
				adapterLog(cfg, `WRITE-CHECK refused ${file}`);
				refusals.push(r.reason);
			}
			if (refusals.length > 0) return { isError: true, content: [{ type: "text", text: refusals.join("\n\n") }] };
		}
		if ((!c.hasAgent || c.kind === "main") && asString(e.toolName) === "bash" && !e.isError) {
			if (PUSH_MERGE.test(asString(asRecord(e.input).command))) autoClose(cfg);
		}
		if ((!c.hasAgent || c.kind === "main") && !e.isError) {
			const text = content.map(p => asString(asRecord(p).text)).join("\n");
			recordMainResult(asString(e.toolName), asRecord(e.input), c.cwd ?? process.cwd(), text, cfg.paths);
			// After the reads are recorded: a fresh hit clears its own warning, a stale list warns
			// before Main drafts an edit the plan-read guard would refuse (I-20261025-208 P3).
			const readNote = planReadNote(asString(e.toolName), asRecord(e.input), c.cwd ?? process.cwd(), text, cfg);
			if (readNote) notes.push(readNote);
		}
		if ((!c.hasAgent || c.kind === "main") && e.isError) {
			revertMainEdit(asString(e.toolName), asRecord(e.input), c.cwd ?? process.cwd(), cfg);
		}
		// Real-time detectors after each Main bash result, crashes included (D2 wants the stack).
		if ((!c.hasAgent || c.kind === "main") && asString(e.toolName) === "bash") {
			mainDetectors(cfg, { runSource: defaultRunSource, completedResults: defaultCompletedResults, mainEvents: defaultMainEvents }, {
				bash: { command: asString(asRecord(e.input).command), output: content.map(p => asString(asRecord(p).text)).join("\n") },
			});
		}
		if (notes.length) return { content: [...content, ...notes.map(text => ({ type: "text", text }))] };
		return undefined;
	});

	pi.on("session_stop", (e, ctx) => {
		cfg = freshPlannerConfig(freshConfig);
		const c = asCtx(ctx);
		if (c.hasAgent && c.kind !== "main") return;
		// A relaunch is requested: omp shuts down at the next idle, so the stop must not be continued.
		if (rollover.isRelaunched()) {
			adapterLog(cfg, "notify: skipped (relaunch requested)");
			return undefined;
		}
		// The stop hands the turn back to the owner: post the stop event's own final reply, once
		// per distinct text. The reply comes from the event (last_assistant_message, falling back
		// to the last assistant entry of messages), never the session file: omp fires session_stop
		// BEFORE agent_end, so a file read would lag a whole turn.
		const stopMsg = asRecord(e).last_assistant_message;
		const reply = stopMsg ? lastAssistantIn([stopMsg]) : lastAssistantIn(asRecord(e).messages);
		// A turn that ended on a provider rate limit waits it out (plan 20261025_0640): ALLOW before
		// the rollover and queue decisions — any block here would re-ask straight into the limit —
		// and without touching the idle-stop counters: checkStop is not consulted.
		const rl = rateLimit.rateLimitOf(reply);
		if (rl) {
			// Who is rate-limited is live data (plan 20261025_1700 P1): the error text's own reset
			// time, else the fallback wait. Best effort — a failed write never changes the stop.
			let named: number | null = null;
			try {
				named = recordProviderOutFromRateLimit(reply, rl.untilMs, cfg);
			} catch (err) {
				adapterLog(cfg, `PROVIDER-OUT record failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			rateLimit.onRateLimitedStop(c, named, reply?.errorMessage ?? "", reply?.model ?? "");
			return undefined;
		}
		// Any turn that ends without a rate limit ends the episode and disarms its resume timer.
		rateLimit.disarmEpisode();
		// A pending rollover decides the stop and checkStop is not consulted: its queue, incident and cancel
		// blocks would hold Main at a wait the new session raises again through main-start, and its "spawn an
		// agent" text is refused while the rollover is pending.
		const rc = cfg.rollover.enabled ? asRolloverCtx(ctx) : null;
		if (rc) {
			const snap = rollover.snapshot(rc);
			if (snap.state === "need-note") {
				adapterLog(cfg, "BLOCK stop: rollover need-note");
				notifyHandback(reply, "blocked session_stop");
				stopBlocked = true;
				return { decision: "block", reason: rollover.noteRequestFor(rc, snap) };
			}
			if (snap.state === "ready" || snap.state === "wait-jobs") {
				adapterLog(cfg, `ALLOW stop: rollover ${snap.state}`);
				recordTurnAnswer(reply);
				// Under the launcher a ready rollover starts now (not a hand-back to the owner).
				const handsToOwner = !(snap.state === "ready" && rollover.requestRelaunch(rc, notePath(rc.sessionId, mainStateDir(cfg))));
				if (handsToOwner) notifyHandback(reply, "allowed session_stop");
				else adapterLog(cfg, "notify: skipped (relaunch requested)");
				return undefined;
			}
		}
		const d = checkStop({ agent: "main", callsSinceStop, idleStops, ledgerText: ledgerText(cfg), reply: reply?.text ?? undefined }, cfg);
		callsSinceStop = d.state?.callsSinceStop ?? 0;
		idleStops = d.state?.idleStops ?? idleStops;
		if (d.allow) {
			recordTurnAnswer(reply);
			notifyHandback(reply, "allowed session_stop");
			return undefined;
		}
		notifyHandback(reply, "blocked session_stop");
		stopBlocked = true;
		return { decision: "block", reason: d.reason };
	});

	// ---- ordered agent_end pipeline (consolidates all 7 turn-end stages in exact sequence) ----

	// Stage 2: Hand-back without a session_stop (plan 20261025_0130): while an async job is pending
	// omp fires agent_end with willContinue:true and SKIPS session_stop — this deferred hand-back
	// posts from the event's own messages. omp also sets willContinue after a BLOCKED stop
	// (sessionStopWillContinue) and for todo/plan-mode/rewind continuations, so a post here needs
	// both: no blocked stop just decided (the flag), and an async job really pending. A terminal
	// end (willContinue unset) is not a hand-back: the session_stop that follows it decides. A
	// mid-run continuation — tool calls, or a non-"stop" reason such as an auto-retry — posts
	// nothing.
	const onDeferredHandback = (e: unknown, ctx: unknown): void => {
		if (!isMain(ctx)) return;
		if (asRecord(e).willContinue !== true) return;
		if (stopBlocked) {
			stopBlocked = false;
			adapterLog(cfg, "notify: skipped (stop blocked, agent_end)");
			return;
		}
		const reply = lastAssistantIn(asRecord(e).messages);
		// The same rate-limit check as session_stop (plan 20261025_0640): a rate-limited deferred
		// hand-back opens the episode instead of logging "no reply text" — its reply carries an
		// error, no text. A mid-run continuation (tool calls, auto-retry) is not a turn end: the
		// episode state stays as it is.
		const rl = rateLimit.rateLimitOf(reply);
		if (rl) {
			// The same one parse as session_stop (plan 20261027_1500 P1/P3): the error text's own
			// reset time, else the fallback wait. Best effort — a failed write never changes the stop.
			let named: number | null = null;
			try {
				named = recordProviderOutFromRateLimit(reply, rl.untilMs, cfg);
			} catch (err) {
				adapterLog(cfg, `PROVIDER-OUT record failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			rateLimit.onRateLimitedStop(asCtx(ctx), named, reply?.errorMessage ?? "", reply?.model ?? "");
			return;
		}
		const jobCount = asRolloverCtx(ctx)?.runningJobs().length ?? 0;
		if (jobCount === 0) {
			adapterLog(cfg, "notify: skipped (no pending job, agent_end)");
			return;
		}
		if (!reply || !reply.text) {
			// A turn that ended on some other no-text outcome is a turn end without a rate limit.
			rateLimit.disarmEpisode();
			adapterLog(cfg, "notify: skipped (no reply text, agent_end hand-back)");
			return;
		}
		if (reply.stopReason !== "stop" || reply.toolCalls > 0) {
			adapterLog(
				cfg,
				`notify: skipped (mid-run: stop reason ${reply.stopReason ?? "unknown"}${reply.toolCalls > 0 ? ` + ${reply.toolCalls} tool call(s)` : ""}, agent_end hand-back)`,
			);
			return;
		}
		// A real hand-back: the turn ended without a rate limit — the episode is over.
		rateLimit.disarmEpisode();
		recordTurnAnswer(reply);
		// A deferred hand-back fires no session_stop: reset the per-turn cap here (I-20261030-24),
		// record the hand-back for the owner-answer wait (P9), and steer a promise like checkStop
		// refuses it (I-20261030-32).
		resetMainCalls(cfg.paths);
		ownerAnswerHandback(nowSec(), cfg.paths);
		if (new RegExp(cfg.guards.plan_offer, "i").test(reply.text)) {
			pi.sendUserMessage(STOP_PLAN_OFFER_REFUSAL);
		}
		notifyHandback(reply, "agent_end hand-back");
	};

	// Stage 4: Write-check deferral (I-20261028-166): at a session's own turn end its still-present
	// deferred findings go out — Main by steer (the only session sendUserMessage is proven to
	// reach), a subagent through the adapter log; cleared per session, so it is never repeated.
	const onDeferredWriteCheck = (ctx: unknown): void => {
		const c = asCtx(ctx);
		const wc = cfg.write_check;
		const key = c.id ?? "main";
		const files = deferredWrite.get(key);
		if (!wc.enabled || (wc.applies_to !== "all" && c.kind !== "sub") || !files || files.size === 0) return;
		const steers: string[] = [];
		for (const [file, before] of files) {
			let after: string | null = null;
			try {
				after = readFileSync(file, "utf8");
			} catch {}
			const s = deferSteer(file, before, after, wc);
			if (s) steers.push(s);
		}
		deferredWrite.delete(key);
		if (steers.length === 0) return;
		if (!c.hasAgent || c.kind === "main") pi.sendUserMessage(steers.join("\n"));
		else adapterLog(cfg, `WRITE-CHECK deferred still present: ${steers.join(" | ")}`);
	};

	pi.on("agent_end", (e, ctx) => {
		// 1. Session rollover size/version check & relaunch re-arm
		rollover.onSizeCheck("agent_end", e, ctx);
		// 2. Deferred hand-back notify / rate-limit handling (when willContinue === true)
		onDeferredHandback(e, ctx);
		// 3. Deliver owner inbox & ping Discord on newly waiting plans (Main only)
		if (isMain(ctx)) {
			deliverOwnerInbox(pi, cfg);
			notifyWaitingPlans();
		}
		// 4. Report still-present deferred write-check findings for this session
		onDeferredWriteCheck(ctx);
		// 5. Terminal hand-back: reset Main's per-turn call budget & record answer hand-back
		if (isMain(ctx) && asRecord(e).willContinue !== true) {
			resetMainCalls(cfg.paths);
			ownerAnswerHandback(nowSec(), cfg.paths);
		}
		// 6. P4k backstop: check if a named review subagent ended without recording a verdict
		const c = asCtx(ctx);
		if (c.kind === "sub" && c.id) {
			const note = reviewSpawnEnd(c.id, cfg);
			if (note) pendingReviewNotes.push(note);
		}
		// 7. Recall topics: spawn background segmentation when due (Main only)
		if (isMain(ctx) && cfg.recall.topics_model !== "" && topicsDue(appendedSinceSpawn(), cfg.recall.topics_every)) {
			markTopicsSpawned();
			spawnTopics(cfg, ctx, ["recall", "topics"]);
		}
	});

	pi.on("session_shutdown", (_e, ctx) => {
		if (isMain(ctx) && cfg.recall.topics_model !== "") {
			spawnTopics(cfg, ctx, ["recall", "topics", "--close"]);
		}
		// omp is really shutting down: the exit-grace fallback must not fire. A clean shutdown is also
		// the owner's last stamp (P2 d): verify first, then record the state that pass confirmed.
		rollover.clearGrace();
		stampPlannerState(freshConfig);
	});

	// Compaction keeps the owner's holds true: a summary may state a hold only as a plans' WAITING on owner line says it.
	pi.on("session.compacting", (_e, ctx) => {
		if (!isMain(ctx)) return undefined;
		const holds = q.ownerHolds(cfg.paths);
		return {
			context: [
				"Owner holds/blockers: only plans' WAITING on owner lines are real:",
				...(holds.length > 0 ? holds : ["none"]),
				"Any other hold, 'needs the owner' or 'paused' claim carried in this summary is unverified: re-read the plan before repeating it to the owner.",
			],
		};
	});

	// Register chat commands (unlock/tier/planner/go/approve + context) BEFORE rollover input
	// so unlock wins while a rollover is ready or in flight.
	registerChatCommands(pi, getCfg);
	pi.on("input", (event, ctx) => rollover.handleInput(event, ctx));
	rollover.registerCommand();
}

/** Clear the active adapter's rollover state and release the session lock. Tests call this in
 * afterAll so a stale grace-period timer does not fire into a later test file's sandbox paths
 * (P3c), and so the process-lifetime flock does not leak into the next file (P4). */
export function reset(): void {
	if (activeAdapterReset) {
		activeAdapterReset();
		activeAdapterReset = null;
	}
	heldSessionLock?.release();
	heldSessionLock = null;
}

/** package.json omp.extensions entry. */
export default function ompExtension(pi: ExtensionHost): void {
	// The one switch (MAIN_ENV): plain `omp` runs nothing of neurastream — no hook, no command,
	// no config read. `neurastream main` sets it for its child (launch.ts), so anything the Main
	// session spawns inherits it and stays guarded.
	if (process.env[MAIN_ENV] !== "1") return;
	const initial = loadConfig();
	createOmpAdapter(pi, initial, reloadingConfig(initial, configFile(), () => loadConfig(), line => adapterLog(initial, line)));
}
