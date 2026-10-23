import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// NS_HEAVY_RUN_MODULE lets the same test run against an older copy of heavy-run.ts (fail-before).
const MODULE = process.env.NS_HEAVY_RUN_MODULE ?? join(import.meta.dir, "..", "src", "core", "heavy-run.ts");

test("heavy-run keeps the lock for the whole command, so a second run sees busy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heavy-lock-"));
  const cfg = {
    paths: {
      heavy_lock: join(dir, "heavy.lock"),
      heavy_owner: join(dir, "heavy.owner"),
      heavy_log: join(dir, "heavy.log"),
    },
  };
  const cfgFile = join(dir, "cfg.json");
  await Bun.write(cfgFile, JSON.stringify(cfg));
  const driver = join(dir, "driver.ts");
  await Bun.write(
    driver,
    `import { heavyRun } from ${JSON.stringify(MODULE)};
const cfg = JSON.parse(await Bun.file(${JSON.stringify(cfgFile)}).text());
process.exit(heavyRun(process.argv.slice(2), cfg));
`,
  );
  // The holder's command prints READY once it runs (so the lock is held) and then blocks on stdin.
  const holder = Bun.spawn([process.execPath, driver, "A", "work", "--", "sh", "-c", "echo READY; read x"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let seen = "";
  for await (const chunk of holder.stdout) {
    seen += new TextDecoder().decode(chunk);
    if (seen.includes("READY")) break;
  }
  const status = Bun.spawnSync([process.execPath, driver, "--status"], { stdout: "pipe", stderr: "pipe" });
  holder.stdin.end();
  await holder.exited;
  expect(status.stdout.toString()).toMatch(/^busy: A \| work/);
});
