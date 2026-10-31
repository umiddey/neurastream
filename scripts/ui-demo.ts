// One self-contained presentation copy of the owner page: every tab and every Base view is
// pre-rendered into the same file and switched in place — no server, no fetch, nothing live.
// The tab pills, the queue's "Show all" link and the Base drill-down links swap views locally;
// the topic view embeds the real docs/knowledge/architecture.html bytes via iframe srcdoc.
// Buttons, forms and drag-sort stay inert (they post to the server): this file is for showing,
// not driving. Shares the fixture state with scripts/ui-preview.ts.
// Usage: bun scripts/ui-demo.ts <out.html>

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { renderPage } from "../src/core/owner-ui.ts";
import { fixtureConfig, fixtureData } from "./ui-preview.ts";

const out = process.argv[2];
if (!out) {
	console.error("usage: bun scripts/ui-demo.ts <out.html>");
	process.exit(2);
}

const cfg = fixtureConfig();
const data = fixtureData();
const nonce = "demo-fixed-nonce";

/** View key → the query the server route would get. Key "a/b/c" = Base drill-down a → b → c. */
const views: [string, string][] = [
	["now", ""],
	["queue", "tab=queue"],
	["agents", "tab=agents"],
	["spend", "tab=spend"],
	["knowledge", "tab=knowledge"],
	["knowledge/neurastream", "tab=knowledge&repo=neurastream"],
	["knowledge/neurastream/architecture", "tab=knowledge&repo=neurastream&topic=architecture"],
];

const mainOf = (html: string): string => {
	const start = html.indexOf("<main>");
	const end = html.indexOf("</main>");
	if (start < 0 || end < 0) throw new Error("renderPage output has no <main>");
	return html.slice(start, end + "</main>".length);
};

const topic = readFileSync(join(import.meta.dirname, "..", "docs", "knowledge", "architecture.html"), "utf8");
const srcdoc = topic.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

const mains = views.map(([key, qs]) => {
	let main = mainOf(renderPage(cfg, data, new URLSearchParams(qs), nonce));
	if (key.endsWith("/architecture")) main = main.replace(/ src="\/knowledge\/[^"]*"/, ` srcdoc="${srcdoc}"`);
	return main.replace("<main>", `<main data-v="${key}"${key === "now" ? "" : " hidden"}>`);
});

// The shell of the Now render carries doctype, styles and the pill bar; its own fetch-based
// script is dropped — on a file there is no server to fetch from.
const shell = renderPage(cfg, data, new URLSearchParams(""), nonce);
const head = shell.slice(0, shell.indexOf("<main>"));

const switcher = `
(function(){
"use strict";
function viewOf(href){
	var get=function(k){var m=new RegExp("[?&]"+k+"=([^&]*)").exec(href);return m?decodeURIComponent(m[1]):"";};
	var tab=get("tab")||"now";
	if(tab!=="knowledge")return tab;
	var v="knowledge",r=get("repo"),t=get("topic");
	if(r)v+="/"+r;
	if(r&&t)v+="/"+t;
	return v;
}
function show(v){
	var any=false;
	document.querySelectorAll("main[data-v]").forEach(function(m){var on=m.getAttribute("data-v")===v;m.hidden=!on;any=any||on;});
	if(!any)return false;
	document.querySelectorAll(".pills a").forEach(function(a){
		var href=a.getAttribute("href")||"";
		var pv=viewOf(href);
		a.classList.toggle("on",pv===v||v.indexOf(pv+"/")===0);
	});
	window.scrollTo(0,0);
	return true;
}
document.addEventListener("click",function(e){
	var a=e.target&&e.target.closest?e.target.closest("a"):null;
	if(!a)return;
	var href=a.getAttribute("href")||"";
	if(href.charAt(0)!=="/"||href.charAt(1)!=="?")return;
	if(!show(viewOf(href)))return;
	e.preventDefault();
});
})();`;

const doc = `${head}${mains.join("\n")}\n<script>${switcher}</script>\n</body>\n</html>`;
mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(out, doc);
console.log(`wrote ${out} (${doc.length} bytes, ${views.length} views: ${views.map(([k]) => k).join(", ")})`);
