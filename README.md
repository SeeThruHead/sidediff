# sidediff

GitHub-style diff review in the browser, with a live notes column. Built on [`@pierre/diffs`](https://diffs.com).

- GitHub-style review: a collapsible file tree, split or unified diffs, per-file Viewed checkboxes with a progress bar, and a third column of notes aligned to the lines they describe.
- Base16 Tomorrow Night and Tomorrow Night Eighties themes with muted change highlighting and a near-black code background.
- Expand unmodified lines between hunks, like GitHub; the server serves both sides of the range.
- Viewed marks are stored per repository in the browser and clear themselves when a file changes again, like GitHub.
- Watch mode by default: edits, commits and checkouts re-render the page without a refresh.
- Notes are plain files that any tool or agent can write while you read; they appear immediately.

## Install

```sh
npm install -g sidediff
```

## Use

```sh
sidediff                      # working tree against HEAD
sidediff origin/main...HEAD   # a branch against its base
sidediff HEAD~1 --no-watch    # a fixed range, no watching
```

Options: `--port` (default 4977, falls back to the next free port), `--host` (default 127.0.0.1), `--no-open`, `--no-watch`. Any other arguments are passed to `git diff`.

Keys: `s` split or unified, `a` show or hide notes, `n` / `p` next or previous note.

## Notes

```sh
sidediff note add --file src/app.ts --new-line 42 --summary "Why this changed" --rationale "Longer explanation"
echo '{"comments":[{"filePath":"src/app.ts","newLine":42,"summary":"Why"}]}' | sidediff note apply --stdin
sidediff note list [--json] [--file src/app.ts]
sidediff note rm <id>
sidediff note clear [--file src/app.ts]
```

`--new-line` targets the new side of the diff, `--old-line` the old side. The batch format matches Hunk's `session comment apply`, so existing agent tooling can target either.

Notes are stored one file per note under `<git dir>/sidediff/notes`, so concurrent writers never collide and nothing is committed to the repository.

## Develop

```sh
pnpm install
pnpm run build      # client and CLI
pnpm run dev        # rebuild the client on change
pnpm run typecheck
```

MIT licensed.
