#!/usr/bin/env bun
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

/*
 * angular-check: ngc's errors, with Bun's native TypeScript checker doing the
 * type-checking.
 *
 * ngc checks an Angular project in one process: it builds the TypeScript
 * program, analyses the components, generates the TypeScript that type-checks
 * each template, and type-checks all of it. The last part is most of the
 * time. Here Angular's compiler does everything but that (worker.mjs), and
 * `bun check` type-checks the project and the generated check code.
 *
 * The compiler is the project's own @angular/compiler-cli, and the errors
 * are mapped, filtered and printed by it, so the output is ngc's.
 *
 *   angular-check [-p tsconfig.json] [--threads=N] [--out-dir=.angular-check]
 *
 * A project on a version of Angular's compiler this can't drive is checked
 * by ngc itself: slower, never different.
 */

const UNSUPPORTED = 90;

const argument = (name: string) => {
	const index = process.argv.findIndex((value) => value === name || value.startsWith(`${name}=`));
	if (index < 0) return undefined;
	const value = process.argv[index];

	return value?.includes('=') ? value.slice(value.indexOf('=') + 1) : process.argv[index + 1];
};

const root = process.cwd();
const configPath = resolve(root, argument('-p') ?? argument('--project') ?? 'tsconfig.json');
if (!existsSync(configPath)) {
	console.error(`angular-check: ${relative(root, configPath)} not found`);
	process.exit(2);
}
/* Where the generated check files go: .angular-check/ in the project, or
 * --out-dir (a tool that keeps a cache folder, such as absolute typecheck). */
const outDir = resolve(root, argument('--out-dir') ?? '.angular-check');
const threads = argument('--threads');
/* Anything else is a compiler option for the checker (e.g. --skipLibCheck). */
const OWN = new Set(['-p', '--project', '--threads', '--out-dir']);
const passThrough = process.argv.slice(2).filter((value, index, all) => {
	if (OWN.has(value.split('=')[0] ?? '')) return false;
	const previous = all[index - 1];

	return !(previous && OWN.has(previous) && !previous.includes('='));
});

/* ANGULAR_CHECK_TSC=<tsc> checks with that tsc instead of bun check: the same
 * generation and mapping, only the checker differs. The benchmark uses the
 * project's own tsc this way to show the Angular handling equals ngc's, and
 * real tsc 7 to show bun check agrees with it. */
const oracleTsc = process.env.ANGULAR_CHECK_TSC;
const checkCommand = oracleTsc
	? [...(oracleTsc.endsWith('.js') ? [Bun.which('node') ?? process.execPath] : []), oracleTsc, '--noEmit', '--pretty', 'false', ...passThrough]
	: [
			process.execPath,
			'check',
			'--no-pretty',
			'--all',
			// Type-check, never a project's own `check` script in its place.
			'--no-script',
			...(threads ? [`--threads=${threads}`] : []),
			...passThrough
		];

/* Angular's compiler is written for Node and uses far less memory there, so
 * the worker runs on Node when it is installed and on Bun when it isn't.
 * ANGULAR_CHECK_RUNTIME=<path> names one. */
const runtime = process.env.ANGULAR_CHECK_RUNTIME ?? Bun.which('node') ?? process.execPath;

const scratch = mkdtempSync(join(tmpdir(), 'angular-check-'));
const requestFile = join(scratch, 'request.json');
writeFileSync(
	requestFile,
	JSON.stringify({ checkCommand, configPath, outDir, phasesFile: process.env.ANGULAR_CHECK_PHASES ?? null, root })
);
const worker = Bun.spawnSync([runtime, join(import.meta.dir, 'worker.mjs'), requestFile], {
	cwd: root,
	stderr: 'inherit',
	stdin: 'inherit',
	stdout: 'inherit'
});
rmSync(scratch, { force: true, recursive: true });
if (worker.exitCode !== UNSUPPORTED) process.exit(worker.exitCode ?? 3);

/* ngc itself, for a compiler the worker can't drive. */
const ngc = (() => {
	try {
		const manifest = createRequire(join(root, 'package.json')).resolve('@angular/compiler-cli/package.json');

		return join(dirname(manifest), 'bundles', 'src', 'bin', 'ngc.js');
	} catch {
		return null;
	}
})();
if (ngc === null || !existsSync(ngc)) {
	console.error('angular-check: @angular/compiler-cli is not installed in this project, so it was NOT type-checked.');
	process.exit(3);
}
if (process.env.ANGULAR_CHECK_EXPLAIN) console.error('angular-check: checking with ngc instead.');
const fallback = Bun.spawnSync([runtime, ngc, '-p', configPath, '--noEmit'], {
	cwd: root,
	stderr: 'inherit',
	stdin: 'inherit',
	stdout: 'inherit'
});
process.exit(fallback.exitCode ?? 3);
