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

Or from source:

```sh
git clone https://github.com/SeeThruHead/sidediff.git
cd sidediff
pnpm install
pnpm run build
npm link
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
echo '{"comments":[{"filePath":"src/app.ts","newLine":42,"summary":"Why"}]}' | sidediff note apply
sidediff note list [--json] [--file src/app.ts]
sidediff note rm <id>
sidediff note clear [--file src/app.ts]
```

`--new-line` targets the new side of the diff, `--old-line` the old side. The batch format matches Hunk's `session comment apply`, so existing agent tooling can target either.

Notes, review threads and the running server's address are stored per worktree under `$XDG_STATE_HOME/sidediff/<worktree>/` (`~/.local/state/sidediff/<worktree>/` by default), one file per note, so concurrent writers never collide, nothing is committed to the repository, worktrees of the same repository never see each other's notes, and a review's annotations and threads come back when its server restarts. Versions before 0.3.1 kept them in the repository's shared `<git dir>/sidediff`; those files are left where they are.

## Review threads

Hover a line in the diff and press `+` to start a thread on it. Every note is a thread: it lists its replies and has a reply box and Resolve. Threads, replies and resolved state are saved with the note, so they survive restarts.

The agent side talks to the running server, so the page updates the moment it replies:

```sh
sidediff threads [--after <seq>] [--wait 600] [--all]   # blocks until the reviewer starts a thread, replies or resolves
sidediff thread <id>                                    # print a thread: the first comment and every reply
sidediff reply <id> "text"                              # reply as the agent
sidediff resolve <id> [--reopen]
```

`sidediff threads` prints `seq  kind  note-id  file:line  author: text` and skips the agent's own events unless `--all` is passed. Pass the last `seq` as `--after` to pick up where you left off. Threads started in the page are attributed to `git config user.name`.

## Guided tours and conversation

A running server accepts commands that drive the open page, so a person or an agent can walk someone through a change:

```sh
sidediff show src/app.ts:40                     # scroll there
sidediff highlight src/app.ts:40-48 --text userId   # select lines and mark text
sidediff explain src/app.ts:40-48 --title "Why" --body "..." [--speak]   # zoomed popover over the diff
sidediff say "Next, the worker"                 # spoken through the browser, with a caption
sidediff clear
sidediff tour tour.json                         # steps array of the commands above; Next/Back in the page, or ] and [
sidediff where                                  # which file the reader is on
sidediff listen [--after <id>] [--wait 600]     # blocks until the reader says something
```

Press Talk (or `m`) in the page to speak. Recognition uses the browser's built-in speech service (Chrome sends audio to Google; Safari uses Apple's), each finished sentence is posted to the server, and `sidediff listen` returns it. Replies are read aloud with the browser's speech synthesis.

## Develop

```sh
pnpm install
pnpm run build      # client and CLI
pnpm run dev        # rebuild the client on change
pnpm run typecheck
```

MIT licensed.
