#!/usr/bin/env bash
# Builds the comparison corpus in <dir>: every project in bench/corpus.txt at
# its commit, installed by its own package manager inside a container with
# install scripts off. Nothing from these projects runs on the host.
#   bench/setup-corpus.sh <dir> [name]
set -euo pipefail
dir=$(realpath -m "$1"); only=${2:-}; tool=$(realpath "$(dirname "$0")/..")
mkdir -p "$dir"
grep -v '^#' "$tool/bench/corpus.txt" | while IFS='|' read -r name repository commit _project _tsconfig install; do
	[ -n "$only" ] && [ "$only" != "$name" ] && continue
	clone=$dir/$name
	if [ ! -d "$clone/.git" ]; then
		git init -q "$clone" && git -C "$clone" remote add origin "https://github.com/$repository.git"
		git -C "$clone" fetch -q --depth 1 origin "$commit" && git -C "$clone" checkout -q FETCH_HEAD
	fi
	where=$clone; [ "$install" != "-" ] && where=$clone/$install
	docker run --rm --memory "${MEMORY:-6g}" --user "$(id -u):$(id -g)" -e HOME=/tmp -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
		-e npm_config_cache=/tmp/npm -v "${BUN_BINARY:-$(command -v bun)}":/usr/local/bin/bun:ro -v "$clone":/project -w "/project${where#"$clone"}" node:22-bookworm bash -c '
		if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --ignore-scripts --frozen-lockfile
		elif [ -f pnpm-lock.yaml ]; then corepack pnpm install --ignore-scripts --frozen-lockfile
		elif [ -f yarn.lock ]; then corepack yarn install --mode=skip-build || corepack yarn install --ignore-scripts
		else npm ci --ignore-scripts --no-audit --no-fund || npm ci --ignore-scripts --no-audit --no-fund --legacy-peer-deps; fi' > "$dir/$name.install.log" 2>&1 \
		&& echo "ready: $name" || echo "INSTALL FAILED: $name (see $dir/$name.install.log)"
done
