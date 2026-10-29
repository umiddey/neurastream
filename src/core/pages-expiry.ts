import { lstatSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ExpiryRecord { published: string; expires: string | null; repo?: string }
export type ExpiryMap = Record<string, ExpiryRecord>;

const RECORD = ".expiry.json";
const DAY_MS = 86_400_000;

function expiryRecord(value: unknown): ExpiryRecord | null {
 if (!value || typeof value !== "object" || Array.isArray(value)) return null;
 const published = "published" in value ? value.published : undefined;
 const expires = "expires" in value ? value.expires : undefined;
 if (typeof published !== "string") return null;
 if (expires !== null && typeof expires !== "string") return null;
 const rec: ExpiryRecord = { published, expires };
 const repo = "repo" in value ? value.repo : undefined;
 if (typeof repo === "string" && repo) rec.repo = repo;
 return rec;
}

export function readExpiry(dir: string): ExpiryMap {
 const path = join(dir, RECORD);
 let st;
 try { st = lstatSync(path); } catch { return {}; }
 if (!st.isFile()) return {};
 try {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: ExpiryMap = {};
  for (const [name, value] of Object.entries(parsed)) {
   const rec = expiryRecord(value);
   if (rec) out[name] = rec;
  }
  return out;
 } catch { return {}; }
}

function writeExpiry(dir: string, map: ExpiryMap): void {
 const tmp = join(dir, `.expiry.${process.pid}.${Date.now()}.tmp`);
 writeFileSync(tmp, `${JSON.stringify(map)}\n`);
 renameSync(tmp, join(dir, RECORD));
}

export function recordPublish(dir: string, name: string, keep: boolean, keepDays: number, now: Date, repo?: string): ExpiryRecord {
 const map = readExpiry(dir);
 const existing = map[name];
 const rec: ExpiryRecord = {
  published: now.toISOString(),
  expires: keep || existing?.expires === null ? null : new Date(now.getTime() + keepDays * DAY_MS).toISOString(),
  // An explicit repo replaces the old one (--repo wins); without one a republish keeps its repo.
  repo: repo ?? existing?.repo,
 };
 map[name] = rec;
 writeExpiry(dir, map);
 return rec;
}

export function sweepPages(dir: string, keepDays: number, now: Date): { removed: string[] } {
 let dirStat;
 try { dirStat = lstatSync(dir); } catch { return { removed: [] }; }
 if (!dirStat.isDirectory()) return { removed: [] };
 const map = readExpiry(dir);
 const next: ExpiryMap = {};
 const removed: string[] = [];
 for (const entry of readdirSync(dir, { withFileTypes: true })) {
  if (entry.name.startsWith(".") || !entry.isFile()) continue;
  const path = join(dir, entry.name);
  let st;
  try { st = lstatSync(path); } catch { continue; }
  if (!st.isFile()) continue;
  const rec = map[entry.name];
  const expiresAt = rec?.expires == null ? null : Date.parse(rec.expires);
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt < now.getTime()) {
   unlinkSync(path);
   removed.push(entry.name);
   continue;
  }
  if (rec && (rec.expires === null || (typeof expiresAt === "number" && Number.isFinite(expiresAt)))) next[entry.name] = rec;
  else next[entry.name] = { published: now.toISOString(), expires: new Date(now.getTime() + keepDays * DAY_MS).toISOString() };
 }
 writeExpiry(dir, next);
 return { removed };
}
