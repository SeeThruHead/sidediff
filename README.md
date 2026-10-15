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

## Agents

sidediff ships a skill that teaches a coding agent the whole workflow: opening a review, annotating it, the explainer panel, walking you through the change, type lookups, and above all listening for and answering the comments you leave on the diff. Install it into your agents' skills folders:

```sh
sidediff init                                  # pick from Claude Code, Codex, OpenCode, Pi and ~/.agents
sidediff init --agent claude --agent codex     # no prompt
sidediff init --dir ./.claude/skills           # any other skills folder, e.g. one per project
```

The picker pre-selects the agents it finds in your home directory. Folders that are symlinks to the same place are written once. Run it again after upgrading sidediff to refresh the skill. Pi also finds the skill in the installed package on its own (the `pi.skills` entry in `package.json`).

The skill itself is [`skills/sidediff/SKILL.md`](skills/sidediff/SKILL.md).

## Use

```sh
sidediff                      # working tree against HEAD
sidediff origin/main...HEAD   # a branch against its base
sidediff HEAD~1 --no-watch    # a fixed range, no watching
```

Options: `--port` (default 4977, falls back to the next free port), `--host` (default 127.0.0.1), `--no-open`, `--no-watch`. Any other arguments are passed to `git diff`.

Keys: `s` split or unified, `a` show or hide notes, `i` show or hide comments, `n` / `p` next or previous note, `e` show or hide the explainer.

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

## Explainer

An HTML document that explains the change can sit beside the diff:

```sh
sidediff explainer review/explainer.html      # load it into the running server
sidediff explainer --clear                    # remove it
sidediff origin/main...HEAD --explainer review/explainer.html   # or load it at start
sidediff section data-flow                    # open the panel at the element with id="data-flow"
```

On a screen at least 1500px wide the explainer is a column left of the file tree; narrower, it opens as an overlay. `e` toggles it and its right edge drags to resize. It reloads when the file changes and keeps its scroll position. The choice is remembered per worktree.

Links go both ways:

- A note with `"explainer": "<id>"` (or `note add --explainer <id>`) shows a `§` link that opens the explainer at that element.
- An element in the explainer with `data-file="src/app.ts" data-line="42"` (and `data-side="old"` for the old side) scrolls the diff to that line when clicked. Put it on a link to the code on GitHub and the same document still works outside sidediff. Other outbound links open in a new tab.

## Guiding the reviewer

A running server accepts commands that drive the open page, so a person or an agent can walk someone through a change without covering the diff:

```sh
sidediff guide src/app.ts:40-48 "Why this matters: ..." --section data-flow   # the main one
sidediff show src/app.ts:40                     # just scroll there
sidediff highlight src/app.ts:40-48 --text userId   # select lines and mark text
sidediff say "Next, the worker"                 # a caption (spoken with --speak)
sidediff clear
sidediff where                                  # which file the reader is on
sidediff listen [--after <id>] [--wait 600]     # blocks until the reader says something
```

`guide` is one stop on a walkthrough. It scrolls the diff to the lines and selects them, leaves a comment under them saying why they matter (a normal thread: the reviewer can reply and the agent sees it through `sidediff threads`), and scrolls the explainer to `--section` beside it. `--text` marks a substring, `--detail` adds a longer explanation, `--side old` points at deleted lines. The agent decides what comes next; there is no prepared tour file.

Press Talk (or `m`) in the page to speak. Recognition uses the browser's built-in speech service (Chrome sends audio to Google; Safari uses Apple's), each finished sentence is posted to the server, and `sidediff listen` returns it. Replies are read aloud with the browser's speech synthesis.

## Develop

```sh
pnpm install
pnpm run build      # client and CLI
pnpm run dev        # rebuild the client on change
pnpm run typecheck
```

MIT licensed.
