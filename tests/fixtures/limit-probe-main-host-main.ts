// The adapter side of the compiled stand-in harness, loaded from disk by the tiny compiled
// loader (limit-probe-main-host.ts): it loads the real omp adapter and fires one main
// session_start, then stays up until the test kills it.
import { createOmpAdapter, type ExtensionHost } from "../../src/adapters/omp/index.ts";
import { loadConfig } from "../../src/core/config.ts";

const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
const host: ExtensionHost = {
	on(event, cb) {
		handlers.set(event, [...(handlers.get(event) ?? []), cb]);
	},
	registerCommand() {},
	sendUserMessage() {},
	sendMessage() {},
};
createOmpAdapter(host, loadConfig());
const ctx = { agent: { kind: "main", id: process.env.NEURASTREAM_MAIN_ID ?? "main" } };
Promise.all((handlers.get("session_start") ?? []).map(cb => cb({}, ctx)))
	.then(() => console.log(`main-host ready ${ctx.agent.id}`))
	.catch(err => {
		console.error(`main-host failed: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(2);
	});
setInterval(() => {}, 60_000);
