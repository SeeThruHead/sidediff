import { changedLinesOf, type DiffStyle, rowsOf } from './model';
import { unreadRowsOf } from './read';
import type { Context, FileContext } from './state';

export const appPatch = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
 const e = 6;
@@ -10,3 +11,3 @@ function f() {
 return a;
-return b;
+return c;
 }
`;

export const utilPatch = `diff --git a/src/util.ts b/src/util.ts
index 3333333..4444444 100644
--- a/src/util.ts
+++ b/src/util.ts
@@ -1,2 +1,2 @@
-export const one = 1;
+export const one = 'one';
 export const two = 2;
`;

export const fileContext = (path: string, patch: string, style: DiffStyle, overrides: Partial<FileContext> = {}): FileContext => {
  const rows = rowsOf(patch, style);

  return {
    path,
    rows,
    open: true,
    viewed: false,
    unreadRows: unreadRowsOf(rows, changedLinesOf(patch)),
    ...overrides,
  };
};

export const context = (style: DiffStyle = 'unified', overrides: Partial<Context> = {}): Context => ({
  files: [fileContext('src/app.ts', appPatch, style), fileContext('src/util.ts', utilPatch, style)],
  style,
  halfPage: 3,
  fileLines: null,
  results: [],
  ...overrides,
});
