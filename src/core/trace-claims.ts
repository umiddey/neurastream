// Claim extraction (plan 20261024_0300 P2): what an agent's final report CLAIMS happened —
// test result counts, exit codes, commit SHAs, heavy-run labels, changed file paths. Pure text
// in, claims out; the P3 verifier matches each claim against TraceEvents of the same run and
// turns unmatched claims into findings. Evidence is capped at 160 chars and long token-like
// runs are masked, so a claim line can never carry a secret into findings or logs.

import type { TraceEvent } from "./adapter.ts";

export type ClaimKind =
	| "tests-passed"
	| "tests-failed"
	| "exit"
	| "sha"
	| "heavy-label"
	| "changed-path";

export interface Claim {
	kind: ClaimKind;
	/** tests-passed / tests-failed: the claimed count; exit: the claimed exit code. */
	count?: number;
	/** sha: the commit SHA; heavy-label: the label text; changed-path: the path. */
	value?: string;
	/** At most 160 chars of the claiming line, token-masked. */
	evidence: string;
}

const TOKEN_MASK = /[A-Za-z0-9_-]{24,}/g;
const EVIDENCE_MAX = 160;

/** Mask long token-like runs (they may be credentials) and cap the length. */
export function maskEvidence(line: string): string {
	return line.replace(TOKEN_MASK, "[masked]").slice(0, EVIDENCE_MAX);
}

// "pass"/"fail" with or without "ed" so both prose ("530 passed") and test-runner summary
// lines ("3 pass / 0 fail") are claimed; "passing"/"failing" have no word boundary and are not.
const PASSED = /(\d+)\s+pass(?:ed)?\b/gi;
const FAILED = /(\d+)\s+fail(?:ed)?\b/gi;
const EXIT = /\bexit(?:\s+code)?\s*[:=]?\s*(\d+)\b/gi;
// Lowercase hex, 7 (git short) to 40 (full); at least one a-f letter keeps numeric counts out.
const SHA = /\b[0-9a-f]{7,40}\b/g;
// heavy-run <agent> "<label>" — the quoted label is the claim (both bin spellings).
const HEAVY_LABEL = /heavy-run(?:\.sh)?\s+\S+\s+"([^"]+)"/;
// "3. Run `heavy-run.sh agent \"x full\" …`" is a next-step instruction, not a claim that the
// label ran (P4 smoke: an agent's numbered TODO list read as label claims).
const INSTRUCTION = /^\s*\d+[.)]\s+(?:run|execute|start|kick off)\b/i;
// A path only counts as "changed" on a line that says a change happened; the token must end in
// a file extension so branch names (feat/x) and prose never become path claims. The extension
// must be a real one: the P4 smoke flagged dotted API symbols (`Bun.sleep`, `os.remove`,
// `entry.kind`) and emails (`x@y.z`) because any `.word` looked like an extension.
const CHANGE_VERB = /\b(chang|commit|edit|writ|updat|creat|add|remov|delet|fix|touch|modif|refactor|migrat)/i;
const EXTENSIONS: Record<string, true> = {
	ts: true, tsx: true, mts: true, cts: true, js: true, jsx: true, mjs: true, cjs: true,
	json: true, jsonl: true, md: true, mdx: true, txt: true, yml: true, yaml: true, toml: true,
	sh: true, bash: true, zsh: true, py: true, pyi: true, rb: true, go: true, rs: true,
	java: true, kt: true, swift: true, c: true, h: true, cpp: true, hpp: true, cc: true,
	hh: true, cs: true, php: true, lua: true, sql: true, html: true, htm: true, css: true,
	scss: true, xml: true, csv: true, tsv: true, ini: true, cfg: true, conf: true, env: true,
	lock: true, service: true, socket: true, timer: true, patch: true, diff: true,
};
const PATH_TOKEN = /(?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z][A-Za-z0-9]{0,7}\b/g;
// A shell segment writes a file when one of these operators precedes the path: redirection,
// heredoc, tee/touch/cp/mv. A bare mention (grep, cat) never writes.
const SHELL_WRITE = /(?:>>?|<<|\btee\b|\btouch\b|\bcp\b|\bmv\b)/;

/**
 * A hex run glued into a longer identifier is not a commit reference: hyphen-joined hex is a
 * session-UUID fragment (`…_01a16feb-3a5d-…jsonl`), a hyphen/colon-joined preceding identifier
 * is a catalog id (`…-accounts-991b4d35`) or a digest (`sha256:e61c0a9d2f47…`). Found in the
 * P4 smoke over real sessions (a report citing its own session file name; pipeline catalog
 * ids and digests quoted in a final report).
 */
function joinedFragment(line: string, at: number, match: string): boolean {
	const after = line.slice(at + match.length);
	if (after.startsWith("-") && /^[0-9a-f]/i.test(after.slice(1))) return true;
	const glued = line[at - 1];
	if ((glued === "-" || glued === ":") && /[A-Za-z0-9]{2,}$/i.test(line.slice(0, at - 1))) return true;
	return false;
}

/** Every verifiable claim in one final-report text, in order of appearance, deduped. */
export function extractClaims(text: string): Claim[] {
	const out: Claim[] = [];
	const seen = new Set<string>();
	for (const raw of text.split("\n")) {
		if (!raw.trim()) continue;
		// Claims are read from the raw line (masking must not eat real SHAs); only the stored
		// evidence is masked and capped.
		const evidence = maskEvidence(raw);
		const push = (c: Omit<Claim, "evidence">) => {
			const key = `${c.kind}:${c.count ?? ""}:${c.value ?? ""}`;
			if (seen.has(key)) return;
			seen.add(key);
			out.push({ ...c, evidence });
		};
		for (const m of raw.matchAll(PASSED)) push({ kind: "tests-passed", count: Number(m[1]) });
		for (const m of raw.matchAll(FAILED)) push({ kind: "tests-failed", count: Number(m[1]) });
		for (const m of raw.matchAll(EXIT)) push({ kind: "exit", count: Number(m[1]) });
		for (const m of raw.matchAll(SHA)) {
			if (!/[a-f]/.test(m[0])) continue; // digit-only runs are counts, not SHAs
			if (joinedFragment(raw, m.index!, m[0])) continue; // session UUIDs, catalog ids and digests are not SHAs
			push({ kind: "sha", value: m[0] });
		}
		if (!INSTRUCTION.test(raw)) {
			const label = HEAVY_LABEL.exec(raw);
			if (label) push({ kind: "heavy-label", value: label[1] });
		}
		if (CHANGE_VERB.test(raw)) {
			for (const m of raw.matchAll(PATH_TOKEN)) {
				if (m[0].includes("@")) continue; // emails and npm scopes are not files
				if (!EXTENSIONS[m[0].slice(m[0].lastIndexOf(".") + 1).toLowerCase()]) continue;
				push({ kind: "changed-path", value: m[0] });
			}
		}
	}
	return out;
}

// ---- P3 verifier: every claim must be backed by the same run's tool activity ----

/** One claim's check result; backed verdicts carry where the proof was found. */
export interface ClaimVerdict {
	claim: Claim;
	backed: boolean;
	/** Where the proof came from, "" when unbacked. */
	how: string;
}

/** Every string an args object carries (commands, paths, labels), joined for substring checks. */
function argsText(args: Record<string, unknown> | undefined): string {
	const parts: string[] = [];
	const walk = (v: unknown): void => {
		if (typeof v === "string") parts.push(v);
		else if (Array.isArray(v)) for (const x of v) walk(x);
		else if (v !== null && typeof v === "object") for (const x of Object.values(v as object)) walk(x);
	};
	walk(args ?? {});
	return parts.join("\n");
}

/**
 * The claims of one run, read from its last assistant text — the final report. Runs with no
 * assistant text at all claim nothing.
 */
export function claimsFromEvents(events: TraceEvent[]): Claim[] {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e?.kind === "assistantText" && e.text?.trim()) return extractClaims(e.text);
	}
	return [];
}

/**
 * Checks each claim against the events of the same run:
 *   tests-passed / tests-failed / exit — the same result line in some toolResult's output;
 *   sha — printed in the output of the very git call whose result it answered in (the i-th
 *     toolResult pairs with the i-th toolCall; a sha echoed by a non-git tool while some other
 *     git call ran elsewhere is not backing);
 *   heavy-label — the label, quoted, in a heavy-run call the run actually made;
 *   changed-path — carried by an edit/write tool call's arguments, or written by a shell
 *     command (a write operator before the path in one command segment).
 */
export function verifyClaims(claims: Claim[], events: TraceEvent[]): ClaimVerdict[] {
	const results = events.filter((e) => e.kind === "toolResult").map((e) => e.text ?? "");
	const calls = events
		.filter((e) => e.kind === "toolCall")
		.map((e) => ({ tool: e.tool ?? "", args: argsText(e.args) }));
	// The harness writes exactly one toolResult per toolCall, in order, so the i-th result
	// pairs with the i-th call.
	const paired = results.map((text, i) => ({ text, call: calls[i] }));
	const verdict = (c: Claim): ClaimVerdict => {
		const unbacked: ClaimVerdict = { claim: c, backed: false, how: "" };
		switch (c.kind) {
			case "tests-passed":
			case "tests-failed": {
				const word = c.kind === "tests-passed" ? "pass" : "fail";
				if (results.some((t) => new RegExp(`\\b${c.count}\\s+${word}(?:ed)?\\b`, "i").test(t)))
					return { claim: c, backed: true, how: "count in a toolResult" };
				return unbacked;
			}
			case "exit":
				if (results.some((t) => new RegExp(`\\bexit(?:\\s+code)?\\s*[:=]?\\s*${c.count}\\b`, "i").test(t)))
					return { claim: c, backed: true, how: "exit line in a toolResult" };
				return unbacked;
			case "sha":
				if (paired.some((p) => p.call !== undefined && /\bgit\b/.test(p.call.args) && p.text.includes(c.value ?? "\u0000")))
					return { claim: c, backed: true, how: "in a git command's output" };
				return unbacked;
			case "heavy-label":
				if (calls.some((c2) => c2.args.includes("heavy-run") && c2.args.includes(`"${c.value}"`)))
					return { claim: c, backed: true, how: "label in a heavy-run call" };
				return unbacked;
			case "changed-path": {
				const v = c.value ?? "\u0000";
				if (calls.some((c2) => /edit|write/i.test(c2.tool) && c2.args.includes(v)))
					return { claim: c, backed: true, how: "path in an edit/write call" };
				// Files agents create through the shell (`cat > f <<EOF`) are real changes; a
				// write operator before the path inside one command segment backs the claim,
				// a bare mention (grep, cat) does not.
				const written = calls.some((c2) =>
					c2.args.split(/\n|&&|\|\||[;|]/).some((seg) => {
						const at = seg.indexOf(v);
						return at >= 0 && SHELL_WRITE.test(seg.slice(0, at));
					})
				);
				if (written) return { claim: c, backed: true, how: "path written by a shell command" };
				return unbacked;
			}
		}
	};
	return claims.map(verdict);
}
