import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function helpDoc(name: string): string {
	return readFileSync(join(HERE, "../../templates/help", `${name}.txt`), "utf8");
}

/** sys.exit(text): the interpreter writes text plus one newline to stderr, then exits 1. */
export function exitText(text: string): number {
	process.stderr.write(`${text}\n`);
	return 1;
}

/** print(text): always one extra newline, even when text already ends with one. */
export function printText(text: string): void {
	process.stdout.write(`${text}\n`);
}
