// `neurastream setup` detection (plan 20261028_2356 P3): reads the machine and returns one typed
// object. Pure over injected seams (HOME as the fs root, a PATH lookup, the Tailscale seam, os
// facts): no prompts, no writes. realSeams wires the node fs/os, the given PATH and realTailscale.
// Core names no harness: the caller passes the harness binaries (the adapter registry lives in
// src/adapters, which core may not import).

import { existsSync, readdirSync, statfsSync, statSync } from "node:fs";
import { availableParallelism, homedir, totalmem } from "node:os";
import { join } from "node:path";
import { configFile, loadConfig, type Config } from "./config.ts";
import { PROXY_BIN } from "./secret-redact.ts";
import { realTailscale, type Tailscale, type TailscaleState } from "./tailscale.ts";

export interface HarnessBin {
	name: string;
	/** The binary name looked up on PATH. */
	bin: string;
}

export interface OsFacts {
	cores: number;
	ramMb: number;
	/** Free space on the filesystem holding HOME, in GB (1e9 bytes, as the machine guard counts). */
	diskFreeGb: number;
}

export interface SetupSeams {
	/** HOME: the fs root the config and the work roots resolve against. */
	home: string;
	onPath(bin: string): boolean;
	harnesses: HarnessBin[];
	tailscale: Tailscale;
	os: OsFacts;
}

export interface MachineProposal {
	load_over_cores: number;
	avail_min_mb: number;
	disk_min_gb: number;
}

export interface SetupFacts {
	/** Absolute paths of HOME's direct non-dot children that hold a git repo one level down, sorted. */
	workRoots: string[];
	/** Names of the harnesses whose binary is on PATH. */
	harnesses: string[];
	tailscale: { state: TailscaleState; logins: string[] | null };
	secretgate: boolean;
	machine: OsFacts;
	/** The values setup would write: the config.yml values on a re-run, else computed from the machine. */
	proposed: MachineProposal;
	/** The loaded config when config.yml exists; null on a first run. */
	current: Config | null;
}

function hasRepoBelow(dir: string): boolean {
	try {
		return readdirSync(dir, { withFileTypes: true }).some(c => c.isDirectory() && existsSync(join(dir, c.name, ".git")));
	} catch {
		return false;
	}
}

function workRoots(home: string): string[] {
	return readdirSync(home, { withFileTypes: true })
		.filter(d => d.isDirectory() && !d.name.startsWith("."))
		.map(d => join(home, d.name))
		.filter(hasRepoBelow)
		.toSorted();
}

export function detect(seams: SetupSeams): SetupFacts {
	// env {} so a live QUEUE_* override never leaks into what setup proposes.
	const cfg = loadConfig({ home: seams.home, env: {} });
	const current = existsSync(configFile(seams.home)) ? cfg : null;
	const os = seams.os;
	// Without a config.yml, loadConfig returns the shipped template, so its machine values are the defaults.
	const proposed: MachineProposal = current
		? { load_over_cores: cfg.machine.load_over_cores, avail_min_mb: cfg.machine.avail_min_mb, disk_min_gb: cfg.machine.disk_min_gb }
		: {
				load_over_cores: cfg.machine.load_over_cores,
				avail_min_mb: Math.max(1024, Math.round(os.ramMb * 0.1)),
				disk_min_gb: Math.max(1, Math.min(cfg.machine.disk_min_gb, Math.floor(os.diskFreeGb * 0.1))),
			};
	return {
		workRoots: workRoots(seams.home),
		harnesses: seams.harnesses.filter(h => seams.onPath(h.bin)).map(h => h.name),
		tailscale: { state: seams.tailscale.state(), logins: seams.tailscale.logins() },
		secretgate: seams.onPath(PROXY_BIN),
		machine: os,
		proposed,
		current,
	};
}

function binOnPath(bin: string, env: NodeJS.ProcessEnv): boolean {
	for (const dir of (env.PATH ?? "").split(":")) {
		if (dir === "") continue;
		try {
			if (statSync(join(dir, bin)).isFile()) return true;
		} catch {}
	}
	return false;
}

/** The production seams: node fs/os, the given PATH, realTailscale. */
export function realSeams(harnesses: HarnessBin[], home: string = homedir(), env: NodeJS.ProcessEnv = process.env): SetupSeams {
	const st = statfsSync(home);
	return {
		home,
		onPath: bin => binOnPath(bin, env),
		harnesses,
		tailscale: realTailscale,
		os: {
			cores: availableParallelism(),
			ramMb: totalmem() / 1024 / 1024,
			diskFreeGb: (Number(st.bavail) * Number(st.bsize)) / 1e9,
		},
	};
}
