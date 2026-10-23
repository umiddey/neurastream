// Heredoc bodies are data, not shell commands: writeTargets must not read the
// text of a `<<WORD` body as redirects or as command words (incident
// I-20261023-13, where prose inside `python3 - <<'EOF'` bodies was resolved as
// write targets such as `/home/ukd/projects/,`). A redirect target made only of
// punctuation is not a write target either. Real writes keep their targets.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { writeTargets } from "../src/core/queue/lib.ts";

const CWD = "/tmp/neurastream-home-heredoc/projects";

function targets(command: string): string[] {
	return writeTargets("bash", { command }, CWD);
}

test("a python heredoc whose prose holds <a>.<b> and `x > , y` writes nothing", () => {
	const command = [
		"python3 - <<'EOF'",
		"Token format: `<exp_unix>.<hmac(job_id|exp)>` and the rule x > , y applies.",
		"Print the summary when done.",
		"EOF",
	].join("\n");
	expect(targets(command)).toEqual([]);
});

test("a redirect inside a heredoc body is not a write; the heredoc's own redirect is", () => {
	const command = ["cat <<EOF > out.txt", "hello > world.txt", "EOF"].join("\n");
	expect(targets(command)).toEqual([join(CWD, "out.txt")]);
});

test("a command word inside a heredoc body is not a write target", () => {
	const command = ["cat <<EOF > plan.md", "rm old-notes.txt", "EOF"].join("\n");
	expect(targets(command)).toEqual([join(CWD, "plan.md")]);
});

test("quoted, tab-stripped and bare heredoc forms all end at their terminator", () => {
	expect(targets(['cat <<"A" > a.txt', "q > b.txt", "A"].join("\n"))).toEqual([join(CWD, "a.txt")]);
	expect(targets(["cat <<-B > c.txt", "\tq > d.txt", "\tB"].join("\n"))).toEqual([join(CWD, "c.txt")]);
	expect(targets(["cat <<C > e.txt", "q > f.txt", "C"].join("\n"))).toEqual([join(CWD, "e.txt")]);
});

test("a punctuation-only redirect target is not a write target", () => {
	expect(targets("echo a >,")).toEqual([]);
	expect(targets("echo a > , b")).toEqual([]);
});

test("real writes keep their targets", () => {
	expect(targets("echo y > uv.lock")).toEqual([join(CWD, "uv.lock")]);
	expect(targets("cat > src/x.ts <<EOF\nbody\nEOF")).toEqual([join(CWD, "src/x.ts")]);
	expect(targets("sed -i 's/a/b/' f.ts")).toEqual([join(CWD, "f.ts")]);
	expect(targets("rm f.txt")).toEqual([join(CWD, "f.txt")]);
	expect(targets("echo x | tee f.log")).toEqual([join(CWD, "f.log")]);
	expect(targets(`python3 -c 'open("f.ts","w")'`)).toEqual([join(CWD, "f.ts")]);
});

test("a python heredoc that really opens a file for writing still counts", () => {
	expect(targets(["python3 - <<'EOF'", 'open("g.py", "w").write("x")', "EOF"].join("\n"))).toEqual([
		join(CWD, "g.py"),
	]);
});
