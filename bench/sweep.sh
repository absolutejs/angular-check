#!/usr/bin/env bash
# The whole comparison over a corpus built by bench/setup-corpus.sh: each
# project as it is, with template errors planted, and with class errors
# planted as well, ngc against angular-check each time. One line per case.
#   bench/sweep.sh <corpus-dir> [name]
set -uo pipefail
dir=$(realpath "$1"); only=${2:-}; tool=$(realpath "$(dirname "$0")/..")
grep -v '^#' "$tool/bench/corpus.txt" | while IFS='|' read -r name _repository _commit project tsconfig _install; do
	[ -n "$only" ] && [ "$only" != "$name" ] && continue
	clone=$dir/$name; app=$clone/$project
	restore() { git -C "$clone" checkout -q -- . ; }
	run() { # <case>
		out=$("$tool/bench/compare.sh" "$app" "$tsconfig" "$clone" 2>&1)
		echo "$name [$1] $(echo "$out" | grep -E '^(identical|DIFFERENT)' | head -1) | $(echo "$out" | grep -E '^(ngc|angular-check):' | tr '\n' ';')"
		echo "$out" > "$dir/$name.$1.log"
	}
	restore; run clean
	bun "$tool/bench/plant.ts" "$app" > /dev/null; run templates; restore
	bun "$tool/bench/plant.ts" "$app" --typescript > /dev/null; run classes; restore
done
