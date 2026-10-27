// Diagram coverage (plan 20261026_0930 P10, INCIDENT I-20261027-73: the owner's "the architecture
// diagram should fucking have everything … from smallest to biggest, everything should be drilled
// down"). A plan's diagram is checked against the plan itself: every phase and every file or command
// path its phase lines name must appear in the page's diagram data, and a box that drills down must
// drill into at least two things. The styling half — no arrow crossing a box, no arrow label on a box
// at 1280 and 390 width — is a browser check the architecture-drilldown skill runs; no code here can
// see a rendered arrow.
import { readFileSync } from "node:fs";

export interface DiagramReport {
	/** Phases and paths the plan names that no box mentions. */
	missing: string[];
	/** Boxes that drill down into one thing (or none). */
	thin: string[];
}

/** Index of the bracket matching the one at `open`, skipping string contents; -1 when unbalanced. */
function matchBracket(text: string, open: number): number {
	let depth = 0;
	let quote = "";
	for (let i = open; i < text.length; i++) {
		const c = text[i]!;
		if (quote !== "") {
			if (c === "\\") i++;
			else if (c === quote) quote = "";
			continue;
		}
		if (c === '"' || c === "'" || c === "`") quote = c;
		else if (c === "{" || c === "[") depth++;
		else if (c === "}" || c === "]") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** The diagram data a drilldown page carries: `const T={…}` up to its matching brace. */
export function diagramData(html: string): string | null {
	const at = /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*\{/.exec(html);
	if (at === null) return null;
	const open = at.index + at[0].length - 1;
	const end = matchBracket(html, open);
	return end < 0 ? null : html.slice(open, end + 1);
}

/** How many objects a `kids:[` array holds directly. */
function kidCount(data: string, open: number): number {
	const end = matchBracket(data, open);
	if (end < 0) return 0;
	let n = 0;
	for (let i = open + 1; i < end; i++) {
		if (data[i] !== "{") continue;
		n++;
		const close = matchBracket(data, i);
		if (close < 0) break;
		i = close;
	}
	return n;
}

/** The id of the box whose `kids` sits at `at`, for the message. */
function boxId(data: string, at: number): string {
	const head = data.slice(Math.max(0, at - 4000), at);
	const ids = [...head.matchAll(/\bid\s*:\s*"([^"]+)"/g)];
	return ids.length === 0 ? "a box" : ids[ids.length - 1]![1]!;
}

const PHASE = /^\s*[-*]\s+\[[ x]\]\s+(P\d+[a-z]?)\b/;
const SPAN = /`([^`\n]+)`/g;
/** A word that looks like a file or a path: it has a directory part or a short extension. */
const PATHISH = /[A-Za-z0-9_~/.-]*(?:\/[A-Za-z0-9_~/.-]+|\.[A-Za-z][A-Za-z0-9]{0,4}\b)/g;

export interface PlanItems {
	phases: string[];
	/** path → the phase whose line names it (first one wins). */
	paths: Map<string, string>;
}

function clean(word: string): string {
	return word.replace(/^[("'`]+/, "").replace(/[)"'`,;:.]+$/, "");
}

/** The phases of a plan and the files or commands their lines name in backticks. */
export function planItems(markdown: string): PlanItems {
	const phases: string[] = [];
	const paths = new Map<string, string>();
	for (const line of markdown.split("\n")) {
		const phase = PHASE.exec(line);
		if (phase === null) continue;
		const id = phase[1]!;
		if (!phases.includes(id)) phases.push(id);
		for (const span of line.matchAll(SPAN)) {
			for (const raw of span[1]!.matchAll(PATHISH)) {
				const word = clean(raw[0]);
				// Short noise ("e.g", "y/N", "Pn") and web addresses are not what a box must name.
				if (word.length < 4 || /^https?:/i.test(word) || word.includes("…")) continue;
				if (!paths.has(word)) paths.set(word, id);
			}
		}
	}
	return { phases, paths };
}

/** What the diagram of `planText` is missing, checked against the page's own data. */
export function checkDiagram(html: string, planText: string): DiagramReport {
	const data = diagramData(html);
	if (data === null) return { missing: ["the page carries no diagram data (expected `const NAME={` … `}`)"], thin: [] };
	const items = planItems(planText);
	const missing: string[] = [];
	for (const phase of items.phases) {
		if (!new RegExp(`\\b${phase}\\b`).test(data)) missing.push(`${phase}: the phase is in no box`);
	}
	for (const [path, phase] of items.paths) {
		if (!data.includes(path)) missing.push(`${path} (${phase}): named in the plan, in no box`);
	}
	const thin: string[] = [];
	for (const hit of data.matchAll(/kids\s*:\s*\[/g)) {
		const count = kidCount(data, hit.index + hit[0].length - 1);
		if (count < 2) thin.push(`${boxId(data, hit.index)} has ${count} kid${count === 1 ? "" : "s"}`);
	}
	return { missing, thin };
}

/** The check for two files on disk; a page without data reads as one missing item, never a crash. */
export function checkDiagramFiles(htmlFile: string, planFile: string): DiagramReport {
	return checkDiagram(readFileSync(htmlFile, "utf8"), readFileSync(planFile, "utf8"));
}
