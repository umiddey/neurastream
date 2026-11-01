import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { checkEdited, setConfigKeys, yamlValue } from "../core/config-edit.ts";
import { configFile, loadConfig } from "../core/config.ts";

export function runWip(args: string[], home: string = homedir()): number {
	const verb = args[0];
	if (!verb || verb === "--help" || verb === "-h") {
		console.log("usage: neurastream wip add|remove|list [path]");
		return 0;
	}

	if (verb === "list") {
		const file = configFile(home);
		if (existsSync(file)) {
			try {
				const parsed = Bun.YAML.parse(readFileSync(file, "utf8")) as { wip?: { roots?: unknown } } | null;
				if (Array.isArray(parsed?.wip?.roots)) {
					for (const r of parsed.wip.roots) console.log(String(r));
					return 0;
				}
			} catch {}
		}
		const cfg = loadConfig({ home });
		for (const r of cfg.wip.roots) console.log(r);
		return 0;
	}

	if (verb !== "add" && verb !== "remove") {
		console.error("usage: neurastream wip add|remove|list [path]");
		return 2;
	}

	const target = args[1];
	if (!target) {
		console.error("usage: neurastream wip add|remove|list [path]");
		return 2;
	}

	const file = configFile(home);
	const original = existsSync(file) ? readFileSync(file, "utf8") : null;
	let currentRoots: string[] = [];
	if (original) {
		try {
			const parsed = Bun.YAML.parse(original) as { wip?: { roots?: unknown } } | null;
			if (Array.isArray(parsed?.wip?.roots)) {
				currentRoots = parsed.wip.roots.map((r: unknown) => String(r));
			} else {
				currentRoots = [...loadConfig({ home }).wip.roots];
			}
		} catch {
			currentRoots = [...loadConfig({ home }).wip.roots];
		}
	}

	if (verb === "add") {
		if (!currentRoots.includes(target)) currentRoots.push(target);
	} else {
		currentRoots = currentRoots.filter((r) => r !== target);
	}

	const text = yamlValue(currentRoots);
	const edited = setConfigKeys(original, { "wip.roots": text });
	if (!checkEdited(edited, home, (line) => console.error(line))) return 1;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, edited);
	return 0;
}
