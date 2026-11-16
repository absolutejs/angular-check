# angular-check

Type-check Angular projects with **Bun's native TypeScript checker** doing the type-checking.
`angular-check` reports what `ngc` reports, in less than half the time.

```sh
bunx @absolutejs/angular-check -p tsconfig.json
```

It prints errors exactly as `ngc` prints them and exits as `ngc` exits, so it can replace
`ngc -p tsconfig.json --noEmit` in a `typecheck` script. It needs [Bun](https://bun.com) 1.4.4 or
newer and a project with `@angular/compiler-cli` installed. It uses Node for one step when Node is
installed (Angular's compiler needs much less memory there) and Bun when it isn't.

angular-check writes the check code it generates to `.angular-check/` in the project, so add
`.angular-check/` to `.gitignore`, or put it in a folder you already ignore with `--out-dir=<dir>`.

## How it works

`ngc` checks a project in one Node process. It builds the TypeScript program, analyses the
components, generates the TypeScript that type-checks each template (a "type-check block", in a
check file beside the component), and type-checks all of it. On a real project the type-checking is
about two thirds of the time.

`angular-check` keeps everything but that:

1. **The same compiler.** Your project's own `@angular/compiler-cli` builds the program, analyses the
   components and generates the check code, as it does for `ngc`. `ngc` keeps the check files in
   memory; here they are written to `.angular-check/`.
2. **Bun's checker.** `bun check` type-checks your project's files and the check files as one
   program. `rootDirs` joins the two trees, so a check file's `import … from './my.component'`
   resolves to your component.
3. **The same errors.** The checker's errors are handed back to Angular's compiler as the program's
   semantic diagnostics, and the compiler does the rest as it does for `ngc`: it maps an error in a
   check file back to its place in the template, drops the ones it always drops, adds its own
   (unknown elements and properties, missing pipes, the extended checks), and prints them.

Because the mapping, the filtering and the printing are Angular's own, the output is `ngc`'s.

It never hides a failure. If the checker fails without naming an error, or a generated check file
doesn't parse, `angular-check` exits with code 3 and says the project was not type-checked.

## Which versions

- **`@angular/compiler-cli` 22.2 and newer:** everything.
- **21:** everything, unless a component's check code has to go inside the component's own file
  (a generic component whose type bound can't be named from another file). From 22.2 the compiler
  can copy that component's source into the check file; before it, the compiler edits the file in
  memory, which a checker reading the disk can't see.

A project it can't check itself is checked by `ngc`, and it says so: slower, never different.

## How it's tested

`bench/compare.sh` runs `ngc` and `angular-check` on the same project in a container with no
network and compares everything each printed, and the exit code. `bench/plant.ts` plants errors of
the kinds a template can have (a missing property, an unknown element, an unknown property, a
missing pipe, a missing handler, `@if` and `@for` on missing names, bindings, type errors on values
the template makes) and, with `--typescript`, errors in component classes, which `ngc` reports
before it checks any template.

On PeerTube's web client (Angular 22.2, TypeScript 6.0, 337 components, strict templates):

| | `ngc` | `angular-check` |
|---|---|---|
| clean project | no errors | no errors |
| 12 template errors planted | 13 errors | the same 13, identical output |
| 2 class errors planted as well | 2 errors | the same 2, identical output |
| time, clean project | about 21 s | about 9 s |
| peak memory of the Angular step | 1.3 GB | 0.77 GB |

The memory row is the Node process only; `bun check` runs while it waits.

## Known limits

- **TypeScript 7's semantics.** The type-checking is TypeScript 7's (`bun check`). Where that differs
  from your project's TypeScript, you see what TypeScript 7 reports.
- **Internal APIs.** Getting the check files out of Angular's compiler uses parts of it that Angular
  doesn't promise to keep. `angular-check` tests for each one and leaves the project to `ngc` when
  one is missing, so a new Angular release can make it slower until it's supported, never wrong.

## License

MIT
