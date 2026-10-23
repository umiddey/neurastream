import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The installed copy this plugin comes from, and the package.json whose version decides staleness.
// omp never reloads a plugin, so the version is read once at adapter start (the code actually
// running) and re-read at every rollover check; a different or unreadable version means the running
// plugin is stale. NEURASTREAM_PACKAGE_JSON overrides the path (tests and the sandbox smoke point it
// at a copy whose version changes mid-run), like QUEUE_CLOSE_BIN.

/** The package root: this file is src/adapters/omp/package-root.ts. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The package.json whose version is compared: NEURASTREAM_PACKAGE_JSON, else the package on disk. */
export function packageJsonPath(): string {
	return process.env.NEURASTREAM_PACKAGE_JSON ?? join(PACKAGE_ROOT, "package.json");
}

/** The version in a package.json, or null when it cannot be read or has no string version. */
export function packageVersion(packageJson: string): string | null {
	try {
		const version = (JSON.parse(readFileSync(packageJson, "utf8")) as { version?: unknown } | null)?.version;
		return typeof version === "string" ? version : null;
	} catch {
		return null;
	}
}
