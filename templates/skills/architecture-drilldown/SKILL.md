---
name: architecture-drilldown
description: Build a self-contained, click-to-drill architecture diagram (one HTML file) from a template. Use when the user wants an interactive system map with boxes that open into their parts.
---

# architecture-drilldown

Make one HTML file that shows a system as boxes. Tap a box to open its inside; the root is the whole system, each level is one part of the level above.

## Start

1. Copy `template.html` (this folder) to the target, e.g. `architecture.html`. Keep the file self-contained: no CDN, no build step.
2. Edit only the block between `/* === DATA === */` and `/* === END DATA === */`. Everything below `END DATA` is the engine: leave it as it is.
3. Open the file in a browser and check the root and one drilled level (see Verify).

## Data schema

The root is `const T={...}`. Each box is an object:

| Field | Meaning |
|---|---|
| `id` | Unique string. Used in `flows` and in the URL hash. |
| `nm` | Name shown on the box. |
| `role` | Short subtitle, one line. |
| `st` | `"built"`, `"almost"` or `"plan"`. Drives the box style. |
| `at` | `[col,row]` cell in this level's desktop grid. |
| `atM` | `[col,row]` cell on the phone grid (root and any level with `gm`). |
| `c` | Colour (CSS hex). Children inherit it. |
| `kind` | `"actor"` = outside party (grey pill, not clickable). |
| `g` | `[cols,rows]` desktop grid of this level. |
| `gm` | `[cols,rows]` phone grid of this level. Without `gm` the desktop grid is transposed on the phone when it has more than 2 columns. |
| `flows` | `[from, to, label]` arrows between boxes of this level. Labels: 3 words max. |
| `kids` | Boxes one level down. A box with `kids` shows "open ›". |
| `what`, `files`, `ex` | Sheet text on a leaf: what it does, source files, one example. |
| `steps` | Root only: numbered list in the sheet. |

## Style rules

- Max 4 columns on the desktop grid, 2 on the phone grid.
- Keep each level to 3-6 boxes. If a level needs more, split it into a child level.
- Every arrow connects neighbours on the grid. An arrow that passes through a box is a layout bug: move the box or add a middle step.
- Actors are the outside world (users, third-party services). Do not give them `kids`.
- Use one colour per top-level area; reuse it for that area's children.
- Labels say what moves, not how it is built.

## Verify

Open the file at two widths and check the root plus one drilled level:

- Desktop 1280 px: boxes and arrows sit in their grid cells, no arrow crosses a box, the sheet opens on tap and closes on `×`.
- Phone 390 px: the phone grid (`gm`/`atM`) is used, boxes stay readable, no horizontal scroll.
- Console: no JS errors on load, on drill-down, or on going back.

## Host

Build the HTML in a scratch directory (`mktemp -d`), not in a repo. Publish it with `neurastream pages publish <file>`. A plan page (`--plan`) is refused unless it is this template with only DATA edited. The page is deleted after 15 days. Add `--keep` only when the owner's prompt says to keep it permanently. Never commit the HTML into a repo unless the owner asks.
