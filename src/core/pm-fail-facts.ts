import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, resolve, join } from "node:path";
import type { Config } from "./config.ts";
import { exitText, helpDoc, printText } from "./help.ts";

function unescapeXml(s: string): string {
	return s
		.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function attr(blob: string, name: string): string {
	const m = blob.match(new RegExp(`\\b${name}="([^"]*)"`)) ?? blob.match(new RegExp(`\\b${name}='([^']*)'`));
	return m ? unescapeXml(m[1]!) : "";
}

function child(inner: string, tag: string): { attrs: string; text: string } | null {
	const re = new RegExp(`<${tag}\\b([^>]*)/>|<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`);
	const m = inner.match(re);
	if (!m) return null;
	if (m[1] !== undefined) return { attrs: m[1], text: "" };
	return { attrs: m[2] ?? "", text: unescapeXml(m[3] ?? "") };
}

function opt(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	if (i < 0) return undefined;
	return args[i + 1];
}

function slug(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function head(path: string, k: number): string {
	try {
		return readFileSync(path, "utf8").split(/\n/).slice(0, k).join("\n").replace(/\s+$/, "");
	} catch {
		return "";
	}
}

export function pmFailFacts(args: string[], cfg: Config): number {
	if (args.length < 1) return exitText(helpDoc("pm-fail-facts"));
	const wt = resolve(args[0]!);
	const nRaw = opt(args, "--lines");
	const n = nRaw !== undefined ? Number(nRaw) : cfg.pm.fail_lines;
	const blog = opt(args, "--backend-log") ?? cfg.pm.backend_log;
	const junit = join(wt, "test-results", "e2e-junit.xml");
	if (!existsSync(junit)) return exitText(`no ${junit}`);

	const xml = readFileSync(junit, "utf8");
	const cases: { cls: string; name: string; inner: string; attrs: string }[] = [];
	const re = /<testcase\b([^>]*)\/>|<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;
	for (const m of xml.matchAll(re)) {
		if (m[1] !== undefined) cases.push({ cls: attr(m[1], "classname"), name: attr(m[1], "name"), inner: "", attrs: m[1] });
		else cases.push({ cls: attr(m[2] ?? "", "classname"), name: attr(m[2] ?? "", "name"), inner: m[3] ?? "", attrs: m[2] ?? "" });
	}
	const failed: { cls: string; name: string; text: string }[] = [];
	for (const c of cases) {
		const f = child(c.inner, "failure") ?? child(c.inner, "error");
		if (f) failed.push({ cls: c.cls, name: c.name, text: `${attr(f.attrs, "message")}\n${f.text}` });
	}
	const skipped = cases.filter(c => /<skipped\b/.test(c.inner)).length;
	printText(`== ${junit}: ${cases.length} tests, ${failed.length} failed, ${skipped} skipped`);

	const artRoot = join(wt, "test-results", "playwright-output");
	const dirs = existsSync(artRoot)
		? readdirSync(artRoot).map(d => join(artRoot, d)).filter(d => {
			try {
				return statSync(d).isDirectory();
			} catch {
				return false;
			}
		})
		: [];

	for (const { cls, name, text } of failed) {
		const loc = text.match(/(tests\/[\w/.\-]+\.spec\.[jt]s):(\d+)/);
		printText(`\n#### FAIL ${cls} :: ${name}`);
		if (loc) printText(`at ${loc[1]}:${loc[2]}`);
		const err = text.split(/\r?\n/).filter(l => l.trim()).slice(0, n);
		printText(err.map(l => `  ${l.slice(0, 220)}`).join("\n"));
		const words = slug(`${cls} ${name}`).split("-").filter(w => w.length > 2);
		const scored = dirs
			.map(d => ({ score: words.filter(w => basename(d).toLowerCase().includes(w)).length, d }))
			.sort((a, b) => b.score - a.score || (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
		const best = scored[0]?.score ?? 0;
		const match = scored.filter(s => s.score >= 2 && s.score === best).slice(0, 2).map(s => s.d);
		for (const d of match) {
			printText(`-- artifacts ${d}`);
			for (const fn of ["error-context.md", "failed-requests.log", "console-errors.log"]) {
				const p = join(d, fn);
				if (!existsSync(p)) continue;
				printText(`   [${fn}]`);
				printText(head(p, n).split(/\r?\n/).map(l => `   ${l.slice(0, 200)}`).join("\n"));
			}
			const traces = existsSync(d) ? readdirSync(d).filter(f => f.startsWith("trace") && f.endsWith(".zip")) : [];
			if (traces.length) printText(`   trace: ${join(d, traces[0]!)}  (npx playwright show-trace)`);
		}
		if (match.length === 0) printText("-- no artifact dir matched");
	}

	if (existsSync(blog)) {
		const pat = new RegExp(cfg.pm.backend_error);
		const hits = readFileSync(blog, "utf8").split(/\n/).map(l => l.replace(/\s+$/, "")).filter(l => pat.test(l));
		printText(`\n== backend log ${blog}: ${hits.length} error lines (last ${n})`);
		printText(hits.slice(-n).map(l => `  ${l.slice(0, 220)}`).join("\n"));
	}
	return 0;
}
