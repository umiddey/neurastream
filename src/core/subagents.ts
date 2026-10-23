import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { allowedAgents } from "./queue/lib.ts";

const TEMPLATE = join(import.meta.dir, "../../templates/notes/subagents.md");
const SLUG = /^[a-z0-9-]+$/;
const ALLOWED_HEAD = /^## allowed\s*$/i;
const BULLET = /^\s*[-*]\s+`([a-z0-9-]+)`/;

/** A slug that is not a valid allow-list entry. The CLI maps it to exit 2. */
export class InvalidSlugError extends Error {}

/** Slugs that are not valid allow-list entries. */
export function invalidSlugs(slugs: string[]): string[] {
	return slugs.filter(s => !SLUG.test(s));
}

/** Index of the `## Allowed` heading and of the line that ends its section. */
function allowedSection(lines: string[]): { head: number; end: number } | null {
	const head = lines.findIndex(l => ALLOWED_HEAD.test(l));
	if (head === -1) return null;
	let end = lines.findIndex((l, i) => i > head && /^## /.test(l));
	if (end === -1) end = lines.length;
	return { head, end };
}

/**
 * Append `- \`slug\`` bullets at the end of the `## Allowed` section. Creates the file from the
 * template and the section when missing. Slugs already listed are skipped. Every other line is
 * left as it was.
 */
export function allowAgents(file: string, slugs: string[]): { added: string[]; kept: string[] } {
	const bad = invalidSlugs(slugs);
	if (bad.length) throw new InvalidSlugError(`invalid slug: ${bad.join(", ")} (use a-z, 0-9 and -)`);
	const wanted = [...new Set(slugs)];
	const present = existsSync(file);
	const listed = present ? allowedAgents(file) : new Set<string>();
	const added = wanted.filter(s => !listed.has(s));
	const kept = wanted.filter(s => listed.has(s));
	if (present && added.length === 0) return { added, kept };

	const text = present ? readFileSync(file, "utf8") : readFileSync(TEMPLATE, "utf8");
	const bullets = added.map(s => `- \`${s}\``);
	const lines = text.split("\n");
	const sec = allowedSection(lines);
	let next: string;
	if (!sec) {
		const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
		next = `${base}\n## Allowed\n\n${bullets.join("\n")}\n`;
	} else {
		let last = sec.head;
		for (let i = sec.head + 1; i < sec.end; i++) if ((lines[i] ?? "").trim() !== "") last = i;
		const insert = last === sec.head ? ["", ...bullets] : bullets;
		lines.splice(last + 1, 0, ...insert);
		next = lines.join("\n");
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, next);
	return { added, kept };
}

/** Remove the bullet lines for these slugs from the `## Allowed` section; nothing else changes. */
export function denyAgents(file: string, slugs: string[]): { removed: string[]; absent: string[] } {
	const bad = invalidSlugs(slugs);
	if (bad.length) throw new InvalidSlugError(`invalid slug: ${bad.join(", ")} (use a-z, 0-9 and -)`);
	const wanted = [...new Set(slugs)];
	if (!existsSync(file)) return { removed: [], absent: wanted };
	const listed = allowedAgents(file);
	const removed = wanted.filter(s => listed.has(s));
	const absent = wanted.filter(s => !listed.has(s));
	if (removed.length === 0) return { removed, absent };

	const lines = readFileSync(file, "utf8").split("\n");
	const sec = allowedSection(lines);
	if (!sec) return { removed, absent };
	const kept = lines.filter((l, i) => {
		if (i <= sec.head || i >= sec.end) return true;
		const m = BULLET.exec(l);
		return !(m && removed.includes(m[1] ?? ""));
	});
	writeFileSync(file, kept.join("\n"));
	return { removed, absent };
}
