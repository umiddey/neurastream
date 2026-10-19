"""Shared helpers for blocker scripts.

Contract (called by ~/.omp/agent/extensions/plan-guard.ts for every tool call that touches a
queued plan's repo or worktrees):
  argv[1:]  the arguments written after the blocker name in the plan's "## Blockers" line
  stdin     JSON {tool, input, cwd, agent: "main"|"sub", repo, plan, paths: [absolute paths]}
  exit 0    allow;  exit 2 + one line on stderr = refuse the call with that reason.
"""
import fnmatch, json, os, re, sys

CALL = json.load(sys.stdin)
ARGS = sys.argv[1:]
TOOL = CALL.get("tool", "")
INPUT = CALL.get("input") or {}
SHELL = TOOL in ("bash", "eval")
COMMAND = str(INPUT.get("command") or INPUT.get("code") or "") if SHELL else ""
WRITES = TOOL in ("write", "edit", "ast_edit")
MUTATING = re.compile(r"(\brm\b|\bmv\b|\bcp\b|\btruncate\b|\bsed\s+-i|\btee\b|>{1,2}\s*\S|\bgit\s+(rm|mv|checkout|restore)\b|writeFile|Bun\.write|unlink|\bpatch\b)")


def block(reason):
    print(f"{os.path.basename(sys.argv[0])}: {reason}", file=sys.stderr)
    sys.exit(2)


def git_root(p):
    d = p if os.path.isdir(p) else os.path.dirname(p)
    while True:
        if os.path.exists(os.path.join(d, ".git")):
            return d
        up = os.path.dirname(d)
        if up == d:
            return None
        d = up


def rel(p):
    root = git_root(p) or CALL.get("repo") or "/"
    r = os.path.relpath(p, root)
    return p if r.startswith("..") else r


def matches(p, glob):
    if glob.startswith("/") or glob.startswith("~"):
        return fnmatch.fnmatch(p, os.path.expanduser(glob))
    r = rel(p)
    return fnmatch.fnmatch(r, glob) or fnmatch.fnmatch(r, glob.rstrip("/") + "/*") or r == glob.rstrip("/")


def shell_paths():
    """Absolute forms of every word in a shell command, resolved against the call's cwd."""
    if not SHELL:
        return []
    base = os.path.expanduser(str(INPUT.get("cwd") or CALL.get("cwd") or "/"))
    out = []
    for w in re.split(r"[\s;&|<>()'\"]+", COMMAND):
        w = w.strip()
        if w and not w.startswith("-"):
            out.append(os.path.normpath(os.path.join(base, os.path.expanduser(w))))
    return out


def written_text():
    if TOOL == "write":
        return str(INPUT.get("content") or "")
    if TOOL == "edit":
        return "\n".join(l[1:] for l in str(INPUT.get("input") or "").splitlines() if l.startswith("+"))
    if TOOL == "ast_edit":
        return json.dumps(INPUT)
    return COMMAND
