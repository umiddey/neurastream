// `neurastream notes check <page>` (plan 20261026_0930 P8): every note the owner submitted on a
// published page must get an answer in Main's answer file. Exit 1 lists the ids still open, and
// `pages publish` refuses the next version of that page while any id is open.
import { ConfigError, loadConfig } from "../core/config.ts";
import { notesAnswersPath, openNoteIds, readAnswers, readNotes } from "../core/page-notes.ts";

export interface NotesDeps { home?: string }

export function runNotes(args: string[] = [], deps: NotesDeps = {}): number {
	const [sub, page] = args;
	if (sub !== "check" || page === undefined || args.length !== 2) {
		console.error("usage: neurastream notes check <page>");
		return 2;
	}
	let cfg;
	try {
		cfg = loadConfig({ home: deps.home });
	} catch (err) {
		console.error(err instanceof ConfigError ? err.message : String(err));
		return 1;
	}
	const notes = readNotes(cfg, page);
	const answers = readAnswers(cfg, page);
	const open = openNoteIds(cfg, page);
	for (const note of notes) {
		const answer = answers[note.id];
		const quote = note.quote === "" ? "" : ` "${note.quote.slice(0, 80)}"`;
		console.log(`${note.id}${quote}: ${note.note.slice(0, 200)}${answer === undefined ? "" : `\n    answer: ${answer.slice(0, 200)}`}`);
	}
	if (open.length > 0) {
		console.error(`notes: ${open.length} unanswered on ${page} (${open.join(", ")}) — write them in ${notesAnswersPath(cfg, page)}`);
		return 1;
	}
	console.log(`notes: all ${notes.length} answered on ${page}`);
	return 0;
}
