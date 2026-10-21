// Adapter-owned package-operation shapes for the P8 guard parity: core's
// writeTargets never names a harness, so the plugin-command matcher lives here
// and registers itself into core at module load. Every plugin command writes
// under the plugin directory, which src/adapters/omp/install.ts lists in the
// config's guards.protected — so mapping the commands onto that directory puts
// them behind the owner's unlock like every other guard file.

import { homedir } from "node:os";
import { registerPackageOpTarget, type PackageOpMatcher } from "../../core/queue/lib.ts";

const PLUGIN_ACTIONS = ["install", "uninstall", "link", "unlink", "update"];

/** Target for `<harness> plugin <action>` segments; null when none matches. */
export const pluginCommandTarget: PackageOpMatcher = (code: string): string | null => {
	for (const seg of code.split(/&&|\|\||;|\n|\|/)) {
		const toks = seg.trim().split(/\s+/).filter(Boolean);
		let i = 0;
		while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i] ?? "")) i++;
		const cmd = (toks[i] ?? "").replace(/^["']|["']$/g, "").replace(/^.*\//, "");
		if (cmd !== "omp") continue;
		const sub = (toks[i + 1] ?? "").replace(/^["']+|["']+$/g, "");
		if (sub === "plugin" && PLUGIN_ACTIONS.includes((toks[i + 2] ?? "").replace(/^["']+|["']+$/g, "")))
			return `${homedir()}/.omp/plugins/`;
	}
	return null;
};

registerPackageOpTarget(pluginCommandTarget);
