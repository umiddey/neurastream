// Owner UI HTTP server: binds tailnet address, enforces Host/auth/Origin guards, and dispatches GET/POST routes.

import type { RunSource } from "../adapter.ts";
import { nowSec } from "../clock.ts";
import type { Config } from "../config.ts";
import { log } from "../guards.ts";
import { readKnowledgeTopicFile, urlField } from "../knowledge.ts";
import type { Tailscale } from "../tailscale.ts";
import { authenticate, fieldsOf, hostAllowlist, originIsHost, textRes, type UiHttpServer } from "./auth.ts";
import { clearAnswerDedupe, handleAnswer, handleIncident, handleLock, handleReorder, handleTier, handleUnlock } from "./handlers.ts";
import { handleMessage, handleMessageImage, sweepOwnerMessages } from "./messages.ts";
import { pageRes } from "./render.ts";
import { noopResultsBuild, type ResultsBuild } from "./results.ts";

export interface OwnerUiServer {
	stop(): void;
	hostname: string;
	port: number;
}

export interface OwnerUiOptions {
	cfg: Config;
	tailscale: Tailscale;
	source: RunSource;
	/** Bind address. Default: the tailnet address from `tailscale ip -4`. Tests bind 127.0.0.1. */
	hostname?: string;
	/** Bind port. Default: workspace.port; 0 picks a free port (tests). */
	port?: number;
	/** The peer address of a request. Default: the socket address. Tests inject fixture peers. */
	peerOf?: (req: Request, server: UiHttpServer) => string;
	/** Starts a background Results build. Default: no-op (CLI passes `spawnResultsBuild`). Tests inject a recorder. */
	resultsBuild?: ResultsBuild;
}

/** Starts the page. Refuses to start when workspace.enabled is false or workspace.owner_login is empty, and on the default hostname when tailscale does not answer. */
export function startOwnerUi(opts: OwnerUiOptions): OwnerUiServer {
	const { cfg, tailscale, source } = opts;
	const resultsBuild = opts.resultsBuild ?? noopResultsBuild;
	// The Base tab links to the pages server by its MagicDNS name, the same URL `pages publish` prints.
	const pagesHost = tailscale.dnsName() ?? "tailnet";
	// The double-press guard (P8c) is per-server memory: a fresh server starts empty, which also
	// keeps the tests (one server per test) hermetic.
	clearAnswerDedupe();
	if (!cfg.workspace.enabled) throw new Error("owner ui: workspace.enabled is false — set it in the config first");
	if (!cfg.workspace.owner_login) throw new Error("owner ui: workspace.owner_login is empty — set the tailscale login that may open the page");
	const hostname = opts.hostname ?? tailscale.ip4();
	if (!hostname) throw new Error("owner ui: tailscale ip -4 did not answer — is tailscale up?");
	const peerOf = opts.peerOf ?? ((req: Request, server: UiHttpServer) => server.requestIP(req)?.address ?? "");
	const hostAllowed = hostAllowlist(tailscale);
	const server = Bun.serve({
		hostname,
		port: opts.port ?? cfg.workspace.port,
		fetch: async (req, srv) => {
			const url = new URL(req.url);
			let code = 500;
			let login: string | null = null;
			let res: Response;
			try {
				const hostHeader = req.headers.get("host") ?? "";
				if (!hostAllowed(hostHeader, srv.port)) {
					res = textRes("forbidden: host is not this page", 403);
					code = 403;
				} else {
					const auth = authenticate(cfg, tailscale, peerOf(req, srv));
					if (!auth.ok) {
						res = textRes("forbidden: this page serves only the owner", 403);
						code = 403;
					} else {
						login = auth.login;
						if (req.method === "POST" && !originIsHost(req.headers.get("origin"), hostHeader)) {
							res = textRes("forbidden: origin is not this page", 403);
							code = 403;
						} else if (req.method === "GET" && url.pathname === "/") {
							sweepOwnerMessages(nowSec(), cfg.paths);
							res = pageRes(cfg, source, url.searchParams, resultsBuild, pagesHost);
							code = 200;
						} else if (req.method === "GET" && url.pathname.startsWith("/knowledge/")) {
							// The Knowledge tab's frame: the topic's own file bytes, GET only, no write path.
							const topicPath = /^\/knowledge\/([^/]+)\/([^/]+)$/.exec(url.pathname);
							const bytes =
								topicPath === null
									? null
									: readKnowledgeTopicFile(cfg, urlField(topicPath[1]!), urlField(topicPath[2]!));
							res =
								bytes === null
									? textRes("not found", 404)
									: new Response(bytes, {
											headers: {
												"content-type": "text/html; charset=utf-8",
												"content-security-policy": "sandbox allow-scripts",
												"x-content-type-options": "nosniff",
											},
										});
							code = res.status;
						} else if (req.method === "GET" && url.pathname.startsWith("/message-image/")) {
							const mim = /^\/message-image\/([^/]+)\/([^/]+)$/.exec(url.pathname);
							res = mim ? handleMessageImage(mim[1]!, mim[2]!, cfg.paths) : textRes("not found", 404);
							code = res.status;
						} else if (req.method === "POST") {
							// The page's script asks for JSON on every POST (P11b); a no-JS form post gets today's 303s.
							const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");
							if (url.pathname === "/message") {
								res = await handleMessage(req, cfg, login, wantsJson);
								code = res.status;
							} else if (url.pathname === "/incident") {
								res = handleIncident(cfg, await fieldsOf(req), login, wantsJson);
								code = res.status;
							} else if (url.pathname === "/answer") {
								res = handleAnswer(cfg, source, await fieldsOf(req), login, wantsJson, pagesHost);
								code = res.status;
							} else if (url.pathname === "/unlock") {
								res = handleUnlock(cfg, await fieldsOf(req), login, wantsJson);
								code = res.status;
							} else if (url.pathname === "/lock") {
								res = handleLock(cfg, await fieldsOf(req), login, wantsJson);
								code = res.status;
							} else if (url.pathname === "/tier") {
								res = handleTier(cfg, await fieldsOf(req), login, wantsJson);
								code = res.status;
							} else if (url.pathname === "/reorder") {
								res = handleReorder(cfg, await fieldsOf(req), login, wantsJson);
								code = res.status;
							} else {
								res = textRes("not found", 404);
								code = 404;
							}
						} else {
							res = textRes("not found", 404);
							code = 404;
						}
					}
				}
			} catch {
				res = textRes("internal error", 500);
				code = 500;
			}
			log(cfg.paths.guard_log, `UI ${req.method} ${url.pathname} login=${login ?? "-"} → ${code}`);
			return res;
		},
	});
	return { stop: () => server.stop(true), hostname, port: Number(server.port) };
}
