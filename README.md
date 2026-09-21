# Git Easy Ops

Right-click a commit or a branch and do the git surgery that is awkward on the
command line - **reword an old commit**, **fast-forward `main` onto it** (keeping
the old tip as a backup branch), **create / rename / delete a branch**,
**force-push safely**, or **apply a patch at the base it actually belongs to**.
Every operation writes a recovery point first and (i hope) can be undone.

Works in VS Code and VSCodium. No proposed APIs required for the default install.

## Main Highlighted Features

- **Squash N commits** - combine any contiguous run of commits into one
- **Remove redundant branches** - one click deletes the branch names left over after fast-forwarding `main`: branches whose every commit another branch, tag or remote already has, so nothing about the files changes
- **The view keeps up** - squash, fast-forward, branch work and undo repaint the graph as soon as the operation is done, no manual refresh
- **Customize the context menus** - switch every Git Easy Ops menu item on/off from a native checkbox tree (`Git Easy Ops: Customize Context Menus...`)
- **Change commit message** - reword, append, or rename text in any commit's message
- **Fast-forward default branch** - move `main` onto any commit safely, with the old tip parked on a backup branch first
- **Clean the whole graph** - one trash button on the **Graph** row finds every file that exists only in old commits (no branch, tag or remote has it anymore), backs the repository up as a bundle and rewrites the history so those files are gone for good

# Next text is not for human (ask LLM if need)

This repo
https://github.com/luncat8/git-easy-context-operations

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

| 7b | **Remove Redundant Branches...** | The cleanup for what fast-forwarding leaves behind. A branch is *redundant* when every commit it points at is already reachable from another branch, tag or remote-tracking branch - deleting it changes no file, no diff and no `git log`, only the list of names gets shorter (`old`, merged feature branches, a second name on the same commit). You get a checkbox list of exactly what would go, each with the ref that already holds its commits; the checked-out branch, branches checked out in another worktree and the default branch are never offered, and a branch whose commits only *it* has is kept and reported with the count. Every tip is re-verified right before deletion, so a scan that went stale deletes less, never more. Remote-tracking branches are part of the list too: a branch that was merged on the remote (`origin/fix/x` while `origin/main` holds every commit of it) is offered as *remote branch on origin*, and one question decides whether it is deleted there as well (`git push --delete`) or only its local remote-tracking ref goes - the default keeps the branch on the remote. The remote's default branch and the remote copy of the checked-out branch are never offered, and neither is a remote branch a surviving local branch still tracks. The whole batch is one journal entry - a single **Undo** restores every branch with its tracking configuration and pushes back the remote branches it deleted. It shows up on commit rows as well as branch rows, and on every one of them it is the **last** entry of the branch group, directly behind **Create Branch...**|

| 8 | **Clean History (Remove Dead Paths)...** | The whole-graph operation: scans every branch, tag, remote-tracking branch *and* HEAD for paths that exist only in old commits, shows them with the size they still occupy, writes a `git bundle` backup of every ref, then rewrites the history with `git filter-repo` (recovery points under `refs/geco/` excluded, so **Undo** of earlier operations keeps working). Afterwards it puts the remotes filter-repo removed back, rescans to verify, journals where the bundle is, and offers the force push. Without `git-filter-repo` installed it **offers to install it for you** (pip, Homebrew, or the system package manager when sudo needs no password) and continues the cleanup once the tool is in place - the exact script is the fallback, not the answer. |

| 9 | **Customize Context Menus...** / **Reset Hidden Menu Items** | The menu editor: a checkbox tree of every menu Git Easy Ops contributes, grouped by surface (sidebar commit/branch rows, view toolbar, the *Git Easy Ops* submenu, Source Control title/repository, Timeline, the graph build). Unchecking a row hides that command from **every** menu that shows it - immediately, no reload; checking restores it. Saved in `geco.hiddenMenuItems`, fail-open by design (with the extension disabled nothing is ever hidden), and every context menu keeps a required *Customize Context Menus...* entry as the way back. |

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
  a proposed API (see below). The view **reloads itself** whenever an operation
  changes the repository - including the *Undo* you pick in the notification
  afterwards - so what you see is never one squash behind.
- **The same view** also lists all branches and the recovery points/journal.
- **Remove Redundant Branches...** sits on every branch row *and* on every commit
  row (in the branch group, last - right after **Create Branch...**) and in the
  view's `···` menu: it sweeps up the names a fast-forward left behind (see
  feature 7b).
- **Two buttons for the whole graph** (they are not about one commit, so they do
  not sit in a commit row): the *trash* icon in the view toolbar next to
  **Refresh**, and the inline *trash* icon on the **Graph** group row itself -
  both run **Clean History (Remove Dead Paths)...**. The same command is the
  **last** item of a commit row's context menu and of the *Git Easy Ops* submenu,
  for the case where the right-click happens first.
- **Timeline view** - right-click a commit row of the selected file
  (`timelineItem == git:file:commit`).
- **Source Control title / repository menu** (`···`) → *Git Easy Ops*.
- **Command Palette** → `Git Easy Ops: ...` (asks for the commit when nothing is selected).
- **The gear icon** in the view toolbar - and **Customize Context Menus...** as the last
  entry of every context menu the extension contributes - opens the menu editor below.

### The built-in **Source Control Graph** (commit and branch rows)

Adding entries to that graph needs a **proposed** VS Code API
(`contribSourceControlHistoryItemMenu` - still proposed in VS Code 1.10x). A
Marketplace-published extension cannot declare it, so the repo ships a second
build, and VS Code additionally requires the proposal to be **allowed** for the
extension id. Both halves are needed:

1. install the graph build (`dist/git-easy-context-operations-0.4.1+graph.vsix`), and
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
| *Create Branch...* (`2_branch`) | **Remove Redundant Branches...** - last in that group, directly behind the built-in *Create Branch...* (`2_branch@2`). Deliberately **not** on the branch badges - see below. |
| after *Compare* (`6_patch`) | **Apply Patch at Proper Base...**, **Find Proper Base for Patch...** |
| new section (`7_move`) | **Fast-Forward Default Branch to Commit...**, **Fast-Forward Branch to Commit...**, **Create Backup Branch...** |
| new section (`8_remote`) | **Force Push (with lease)...**, **Force Push (--force)...** |
| graph *toolbar* (`scm/history/title`, `navigation`) | **Clean History (Remove Dead Paths)...** and **Remove Redundant Branches...** next to Refresh - the two operations that belong to the whole graph instead of one commit row |

Nothing is duplicated: the built-in graph already offers checkout, create branch,
create tag, cherry pick, copy commit id and - on a branch badge - delete branch,
so this build does not repeat them. The one thing git has no counterpart for is
renaming a branch, which is why **Rename Branch... › main** appears on the ref
badge itself (`scm/historyItemRef/context`: VS Code only accepts plain commands
there and builds the per-ref entry itself, exactly like *Checkout › main* and
*Delete Branch › main*).

**Remove Redundant Branches...** is deliberately *not* on those badges: VS Code
would expand the entry per ref into sub-items like *Remove Redundant Branches... ›
main*, and a sub-item carrying the selected branch name reads as "this branch
gets deleted" - the opposite of a whole-graph cleanup whose list of victims only
exists after the scan. It sits flat on the commit row and on the graph toolbar
instead; clicking it shows the redundant branches as a checkbox list, all
pre-ticked, and OK removes exactly the ticked ones.

The built-in graph cannot select several rows, so use **Squash with Previous
Commits...** there - it asks for the number of commits before the one you clicked.
Our own **Graph** group above is multi-select, so *Squash Selected Commits...*
works on any contiguous run you select (a gap or a selection spanning two branches
is refused with an explanation instead of guessing).

Running from source (`F5`) needs no flag at all: an Extension Development Host
grants the proposals listed in `enabledApiProposals`.

### Customize Context Menus...

`Git Easy Ops: Customize Context Menus...` reveals the hidden **"Git Easy Ops Menus"**
view in the Source Control sidebar: one collapsible surface per real menu, one
checkbox per command. It is a plain native tree - no webview, nothing loaded
until you open it.

- One switch hides the command **everywhere** (sidebar commit menu, branch menu,
  submenu, Timeline, graph build) - that is what "I don't want this item" means.
  The Command Palette, keybindings and other extensions keep working regardless.
- The *Customize Context Menus...* entry itself is locked (the way back), and the
  palette command **Reset Hidden Menu Items** shows everything again.
- Hidden state lives in `geco.hiddenMenuItems` (user scope by default; a
  workspace value keeps this workspace different). Unknown ids are kept, so a
  downgrade never loses customizations.
- **Known limits** (VS Code has no API for more): built-in git items (*Cherry
  Pick*, *Compare*, ...) cannot be hidden - microsoft/vscode#9285 is open since
  2016. Items cannot be reordered or moved between sections. Immediately after
  startup (or with the extension disabled) everything is visible until the state
  is applied - fail-open by design.

## Install

The built artifacts are **committed to this repository**, so a clone is enough -
no toolchain needed:

```bash
# the everyday build: sidebar graph, Timeline, SCM menus, palette
code   --install-extension dist/git-easy-context-operations-0.4.1.vsix
codium --install-extension dist/git-easy-context-operations-0.4.1.vsix

# the graph flavour: the same plus context menus in the built-in Source Control Graph
code   --install-extension dist/git-easy-context-operations-0.4.1+graph.vsix
codium --install-extension dist/git-easy-context-operations-0.4.1+graph.vsix
```

For the graph flavour, allow the proposed API once - inside the editor run **Git
Easy Ops: Enable Source Control Graph Menu...** and pick `product.json` (no
command line) or `argv.json`, or edit the file yourself:

```jsonc
// ~/.vscode/argv.json (~/.vscode-oss/argv.json for VSCodium), then restart
{ "enable-proposed-api": ["luncat8.git-easy-context-operations"] }
```

`dist/git-easy-context-operations-0.4.1.vsix` (no `+graph`) is the Marketplace-safe
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
- **Clean History** is the one operation git itself cannot undo (every commit gets
  a new SHA), so it refuses a dirty working tree or a linked worktree *before*
  anything is written, insists on a `git bundle` backup of *every* ref (full ref
  names, recovery points included) next to the repository, excludes the recovery
  points from the rewrite, verifies with a rescan, and journals the bundle path -
  that journal entry is the map back. If the bundle cannot be written it stops
  and asks; without `git-filter-repo` on `PATH` it touches nothing at all.
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
| `geco.hiddenMenuItems` | `[]` | Row ids hidden from the context menus. Maintained by **Customize Context Menus...** - edit by hand at your own risk. |

## Development

```bash
npm install
npm run compile        # type-check + bundle to dist/extension.js
npm test               # 500+ headless tests (real git repositories, no editor)
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
- **Clean History (Remove Dead Paths)...** needs
  [`git-filter-repo`](https://github.com/newren/git-filter-repo) - without it the extension offers to
  install it (pip / Homebrew / `apt`/`dnf`/`pacman` when sudo works without a password; PEP 668
  "externally managed" Pythons are explained and skipped). If nothing can be installed
  automatically you get the full script to run by hand instead. It rewrites *everything*: every SHA
  changes, every collaborator has to re-clone, and the only way back is the
  backup bundle. Paths with a literal newline in their name are reported but not
  compared (git's line-based output cannot carry them).

## License

MIT - see [LICENSE](LICENSE).
