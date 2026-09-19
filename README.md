# Git Easy Ops

Right-click a commit or a branch and do the git surgery that is awkward on the
command line - **reword an old commit**, **fast-forward `main` onto it** (keeping
the old tip as a backup branch), **create / rename / delete a branch**,
**force-push safely**, or **apply a patch at the base it actually belongs to**.
Every operation writes a recovery point first and (i hope) can be undone.

Works in VS Code and VSCodium. No proposed APIs required for the default install.

## Main Highlighted Features

- **Squash N commits** - combine any contiguous run of commits into one
- **Change commit message** - reword, append, or rename text in any commit's message
- **Fast-forward default branch** - move `main` onto any commit safely, with the old tip parked on a backup branch first

# Next text is not for human (ask LLM if need)

## Features

| # | Command (palette: `Git Easy Ops: ...`) | What it does |
|---|----------------------------------------|--------------|
| 1 | **Reword Commit Message...** / **Append to Commit Message...** / **Rename Text in Commit Message...** | Rewrites the message of *any* commit, not just the last one: `v0.2` → `v0.2 add new button`. Descendant commits are replayed with identical trees, parents and author dates. |
| 2 | **Fast-Forward Default Branch to Commit...** / **Fast-Forward Branch to Commit...** | Moves `main` (or a branch you pick) onto the selected commit. The old tip is parked on a backup branch named `old` (or whatever you type) *before* anything moves. |
| 3 | **Force Push (with lease)...** / **Force Push (--force)...** | Pushes the rewritten history. `--force-with-lease` refuses to overwrite work a colleague pushed since your last fetch. |
| 4 | **Apply Patch at Proper Base...** / **Find Proper Base for Patch...** | Finds the commit a patch was made against (exact blob match, clean apply, then 3-way) and applies it there - on a new branch or in a separate worktree, so your checkout is never disturbed. |
| 5 | **Create Backup Branch...**, **Show Backups and Recovery Points**, **Undo Last Operation** | The safety net: hidden recovery refs under `refs/geco/`, backup branches, and a journal of everything the extension did. Undo rolls operations back, newest first. |

| 6 | **Squash Selected Commits...** / **Squash with Previous Commits...** | Turns a run of commits into one: `wip` + `fix tests` + `review feedback` → a single commit that keeps the tree of the newest one (and the message you type, pre-filled with that newest message). In the sidebar **Graph** group Ctrl/Shift-click the rows and pick *Squash Selected Commits*; from the built-in graph or the palette, *Squash with Previous Commits* asks how many commits before the one you clicked should be combined. Commits after the run are replayed with new SHAs, a recovery point is created, and one **Undo** restores everything. |

| 7 | **Create Branch...** / **Rename Branch...** / **Delete Branch...** / **Check Out Branch...** | Branch work from a commit row ("create a branch *here*") or from a branch row. Renaming asks what should happen to the remote branch it tracks (leave it, rename it there too, or just push the new name); deleting refuses the checked-out branch and refuses unmerged commits until you insist. One journal entry per action, so **Undo** restores names, tips, tracking configuration and deleted remote branches in one click. |

Plus: **Copy Commit SHA** - and the sidebar view now shows the commit **graph**
(lanes, ref badges, relative dates) with the same context menus on commits and
branches, so the operations work the same in VS Code, VSCodium and Remote-SSH
without any proposed API.

## Where the menus are

**Always available, no flags, VS Code and VSCodium:**

- **Source Control sidebar → "Git Easy Ops" view → "Graph"** - the commit graph
  itself: lane art (`●│╮…`), every ref that points at a commit, relative dates and
  a full context menu on each row - no "Git Easy Ops" submenu to look for, the
  items sit in plain groups (message / commit / branch / move / remote / patch).
  Ctrl/Shift-click selects several commit rows, and **Squash Selected Commits...**
  then combines the whole selection into one commit. Expand a commit to get its
  branches as child nodes - right-clicking one of those gives **Create / Rename /
  Check Out / Delete Branch**, fast-forward, backup and force push. This is the
  stand-in for the built-in Source Control Graph, which cannot be extended without
  a proposed API (see below).
- **The same view** also lists all branches and the recovery points/journal.
- **Timeline view** - right-click a commit row of the selected file
  (`timelineItem == git:file:commit`).
- **Source Control title / repository menu** (`···`) → *Git Easy Ops*.
- **Command Palette** → `Git Easy Ops: ...` (asks for the commit when nothing is selected).

### The built-in **Source Control Graph** (commit and branch rows)

Adding entries to that graph needs a **proposed** VS Code API
(`contribSourceControlHistoryItemMenu` - still proposed in VS Code 1.10x). A
Marketplace-published extension cannot declare it, so the repo ships a second
build, and VS Code additionally requires the proposal to be **allowed** for the
extension id. Both halves are needed:

1. install the graph build (`git-easy-context-operations-0.2.0+graph.vsix`), and
2. allow the proposal - easiest via `product.json` (no command line at all):

```jsonc
// <install>/resources/app/product.json
"extensionEnabledApiProposals": {
  "luncat8.git-easy-context-operations": [
    "contribSourceControlHistoryItemMenu",
    "contribSourceControlHistoryTitleMenu"
  ]
}
```

   ...or per user in `~/.vscode/argv.json` (`~/.vscode-oss/argv.json` for
   VSCodium), or per launch with `code --enable-proposed-api <id>`.

   Inside the editor, **Git Easy Ops: Enable Source Control Graph Menu...** offers
   both files, writes the entry (with a backup) and reports what is still missing.
3. restart VS Code or ctrl-shift-p Developer: Reload Window

In the graph, the items are **flattened into the groups the built-in entries
already use** instead of hiding in a "Git Easy Ops" submenu:

| Group (next to the built-in items) | What this build adds |
|------------------------------------|----------------------|
| *Cherry Pick* (`4_modify`) | **Squash with Previous Commits...**, **Reword Commit Message...**, **Append to...**, **Rename Text in...** |
| after *Compare* (`6_patch`) | **Apply Patch at Proper Base...**, **Find Proper Base for Patch...** |
| new section (`7_move`) | **Fast-Forward Default Branch to Commit...**, **Fast-Forward Branch to Commit...**, **Create Backup Branch...** |
| new section (`8_remote`) | **Force Push (with lease)...**, **Force Push (--force)...** |

Nothing is duplicated: the built-in graph already offers checkout, create branch,
create tag, cherry pick, copy commit id and - on a branch badge - delete branch,
so this build does not repeat them. The one thing git has no counterpart for is
renaming a branch, which is why **Rename Branch... › main** appears on the ref
badge itself (`scm/historyItemRef/context`: VS Code only accepts plain commands
there and builds the per-ref entry itself, exactly like *Checkout › main* and
*Delete Branch › main*).

The built-in graph cannot select several rows, so use **Squash with Previous
Commits...** there - it asks for the number of commits before the one you clicked.
Our own **Graph** group above is multi-select, so *Squash Selected Commits...*
works on any contiguous run you select (a gap or a selection spanning two branches
is refused with an explanation instead of guessing).

Running from source (`F5`) needs no flag at all: an Extension Development Host
grants the proposals listed in `enabledApiProposals`.

## Install

The built artifacts are **committed to this repository**, so a clone is enough -
no toolchain needed:

```bash
# the everyday build: sidebar graph, Timeline, SCM menus, palette
code   --install-extension git-easy-context-operations-0.2.0.vsix
codium --install-extension git-easy-context-operations-0.2.0.vsix

# the graph flavour: the same plus context menus in the built-in Source Control Graph
code   --install-extension git-easy-context-operations-0.2.0+graph.vsix
codium --install-extension git-easy-context-operations-0.2.0+graph.vsix
```

For the graph flavour, allow the proposed API once - inside the editor run **Git
Easy Ops: Enable Source Control Graph Menu...** and pick `product.json` (no
command line) or `argv.json`, or edit the file yourself:

```jsonc
// ~/.vscode/argv.json (~/.vscode-oss/argv.json for VSCodium), then restart
{ "enable-proposed-api": ["luncat8.git-easy-context-operations"] }
```

`git-easy-context-operations-0.2.0.vsix` (no `+graph`) is the Marketplace-safe
build: same commands, but they appear in the sidebar graph, Timeline, the Source
Control title/repository menus and the palette instead of the graph rows.
**Git Easy Ops: Why Don't I See the Menus?** tells you which half is missing.

Building them yourself:

```bash
npm install
npm run package         # publishable build: sidebar graph, Timeline, SCM menus, palette
npm run package:graph   # + the Source Control Graph commit/branch context menus
```

`dist/extension.js` (the bundle both `.vsix` files carry) is tracked as well, so
you can also drop the repository folder straight into your extensions directory.
For the graph menus to render in that case, flip the manifest first:
`npm run graph-menu:on && npm run compile` (`npm run graph-menu:off` reverts it -
do that before publishing).

## Safety

- Nothing is rewritten without a **recovery point**: `refs/geco/...` refs, backup
  branches, and a journal in `.git/geco/journal.json`.
- Destructive steps show a **confirmation with the concrete plan** (which commits
  change, which branch moves, what the remote will lose). Turn it off with
  `geco.confirmDestructiveOperations`.
- Ref updates are **atomic** (`update-ref <ref> <new> <expected>`): if something
  else moved the branch in the meantime, the operation fails instead of clobbering.
- **Deleting a branch** refuses the one you have checked out, and refuses a branch
  with commits that exist nowhere else until you explicitly say "Delete anyway" -
  the confirmation lists those commits.
- **Undo of a remote change** never clobbers a colleague: a remote branch we pushed
  is only deleted again while it still points at the sha we left behind
  (`--force-with-lease`).
- Patch probing never touches your index or working tree; a failed apply removes
  the worktree and branch it created.
- git runs with `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, `LC_ALL=C`, no
  shell involved, and a 5-minute timeout.

## Settings

| Setting | Default | Meaning |
|---------|---------|---------|
| `geco.gitPath` | `""` | git executable (falls back to `git.path`, then `PATH`). |
| `geco.defaultBackupBranchName` | `old` | Where the old branch tip is parked (`old-2`, `old-3`, ... if taken). |
| `geco.backupRefPrefix` | `refs/geco/` | Prefix for hidden recovery refs. |
| `geco.forcePushMode` | `lease` | Default for **Force Push**: `lease` or `force`. |
| `geco.confirmDestructiveOperations` | `true` | Ask before rewriting/moving/pushing. |
| `geco.preserveCommitterDateOnReword` | `true` | Keep committer dates when rewording. |
| `geco.commitPickerLimit` | `50` | Commits listed in the picker. |
| `geco.patchBaseCandidateLimit` | `40` | Candidate bases probed for a patch. |
| `geco.applyPatchDestination` | `newBranch` | `current`, `newBranch` or `worktree`. |
| `geco.worktreeFolder` | `.geco-worktrees` | Where patch worktrees are created. |
| `geco.threeWayApply` | `true` | Fall back to `git apply --3way` / `git am -3`. |
| `geco.journalMaxEntries` | `100` | How many operations Undo remembers. |
| `geco.showGraphMenuHint` | `true` | One-time hint about the entry points. |
| `geco.graphCommitLimit` | `200` | Commits listed in the **Graph** group of the sidebar view. |
| `geco.showGraphLanes` | `true` | Draw the `●│╮…` lane art in the Graph group (`false` = plain list). |

## Development

```bash
npm install
npm run compile        # type-check + bundle to dist/extension.js
npm test               # 441 headless tests (real git repositories, no editor)
npm run test:vscode    # integration smoke test inside a real VS Code
npm run package        # build the .vsix
```

Press `F5` to run the extension in a development host.

**Layout** - `src/core/` is the git engine: pure TypeScript, an injectable process
spawner and a UI interface, which is why the whole thing is testable without an
editor. `src/vscode/` and `src/extension.ts` are the thin adapter: settings,
output channel, tree view, commands. `src/test/core/` contains the engine tests
(each one builds throw-away repositories), `src/test/vscode/` the smoke test.

## Known limits

- A signed commit loses its signature when it is rewritten (git cannot re-sign
  without your key); you are told when that happens.
- Rewording and squashing need the commit to be reachable from a local branch.
- A squash covers an **unbroken run** of commits (no gaps, no selection across two
  branches); merge commits inside the run are flattened to their first parent.
- **Fast-Forward** moves a branch, it does not rebase: if the branch has commits
  the target does not, you are shown them and asked before anything is forced.
- Undo restores refs, branches, worktrees and (for pushes) the remote branch. It
  cannot un-send an e-mail or undo what a colleague already fetched.
- A remote refuses to delete the branch its `HEAD` points at (usually the default
  branch). Renaming such a branch *on the remote* therefore pushes the new name and
  reports that the old one stayed - change the default branch on the host first.
- Renaming a branch does not rewrite anything: the commits keep their shas, so no
  force-push is needed for the local rename itself.

## License

MIT - see [LICENSE](LICENSE).
