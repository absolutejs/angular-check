import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

/*
 * A run's result, remembered with everything it read. The next run with the
 * same command prints it again, and does nothing else, when none of that has
 * changed.
 *
 * What a run read:
 *
 *   - every file of the program, as Angular's compiler names them;
 *   - every file under the folders the tsconfig includes, whatever it is: a
 *     new file there can join the program, and a component's template and
 *     styles are files the program doesn't hold;
 *   - the tsconfig and every config it extends;
 *   - for a new file elsewhere that would change what an import means: each
 *     folder that holds a file of the program outside node_modules, and, for
 *     packages, each lockfile, node_modules and node_modules/@types from the
 *     project up.
 *
 * A file is the same when its size and modification time are; a folder,
 * when its modification time is (it changes when an entry is added or
 * removed). The key holds what isn't a file: this tool's version, Bun's,
 * the runtime the Angular step runs on, the command and the environment
 * variables that change a run.
 *
 * Only a run that finished its check is remembered: what it printed and its
 * exit code. One that couldn't check (exit 3) runs again every time.
 */

const VERSION = 1;
const LOCKFILES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'package.json'];
/* Folders a tsconfig never includes unless it names them. */
const NEVER_INCLUDED = new Set(['node_modules', 'bower_components', 'jspm_packages', '.git']);

export type Reads = {
	/** Folders whose own modification time says a file was added or removed. */
	folders: string[];
	/** Files, by size and modification time. */
	files: string[];
	/** Folders read through: every file under them. */
	trees: string[];
	/** Folders left out of the trees: the output folder, and the tsconfig's `exclude` where it names a folder. */
	skipped: string[];
};
export type Printed = { stderr: string; stdout: string };
type Remembered = Printed & { exitCode: number; fingerprint: string; key: string; reads: Reads; version: number };

const stamp = (path: string) => {
	try {
		const stats = statSync(path);

		return stats.isDirectory() ? `d${stats.mtimeMs}` : `${stats.size}:${stats.mtimeMs}`;
	} catch {
		return 'missing';
	}
};
const walk = (folder: string, skipped: Set<string>, lines: string[]) => {
	let entries;
	try {
		entries = readdirSync(folder, { withFileTypes: true });
	} catch {
		lines.push(`${folder}\tmissing`);

		return;
	}
	for (const entry of entries) {
		const path = join(folder, entry.name);
		if (entry.isDirectory()) {
			if (!NEVER_INCLUDED.has(entry.name) && !skipped.has(path)) walk(path, skipped, lines);
		} else lines.push(`${path}\t${stamp(path)}`);
	}
};

/** What everything a run read looks like now. */
export const fingerprintOf = (reads: Reads) => {
	const lines: string[] = [];
	const skipped = new Set(reads.skipped);
	for (const tree of reads.trees) walk(tree, skipped, lines);
	for (const path of [...reads.files, ...reads.folders]) lines.push(`${path}\t${stamp(path)}`);
	const hash = createHash('sha256');
	for (const line of lines.sort()) hash.update(`${line}\n`);

	return hash.digest('hex');
};

/** What a run read, from what Angular's compiler says the program is. */
export const readsOf = (given: {
	configs: string[];
	outDir: string;
	programFiles: string[];
	root: string;
	skipped: string[];
	trees: string[];
}): Reads => {
	const inTree = (path: string) => given.trees.some((tree) => !relative(tree, path).startsWith('..') && !isAbsolute(relative(tree, path)));
	const generated = (path: string) => !relative(given.outDir, path).startsWith('..');
	const files = new Set(given.configs);
	const folders = new Set<string>();
	for (const file of given.programFiles) {
		if (generated(file)) continue;
		if (!inTree(file)) files.add(file);
		if (!file.includes('/node_modules/') && !inTree(file)) folders.add(dirname(file));
	}
	for (let folder = given.root; ; folder = dirname(folder)) {
		for (const name of LOCKFILES) files.add(join(folder, name));
		folders.add(join(folder, 'node_modules'));
		folders.add(join(folder, 'node_modules', '@types'));
		if (folder === parse(folder).root) break;
	}

	return { files: [...files].sort(), folders: [...folders].sort(), skipped: [given.outDir, ...given.skipped], trees: given.trees };
};

/** What isn't a file and changes a run. */
export const keyOf = (given: { argv: string[]; configPath: string; outDir: string; root: string; runtime: string }) => {
	const own = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as { version?: string };

	return JSON.stringify({
		angularCheck: own.version ?? '',
		argv: given.argv,
		bun: process.versions.bun,
		configPath: resolve(given.configPath),
		explain: process.env.ANGULAR_CHECK_EXPLAIN ?? '',
		outDir: given.outDir,
		platform: `${process.platform}-${process.arch}`,
		root: given.root,
		runtime: given.runtime,
		tsc: process.env.ANGULAR_CHECK_TSC ?? ''
	});
};

const fileOf = (outDir: string) => join(outDir, 'cache.json');

/** The last run's result, when this run would read exactly what it read. */
export const remembered = (outDir: string, key: string) => {
	const file = fileOf(outDir);
	if (!existsSync(file)) return null;
	try {
		const last = JSON.parse(readFileSync(file, 'utf8')) as Remembered;
		if (last.version !== VERSION || last.key !== key || fingerprintOf(last.reads) !== last.fingerprint) return null;

		return { exitCode: last.exitCode, stderr: last.stderr, stdout: last.stdout };
	} catch {
		return null;
	}
};

export const remember = (outDir: string, key: string, reads: Reads, exitCode: number, printed: Printed) => {
	const result: Remembered = { ...printed, exitCode, fingerprint: fingerprintOf(reads), key, reads, version: VERSION };
	// A project checked without anything generated has no output folder yet.
	mkdirSync(outDir, { recursive: true });
	writeFileSync(fileOf(outDir), JSON.stringify(result));
};
