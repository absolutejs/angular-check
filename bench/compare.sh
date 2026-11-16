#!/usr/bin/env bash
# ngc against angular-check on one project, in a container with no network.
# The checker is the one thing angular-check lets you swap, so it runs three
# ways, and each pair isolates one part:
#
#   ngc                               the oracle (the project's TypeScript)
#   angular-check, project's tsc      must equal ngc: the Angular handling
#   angular-check, tsc 7              what TypeScript 7 changes, measured
#   angular-check, bun check          must equal the tsc 7 run: Bun's checker
#
# What each printed and its exit code are compared. Third-party code never
# runs on the host.
#   bench/compare.sh <project-dir> <tsconfig> [workspace-root]
# For a package in a monorepo, pass the root that holds its node_modules.
set -uo pipefail
project=$(realpath "$1"); tsconfig=$2; workspace=$(realpath "${3:-$1}")
tool=$(realpath "$(dirname "$0")/..")
bun_binary=${BUN_BINARY:-$(command -v bun)}
inside=/project/$(realpath --relative-to="$workspace" "$project")
docker run --rm --network none --memory "${MEMORY:-6g}" --user "$(id -u):$(id -g)" -e HOME=/tmp \
	-v "$workspace":/project -v "$tool":/tool:ro -v "$bun_binary":/usr/local/bin/bun:ro \
	-v "$tool/node_modules/@typescript/typescript-linux-x64":/tsc7:ro \
	-w "$inside" node:22-bookworm bash -c '
	config="'"$tsconfig"'"
	plain() { sed "s/\x1b\[[0-9;]*m//g" "$@"; }
	resolved() { node -e "console.log(require.resolve(\"$1\"))"; }
	ngc=$(resolved @angular/compiler-cli/package.json | sed "s|package.json\$|bundles/src/bin/ngc.js|")
	project_tsc=$(resolved typescript/package.json | sed "s|package.json\$|lib/tsc.js|")
	leg() { # <name> <command...>: output to /tmp/<name>.txt, exit code and time to /tmp/<name>.meta
		name=$1; shift; started=$(date +%s%N)
		"$@" > /tmp/$name.out 2> /tmp/$name.err; code=$?
		plain /tmp/$name.out /tmp/$name.err > /tmp/$name.txt
		echo "$code $(( ($(date +%s%N) - started) / 1000000 ))" > /tmp/$name.meta
		echo "$name: exit $code, $(grep -c "error " /tmp/$name.txt) errors, $(cut -d" " -f2 /tmp/$name.meta) ms"
	}
	same() { [ "$(cut -d" " -f1 /tmp/$1.meta)" = "$(cut -d" " -f1 /tmp/$2.meta)" ] && cmp -s /tmp/$1.txt /tmp/$2.txt; }
	leg ngc node "$ngc" -p "$config" --noEmit
	leg project-tsc env ANGULAR_CHECK_TSC="$project_tsc" bun /tool/src/cli.ts -p "$config" --out-dir=/tmp/ac-project
	leg tsc7 env ANGULAR_CHECK_TSC=/tsc7/lib/tsc bun /tool/src/cli.ts -p "$config" --out-dir=/tmp/ac-tsc7
	leg bun-check env ANGULAR_CHECK_PHASES=/tmp/phases.json bun /tool/src/cli.ts -p "$config" --out-dir=/tmp/ac-bun
	cat /tmp/phases.json 2>/dev/null; echo
	status=0
	if same ngc project-tsc; then echo "handling: identical to ngc"; else echo "handling: DIFFERENT from ngc"; diff /tmp/ngc.txt /tmp/project-tsc.txt | head -30 | cut -c1-220; status=1; fi
	if same tsc7 bun-check; then echo "checker: bun check identical to tsc 7"; else echo "checker: bun check DIFFERENT from tsc 7"; diff /tmp/tsc7.txt /tmp/bun-check.txt | head -30 | cut -c1-220; status=1; fi
	changes=$(diff <(grep "error " /tmp/ngc.txt) <(grep "error " /tmp/bun-check.txt) | grep -c "^[<>]")
	echo "typescript 7 changes: $changes error lines differ between ngc and angular-check on bun check"
	diff <(grep "error " /tmp/ngc.txt) <(grep "error " /tmp/bun-check.txt) | grep "^[<>]" | head -6 | cut -c1-200
	[ $status = 0 ] && echo "identical"
	exit $status'
