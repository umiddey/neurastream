// The shipped adapter's HarnessAdapter implementation: thin wiring over this folder's readers,
// launcher, installer and doctor. Only src/adapters may name the harness.

import type { HarnessAdapter } from "../index.ts";
import { runDoctor } from "./doctor.ts";
import { runAdapterInstall } from "./install.ts";
import { runMainLauncher } from "./launch.ts";
import { defaultCompletedResults, defaultRunSource } from "./sessions.ts";
import { dumpModel, dumpParts, dumpPromptTokens, ompDumps, ompScoreTraces, ompTraceRuns, ompTraceSource, ompTraceStart, spawnBriefsIn, subagentTraces } from "./traces.ts";

export const ompAdapter: HarnessAdapter = {
	name: "omp",
	runSource: defaultRunSource,
	completedResults: defaultCompletedResults,
	scoreTraces: ompScoreTraces,
	traceRuns: ompTraceRuns,
	traceSource: ompTraceSource,
	traceStart: ompTraceStart,
	dumps: ompDumps,
	dumpModel,
	dumpParts,
	dumpPromptTokens,
	spawnBriefsIn,
	subagentTraces,
	launchMain: runMainLauncher,
	install: runAdapterInstall,
	doctor: runDoctor,
};
