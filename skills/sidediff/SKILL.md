---
name: sidediff
description: Review a git diff with a human in the sidediff browser view (GitHub-style diff, a notes column, an optional HTML explainer panel, guided tours, type hovers), and answer the review comments they leave on lines of the diff. Use when the user asks to open a diff or PR in sidediff, annotate a diff, walk them through a change, show an explainer beside a diff, look up types in a reviewed change, or when they comment in a running sidediff review.
---

# sidediff

`sidediff` serves a git diff in the browser for a human reviewer and gives the agent a CLI to drive that view: notes beside the code, an explainer document beside the diff, highlights and guided tours, type information from the repository's own language servers, and review threads the human starts on any line and the agent answers.

The human reads and comments in the browser. The agent works through the CLI. Everything the agent writes appears in the page immediately.

## Setup

```sh
npm install -g sidediff
sidediff init                  # installs this skill into your agents' skills folders
```

`sidediff init` asks which agents to install into. Non-interactive: `sidediff init --agent claude --agent codex`, or `sidediff init --dir <skills folder>` for any other location. Run it again after upgrading sidediff to refresh the skill.

## How it finds things

- Run every command from inside the repository (or worktree) being reviewed. The CLI finds the running server for that worktree on its own.
- One server per worktree. State (notes, threads, the server address, the chosen explainer) lives under `$XDG_STATE_HOME/sidediff/<worktree>` (default `~/.local/state/sidediff/...`), so it survives restarts and never touches the repository.
- Notes and threads are stored per worktree, not per diff. Starting a new review in the same worktree shows the old notes too; remove them with `sidediff note rm <id>` or `sidediff note clear --file <path>`.
- Commands other than starting a review work outside a git repository; starting a review needs one.

## 1. Start a review

```sh
sidediff                         # unstaged changes in the working tree
sidediff main...HEAD             # what this branch adds on top of main (merge-base diff)
sidediff origin/main...my-branch # a branch that isn't checked out
sidediff abc123 def456           # between two commits
```

The range is passed to `git diff`, so any revision form it accepts works. The server starts on port 4977 (the next free port if that is taken), prints its URL and opens the browser. Flags: `--port`, `--host`, `--no-open`, `--no-watch`, `--explainer <file.html>`.

- It is a long-running process. Start it with your harness's background mode, never in the foreground.
- Keep watching on (the default). With `--no-watch` the page stays on the diff from startup and new commits never appear.
- Type hovers, go-to-definition and diagnostics read files from disk. If you are reviewing a branch that is not checked out, check out its head in that worktree first, or hovers describe the wrong version of the file.

**Immediately after the server is up, start listening for comments (section 2).** Never leave a review open without a listener.

## 2. Answer the reviewer's comments (always on)

The reviewer hovers a line and presses `+` to start a thread, replies in threads, and resolves them. They expect answers in the thread, in the page, not only in chat. This loop runs for as long as the review is open.

### The loop

1. **Catch up first.** Before the first listener, list what is already there:

   ```sh
   sidediff threads --after 0 --wait 1 --all
   ```

   Answer every thread whose last word is from the reviewer (step 3). Note the highest `seq` printed.

2. **Wait for the next event**, in the background:

   ```sh
   sidediff threads --after <last seq> --wait 3600
   ```

   It blocks until the reviewer does something, prints the events, and exits. If nothing happens within `--wait` seconds it exits with no output; just start it again.

   Output, one line per event, tab-separated:

   ```
   <seq>  <kind>  <note id>  <file>:<line>  <author>: <text>
   ```

   `kind` is `thread` (new comment), `reply`, `resolved`, `reopened`, or `converted` (the reviewer turned one of your notes into a thread). Your own replies are skipped unless you pass `--all`.

3. **Handle each event.**
   - `thread` or `reply`: read the code at that line (and `sidediff thread <note id>` for the whole conversation), then answer in the thread:

     ```sh
     sidediff reply <note id> "<answer>"
     ```

     Answer the question that was asked, in plain language, with evidence from the code. If they asked for a change, make it, then reply with what changed. If they asked you to do something outside the review (post a comment somewhere, open a ticket), do it and reply with the result.
   - `resolved`: nothing to say. Don't reply to a resolved thread unless asked.
   - `reopened`: read the thread again; something still needs an answer.

4. **Start the listener again** with `--after` set to the highest `seq` you just handled. Go back to step 2.

### Rules for the loop

- One listener at a time. Start the next one only after handling the previous one's output.
- If your harness can run commands in the background and notify you when they finish, use that for step 2 and keep doing other work meanwhile. If it can't, run step 2 with a short `--wait` (60) between other steps of your work, so comments never wait long.
- Every event gets handled before the next listener starts. A comment that never gets an answer is the worst outcome.
- If the server restarts, sequence numbers start again from 1. Repeat step 1 (`--after 0 --all`) and check for threads still waiting on you: `sidediff note list --json` shows each note's `replies`; a thread whose last reply isn't yours, and isn't resolved, needs an answer.
- `sidediff resolve <note id>` once a thread is settled and the reviewer has agreed; `--reopen` to undo. Usually leave resolving to the reviewer.
- `sidediff reply` signs as `agent`. Pass `--author <name>` only if the user asks.

## 3. Annotate the diff

Notes are short explanations pinned to lines. They show in the notes column; the reviewer can turn any note into a thread.

```sh
sidediff note apply < notes.json
```

```json
{
  "comments": [
    {
      "filePath": "src/server.ts",
      "newLine": 42,
      "summary": "One line: what this hunk does or what is wrong with it.",
      "rationale": "Optional longer explanation: why, what it was before, what to watch for.",
      "explainer": "section-id"
    }
  ]
}
```

- `newLine` is a line number on the new side of the diff; `oldLine` the old side (for deleted lines). Use the file's real line numbers and check them (`sed -n` on the file, or `git show <rev>:<path>`) before writing notes.
- `explainer` is optional: the `id` of a section in the explainer page. The note then shows a link that opens the explainer at that section.
- One note per meaningful hunk reads better than a few long ones. Lead with the kind of change when it isn't obvious (added, removed, moved, renamed).
- `sidediff note add --file <path> --new-line <n> --summary "..." [--rationale "..."] [--explainer <id>]` adds one.
- `sidediff note list [--file <path>] [--json]`, `sidediff note rm <id>`, `sidediff note clear --file <path>` (without `--file` it removes every note in the worktree).
- When the branch changes under you, notes stay on their old line numbers. Re-check and re-apply them after new commits.

## 4. Explainer panel

An HTML document that explains the change, shown beside the diff. Use it when the change needs more than line notes: what the feature is, how a request flows through it, what the findings are.

```sh
sidediff explainer explainer.html   # load or replace it; the page reloads it whenever the file changes
sidediff explainer --clear
sidediff section <id>               # open the panel scrolled to the element with this id
```

- Give every section an `id`; notes, tours and `sidediff section` point at them.
- Links inside the explainer can scroll the diff: `<a href="<link to the code>" data-file="<path>" data-line="<line>">`, plus `data-side="old"` for a deleted line. Inside sidediff the click scrolls the diff; opened on its own the link still works. Other links open in a new tab.
- Wide screens show it as a column left of the file tree; narrow ones as an overlay. The reviewer toggles it with `e`.
- Scripts run in the panel, so diagrams and step-through widgets work. Test anything with a renderer (Mermaid and similar) in a browser before handing it over; a parse error leaves the section blank.

## 5. Drive the view

Point the reviewer at things while you talk.

```sh
sidediff show src/a.ts:120                       # scroll there (--side old for the old side)
sidediff highlight src/a.ts:120-140 --text "retry" # select lines, mark a substring
sidediff explain src/a.ts:120-140 --title "Retry loop" --body "Before: ... Now: ..."
sidediff say "Next, the error handling."        # caption only
sidediff clear                                    # remove highlights, popovers, captions
sidediff where                                    # what the reviewer is looking at now (JSON)
```

`explain` opens a zoomed popover over the code, which hides the diff behind it: say in the title what kind of change it is, and in the body what it was before and what it is now.

### Guided tours

```sh
sidediff tour tour.json
sidediff next | sidediff back | sidediff goto <n>
```

```json
[
  { "type": "section", "anchor": "overview" },
  { "type": "show", "file": "src/a.ts", "start": 120, "side": "additions" },
  { "type": "highlight", "file": "src/a.ts", "start": 120, "end": 140, "side": "additions", "text": "retry" },
  { "type": "explain", "file": "src/a.ts", "start": 120, "end": 140, "side": "additions", "title": "1. ADDED retry loop", "body": "..." },
  { "type": "say", "text": "That's the change." },
  { "type": "clear" }
]
```

Tour fields are not the CLI flag names: `side` is `"additions"` or `"deletions"` and is required on file steps; `start`/`end` are line numbers; `section` takes `anchor`. A malformed file fails with only the usage text; run `sidediff tour tour.json --log-level all` to see the schema error. The reviewer steps with `]` and `[`.

## 6. Types, definitions, references, diagnostics

The server runs the repository's own language servers (TypeScript from the repo's `node_modules`, ESLint, oxlint or Biome when configured), so answers match what the project's editor would say.

```sh
sidediff hover src/a.ts:120:15        # <file>:<line>:<column>, 1-based
sidediff definition src/a.ts:120:15
sidediff references src/a.ts:120:15
sidediff diagnostics src/a.ts [--wait 20]
```

Use these to answer reviewer questions with facts ("what type is this", "who else calls it") instead of guessing. The reviewer gets the same in the page: hover a token for its type, cmd/ctrl-click for its definition.

Other languages: add servers in `~/.config/sidediff/servers.json` or the repository's `.sidediff/servers.json`:

```json
{ "servers": [ { "id": "gopls", "extensions": [".go"], "languageId": "go", "command": "gopls", "rootMarkers": ["go.mod"] } ] }
```

## Keyboard (for telling the reviewer)

`+` on a hovered line starts a thread, `n`/`p` next/previous note, `a` show/hide the notes column, `i` show/hide inline comments, `s` split/unified, `e` explainer panel, `]`/`[` tour steps, `Esc` dismiss popovers.

## Voice (optional, off unless the user asks)

`m` in the page toggles the microphone; `sidediff listen [--after <id>] [--wait 600]` waits for the next thing said and prints `<id>  <text>`. Only use it when the user asks to talk.

## Troubleshooting

- `no sidediff server is running for this repository`: start one from this worktree, or `cd` into the worktree the server was started from.
- The page doesn't show new commits: the server was started with `--no-watch`; restart it without.
- Hover says nothing useful: the reviewed head isn't checked out, or dependencies aren't installed in that worktree.
- Old notes from a previous review show up: notes are per worktree; remove the stale ones.
