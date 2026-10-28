#!/usr/bin/env bun
// Stand-in linter for the write-check tests: prints `file:line:col: RULE msg` for every line that
// holds `lint:RULE`. A file holding `hang-lint` never returns, so a test can drive the timeout.
// Needs no ruff or oxlint.
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "";
const text = readFileSync(file, "utf8");
if (text.includes("hang-lint")) await Bun.sleep(60_000);
text.split("\n").forEach((line, i) => {
	const m = /lint:([\w-]+)/.exec(line);
	if (m) console.log(`${file}:${i + 1}:1: ${m[1]} marked by lint:`);
});
