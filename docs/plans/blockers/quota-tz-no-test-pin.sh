#!/usr/bin/env bash
# Phase-0 blocker for 20261023_2215_quota_reset_zone_abbrev.md:
# the fix goes in src/core/quota-reset.ts, never by weakening the golden oracle test.
set -euo pipefail
cd "$(dirname "$0")" && cd "$(git rev-parse --show-toplevel)"
if ! git diff --quiet origin/main -- tests/golden/ports-p4.test.ts; then
  echo "quota-tz blocker: tests/golden/ports-p4.test.ts changed vs origin/main; fix the port, not the oracle test" >&2
  exit 1
fi
if git diff origin/main -- tests src | grep -E '^\+.*\bTZ[:=]' | grep -v '^+++' | grep -qvE 'ci\.yml'; then
  echo "quota-tz blocker: a TZ pin was added in tests/src; the port must match date(1) in any zone" >&2
  exit 1
fi
echo "quota-tz blocker: clean"
