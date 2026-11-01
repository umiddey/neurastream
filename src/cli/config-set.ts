// `neurastream config set|get|list <key> [value]` (plan 20261028_2356 P1b): the non-interactive door
// to the generic config editor (src/core/config-edit.ts). Keys are the leaf paths of
// templates/config.yml, so a typo is refused and never written. A set writes through the same
// line-based editor and is refused, with the file untouched, when the result would not load.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { checkEdited, leafKeys, setConfigKeys, valueAt, yamlValue } from "../core/config-edit.ts";
import { TEMPLATE_PATH, configFile, loadConfig } from "../core/config.ts";

const VALID_KEYS = leafKeys(Bun.YAML.parse(readFileSync(TEMPLATE_PATH, "utf8")));

export function runConfigKeys(args: string[], home: string = homedir()): number {
	const [verb, key, raw] = args;
	try {
		if (verb === "list") {
			const cfg = loadConfig({ home });
			for (const k of VALID_KEYS) {
				const v = valueAt(cfg, k);
				console.log(`${k} = ${Array.isArray(v) ? JSON.stringify(v) : String(v)}`);
			}
			return 0;
		}
		if (key === undefined || !VALID_KEYS.includes(key)) {
			console.error(`neurastream config ${verb ?? ""}: unknown key ${key ?? "(none)"}; valid keys: ${VALID_KEYS.join(", ")}`);
			return 1;
		}
		if (verb === "get") {
			const v = valueAt(loadConfig({ home }), key);
			console.log(Array.isArray(v) ? JSON.stringify(v) : String(v));
			return 0;
		}
		if (verb !== "set") {
			console.error("usage: neurastream config set|get|list [key] [value]");
			return 1;
		}
		const parsed: unknown = raw === undefined ? null : Bun.YAML.parse(raw);
		if (parsed === null || parsed === undefined || (typeof parsed === "object" && !Array.isArray(parsed))) {
			console.error(`neurastream config set ${key}: give a scalar or a list (e.g. 7788, true, '["a", "b"]')`);
			return 1;
		}
		// Lists in flow style on one line ([a, b]); scalars as JSON, which is valid YAML.
		const text = yamlValue(parsed);
		const file = configFile(home);
		const original = existsSync(file) ? readFileSync(file, "utf8") : null;
		const edited = setConfigKeys(original, { [key]: text });
		if (!checkEdited(edited, home, (line) => console.error(line))) return 1;
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, edited);
		return 0;
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 1;
	}
}
