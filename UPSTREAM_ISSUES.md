# Upstream Issues

Bugs in angular-check's **dependencies** (Angular's `@angular/compiler-cli`, Bun's `bun check`) that
angular-check works around. Each entry has the symptom, the upstream issue to watch, the
workaround, and what to change once upstream fixes it.

angular-check runs **the project's own** `@angular/compiler-cli`, not a pinned copy. So an upstream
fix doesn't retire a workaround on its own: it stays as long as angular-check supports a version
without the fix, and it must be harmless on versions that have it.

Last checked: **2026-11-16**, on `@angular/compiler-cli` 22.2.2 and 22.2.4.

| #   | Problem                                                                  | Upstream                                  | Fixed?                     |
| --- | ------------------------------------------------------------------------ | ----------------------------------------- | -------------------------- |
| 1   | A copied check file's leading imports are joined with nothing between    | angular/angular#71547 closed (PR #71673)  | On `main`; not seen in 22.2 |
| 2   | A copied check file has two sets of imports under the same names         | angular/angular#71547 closed (PR #71673)  | On `main`; not seen in 22.2 |

---

## 1 and 2. Check files that copy their component's source aren't valid TypeScript

- **Dependency:** `@angular/compiler-cli`, the `CopySourceToTcb` inlining mode
  (`packages/compiler-cli/src/ngtsc/typecheck/src/context.ts`), which the language service uses and
  angular-check sets for a component whose check code can't be written outside its own file.
- **Status:** reported by someone else and fixed.
    - **angular/angular#71547**: https://github.com/angular/angular/issues/71547, "Language service
      CopySourceToTcb generates duplicate i0 imports, causing false signal-input errors in generic
      components". It describes both defects.
    - **angular/angular#71673**, "share a single ImportManager for CopySourceToTcb shims", merged
      2026-10-29. It isn't in the history of the 22.2 patch branch, and 22.2.2 (ng-zorro-antd's
      install) shows both defects, so the fix is expected with 22.3.

**Symptom.** In such a check file:

```ts
import * as i0 from '../table/table.component'import * as i1 from '../cell/cell-fixed.directive'/**
// … the component's source, with its check code …
import * as i0 from '../table/table.component';
import * as i1 from '@angular/core';
```

The first line doesn't parse, and `i1` is two modules. Angular's compiler asks only for the file's
semantic errors, so in the editor this shows as false errors (the issue's report). A command-line
checker checks no types in a program with a syntax error, and resolves the doubled name its own way.

**Workaround in angular-check.** `separated` and `renamed` in `src/worker.mjs`: each joined import
gets its semicolon in the file written to disk (positions are translated back), and the first set of
names is renamed, at the same length, where it is used. Neither does anything to a file without the
defect. A check file that still doesn't parse stops the run with exit code 3.

**Remove when:** angular-check no longer supports a 22.2 release. Until then, check on each new
Angular release that the comparison (`bench/sweep.sh`) still passes on ng-zorro-antd.
