#!/usr/bin/env bash
# Install a packed neurastream tarball into a throwaway HOME and prove the
# installed CLI works from there: init, adapter install omp, then queue-check
# and doctor both exit 0. Usage:
#   npm pack --pack-destination /tmp/neurastream-home-pub/pkg
#   HOME=/tmp/neurastream-home-pub bash scripts/publish-smoke.sh /tmp/neurastream-home-pub/pkg/neurastream-<version>.tgz
set -euo pipefail
TARBALL="${1:?usage: publish-smoke.sh <neurastream-<version>.tgz>}"
test -f "$TARBALL"
TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
: "${HOME:?HOME is required}"
case "$HOME" in
/tmp/neurastream-home-*) ;;
*)
	echo "refusing: run with HOME=/tmp/neurastream-home-<name>" >&2
	exit 2
	;;
esac
cd /
rm -rf "$HOME"
mkdir -p "$HOME"
export PATH="$HOME/.bun/bin:${PATH:-/usr/bin:/bin}"

HOME="$HOME" bun add -g "$TARBALL"
echo "smoke: installed $TARBALL"
HOME="$HOME" neurastream init
HOME="$HOME" neurastream adapter install omp
HOME="$HOME" queue-check
echo "smoke: queue-check exit=0"
HOME="$HOME" neurastream doctor
echo "smoke: doctor exit=0"
echo "smoke: PASS"
