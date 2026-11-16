/*
 * The Angular half of angular-check, in a process of its own (Node when it is
 * installed, Bun otherwise): everything ngc does to check a project, with the
 * TypeScript checker's answers taken from a checker run on the command line.
 *
 *   1. Angular's compiler (the project's own @angular/compiler-cli) builds the
 *      program, analyses its components and generates the TypeScript that
 *      type-checks each template: a "type-check block", in a check file beside
 *      the component. ngc keeps those files in memory. Here they are written
 *      to the output folder.
 *   2. The checker checks the project's files and the check files as one
 *      program (rootDirs joins the two trees).
 *   3. Its errors are handed to Angular's compiler as the two programs'
 *      semantic diagnostics, and Angular does the rest exactly as it does for
 *      ngc: it maps an error in a check file back to the template, drops the
 *      ones it always drops, and adds its own (unknown elements and
 *      properties, missing pipes, the extended checks).
 *
 * Exit codes: Angular's own (0, or 1 with errors); 3 when the check didn't
 * happen; 90 when this version of Angular's compiler isn't one this file
 * knows how to drive, and the caller should run ngc instead.
 *
 *   worker.mjs <request.json>
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const UNSUPPORTED = 90;
const NOT_CHECKED = 3;

const request = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8'));
const { checkCommand, configPath, outDir, phasesFile, root } = request;

/* The project's own packages: the compiler that would have checked it, and
 * the TypeScript that compiler runs on. */
const projectRequire = createRequire(join(root, 'package.json'));
const load = async (name) => import(pathToFileURL(projectRequire.resolve(name)).href);
const compilerCli = await load('@angular/compiler-cli');
const ts = (await load('typescript')).default;
const {
	InliningMode,
	NgtscProgram,
	createCompilerHost,
	defaultGatherDiagnostics,
	exitCodeFromResult,
	formatDiagnostics,
	readConfiguration
} = compilerCli;

const unsupported = (reason) => {
	console.error(`angular-check: ${reason}`);
	process.exit(UNSUPPORTED);
};
if (!NgtscProgram || !readConfiguration || !defaultGatherDiagnostics || !formatDiagnostics || !exitCodeFromResult)
	unsupported("this @angular/compiler-cli doesn't export what angular-check drives");

const times = {};
let lapStarted = performance.now();
const lap = (name) => {
	times[name] = Math.round(performance.now() - lapStarted);
	lapStarted = performance.now();
};

const config = readConfiguration(configPath);
if (config.errors.length > 0) {
	console.error(formatDiagnostics(config.errors));
	process.exit(exitCodeFromResult(config.errors));
}
/* Checking only: nothing is emitted, whatever the project's config says. */
const options = { ...config.options, noEmit: true };
const program = new NgtscProgram(config.rootNames, options, createCompilerHost({ options }));
lap('createProgramMs');

const { compiler } = program;
if (!compiler?.programDriver || typeof compiler.ensureAnalyzed !== 'function')
	unsupported("this @angular/compiler-cli's compiler isn't laid out as angular-check expects");
/* A component whose check code can't be written outside its own file (it has
 * a generic bound that can't be named from elsewhere). From 22.2 the compiler
 * can copy the component's source into the check file instead, and keep only
 * the errors in what it generated: that mode is used when it exists. Before
 * it, the compiler edits the component's file in memory, which a checker
 * reading the disk would never see, so a project that needs it is left to
 * ngc (below). */
const copiesSource = InliningMode?.CopySourceToTcb !== undefined;
if (copiesSource) compiler.programDriver.inliningMode = InliningMode.CopySourceToTcb;
await compiler.analyzeAsync();
lap('analysisMs');
const templateChecker = compiler.ensureAnalyzed().templateTypeChecker;
if (typeof templateChecker?.generateAllTypeCheckBlocks !== 'function')
	unsupported("this @angular/compiler-cli's template type checker isn't laid out as angular-check expects");
templateChecker.generateAllTypeCheckBlocks();
lap('generateMs');

/* The check files, each at its own absolute path under the output folder. */
const checkProgram = compiler.getCurrentProgram();
const userProgram = program.getTsProgram();
if (!copiesSource) {
	const edited = userProgram
		.getSourceFiles()
		.find((file) => !file.isDeclarationFile && checkProgram.getSourceFile(file.fileName)?.text !== file.text);
	if (edited)
		unsupported(
			`${relative(root, edited.fileName)} has a component whose check code has to go inside its own file, which needs @angular/compiler-cli 22.2 or newer`
		);
}
const CHECK_FILE = '.ngtypecheck.ts';
const mirrorOf = (fileName) => join(outDir, relative(parse(fileName).root, fileName));
rmSync(outDir, { force: true, recursive: true });
mkdirSync(outDir, { recursive: true });
const checkFiles = new Map();
for (const file of checkProgram.getSourceFiles()) {
	// A component with no template to check has a check file with nothing in it.
	if (!file.fileName.endsWith(CHECK_FILE) || file.statements.length === 0) continue;
	const mirrored = mirrorOf(file.fileName);
	mkdirSync(dirname(mirrored), { recursive: true });
	writeFileSync(mirrored, file.text);
	checkFiles.set(mirrored, file.fileName);
}
/* A check file resolves what it imports from its own folder: a package by
 * walking up through node_modules folders, and the nearest package.json says
 * which module format the file is. So each folder above a component that has
 * either gets a link to it at the same place under the output folder, and a
 * check file resolves every import to the file its component would. */
const linked = new Set();
for (const fileName of checkFiles.values()) {
	for (let folder = dirname(fileName); !linked.has(folder); folder = dirname(folder)) {
		linked.add(folder);
		for (const entry of ['node_modules', 'package.json']) {
			const real = join(folder, entry);
			const mirrored = join(mirrorOf(folder), entry);
			if (!existsSync(real) || existsSync(mirrored)) continue;
			mkdirSync(dirname(mirrored), { recursive: true });
			symlinkSync(real, mirrored);
		}
		if (folder === parse(folder).root) break;
	}
}
const checkConfig = join(outDir, 'tsconfig.json');
writeFileSync(
	checkConfig,
	JSON.stringify({
		compilerOptions: {
			noEmit: true,
			/* The files TypeScript 7 checks must sit under rootDir even when
			 * nothing is emitted, and the check files are outside the project's. */
			rootDir: null,
			// A check file imports its component by a relative path.
			rootDirs: [parse(outDir).root, outDir]
		},
		extends: configPath,
		files: [...config.rootNames, ...checkFiles.keys()],
		include: []
	})
);
lap('writeMs');

const checked = spawnSync(checkCommand[0], [...checkCommand.slice(1), '-p', checkConfig], {
	cwd: root,
	encoding: 'utf8',
	maxBuffer: 2 ** 30
});
lap('checkMs');

/* The checker's errors, by the file each is in. */
const ERROR_LINE = /^(.+?)\((\d+),(\d+)\): (error|warning) TS(\d+): (.*)$/;
const GLOBAL_ERROR = /^error TS\d+: /;
const found = new Map();
const global = [];
let last = null;
for (const line of (checked.stdout ?? '').split('\n')) {
	const match = ERROR_LINE.exec(line);
	if (!match) {
		// A message's further lines are indented under it.
		if (last && line.startsWith('  ')) last.messageText += `\n${line}`;
		else if (GLOBAL_ERROR.test(line)) global.push(line);
		continue;
	}
	const [, file = '', line1 = '0', column1 = '0', severity, code = '0', messageText = ''] = match;
	const absolute = isAbsolute(file) ? file : resolve(root, file);
	last = {
		category: severity === 'error' ? ts.DiagnosticCategory.Error : ts.DiagnosticCategory.Warning,
		code: Number(code),
		column: Number(column1),
		line: Number(line1),
		messageText
	};
	const fileName = checkFiles.get(absolute) ?? absolute;
	const list = found.get(fileName);
	if (list) list.push(last);
	else found.set(fileName, [last]);
}
const reported = [...found.values()].reduce((sum, list) => sum + list.length, 0);
/* A checker that failed and named no error didn't check (a crash, a bad
 * option). Never report that as clean. */
if ((checked.status !== 0 && reported === 0) || checked.error || global.length > 0) {
	process.stderr.write(`${checked.stdout ?? ''}${checked.stderr ?? ''}`);
	if (checked.error) console.error(String(checked.error));
	console.error('angular-check: the checker failed (above), so the project was NOT type-checked.');
	process.exit(NOT_CHECKED);
}
/* A check file that doesn't parse is this tool's or Angular's doing, never the
 * project's, and a command-line checker checks no types once a file doesn't
 * parse. Syntax errors are TS1000 to TS1999. */
const SYNTAX_ERRORS = { first: 1000, last: 1999 };
for (const [fileName, list] of found) {
	if (!fileName.endsWith(CHECK_FILE)) continue;
	const syntax = list.find((item) => item.code >= SYNTAX_ERRORS.first && item.code <= SYNTAX_ERRORS.last);
	if (!syntax) continue;
	console.error(
		`angular-check: the check code generated for ${relative(root, fileName)} doesn't parse (line ${syntax.line}: ${syntax.messageText}).`
	);
	console.error('angular-check: the project was NOT type-checked. Please report the component above.');
	process.exit(NOT_CHECKED);
}

/* Each error as a TypeScript diagnostic on Angular's own source file for the
 * path. The length isn't in a checker's one-line output; Angular maps an
 * error in a check file by where it starts, and for one in the project's own
 * code the token there is what gets underlined. */
const scanner = ts.createScanner(ts.ScriptTarget.Latest, true);
const diagnosticsOf = (file) =>
	(found.get(file.fileName) ?? []).map((item) => {
		const start = ts.getPositionOfLineAndCharacter(file, item.line - 1, item.column - 1);
		scanner.setText(file.text, start);
		scanner.scan();

		return {
			category: item.category,
			code: item.code,
			file,
			length: Math.max(1, scanner.getTokenEnd() - start),
			messageText: item.messageText,
			start
		};
	});
const fromChecker = (ofProgram) => (file) => (file ? diagnosticsOf(file) : ofProgram.getSourceFiles().flatMap(diagnosticsOf));
checkProgram.getSemanticDiagnostics = fromChecker(checkProgram);
userProgram.getSemanticDiagnostics = fromChecker(userProgram);

const diagnostics = defaultGatherDiagnostics(program);
lap('gatherMs');
// As ngc prints them.
if (diagnostics.length > 0) console.error(formatDiagnostics(diagnostics));
if (phasesFile)
	writeFileSync(
		phasesFile,
		JSON.stringify({
			...times,
			checkFiles: checkFiles.size,
			checkerErrors: reported,
			peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
			reported: diagnostics.length
		})
	);
process.exit(exitCodeFromResult(diagnostics));
