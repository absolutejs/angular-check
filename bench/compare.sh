#!/usr/bin/env bash
# ngc and angular-check on one project, in a container with no network: what
# each printed and its exit code, compared. Third-party code never runs on
# the host.
#   bench/compare.sh <project-dir> <tsconfig> [workspace-root]
# For a package in a monorepo, pass the root that holds its node_modules.
set -uo pipefail
project=$(realpath "$1"); tsconfig=$2; workspace=$(realpath "${3:-$1}")
tool=$(realpath "$(dirname "$0")/..")
bun_binary=${BUN_BINARY:-$(command -v bun)}
inside=/project/$(realpath --relative-to="$workspace" "$project")
docker run --rm --network none --memory "${MEMORY:-6g}" --user "$(id -u):$(id -g)" -e HOME=/tmp \
	-v "$workspace":/project -v "$tool":/tool:ro -v "$bun_binary":/usr/local/bin/bun:ro \
	-w "$inside" node:22-bookworm bash -c '
	plain() { sed "s/\x1b\[[0-9;]*m//g" "$@"; }
	ngc=$(node -e "console.log(require.resolve(\"@angular/compiler-cli/package.json\").replace(/package.json$/, \"bundles/src/bin/ngc.js\"))")
	started=$(date +%s%N)
	node "$ngc" -p "'"$tsconfig"'" --noEmit > /tmp/ngc.out 2> /tmp/ngc.err; ngc_exit=$?
	ngc_ms=$(( ($(date +%s%N) - started) / 1000000 ))
	started=$(date +%s%N)
	ANGULAR_CHECK_PHASES=/tmp/phases.json bun /tool/src/cli.ts -p "'"$tsconfig"'" --out-dir=/tmp/angular-check > /tmp/ours.out 2> /tmp/ours.err; ours_exit=$?
	ours_ms=$(( ($(date +%s%N) - started) / 1000000 ))
	plain /tmp/ngc.out /tmp/ngc.err > /tmp/ngc.txt; plain /tmp/ours.out /tmp/ours.err > /tmp/ours.txt
	echo "ngc: exit $ngc_exit, $(grep -c "error " /tmp/ngc.txt) errors, $ngc_ms ms"
	echo "angular-check: exit $ours_exit, $(grep -c "error " /tmp/ours.txt) errors, $ours_ms ms"
	cat /tmp/phases.json 2>/dev/null; echo
	if [ "$ngc_exit" = "$ours_exit" ] && cmp -s /tmp/ngc.txt /tmp/ours.txt; then
		echo "identical: $(wc -l < /tmp/ngc.txt) lines of output and the exit code"
	else
		echo "DIFFERENT"; diff /tmp/ngc.txt /tmp/ours.txt | head -40 | cut -c1-220; exit 1
	fi'
