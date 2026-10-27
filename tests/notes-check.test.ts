// Notes must get answers (plan 20261026_0930 P8): `notes check <page>` exits 1 while any submitted
// note id has no answer, `pages publish` refuses the page until then, and a publish that goes
// through shows each answer by its note and closes the old ones.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/core/config.ts";
import { appendPageNotes, notesAnswersPath, pageNotesGate, readNotes } from "../src/core/page-notes.ts";
import { publishPage } from "../src/core/pages-setup.ts";
import { runNotes } from "../src/cli/notes.ts";

afterEach(() => {
	delete process.env.QUEUE_STATE;
});

function setup(): { dir: string; cfg: Config } {
	const dir = mkdtempSync(join(tmpdir(), "notes-check-"));
	process.env.QUEUE_STATE = dir;
	const cfg = loadConfig({ file: join(dir, "missing.yml"), home: dir, env: {} });
	cfg.paths.queue_state = dir;
	return { dir, cfg };
}

test("notes check: exit 1 names each unanswered id, exit 0 once the answer file carries them", () => {
	const { dir, cfg } = setup();
	appendPageNotes({ page: "/why.html", notes: [{ quote: "too slow", note: "fix the timing" }, { quote: "b", note: "second" }] }, cfg, "owner-login");
	expect(runNotes(["check", "why.html"], { home: dir })).toBe(1);
	writeFileSync(notesAnswersPath(cfg, "why.html"), JSON.stringify({ n1: "raised the timeout" }));
	expect(runNotes(["check", "why.html"], { home: dir })).toBe(1); // n2 is still open
	writeFileSync(notesAnswersPath(cfg, "why.html"), JSON.stringify({ n1: "raised the timeout", n2: "yes" }));
	expect(runNotes(["check", "why.html"], { home: dir })).toBe(0);
	expect(runNotes(["check"], { home: dir })).toBe(2); // usage, not a silent pass
});

test("publish: refused while a note is open, then the answer is on the page and the notes close", () => {
	const { dir, cfg } = setup();
	const src = join(dir, "source.html");
	writeFileSync(src, "<html><body><p>why</p></body></html>");
	appendPageNotes({ page: "/why.html", notes: [{ quote: "too slow", note: "timing?" }] }, cfg, "owner-login");
	const out = join(dir, "public");
	expect(() => publishPage(src, "Why", false, out, false, 15, new Date(), pageNotesGate(cfg))).toThrow(/open note/);
	expect(existsSync(join(out, "why.html"))).toBe(false);
	writeFileSync(notesAnswersPath(cfg, "why.html"), JSON.stringify({ n1: "raised the timeout" }));
	expect(publishPage(src, "Why", false, out, false, 15, new Date(), pageNotesGate(cfg))).toBe("why.html");
	const html = readFileSync(join(out, "why.html"), "utf8");
	expect(html).toContain("timing?"); // the note it answers
	expect(html).toContain("raised the timeout"); // the answer, beside it
	expect(html).toContain('id="ns-answered"');
	expect(readNotes(cfg, "why.html")).toEqual([]); // published: the old notes count as answered
	expect(existsSync(notesAnswersPath(cfg, "why.html"))).toBe(false);
	expect(readdirSync(join(dir, "page-notes")).some(f => f.endsWith(".answered.jsonl"))).toBe(true);
	// The counter survives the archive: a later note is n2, never n1 again.
	appendPageNotes({ page: "/why.html", notes: [{ quote: "c", note: "again" }] }, cfg, "owner-login");
	expect(readNotes(cfg, "why.html").map(n => n.id)).toEqual(["n2"]);
	// A page with no notes publishes through the same gate.
	writeFileSync(join(dir, "plain.html"), "<html><body><p>plain</p></body></html>");
	expect(publishPage(join(dir, "plain.html"), "Plain", false, out, false, 15, new Date(), pageNotesGate(cfg))).toBe("plain.html");
	expect(readFileSync(join(out, "plain.html"), "utf8")).not.toContain('id="ns-answered"');
});
