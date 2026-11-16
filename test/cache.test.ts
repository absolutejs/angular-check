import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintOf, keyOf, readsOf, remember, remembered } from '../src/cache';

/* A project on disk: a source folder the tsconfig includes, a file of the
 * program in a sibling package, and one in node_modules. */
const project = () => {
	const base = mkdtempSync(join(tmpdir(), 'angular-check-cache-'));
	const root = join(base, 'app');
	const outDir = join(root, '.angular-check');
	for (const folder of [join(root, 'src'), outDir, join(base, 'shared'), join(root, 'node_modules', 'pkg')]) mkdirSync(folder, { recursive: true });
	const files = {
		config: join(root, 'tsconfig.json'),
		declaration: join(root, 'node_modules', 'pkg', 'index.d.ts'),
		shared: join(base, 'shared', 'index.ts'),
		source: join(root, 'src', 'main.ts'),
		template: join(root, 'src', 'app.component.html')
	};
	for (const file of Object.values(files)) writeFileSync(file, 'one');
	const reads = () =>
		readsOf({
			configs: [files.config],
			outDir,
			programFiles: [files.source, files.shared, files.declaration, join(outDir, 'app', 'src', 'app.component.ngtypecheck.ts')],
			root,
			skipped: [],
			trees: [join(root, 'src')]
		});

	return { base, files, outDir, reads, root };
};
/* A change a second later: a file's time is what is compared. */
const later = (file: string, seconds = 1) => {
	const time = new Date(Date.now() + seconds * 1000);
	utimesSync(file, time, time);
};

test('nothing changed: the same fingerprint, and the result is remembered', () => {
	const { base, outDir, reads, root } = project();
	const key = keyOf({ argv: [], configPath: join(root, 'tsconfig.json'), outDir, root, runtime: 'node' });
	remember(outDir, key, reads(), 1, { stderr: 'src/app.component.html:1:1 - error TS1: x\n', stdout: '' });

	expect(fingerprintOf(reads())).toBe(fingerprintOf(reads()));
	expect(remembered(outDir, key)).toEqual({ exitCode: 1, stderr: 'src/app.component.html:1:1 - error TS1: x\n', stdout: '' });
	rmSync(base, { force: true, recursive: true });
});

test('every kind of change forgets the result', () => {
	const changes: [string, (made: ReturnType<typeof project>) => void][] = [
		['a source file', ({ files }) => later(files.source)],
		['a template', ({ files }) => later(files.template)],
		['a file of another package', ({ files }) => later(files.shared)],
		['a declaration file in node_modules', ({ files }) => later(files.declaration)],
		['the tsconfig', ({ files }) => later(files.config)],
		['a file with a new size and the same time', ({ files }) => writeFileSync(files.source, 'longer')],
		['a new file in an included folder', ({ root }) => writeFileSync(join(root, 'src', 'new.ts'), '')],
		['a file that isn\'t code in an included folder', ({ root }) => writeFileSync(join(root, 'src', 'template.html'), '')],
		['a removed file', ({ files }) => rmSync(files.source)],
		['a new file beside one of another package', ({ base }) => writeFileSync(join(base, 'shared', 'index.d.ts'), '')],
		['a newly installed package', ({ root }) => mkdirSync(join(root, 'node_modules', 'other'))],
		['a lockfile', ({ root }) => writeFileSync(join(root, 'bun.lock'), '')]
	];
	for (const [name, change] of changes) {
		const made = project();
		const key = keyOf({ argv: [], configPath: made.files.config, outDir: made.outDir, root: made.root, runtime: 'node' });
		remember(made.outDir, key, made.reads(), 0, { stderr: '', stdout: '' });
		expect(remembered(made.outDir, key), `before ${name}`).toEqual({ exitCode: 0, stderr: '', stdout: '' });
		change(made);
		expect(remembered(made.outDir, key), name).toBeNull();
		rmSync(made.base, { force: true, recursive: true });
	}
});

test('another command is another run', () => {
	const { base, files, outDir, reads, root } = project();
	const key = keyOf({ argv: [], configPath: files.config, outDir, root, runtime: 'node' });
	remember(outDir, key, reads(), 0, { stderr: '', stdout: '' });

	expect(remembered(outDir, keyOf({ argv: ['--skipLibCheck'], configPath: files.config, outDir, root, runtime: 'node' }))).toBeNull();
	expect(remembered(outDir, keyOf({ argv: [], configPath: join(root, 'tsconfig.app.json'), outDir, root, runtime: 'node' }))).toBeNull();
	expect(remembered(outDir, keyOf({ argv: [], configPath: files.config, outDir, root, runtime: 'bun' }))).toBeNull();
	rmSync(base, { force: true, recursive: true });
});

test('what a run writes is not what it read', () => {
	const { base, files, outDir, reads, root } = project();
	const key = keyOf({ argv: [], configPath: files.config, outDir, root, runtime: 'node' });
	remember(outDir, key, reads(), 0, { stderr: '', stdout: '' });
	writeFileSync(join(outDir, 'tsconfig.json'), '{}');

	expect(remembered(outDir, key)).toEqual({ exitCode: 0, stderr: '', stdout: '' });
	rmSync(base, { force: true, recursive: true });
});
