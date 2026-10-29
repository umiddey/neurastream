import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
// NS_HEAVY_RUN_MODULE runs the heavy-run cases against another copy of heavy-run.ts (the fail-before run uses HEAD's).
const HEAVY_MODULE = process.env.NS_HEAVY_RUN_MODULE ?? join(ROOT, "src", "core", "heavy-run.ts");
const TMP_SNAPSHOT_MODULE = join(ROOT, "src", "core", "tmp-snapshot.ts");
const HOME = "/tmp/neurastream-home-p3";
// A full `bun test` must leave nothing under os.tmpdir() (plan 20261029_1530 P3): every sandbox
// dir and the fixed HOME above go away when the file's tests are done.
const DIRS: string[] = [];
afterAll(() => {
	for (const d of [...DIRS, HOME]) rmSync(d, { recursive: true, force: true });
});

type Env = Record<string, string | undefined>;
interface Sandbox {
  dir: string;
  driver: string;
  env: Env;
}

// A PATH with only sh, date and sleep: the PATH of a Mac without util-linux flock.
function sandbox(): Sandbox {
  mkdirSync(HOME, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "heavy-lock-"));
  DIRS.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const name of ["sh", "date", "sleep"]) {
    const real = Bun.which(name);
    if (!real) throw new Error(`test needs ${name} on PATH`);
    symlinkSync(real, join(bin, name));
  }
  const cfgFile = join(dir, "cfg.json");
  writeFileSync(
    cfgFile,
    JSON.stringify({
      paths: {
        heavy_lock: join(dir, "heavy.lock"),
        heavy_owner: join(dir, "heavy.owner"),
        heavy_log: join(dir, "heavy.log"),
      },
    }),
  );
  const driver = join(dir, "driver.ts");
  writeFileSync(
    driver,
    `import { readFileSync } from "node:fs";
import { heavyRun } from ${JSON.stringify(HEAVY_MODULE)};
const cfg = JSON.parse(readFileSync(${JSON.stringify(cfgFile)}, "utf8"));
process.exit(heavyRun(process.argv.slice(2), cfg));
`,
  );
  return { dir, driver, env: { ...process.env, HOME, PATH: bin } };
}

async function runHeavy(s: Sandbox, who: string, what: string, cmd: string[]) {
  const p = Bun.spawn([process.execPath, s.driver, who, what, "--", ...cmd], {
    env: s.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
}

function statusOf(s: Sandbox): string {
  const r = Bun.spawnSync([process.execPath, s.driver, "--status"], { env: s.env, stdout: "pipe", stderr: "pipe" });
  return r.stdout.toString();
}

async function readUntil(stream: ReadableStream<Uint8Array>, marker: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes(marker)) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value);
  }
  reader.releaseLock();
}

test("(1) two heavy-runs started together never overlap", async () => {
  const s = sandbox();
  const stamps = join(s.dir, "stamps");
  const script = 'echo "start $0" >> "$1"; sleep 1; echo "end $0" >> "$1"';
  const [a, b] = await Promise.all([
    runHeavy(s, "A", "work", ["sh", "-c", script, "A", stamps]),
    runHeavy(s, "B", "work", ["sh", "-c", script, "B", stamps]),
  ]);
  expect(a.code).toBe(0);
  expect(b.code).toBe(0);
  const lines = existsSync(stamps) ? readFileSync(stamps, "utf8").trim().split("\n") : [];
  expect(lines.length).toBe(4);
  expect(lines[1]).toBe(lines[0]!.replace("start", "end"));
  expect(lines[3]).toBe(lines[2]!.replace("start", "end"));
});

test("(2) while a run holds the lock, --status prints busy with the owner line; after it ends, free", async () => {
  const s = sandbox();
  const holder = Bun.spawn([process.execPath, s.driver, "A", "work", "--", "sh", "-c", "echo READY; read x"], {
    env: s.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await readUntil(holder.stdout, "READY");
  const busy = statusOf(s);
  holder.stdin.end();
  await holder.exited;
  expect(busy).toMatch(/^busy: A \| work \| since .* \| pid \d+\n$/);
  expect(statusOf(s)).toBe("free\n");
});

test("(3) works with a PATH that has no flock", async () => {
  const s = sandbox();
  expect(Bun.which("flock", { PATH: s.env.PATH })).toBeNull();
  const stamps = join(s.dir, "stamps");
  const r = await runHeavy(s, "C", "solo", ["sh", "-c", 'echo ran >> "$1"', "x", stamps]);
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  expect(readFileSync(stamps, "utf8")).toBe("ran\n");
  expect(statusOf(s)).toBe("free\n");
});

test("(4) tmp-snapshot started twice at once prints 'snapshot already running' exactly once", async () => {
  const s = sandbox();
  // Shims: the snapshot's rsync holds the lock for a second; ionice is absent on macOS, so it is shimmed too.
  const shims = join(s.dir, "shims");
  mkdirSync(shims);
  writeFileSync(join(shims, "rsync"), "#!/bin/sh\nsleep 1\n");
  writeFileSync(join(shims, "ionice"), '#!/bin/sh\nwhile [ "${1#-}" != "$1" ]; do shift; done\nexec "$@"\n');
  chmodSync(join(shims, "rsync"), 0o755);
  chmodSync(join(shims, "ionice"), 0o755);
  const driver = join(s.dir, "snap-driver.ts");
  writeFileSync(
    driver,
    `import { tmpSnapshot } from ${JSON.stringify(TMP_SNAPSHOT_MODULE)};
process.exit(tmpSnapshot([], {
  paths: { snapshot_lock: ${JSON.stringify(join(s.dir, "snap.lock"))} },
  snapshot: { tmp_dest: ${JSON.stringify(join(s.dir, "snap"))}, git_repo: "", git_backup: "", excludes: ["*"] },
}));
`,
  );
  const env = { ...process.env, HOME, PATH: `${shims}:${process.env.PATH ?? ""}` };
  const run = async () => {
    const p = Bun.spawn([process.execPath, driver], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, text: out + err };
  };
  const [a, b] = await Promise.all([run(), run()]);
  expect(a.code).toBe(0);
  expect(b.code).toBe(0);
  const count = (a.text + b.text).split("snapshot already running").length - 1;
  expect(count).toBe(1);
});

test("(5) machine-guard does not alert busy on a free lock when heavy_path is missing", async () => {
  const home = `/tmp/neurastream-home-p3-guard-${Date.now()}`;
  mkdirSync(home, { recursive: true });
  const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src/cli/main.ts"), "machine-guard"], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = r.stdout.toString() + r.stderr.toString();
  expect(text).not.toContain("heavy-lock busy");
});
