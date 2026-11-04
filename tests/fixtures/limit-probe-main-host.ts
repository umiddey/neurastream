// The compiled stand-in harness (tests/limit-probe-spawn.test.ts builds it with
// `bun build --compile`, so process.execPath is a non-bun executable like omp's). It only
// redirects to the adapter code on disk — the way the omp binary loads its plugin package from
// the installed files — so import.meta-derived package paths keep working. The dynamic import is
// deliberate: a static import would be bundled into the binary and lose import.meta again, and
// the disk path is only known at test runtime.
await import(process.env.LIMIT_PROBE_FIXTURE_ENTRY ?? "");
