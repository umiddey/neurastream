// The managed block in the owner's AGENTS.md. The rules come from templates/AGENTS.md with the
// config's agent dir filled in; they sit between two markers, and only what is between them is
// ever written or compared. Everything outside the markers stays the owner's.

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
	if (begins.length === 0 && ends.length === 0) return null;
	if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) {
		throw new Error("neurastream block markers malformed: expected one begin marker, then one end marker");
	}
	return { start: begins[0], end: ends[0] + END_MARK.length };
}

// Replace the marked block, or append one when the file has none. Bytes outside the markers are kept.
export function upsertBlock(fileText: string, block: string): string {
	const at = span(fileText);
	if (at) return fileText.slice(0, at.start) + block + fileText.slice(at.end);
	if (fileText === "") return `${block}\n`;
	return `${fileText}\n${block}\n`;
}

// "missing": no block in the file. "stale": the block differs, or its markers are malformed.
export function blockState(fileText: string, block: string): "ok" | "stale" | "missing" {
	let at: { start: number; end: number } | null;
	try {
		at = span(fileText);
	} catch {
		return "stale";
	}
	if (!at) return "missing";
	return fileText.slice(at.start, at.end) === block ? "ok" : "stale";
}
