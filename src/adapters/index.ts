// The one door from src/cli to a harness (plan 20261026_0010 P2). Every adapter import in the
// CLI goes through this file, and tests/host-neutral.test.ts holds that line. Adding a harness
// is one folder under src/adapters plus one entry in ADAPTERS below — zero core changes
// (docs/adapter.md, "Adding a harness").

import type { DumpRef, LaunchOptions, RelatedTrace, RunSource, TaskResult, TraceRun, TraceSource } from "../core/adapter.ts";
import type { Config } from "../core/config.ts";
import type { DumpParts, DumpTokens } from "../core/trace-bloat.ts";
import type { SpawnBrief } from "../core/trace-briefs.ts";
import { ompAdapter } from "./omp/adapter.ts";

export interface HarnessAdapter {
	name: string;
	/** Session reader: the runs and the main session (docs/adapter.md). */
	runSource(cfg: Config): RunSource;
	/** Completed subagent task-results announced in the newest main session file. */
	completedResults(cfg: Config): TaskResult[];
	/** TraceSource for agent-score, over the config's sessions root. */
	scoreTraces(cfg: Config): TraceSource;
	/** Every run id with a trace under the root, each mapped to its newest file. */
	traceRuns(root: string): TraceRun[];
	traceSource(root: string): TraceSource;
	/** Read only the session banner at the start of a trace; null means it is unreadable. */
	traceStart(file: string): number | null;
	/** Every failed-request dump under the harness log dir, oldest first. */
	dumps(home: string): DumpRef[];
	/** Model requested by a failed request dump, if the JSON contains one. */
	dumpModel(file: string): string | undefined;
	/** What a dumped request's prompt is made of (src/core/trace-bloat.ts). */
	dumpParts(file: string): DumpParts;
	/** The prompt tokens a dump states itself, when it does. */
	dumpPromptTokens(file: string): DumpTokens | null;
	/** The spawn briefs in one session file. */
	spawnBriefsIn(file: string, runId: string): SpawnBrief[];
	/** The subagent runs of one main run. */
	subagentTraces(root: string, mainRunId: string): RelatedTrace[];
	launchMain(args: string[], cfg: Config, opts?: LaunchOptions): Promise<number>;
	/** `neurastream adapter install <name>` — validates its own args. */
	install(args: string[]): number;
	/** `neurastream doctor`. */
	doctor(): number;
}

const ADAPTERS: Record<string, HarnessAdapter> = {
	[ompAdapter.name]: ompAdapter,
};

/** The adapter the config names (`harness:`; without a config, the shipped default). An unknown
 *  name throws, so a typo fails loudly instead of silently reading another harness's files. */
export function getAdapter(cfg?: Pick<Config, "harness">): HarnessAdapter {
	const name = cfg?.harness ?? "omp";
	const adapter = ADAPTERS[name];
	if (!adapter) throw new Error(`unknown harness "${name}"; known: ${Object.keys(ADAPTERS).join(", ")}`);
	return adapter;
}
