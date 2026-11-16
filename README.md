# angular-check

Type-check Angular projects with **Bun's native TypeScript checker** doing the type-checking.
`angular-check` reports what `ngc` reports. On Angular 22.2 and newer it does so in about half the
time or less; on older versions it is never different, and faster only for some projects.

```sh
bunx @absolutejs/angular-check -p tsconfig.json
```

It prints errors exactly as `ngc` prints them and exits as `ngc` exits, so it can replace
`ngc -p tsconfig.json --noEmit` in a `typecheck` script. It needs [Bun](https://bun.com) 1.4.4 or
newer and a project with `@angular/compiler-cli` installed. It uses Node for one step when Node is
installed (Angular's compiler needs much less memory there) and Bun when it isn't.

angular-check writes the check code it generates to `.angular-check/` in the project, so add
`.angular-check/` to `.gitignore`, or put it in a folder you already ignore with `--out-dir=<dir>`.

A run that would read exactly what the last one read prints that run's result again and does nothing
else, in well under a tenth of a second. What a run read is every file of the program, every file
under the folders your tsconfig includes (templates and styles among them), the tsconfig and the
configs it extends, and your lockfile and `node_modules` folders; a file counts as changed when its
size or modification time has. `--no-cache` (or `ANGULAR_CHECK_CACHE=0`) always runs the check.

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

- **`@angular/compiler-cli` 22.2 and newer:** the fast path, for every project.
- **Older (tested on 21.2 and 22.0):** the fast path, unless a component's check code has to go inside
  the component's own file (a generic component whose type bound can't be named from another file).
  From 22.2 the compiler can copy that component's source into the check file. Before it, the
  compiler edits the file in memory, which a checker reading the disk can't see, so such a project is
  type-checked with its own TypeScript, as `ngc` does it: the same output, in about the same time.

`ANGULAR_CHECK_EXPLAIN=1` says which path a project took and why.

## How it's tested

The checker is the one thing `angular-check` lets you swap, so `bench/compare.sh` runs a project
four ways in a container with no network, and each pair isolates one part:

| Run | Checker | Must equal | Proves |
|---|---|---|---|
| `ngc` | project's TypeScript | the oracle | |
| `angular-check` | project's `tsc` | `ngc` | the Angular handling |
| `angular-check` | `tsc` 7.0.2 | | what TypeScript 7 changes, measured |
| `angular-check` | `bun check` | the `tsc` 7 run | Bun's checker |

Everything each run printed, and its exit code, is compared. `bench/sweep.sh` does that for every
project in `bench/corpus.txt` three times: as it is, with errors planted in templates
(`bench/plant.ts`: a missing property, an unknown element, an unknown property, a missing pipe, a
missing handler, `@if` and `@for` on missing names, bindings, type errors on values the template
makes), and with errors planted in component classes as well, which `ngc` reports before it checks
any template.

| Project | Angular | Path | Handling = `ngc` | `bun check` = `tsc` 7 | TypeScript 7 changes |
|---|---|---|---|---|---|
| PeerTube web client | 22.2 | fast | ✓ ✓ ✓ | ✓ ✓ ✓ | 0 |
| ng-zorro-antd library | 22.2 | fast | ✓ ✓ ✓ | ✓ ✓ ✓ | 1 |
| ionic-conference-app | 22.0 | fast | ✓ ✓ ✓ | ✓ ✓ ✓ | 0 |
| angular-realworld-example-app | 21.2 | fast | ✓ ✓ ✓ | ✓ ✓ ✓ | 0 |
| Bitwarden web vault | 21.2 | project's TypeScript | ✓ ✓ ✓ | ✓ ✓ ✓ | 0 |

The three marks are the three cases. The one TypeScript 7 change is an error `tsc` 7.0.2 reports in
ng-zorro-antd's own code and TypeScript 6 doesn't.

On PeerTube's web client (337 components, strict templates), a clean check takes `ngc` about 21 s and
`angular-check` about 9 s on the same machine, and the Angular step peaks at 0.77 GB where `ngc`
peaks at 1.3 GB. (`bun check` runs while that step waits; its memory is on top.) On Bitwarden's web
vault, which takes the other path, the two take about the same time.

## Known limits

- **TypeScript 7's semantics.** On the fast path the type-checking is TypeScript 7's (`bun check`).
  Where that differs from your project's TypeScript, you see what TypeScript 7 reports. `ngc` checks
  no template once a class has an error, so one error only TypeScript 7 reports hides the template
  errors until it is fixed, as it would under `ngc` on TypeScript 7. Options whose default changed
  between TypeScript versions (`strict` and its family, `types`) are given the meaning your project's
  TypeScript gives them.
- **Internal APIs.** Getting the check files out of Angular's compiler uses parts of it that Angular
  doesn't promise to keep. `angular-check` tests for each one and leaves the project to `ngc` when
  one is missing, so a new Angular release can make it slower until it's supported, never wrong.

## License

MIT
