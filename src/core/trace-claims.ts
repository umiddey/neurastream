// Claim extraction (plan 20261024_0300 P2): what an agent's final report CLAIMS happened —
// test result counts, exit codes, commit SHAs, heavy-run labels, changed file paths. Pure text
// in, claims out; the P3 verifier matches each claim against TraceEvents of the same run and
// turns unmatched claims into findings. Evidence is capped at 160 chars and long token-like
// runs are masked, so a claim line can never carry a secret into findings or logs.

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
// A path only counts as "changed" on a line that says a change happened; the token must end in
// a file extension so branch names (feat/x) and prose never become path claims.
const CHANGE_VERB = /\b(chang|commit|edit|writ|updat|creat|add|remov|delet|fix|touch|modif|refactor|migrat)/i;
const PATH_TOKEN = /(?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z][A-Za-z0-9]{0,7}\b/g;

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
			push({ kind: "sha", value: m[0] });
		}
		const label = HEAVY_LABEL.exec(raw);
		if (label) push({ kind: "heavy-label", value: label[1] });
		if (CHANGE_VERB.test(raw)) {
			for (const m of raw.matchAll(PATH_TOKEN)) push({ kind: "changed-path", value: m[0] });
		}
	}
	return out;
}
