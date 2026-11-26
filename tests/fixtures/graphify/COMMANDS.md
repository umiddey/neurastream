# Graphify 0.9.100 behaviour fixtures (plan 20261122_1828_reuse_map P1a)

Recorded 2026-11-26 in a throwaway sandbox (`mktemp -d /tmp/gfy-p1-XXXX`; every `uv`
dir inside it, never the repo): `uv tool install graphifyy==0.9.100` (uv 0.9.11)
with `HOME`, `UV_TOOL_DIR`, `UV_TOOL_BIN_DIR`, `UV_CACHE_DIR` all inside the sandbox
dir, then `PATH="$UV_TOOL_BIN_DIR:$PATH"`.

Fixture repo (one git commit per file batch, all under the sandbox):

```
src/a.py   def unique_loader(path): ...
src/b.py   def parse_frame(buf): ... / def parse_header(buf): ...
src/c.py   def unique_loader(path): ...   # same name as src/a.py — the ambiguity case
README.md, docs/design.md                 # non-code; --code-only skips both
```

Each `*.exit` file holds the command's exit code; `*.stdout`/`*.stderr` the verbatim
streams. Commands, run from the fixture repo root:

| fixture            | command                                              | exit |
|--------------------|------------------------------------------------------|------|
| extract.*          | `graphify extract . --code-only`                     | 0    |
| query-exit-0.*     | `graphify query "src/a.py::unique_loader()" --budget 2000` | 0 |
| query-exit-3.*     | `graphify query "unique_loader" --budget 2000`       | 3    |
| query-exit-4.*     | `graphify query "zzz_nothing" --budget 2000`         | 4    |

Observed (graphify 0.9.100, cli.py `EXIT_AMBIGUOUS = 3`, `EXIT_NOT_FOUND = 4`):
0 = hit — NODE lines carry `src=<repo-relative file>`; 3 = several — an
`Ambiguous: ... matches N nodes in different files.` refusal listing the candidate
files; 4 = none — `No matching nodes found.` Both hit and several name files on
stdout, so `searchTerms` parses files from query output; `graphify-out/graph.json`
node `source_file` fields hold the same mapping (node ids `src_<file>_<symbol>`).
