# Owner page: research and design spec

The design behind src/core/owner-ui.ts (plan 20261025_0100_owner_ui_redesign).

## Research (2026-10-25)
- **Approval card anatomy** (https://www.assistant-ui.com/elements/approval-card):
  - header: icon tile, title, subtitle;
  - a short description of what happens;
  - label/value details;
  - action buttons named for the action ("Delete conversations", never "Submit");
  - after a decision, the footer becomes a status receipt.
- **Agentic UX patterns** (https://zylos.ai/research/2026-05-28-agentic-ux-frontend-design-patterns-ai-agents):
  - asks that carry their context (what was done, what this decides, what comes next) get faster, better decisions than a bare approve/deny;
  - progressive disclosure: summary first, details on tap;
  - errors as what / why / next;
  - simple status signals beat numbers.
- **LangChain Agent Inbox** (https://github.com/langchain-ai/agent-inbox): an inbox of interrupts, each with a title, an explaining description, and accept / respond / ignore.
- **Dashboard practice** (OpenObserve, Pixxen, Pencil & Paper):
  - one page = one decision;
  - a glance layer of at most 3–7 signals;
  - never repeat the same item in a strip, an alert and a card.

## Subject
One person's AI-agent workshop, read one-handed on an Android phone. The page has one job: show what needs him, in plain words, answerable in one tap.

## Layout, top to bottom
1. **Status strip** (one line, sticky at the top).
   - Left: the "needs you" count as a large amber number; tapping it scrolls to the cards. When the count is zero it reads "All clear", in teal.
   - Right: three small signals, e.g. "2 working · CI ok · disk 50 GB". A signal turns red only when something is bad: disk below the minimum, load over the max, or an open incident.
2. **Needs you**: one card per waiting plan.
   - Eyebrow: repo label · "waiting 3 h".
   - Title: the plan's `# ` heading.
   - Body: "What I need from you", then the WAITING line.
   - "Background": a closed `<details>` holding the Goal bullets.
   - Actions: "Yes, go ahead" (primary), "No", and "Reply…" (opens a textarea and a "Send reply" button).
   - After sending, a receipt: "Sent to Main · HH:MM".
   - Empty state: "Nothing needs you right now".
3. **Working now**: one row per running or waiting agent.
   - Each row: status dot, name, short model, what it is doing (statusDetail), minutes running.
   - Empty state: "No agents running".
4. **Closed `<details>` blocks**, each with a count chip in its summary:
   - Queue, grouped by repo, titles not file names;
   - Merges: MR · pipelines · time;
   - Incidents;
   - Agent scores, as a real `<table>`;
   - Machine.
5. **Bottom bar** (sticky).
   - Lock state: "Locked" or "Unlocked · 12 min left".
   - Buttons: "Unlock 15 min", "Unlock 30 min", "Lock now".
   - When guards.chat_unlock is off, the bar says so in plain words and shows the line `guards: chat_unlock: true`.

## Palette
CSS variables, switched between light and dark with prefers-color-scheme.

| Variable | Light | Dark |
|---|---|---|
| ink | #1C2430 | #E6EAF0 |
| page | #EEF1F5 | #10141A |
| card | #FFFFFF | #1A2029 |
| line | #D5DBE3 | #2A323D |
| muted | #5E6A7A | #94A0B0 |
| amber ("needs you") | #D98E04 | #D98E04 |
| teal ("fine / working") | #0F8A8A | #0F8A8A |
| red ("broken") | #C8382F | #C8382F |

Colour carries meaning only: amber = needs you, teal = fine, red = broken. No decorative colour.

## Type
- Body: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`, 17px, line-height 1.45.
- Titles: 20px, weight 650.
- The needs-you number: 34px, weight 800, tabular figures.
- Numbers and IDs only: `ui-monospace, "SF Mono", "Roboto Mono", monospace`, 14px.

## Shape
- Cards: 14px radius, 1px line border, no heavy shadows.
- Tap targets at least 48px tall.
- Side padding 16px.
- One column, max-width 36rem.

## Signature element
The amber needs-you number in the strip. It is the one bold thing; everything else stays quiet.

## Copy rules
- Sentence case.
- Name things by what the owner controls ("Unlock 15 min", "Send reply").
- Empty states say what is true.
- No file names on the first screen; they appear only inside Background or the details blocks.

## Accessibility
- Visible focus ring.
- No animation, so prefers-reduced-motion is respected by default.
- Contrast AA in both themes.
