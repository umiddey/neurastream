import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/core/config.ts";
import { readExpiry, recordPublish, sweepPages } from "../src/core/pages-expiry.ts";

const NOW = new Date("2026-10-25T12:00:00.000Z");
const PLUS_15 = "2026-11-09T12:00:00.000Z";

function pagesDir(): string {
 const dir = mkdtempSync(join(tmpdir(), "pages-expiry-"));
 return dir;
}

test("recordPublish defaults to 15 days, keep is null, and a null record stays null", () => {
 const dir = pagesDir();
 expect(recordPublish(dir, "a.html", false, 15, NOW)).toEqual({ published: NOW.toISOString(), expires: PLUS_15 });
 expect(recordPublish(dir, "kept.html", true, 15, NOW).expires).toBeNull();
 const again = recordPublish(dir, "kept.html", false, 15, new Date("2026-11-01T00:00:00.000Z"));
 expect(again.expires).toBeNull();
 expect(again.published).toBe("2026-11-01T00:00:00.000Z");
 expect(loadConfig({ home: mkdtempSync(join(tmpdir(), "pages-expiry-home-")), env: {} }).pages.keep_days).toBe(15);
});

test("sweep removes only expired regular files and backfills unrecorded ones", () => {
 const parent = mkdtempSync(join(tmpdir(), "pages-expiry-sweep-"));
 const dir = join(parent, "pages");
 mkdirSync(dir);
 const outside = join(parent, "outside.html");
 writeFileSync(outside, "out");
 writeFileSync(join(dir, "old.html"), "old");
 writeFileSync(join(dir, "fresh.html"), "fresh");
 writeFileSync(join(dir, "legacy.html"), "legacy");
 writeFileSync(join(dir, ".hidden"), "hid");
 mkdirSync(join(dir, "sub"));
 writeFileSync(join(dir, "sub", "nested.html"), "nest");
 symlinkSync(outside, join(dir, "link.html"));
 writeFileSync(join(dir, ".expiry.json"), JSON.stringify({
  "old.html": { published: "2026-10-01T00:00:00.000Z", expires: "2026-10-10T00:00:00.000Z" },
  "fresh.html": { published: "2026-10-20T00:00:00.000Z", expires: "2026-11-20T00:00:00.000Z" },
  "gone.html": { published: "2026-10-01T00:00:00.000Z", expires: "2026-10-02T00:00:00.000Z" },
  "../outside.html": { published: "2026-10-01T00:00:00.000Z", expires: "2026-10-02T00:00:00.000Z" },
 }));
 const swept = sweepPages(dir, 15, NOW);
 expect(swept.removed).toEqual(["old.html"]);
 expect(existsSync(join(dir, "old.html"))).toBe(false);
 expect(readFileSync(join(dir, "fresh.html"), "utf8")).toBe("fresh");
 expect(readExpiry(dir)["fresh.html"]?.expires).toBe("2026-11-20T00:00:00.000Z");
 expect(existsSync(join(dir, "legacy.html"))).toBe(true);
 expect(readExpiry(dir)["legacy.html"]).toEqual({ published: NOW.toISOString(), expires: PLUS_15 });
 expect(readFileSync(join(dir, ".hidden"), "utf8")).toBe("hid");
 expect(readExpiry(dir)[".hidden"]).toBeUndefined();
 expect(readFileSync(join(dir, "sub", "nested.html"), "utf8")).toBe("nest");
 expect(readExpiry(dir).sub).toBeUndefined();
 expect(lstatSync(join(dir, "link.html")).isSymbolicLink()).toBe(true);
 expect(readFileSync(outside, "utf8")).toBe("out");
 expect(readExpiry(dir)["gone.html"]).toBeUndefined();
 expect(readExpiry(dir)["../outside.html"]).toBeUndefined();
 expect(readExpiry(dir)["link.html"]).toBeUndefined();
});

test("bad keep_days is a ConfigError", () => {
 const home = mkdtempSync(join(tmpdir(), "pages-expiry-cfg-"));
 const file = join(home, "config.yml");
 writeFileSync(file, "pages:\n  keep_days: 0\n");
 expect(() => loadConfig({ home, file, env: {} })).toThrow(ConfigError);
 writeFileSync(file, "pages:\n  keep_days: x\n");
 expect(() => loadConfig({ home, file, env: {} })).toThrow(ConfigError);
});
