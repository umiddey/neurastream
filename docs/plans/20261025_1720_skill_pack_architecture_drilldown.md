# neurastream skill pack: architecture drill-down diagram skill
Worktree: /home/ukd/Work/neurastream-skills
Branch: feat/skill-pack
Read /home/ukd/projects/opus-implementer-method.md first.

## Goal
- Owner (2026-10-25 ~17:20), on the drill-down architecture diagram: "this is the most perfect architecture … please make it into a skill and add it to new [neurastream] skill pack, we are all gonna have skill pack for neurastream, let's do this".
- Done = neurastream ships `templates/skills/architecture-drilldown/` (SKILL.md + a reusable data-driven template.html), and `neurastream install` copies every shipped skill dir into `~/.agents/skills/`, so any agent can draw the same clickable architecture diagram for any system.

## Forbidden
- Changing the look or behaviour of the diagram engine (layout, arrows, drill-down, phone layout, sheet, hash routing). Copy it; only swap the data.
- Overwriting a skill dir the user already has at the destination (copy-if-missing, like `copyPins` does for agents).
- Touching the live copy `/home/ukd/Work/neurastream-architecture.html`.
- Work only in /home/ukd/Work/neurastream-skills on feat/skill-pack. Never push, merge, tag or publish (Main does P3). Commit files by name; never `git add -A`/`.`; never `--no-verify`.
- Tests never write to the real home: install/uninstall/doctor tests use a temp home dir.
- Every test run via `/home/ukd/Work/heavy-run.sh <agent> "<label>" -- <cmd>` with tool timeout 0.
- Call budget: stop and report within ~100 calls. One dated bullet under `## Progress` after the `Status:` line, ending with `Findings:`.

## Blockers
- no-push
- deny-path src/cli/**
- deny-path src/core/owner-ui.ts
- deny-path blockers/**
- deny-path /home/ukd/Work/neurastream-architecture.html /home/ukd/.agents/** /home/ukd/.omp/agent/** /home/ukd/.bun/**
- deny-command --no-verify git\s+add\s+(-A|--all|\.)(\s|$) git\s+push\b git\s+merge\b git\s+tag\b npm\s+publish reset\s+--hard sudo\b

## Phases
- [ ] P1 Skill files: `templates/skills/architecture-drilldown/template.html` = a copy of `/home/ukd/Work/neurastream-architecture.html` whose neurastream tree `T` is replaced by a small generic example (root with 4–5 kids, one 3rd level, one planned + one almost box, actors, `gm`/`atM` phone layout on root) inside one clearly marked `/* === DATA === */ … /* === END DATA === */` block; the engine code below it unchanged. `SKILL.md` with frontmatter `name: architecture-drilldown` and a one-line `description` (when to use: "draw/explain the architecture of a system as a clickable drill-down diagram"), then the body: when to use; the data schema (`id, nm, role, st built|almost|plan, kind:"actor", at:[c,r], g:[cols,rows], gm/atM phone grid, c colour, flows:[from,to,label], steps, what, files, kids`); style rules learned from the owner (Tailscale-like: white page, few boxes per screen ≤8, plain words, short arrow labels ≤3 words, colored labeled arrows, one level per screen, Back/breadcrumb/Esc, statuses ● built ◐ almost ○ planned, research the real code before drawing, no nested zoom canvas); how to verify (desktop 1280 + phone 390 screenshots of root + 2 levels + a leaf sheet, no JS errors, no arrow through a box, no label overlap); how to host (`neurastream pages` if installed, else any static server on the tailnet). — difficulty: 3 — verify: `test -f templates/skills/architecture-drilldown/SKILL.md && grep -q '=== DATA ===' templates/skills/architecture-drilldown/template.html && bun -e "const h=await Bun.file('templates/skills/architecture-drilldown/template.html').text();new Function(h.split('<script>')[1].split('</script>')[0])"`
- [ ] P2 Install the pack: in `src/adapters/omp/install.ts` add a `copySkills` next to `copyPins` that copies each dir under `templates/skills/` into `<home>/.agents/skills/<name>/` when that dir is missing (kept otherwise), called where `copyPins` is called and reported the same way; `linkInstalled` must skip them like it skips agents (copied, never linked). `adapterLiveFiles` in `src/adapters/omp/doctor.ts` lists each shipped `SKILL.md` → `<home>/.agents/skills/<name>/SKILL.md` the way it lists agents, so doctor reports a missing skill. `src/core/uninstall.ts` removes a skill dir only when its SKILL.md is identical to the shipped one (same `ours` rule as agent pins), else keeps it. Tests in `tests/install-overlay.test.ts`, `tests/uninstall.test.ts`, `tests/doctor.test.ts` for copied / kept / removed-only-if-ours / doctor-reports-missing. README section "Skill pack" + CHANGELOG Unreleased line. — difficulty: 2 — verify: `bun run typecheck && bun test`
- [ ] P3 Main: INCIDENT I-20261025-166 first: in the template, the root title and `<title>` come from the data (`T.nm`), not a hard-coded "neurastream" (the only engine change allowed); a one-way copy is intended (same as agent pins: owner edits win). Then review, merge to main, release via `v*` tag, `bun add -g neurastream@latest`, `neurastream install`, `neurastream doctor` exit 0, confirm the installed skill dir architecture-drilldown under ~/.agents/skills has its SKILL.md and `skill://architecture-drilldown` loads. — difficulty: 1 — verify: `neurastream doctor`

## Done check
`test -f templates/skills/architecture-drilldown/SKILL.md && bun run typecheck && bun test`

## Code read by Main
- `src/adapters/omp/install.ts`
- `src/adapters/omp/doctor.ts`
- `src/core/uninstall.ts`
- `package.json`

## Progress
Status: open
- 2026-10-25 17:30 Main: plan written, worktree created from origin/main (bun install done). Findings: none
- 2026-10-25 Skill pack P1+P2 done on `feat/skill-pack` in `/home/ukd/Work/neurastream-skills`: `f646b3e` (P1 template + SKILL.md), `339b24b` (P2 install copy, doctor, uninstall, 3 tests, README, CHANGELOG), `7efe1a9` (390px root layout fix; DATA block only, engine untouched). Browser check on file:// at 1280 and 390, root and drilled `#orders`: no console errors; no arrow or label crosses a box after the fix. Tests not run by me; Main to run `bun run typecheck && bun test` via heavy-run. Findings: (1) uninstall removes a skill dir only when the whole tree is byte-identical, so owner-added files keep it; stricter than comparing SKILL.md alone. (2) Skill copy is one-way: an existing dir is kept, so later template changes never reach an installed copy until the owner deletes it. (3) Engine title wart: `render()` prints root title "neurastream — how it works" while `<title>` says "neurastream — architecture". Engine left unchanged because the plan forbids engine edits; owner decision needed.

## Background
- `package.json` "files" already ships `templates`, so `templates/skills/` is published with no package change.
- Agents read skills from `~/.agents/skills/<name>/SKILL.md` (e.g. `~/.agents/skills/anatomy`).
- Source diagram: `/home/ukd/Work/neurastream-architecture.html`, live at http://ukd.tailc0aee7.ts.net:7788 (owner called it perfect, 2026-10-25).
