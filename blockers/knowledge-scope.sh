#!/bin/sh
# Knowledge base scope (plan 20261026_0930_knowledge_base): the phone page's Knowledge tab is
# read-only, harness-neutral, and reads only docs/knowledge/ of repos under the configured roots.
# Run before every commit; exit 1 names the violation.
set -u
cd "$(dirname "$0")/.." || exit 1
fail() {
	printf 'knowledge-scope: %s\n' "$1" >&2
	exit 1
}

grep -nEi '\b(omp|opencode|codex|claude|cursor|gemini|grok|glm|composer|hiko|muse)\b' src/core/knowledge.ts >/dev/null &&
	fail "src/core/knowledge.ts names a harness"

# Any absolute user-home root, whatever the user is called: the config's $HOME carries that.
grep -rnE '/(home|Users)/[^/]+/' src templates >/dev/null && fail "a hardcoded user home path in src/ or templates/"

# secret-redact.ts is the one file that produces the placeholder, so it is not a copy of one.
grep -rnE --exclude=secret-redact.ts '\[(IP_ADDRESS|EMAIL|API_KEY)\]|\[REDACTED:known-value\]' src templates >/dev/null &&
	fail "a redaction placeholder copied into src/ or templates/"

grep -n 'POST.*/knowledge/\|/knowledge/.*POST' src/core/owner-ui.ts >/dev/null && fail "a POST route for a topic"

grep -nE '(writeFileSync|appendFileSync|renameSync|rmSync|mkdirSync|unlinkSync|truncateSync)' src/core/knowledge.ts >/dev/null &&
	fail "src/core/knowledge.ts writes"

# Only calls count: the named import (`import { readdirSync }`) has no argument list.
grep -nE 'readdirSync[[:space:]]*\(' src/core/knowledge.ts |
	grep -vE 'readdirSync[[:space:]]*\([[:space:]]*(root|knowDir)[[:space:]]*[,)]' >/dev/null &&
	fail "a directory scan outside the configured roots and docs/knowledge"

grep -q 'join("docs", "knowledge")' src/core/knowledge.ts || fail "src/core/knowledge.ts does not read docs/knowledge"

exit 0
