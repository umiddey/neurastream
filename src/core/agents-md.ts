// The managed block: the rules from templates/AGENTS.md with the config's agent dir filled in,
// between two markers. Main puts them in its system prompt; install only strips an old copy from
// the owner's AGENTS.md, and everything outside the markers stays the owner's.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const AGENTS_TEMPLATE = join(HERE, "../../templates/AGENTS.md");
export const BEGIN_MARK = "<!-- neurastream:begin (managed by neurastream; edit the package, not this block) -->";
export const END_MARK = "<!-- neurastream:end -->";

export function renderBlock(cfg: Config, template: string = readFileSync(AGENTS_TEMPLATE, "utf8")): string {
	const body = template.trimEnd().split("{{AGENT_DIR}}").join(cfg.paths.agent_dir);
	return `${BEGIN_MARK}\n${body}\n${END_MARK}`;
}

function occurrences(text: string, mark: string): number[] {
	const at: number[] = [];
	for (let i = text.indexOf(mark); i !== -1; i = text.indexOf(mark, i + mark.length)) at.push(i);
	return at;
}

// The block's span in a file, or null when there are no markers. Anything other than exactly one
// begin marker followed by exactly one end marker is malformed and throws.
function span(text: string): { start: number; end: number } | null {
	const begins = occurrences(text, BEGIN_MARK);
	const ends = occurrences(text, END_MARK);
	const begin = begins[0];
	const end = ends[0];
	if (begin === undefined && end === undefined) return null;
	if (begins.length !== 1 || ends.length !== 1 || begin === undefined || end === undefined || end < begin) {
		throw new Error("neurastream block markers malformed: expected one begin marker, then one end marker");
	}
	return { start: begin, end: end + END_MARK.length };
}

// Remove the marked block, keeping every byte outside the markers. "missing": there was no block.
// "stale": the markers are malformed, and the text comes back untouched.
export function stripBlock(fileText: string): { text: string; state: "ok" | "stale" | "missing" } {
	let at: { start: number; end: number } | null;
	try {
		at = span(fileText);
	} catch {
		return { text: fileText, state: "stale" };
	}
	if (!at) return { text: fileText, state: "missing" };
	let text = fileText.slice(0, at.start) + fileText.slice(at.end);
	if (text.trim() === "") text = "";
	else text = `${text.replace(/\n+$/, "")}\n`;
	return { text, state: "ok" };
}
