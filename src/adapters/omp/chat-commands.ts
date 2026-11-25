// Chat unlock, autonomy tiers, planner switch, one-shot `go`, plan approval, and context reset-time annotation.

import { basename } from "node:path";
import { chatGo, chatPlanner, chatTier, type Tier } from "../../core/autonomy.ts";
import { strftime } from "../../core/clock.ts";
import type { Config } from "../../core/config.ts";
import { chatApprove } from "../../core/plan-approval.ts";
import * as q from "../../core/queue/lib.ts";
import { annotateResetTimes } from "../../core/reset-time.ts";
import { asRecord, asRolloverCtx, asString, isMain, type ExtensionHost } from "./types.ts";

const CHAT_PROMPT_MAX_AGE_MS = 10 * 60_000;

/**
 * Registers the interactive `input` and collab `context` chat-command handlers on the extension host.
 * Must be registered before the rollover `input` handler so unlock/tier/planner/go/approve win
 * while a rollover is ready or in flight.
 *
 * Args:
 *     pi (ExtensionHost): Active extension host
 *     getCfg (() => Config): Accessor returning the adapter's current config
 */
export function registerChatCommands(pi: ExtensionHost, getCfg: () => Config): void {
	// Chat unlock + autonomy tiers (guards.chat_unlock): the owner's whole message "unlock"/
	// "unlock N"/"lock" moves the guard unlock file, "tier <name>" sets the autonomy tier and the
	// approve phrase (autonomy.go_phrase, default "go push") approves one strict landing
	// (src/core/queue/lib.ts chatUnlock, src/core/autonomy.ts chatTier/chatGo). Only prompts the
	// owner really typed count: the local terminal (input event, source "interactive") and collab
	// guest prompts from write peers. This handler is registered BEFORE the rollover input handler,
	// so the unlock wins while a rollover is ready or in flight (emitInput short-circuits on
	// { handled: true }). An applied unlock also wakes Main (sendUserMessage: idle → a new turn,
	// mid-turn → the steer queue), the same message the phone-page unlock sends through the owner inbox.
	const notifyUnlock = (ctx: unknown, r: { command?: "unlock" | "lock"; minutes?: number; until?: number }): void => {
		const c = asRolloverCtx(ctx);
		if (r.command === "unlock" && r.minutes !== undefined && r.until !== undefined) {
			const hhmm = strftime(r.until, "%H:%M");
			c?.notify(`guard unlocked for ${r.minutes} min (until ${hhmm})`);
			pi.sendUserMessage(`Owner unlocked the guards in chat for ${r.minutes} min (until ${hhmm}). Do the step that waited on the unlock now.`);
		} else if (r.command === "lock") {
			c?.notify("guard locked again");
		}
	};
	// The tier switch and the one-shot `go` travel the same two owner paths and answer the same way.
	const notifyTier = (ctx: unknown, r: { tier?: Tier }): void => {
		const c = asRolloverCtx(ctx);
		if (!c || r.tier === undefined) return;
		c.notify(`tier now ${r.tier}`);
	};
	const notifyGo = (ctx: unknown, r: { minutes?: number }): void => {
		const cfg = getCfg();
		const c = asRolloverCtx(ctx);
		if (!c || r.minutes === undefined) return;
		c.notify(`${cfg.autonomy.go_phrase}: one push/merge approved for ${r.minutes} min`);
	};

	pi.on("input", (event, ctx) => {
		const cfg = getCfg();
		if (!cfg.guards.chat_unlock || !isMain(ctx)) return undefined;
		const e = asRecord(event);
		if (asString(e.source) !== "interactive") return undefined;
		const text = asString(e.text);
		const t = chatTier(text, cfg, "interactive");
		if (t.applied) {
			notifyTier(ctx, t);
			return { handled: true };
		}
		const p = chatPlanner(text, cfg, "interactive");
		if (p.applied) {
			asRolloverCtx(ctx)?.notify(`planner now ${p.planner}`);
			return { handled: true };
		}
		const g = chatGo(text, cfg, "interactive");
		if (g.applied) {
			notifyGo(ctx, g);
			return { handled: true };
		}
		const a = chatApprove(text, cfg, "interactive");
		if (a.applied) {
			asRolloverCtx(ctx)?.notify(`approved ${basename(a.plan)}`);
			return { handled: true };
		}
		if (a.problem !== undefined) {
			asRolloverCtx(ctx)?.notify(a.problem);
			return { handled: true };
		}
		const r = q.chatUnlock(asString(e.text), cfg, "interactive");
		if (!r.applied) return undefined;
		notifyUnlock(ctx, r);
		return { handled: true };
	});

	// A collab guest prompt (collab/host.ts #handlePrompt, write peers only) is NOT an input event:
	// it is session.promptCustomMessage({ customType: "collab-prompt", details: { from },
	// attribution: "user" }), which lands in the agent context — the adapter sees it on the
	// "context" event (types.ts ContextEvent, the messages about to go to the LLM). The message
	// stays in the transcript, so later LLM calls replay it: a seen key (timestamp + text) is acted
	// on once, and a resumed session replaying old prompts is stopped by the age limit.
	const seenChatPrompts = new Set<string>();
	pi.on("context", (event, ctx) => {
		if (!isMain(ctx)) return undefined;
		const cfg = getCfg();
		const messages = asRecord(event).messages;
		if (!Array.isArray(messages)) return undefined;
		if (cfg.guards.chat_unlock) {
			for (const raw of messages) {
				const m = asRecord(raw);
				if (m.role !== "custom" || m.customType !== "collab-prompt" || m.attribution !== "user") continue;
				const from = asString(asRecord(m.details).from);
				if (from === "") continue;
				const text =
					typeof m.content === "string"
						? m.content
						: Array.isArray(m.content)
							? m.content.map(c => asString(asRecord(c).text)).join("")
							: "";
				const timestamp = typeof m.timestamp === "number" ? m.timestamp : 0;
				if (Date.now() - timestamp > CHAT_PROMPT_MAX_AGE_MS) continue;
				const key = `${timestamp}:${text}`;
				if (seenChatPrompts.has(key)) continue;
				seenChatPrompts.add(key);
				const r = q.chatUnlock(text, cfg, `collab:${from}`);
				if (r.applied) {
					notifyUnlock(ctx, r);
					continue;
				}
				const t = chatTier(text, cfg, `collab:${from}`);
				if (t.applied) {
					notifyTier(ctx, t);
					continue;
				}
				const g = chatGo(text, cfg, `collab:${from}`);
				if (g.applied) notifyGo(ctx, g);
			}
		}
		const rule = { pattern: cfg.quota.reset_pattern, zone: cfg.quota.reset_tz };
		let changed = false;
		const mapped = messages.map(raw => {
			const message = asRecord(raw);
			if (typeof message.content === "string") {
				const content = annotateResetTimes(message.content, rule);
				if (content === message.content) return raw;
				changed = true;
				return { ...message, content };
			}
			if (!Array.isArray(message.content)) return raw;
			let contentChanged = false;
			const content = message.content.map(part => {
				const block = asRecord(part);
				if (typeof block.text !== "string") return part;
				const text = annotateResetTimes(block.text, rule);
				if (text === block.text) return part;
				contentChanged = true;
				return { ...block, text };
			});
			if (!contentChanged) return raw;
			changed = true;
			return { ...message, content };
		});
		return changed ? { messages: mapped } : undefined;
	});
}
