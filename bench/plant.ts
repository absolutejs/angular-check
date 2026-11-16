#!/usr/bin/env bun
import { appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Plants errors in a copy of an Angular project, of the kinds a template can
 * have: each exercises a different part of what ngc reports, and so of what
 * angular-check has to hand back to Angular's compiler unchanged.
 *
 *   bun bench/plant.ts <app-dir> [--typescript]
 *
 * --typescript also plants two errors in component classes. ngc reports those
 * and stops before it checks any template, which angular-check must do too.
 */

const [appDir = '', ...flags] = process.argv.slice(2);
if (!appDir) throw new Error('usage: bun bench/plant.ts <app-dir> [--typescript]');

const filesUnder = (folder: string, suffix: string): string[] =>
	readdirSync(folder, { withFileTypes: true })
		.sort((first, second) => first.name.localeCompare(second.name))
		.flatMap((entry) => {
			const path = join(folder, entry.name);
			if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesUnder(path, suffix);

			return entry.name.endsWith(suffix) ? [path] : [];
		});

const TEMPLATE_ERRORS = [
	// A name the component doesn't have, read in an interpolation.
	'<p>{{ plantedMissingProperty }}</p>',
	'<p>{{ plantedMissing.deep.value }}</p>',
	// What Angular itself reports, with no help from TypeScript.
	'<planted-unknown-element></planted-unknown-element>',
	'<div [plantedUnknownProperty]="1"></div>',
	'<p>{{ 1 | plantedNoSuchPipe }}</p>',
	// A handler, and the control flow blocks.
	'<button (click)="plantedMissingMethod($event)">x</button>',
	'@if (plantedMissingCondition) { <p>x</p> }',
	'@for (item of plantedMissingList; track item) { <p>{{ item }}</p> }',
	// Bindings.
	'<p [class.active]="plantedMissingFlag"></p>',
	'<input [value]="plantedMissingValue" (input)="plantedMissingHandler()" />',
	// A type error on a value the template itself makes.
	'<p>{{ (1).plantedNotOnNumber }}</p>',
	'<p>{{ "text".toFixed(2) }}</p>'
];
const CLASS_ERRORS = ["export const plantedWrongType: number = 'text'", 'export const plantedMissingName = plantedNotDefined + 1'];
const FIRST_TEMPLATE = 3;
const FIRST_CLASS = 5;
const CLASS_STEP = 37;

const templates = filesUnder(appDir, '.html');
const step = Math.max(1, Math.floor(templates.length / TEMPLATE_ERRORS.length));
let planted = 0;
for (const [index, error] of TEMPLATE_ERRORS.entries()) {
	const template = templates[(index * step + FIRST_TEMPLATE) % templates.length];
	if (template === undefined) continue;
	appendFileSync(template, `\n${error}\n`);
	planted += 1;
}
if (flags.includes('--typescript')) {
	const classes = filesUnder(appDir, '.component.ts');
	for (const [index, error] of CLASS_ERRORS.entries()) {
		const file = classes[(index * CLASS_STEP + FIRST_CLASS) % classes.length];
		if (file === undefined) continue;
		appendFileSync(file, `\n${error}\n`);
		planted += 1;
	}
}
console.log(`planted ${planted} errors`);
