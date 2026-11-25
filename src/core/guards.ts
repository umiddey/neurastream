// Guard rules barrel: re-exports the decomposed modules under src/core/guards/.
// `guards/state.ts` MUST be exported first (zero imports from team-client.ts or sibling guards/*)
// so cyclic imports via `team-client.ts` (`mainId`) and `blockers.ts` (`MAIN_PLAN_FILE`) are TDZ-safe.

export * from "./guards/state.ts";
export * from "./guards/review.ts";
export * from "./guards/planner.ts";
export * from "./guards/spawn.ts";
export * from "./guards/tool.ts";
export * from "./guards/plan-edit.ts";
export * from "./guards/stop.ts";
export { reviewHash } from "./plan-approval.ts";
