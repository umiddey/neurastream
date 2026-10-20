# Changelog

## 0.1.2
### Added
- `agent-score validate <Agent> --plan <plan.md> --phase <P> --evidence <report.md> --section "<heading prefix>" [--weight N] [--rework] [--note T]`: score a validation phase (checks/tests ran, report section written, no commits). Records one `type: "validate"` jsonl line only when every guard holds: the plan's phase line is ticked `- [x]` (weight from its `difficulty: N`; `--weight` overrides), the evidence file has a heading starting with `--section` where the prefix ends at end-of-line, space or `(` (`## CP` matches `## CP (P5, ...)`, not `## CPX`) and its body to the next same-or-higher heading is non-blank, the body cites verbatim at least one `paths.heavy_log` `END   <Agent> | <label> | exit <n>` label run by that agent (the cited labels are recorded), and no earlier `accept`/`validate` covers the same agent+plan+phase. Any failed guard exits 1 with the reason and records nothing.
- Ranking board: column `Accepted (diag)` is now `Accepted (diag/val)`, cells `N (d/v)`; `validate` adds points and first-pass counts like `accept` (unless `--rework`).
