import { expect, test } from "bun:test";
import { parsePlan, splitWaiting } from "../src/core/queue/lib";

const CHECK = " — still true if: ";

test("a one-part WAITING line is ask only; blocked, why and check are null", () => {
	expect(splitWaiting("ship the patch")).toEqual({ ask: "ship the patch", blocked: null, why: null, check: null });
});

test("a two-part line keeps the old ask and why split", () => {
	expect(splitWaiting("ship the patch — why you: Main cannot tag")).toEqual({
		ask: "ship the patch",
		blocked: null,
		why: "Main cannot tag",
		check: null,
	});
});

test("a three-part line keeps the old ask, blocked and why split", () => {
	expect(splitWaiting("ship the patch — blocked: the release stays dark — why you: Main cannot tag")).toEqual({
		ask: "ship the patch",
		blocked: "the release stays dark",
		why: "Main cannot tag",
		check: null,
	});
});

test("the check part is parsed in any position", () => {
	const last = splitWaiting(`ship the patch${CHECK}\`gateforge obligations --blocking\``);
	expect(last.ask).toBe("ship the patch");
	expect(last.check).toBe("gateforge obligations --blocking");
	expect(last.blocked).toBeNull();
	expect(last.why).toBeNull();

	const middle = splitWaiting(`ship the patch${CHECK}\`bun test\` — blocked: the release stays dark — why you: Main cannot tag`);
	expect(middle).toEqual({ ask: "ship the patch", blocked: "the release stays dark", why: "Main cannot tag", check: "bun test" });

	const first = splitWaiting(`ship the patch${CHECK}\`bun test\` — why you: Main cannot tag`);
	expect(first).toEqual({ ask: "ship the patch", blocked: null, why: "Main cannot tag", check: "bun test" });
});

test("a check part without backticks is null, and the ask stops before it", () => {
	const s = splitWaiting(`ship the patch${CHECK}bun test`);
	expect(s.check).toBeNull();
	expect(s.ask).toBe("ship the patch");
});

test("parsePlan carries the check as waitingCheck, and null when the line has none", () => {
	const withCheck = parsePlan("/repo", "a.md", `## Progress\nStatus: open\nWAITING on owner: ship it${CHECK}\`git log --oneline -1\`\n`);
	expect(withCheck.waitingCheck).toBe("git log --oneline -1");
	const without = parsePlan("/repo", "b.md", "## Progress\nStatus: open\nWAITING on owner: ship it\n");
	expect(without.waitingCheck).toBeNull();
	const none = parsePlan("/repo", "c.md", "## Progress\nStatus: open\n");
	expect(none.waitingCheck).toBeNull();
});
