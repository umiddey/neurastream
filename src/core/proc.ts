import { spawnSync } from "node:child_process";

export interface CmdResult {
	code: number;
	stdout: string;
	stderr: string;
}

export function cmd(
	args: string[],
	opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Buffer } = {},
): CmdResult {
	const r = spawnSync(args[0]!, args.slice(1), {
		cwd: opts.cwd,
		env: opts.env,
		input: opts.input,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	return {
		code: r.status === null ? 1 : r.status,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
	};
}

export function gitText(repo: string, args: string[], env?: NodeJS.ProcessEnv): string {
	const r = cmd(["git", "-C", repo, ...args], { env });
	return r.code === 0 ? r.stdout.trim() : "";
}

export function gitRaw(repo: string, args: string[], env?: NodeJS.ProcessEnv): CmdResult {
	const r = cmd(["git", "-C", repo, ...args], { env });
	return { code: r.code, stdout: r.stdout.trim(), stderr: r.stderr };
}
