// Harness glue. Event subscriptions land with the guard port.
// This file is the only place that may name the harness.

import type { Decision } from "../../core/adapter.ts";

export interface ExtensionHost {
	on(event: string, cb: (...args: unknown[]) => unknown): void;
}

/** package.json omp.extensions entry. No hooks until guard functions exist. */
export default function ompExtension(_pi: ExtensionHost): void {}

/** Map a core decision onto the extension return shapes. */
export function toExtensionResult(d: Decision): Record<string, unknown> {
	if (!d.allow) return { block: true, reason: d.reason, decision: "block" };
	if (d.inject) return { additionalContext: d.inject };
	return {};
}
