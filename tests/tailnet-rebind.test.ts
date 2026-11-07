import { afterAll, afterEach, expect, test } from "bun:test";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPages } from "../src/cli/pages.ts";
import { runUi } from "../src/cli/ui.ts";
import { loadConfig } from "../src/core/config.ts";
import { startOwnerUi } from "../src/core/owner-ui.ts";
import { startPagesServer } from "../src/core/pages.ts";
import { applyQueueEnv } from "../src/core/queue/env.ts";
import { type Tailscale, untilIp4Changes } from "../src/core/tailscale.ts";

// Sandboxed: every config path resolves under TMP (loadConfig({ home })), and the fixture tailscale
// never runs the real binary. Servers bind 127.0.0.x only.
const TMP = mkdtempSync(join(tmpdir(), "tailnet-rebind-"));
const OWNER = "owner@example.test";
const PEER = "100.64.0.9";
const OLD = "127.0.0.2";
const NEW = "127.0.0.3";

let ip: string | null = OLD;
const TS: Tailscale = {
	ip4: () => ip,
	state: () => "running",
	dnsName: () => "pc.example.test",
	whois: peer => (peer === PEER ? OWNER : null),
	logins: () => [OWNER],
};

const open: { stop(): void }[] = [];
function track<T extends { stop(): void }>(server: T): T {
	open.push(server);
	return server;
}
afterEach(() => {
	for (const s of open.splice(0)) s.stop();
	for (const k of Object.keys(process.env)) if (k.startsWith("QUEUE_")) delete process.env[k];
});
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// Collects what the watcher prints (console.error) instead of letting it reach the runner.
function captureStderr(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	return {
		lines,
		restore: () => {
			console.error = original;
		},
	};
}

// GET / with an explicit Host header, so the owner page's Host allowlist can be probed.
function get(host: string, port: number, hostHeader = `${host}:${port}`): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const req = request({ host, port, path: "/", headers: { host: hostHeader } }, res => {
		res.resume();
		resolve(res.statusCode ?? 0);
	});
	req.on("error", reject);
	req.end();
	return promise;
}

function sandboxCfg(name: string) {
	const home = join(TMP, name);
	mkdirSync(home, { recursive: true });
	const cfg = loadConfig({ home });
	cfg.ui.enabled = true;
	cfg.ui.owner_login = OWNER;
	applyQueueEnv(cfg);
	return cfg;
}

test("untilIp4Changes resolves 1 once the tailnet address answers a different IPv4", async () => {
	ip = OLD;
	const cap = captureStderr();
	const watch = untilIp4Changes(TS, OLD, 20);
	ip = NEW;
	const code = await watch;
	cap.restore();
	expect(code).toBe(1);
	expect(cap.lines.join("\n")).toContain(`tailnet address changed ${OLD} → ${NEW}`);
});

// One watcher walks a scripted answer sequence. Every answer before NEW must keep it serving: it
// must poll through all of them (the call count proves it did not exit early) and print nothing.
test("untilIp4Changes keeps serving through the bound address and every non-IPv4 answer", async () => {
	const answers: (string | null)[] = [OLD, OLD, null, "", "Logged out.", "fd7a:115c:a1e0::1", "999.1.1.1", NEW];
	let calls = 0;
	const scripted: Tailscale = { ...TS, ip4: () => answers[Math.min(calls++, answers.length - 1)] ?? null };
	const cap = captureStderr();
	const code = await untilIp4Changes(scripted, OLD, 5);
	cap.restore();
	expect({ code, polls: calls }).toEqual({ code: 1, polls: answers.length });
	expect(cap.lines).toHaveLength(1);
	expect(cap.lines[0]).toContain(`tailnet address changed ${OLD} → ${NEW}`);
});

test("the owner page restarts on the new address and keeps its Host allowlist", async () => {
	const cfg = sandboxCfg("owner");
	ip = OLD;
	const source = { listRuns: () => [], mainSession: () => null };
	const first = track(startOwnerUi({ cfg, tailscale: TS, source, port: 0, peerOf: () => PEER }));
	expect(first.hostname).toBe(OLD);
	expect(await get(OLD, first.port)).toBe(200);

	const cap = captureStderr();
	const watch = untilIp4Changes(TS, first.hostname, 20);
	ip = NEW;
	expect(await watch).toBe(1);
	cap.restore();
	first.stop();

	// What systemd does after the exit: a fresh process binds the address `tailscale ip -4` gives now.
	const second = track(startOwnerUi({ cfg, tailscale: TS, source, port: 0, peerOf: () => PEER }));
	expect(second.hostname).toBe(NEW);
	expect(await get(NEW, second.port)).toBe(200);
	expect(await get(NEW, second.port, `${OLD}:${second.port}`)).toBe(403);
});

test("the pages server restarts on the new address and the old one stops answering", async () => {
	const root = join(TMP, "pages-site");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "index.html"), "<h1>ok</h1>");
	const cfg = sandboxCfg("pages");
	cfg.pages.enabled = true;
	cfg.pages.dir = root;
	const source = { listRuns: () => [], mainSession: () => null };
	ip = OLD;
	const first = track(startPagesServer({ cfg, tailscale: TS, source, port: 0, root, peerOf: () => PEER }));
	expect(first.hostname).toBe(OLD);
	expect(await get(OLD, first.port)).toBe(200);

	const cap = captureStderr();
	const watch = untilIp4Changes(TS, first.hostname, 20);
	ip = NEW;
	expect(await watch).toBe(1);
	cap.restore();
	first.stop();

	const second = track(startPagesServer({ cfg, tailscale: TS, source, port: 0, root, peerOf: () => PEER }));
	expect(second.hostname).toBe(NEW);
	expect(await get(NEW, second.port)).toBe(200);
	await expect(get(OLD, first.port)).rejects.toThrow();
});

test("neurastream ui exits 1 once the tailnet address changes, so systemd restarts it", async () => {
	const cfg = sandboxCfg("ui-cli");
	ip = OLD;
	const cap = captureStderr();
	const serving = runUi([], {
		cfg,
		tailscale: TS,
		ipPollMs: 20,
		start: () => ({ stop() {}, hostname: OLD, port: 0 }),
	});
	ip = NEW;
	const code = await serving;
	cap.restore();
	expect(code).toBe(1);
	expect(cap.lines.join("\n")).toContain(`tailnet address changed ${OLD} → ${NEW}`);
});

test("neurastream pages serve exits 1 once the tailnet address changes, so systemd restarts it", async () => {
	const home = join(TMP, "pages-cli");
	const site = join(home, "site");
	mkdirSync(site, { recursive: true });
	mkdirSync(join(home, ".config", "neurastream"), { recursive: true });
	writeFileSync(
		join(home, ".config", "neurastream", "config.yml"),
		`pages:\n  enabled: true\n  port: 0\n  dir: ${site}\n`,
	);
	ip = OLD;
	const cap = captureStderr();
	const serving = runPages(["serve"], { home, tailscale: TS, ipPollMs: 20 });
	ip = NEW;
	const code = await serving;
	cap.restore();
	expect(code).toBe(1);
	expect(cap.lines.join("\n")).toContain(`tailnet address changed ${OLD} → ${NEW}`);
});
