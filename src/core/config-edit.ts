// The one config.yml editor. setConfigKeys edits dotted keys line by line and keeps every other
// line byte-for-byte (comments, order, other sections): it never re-serialises YAML.
// checkEdited proves an edited file still loads before anything is written.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "./config.ts";

const leading = (line: string): number => line.length - line.trimStart().length;
const isBlank = (line: string): boolean => line.trim() === "";

// Leaf dotted paths: a mapping recurses; a scalar, a list or null is a leaf.
export function leafKeys(node: unknown, prefix: string[] = []): string[] {
	if (node === null || typeof node !== "object" || Array.isArray(node)) return [prefix.join(".")];
	return Object.entries(node).flatMap(([k, v]) => leafKeys(v, [...prefix, k]));
}

export function valueAt(cfg: unknown, key: string): unknown {
	let node = cfg;
	for (const seg of key.split(".")) node = (node as Record<string, unknown>)[seg];
	return node;
}

// A value as YAML text for setConfigKeys: lists in flow style on one line ([a, b]); scalars as JSON, which is valid YAML.
export function yamlValue(value: unknown): string {
	return Array.isArray(value) ? `[${value.map((x) => JSON.stringify(x)).join(", ")}]` : JSON.stringify(value);
}

// First line at or after `from` that is not part of a block whose keys sit at column `col`.
// A block is the following lines that are blank or indented deeper than the key.
function blockEnd(lines: string[], from: number, col: number): number {
	let j = from;
	while (j < lines.length && (isBlank(lines[j]!) || leading(lines[j]!) > col)) j++;
	return j;
}

// Just past the last non-blank line in [from, end): where a new line joins that block.
function afterLast(lines: string[], from: number, end: number): number {
	let at = from;
	for (let i = from; i < end; i++) if (!isBlank(lines[i]!)) at = i + 1;
	return at;
}

// Sets one path segment list inside the block of `parent` (-1 = the whole file). `indent` is the
// column its keys sit at. Recurses one level per segment, so a.b.c only matches inside a's and b's blocks.
function setPath(lines: string[], segs: string[], value: string, parent: number, indent: string): void {
	const [seg, ...deeper] = segs as [string, ...string[]];
	const lo = parent < 0 ? 0 : parent + 1;
	const hi = parent < 0 ? lines.length : blockEnd(lines, lo, leading(lines[parent]!));
	const re = new RegExp("^" + indent + seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\s*):(.*)$");
	let k = -1;
	for (let i = lo; i < hi; i++) {
		if (re.test(lines[i]!)) {
			k = i;
			break;
		}
	}
	if (deeper.length === 0) {
		if (k < 0) {
			lines.splice(afterLast(lines, lo, hi), 0, `${indent}${seg}: ${value}`);
			return;
		}
		// Replace the leaf and any child lines under it; keep its trailing comment.
		const rest = re.exec(lines[k]!)![2]!;
		const comment = rest.match(/\s+#.*$/)?.[0] ?? "";
		const cut = afterLast(lines, k + 1, blockEnd(lines, k + 1, indent.length));
		lines.splice(k, cut - k, `${indent}${seg}: ${value}${comment}`);
		return;
	}
	if (k < 0) {
		k = afterLast(lines, lo, hi);
		lines.splice(k, 0, `${indent}${seg}:`);
	}
	const end = blockEnd(lines, k + 1, indent.length);
	const child = lines.slice(k + 1, end).find((l) => !isBlank(l));
	const childIndent = child === undefined ? `${indent}  ` : /^[ \t]*/.exec(child)![0];
	setPath(lines, deeper, value, k, childIndent);
}

// `values` maps each dotted key to its already-formatted YAML value text (`true`, `7788`,
// `["a", "b"]`, `"quoted"`). A value with a line break is refused: it would write extra keys.
export function setConfigKeys(text: string | null, values: Record<string, string>): string {
	for (const [key, value] of Object.entries(values)) {
		if (/[\n\r]/.test(value)) throw new ConfigError(`config ${key}: a value cannot contain a line break`);
	}
	// "".split("\n") is [""], so an empty file still ends with a newline after the first insert.
	let base = text ?? "";
	if (base !== "" && !base.endsWith("\n")) base += "\n";
	const lines = base.split("\n");
	for (const [key, value] of Object.entries(values)) setPath(lines, key.split("."), value, -1, "");
	return lines.join("\n");
}

// Proves an edited config still loads through loadConfig before anything is written. The copy goes
// to a fresh mkdtemp dir (mode 0700, unpredictable name, so no planted symlink can redirect it);
// the dir is removed in finally. Returns false after reporting the error when the file does not load.
export function checkEdited(edited: string, home: string, error: (line: string) => void): boolean {
	const dir = mkdtempSync(join(tmpdir(), "neurastream-check-"));
	try {
		const file = join(dir, "config.yml");
		writeFileSync(file, edited, { mode: 0o600 });
		loadConfig({ file, home });
		return true;
	} catch (err) {
		error(err instanceof ConfigError ? err.message : String(err));
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
