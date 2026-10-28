// Shared fixture plan for the plan-review gate tests (I-20261028-137): one builder so a plan
// template change updates every gate test file in one place. `reuse` is the whole `## Reuse`
// section (or "" for none), matching what the P1 validator accepts.

export interface FixturePlanOpts {
	branch?: string;
	blocker?: string;
	goal?: string;
	reuse?: string;
}

export function fixturePlan({
	branch = "feat/toy",
	blocker = "ok.sh",
	goal = "- Reuse-line toy.",
	reuse = "## Reuse\n- new: none — checked: src/a.ts:1 — reuse: the existing helper\n\n",
}: FixturePlanOpts = {}): string {
	return `# Toy plan

Worktree: -
Branch: ${branch}

## Goal
${goal}

## Forbidden
- Never skip tests.

## Blockers
- ${blocker}

## Phases
- [ ] P1 do the thing — verify: \`test -f src/a.ts\`

## Code read by Main
- \`src/a.ts\`

${reuse}## Done check
\`test -f src/a.ts\`

## Progress
Status: open

- Started.
`;
}
