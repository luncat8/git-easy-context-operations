# Changelog

All notable changes to **Git Easy Ops** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
the project uses [semantic versioning](https://semver.org/).

## Unreleased

### Added

- **Clean History (Remove Dead Paths)...** - the operation that belongs to the
  *whole graph* instead of one commit: it scans every branch, tag,
  remote-tracking branch and HEAD for paths that exist only in old commits,
  shows them with the object-store size they still occupy, writes a `git bundle`
  backup of every ref (recovery points included) next to the repository, and
  rewrites the history with `git filter-repo`. Afterwards it puts the remotes
  filter-repo removed back, rescans to verify, journals the bundle path and
  offers the force push that publishes the result.
- **Two buttons for it, plus the fallbacks**: the trash icon in the *Git Easy
  Ops* view toolbar (next to **Refresh**), the inline trash icon on the **Graph**
  group row, and - because a right-click usually lands on a commit - the *last*
  item of the commit context menu, of the *Git Easy Ops* submenu and of the Graph
  row's own menu. The graph build also puts it in the toolbar of the built-in
  Source Control Graph (`scm/history/title`).
- **Safety for the cleanup**: the rewrite is limited to the public refs
  (`--refs --branches --remotes --tags`), so the recovery points under
  `refs/geco/` keep pointing at what they recorded and **Undo** of earlier
  operations survives; the flow then offers to drop them (plus
  `git reflog expire` and `git gc --prune=now`) because until they are gone the
  removed files stay reachable. Without `git-filter-repo` installed nothing is
  touched - you get the exact script, with the dead-path list already written.
  A dirty working tree or a linked worktree is refused up front (both make
  `git filter-repo` fail anyway), and a backup bundle that cannot be written
  stops the rewrite instead of quietly continuing without a way back.

### Fixed

- `archive/clean-git-workflow.txt`, the shell workflow this feature came from, is
  rewritten: the missing `)` after `mktemp -d`, the alive-side scan that passed
  `--branches --tags HEAD` to `ls-tree` (which takes exactly one tree-ish, so
  the verification compared against nothing and always "passed"), `--all` on the
  history side (dragging stashes and hidden refs into the scan), missing
  `--diff-merges=separate` (files that only ever arrived through a merge were
  never listed), missing `LC_ALL=C` and `core.quotePath=false` (locale and
  quoting made the two sides disagree), the blind `git push --all --force`, the
  `gc --aggressive` + full `repack` that a just-rewritten repository does not
  need, and the unmentioned facts that `git filter-repo` deletes the remotes and
  that reflogs have to expire before anything is pruned.

## 0.2.0

The Source Control sidebar view becomes the graph, the built-in Source Control
Graph menus start working - without a command line - and commits can be squashed
into one.

### Added

- **The "Git Easy Ops" view now shows the commit graph**: lane art (`●│╮`) drawn
  from the real parent structure, the refs that point at each commit, relative
  dates and tooltips. Every commit expands into its branches as child nodes, so
  **Create / Rename / Check Out / Delete Branch**, fast-forward, backup and
  force push are one right-click away - in VS Code and VSCodium alike, since a
  tree view is a stable API.
- **Two settings for that graph**: `geco.showGraphLanes` (default `true`) turns
  the lane art off for a plain list, `geco.graphCommitLimit` (default `200`) sets
  how much history the group lists.
- **Multi-select in the graph group** (Ctrl/Shift-click): VS Code hands a command
  every selected row, which is what makes the next item possible.
- **Squash Selected Commits...** combines the selected rows into one commit that
  keeps the tree of the newest one, the parents of the oldest one and a message
  you can edit (pre-filled with the newest commit's message). Commits after the
  run are replayed, a recovery point is created, and one **Undo** brings every
  squashed commit back.
- **Squash with Previous Commits...** does the same from any single commit row -
  the built-in Source Control Graph, the Timeline, the palette - by asking for the
  number of previous commits (1-50) to combine it with. This is the variant that
  works where multi-select does not exist.
- A selection that is not an unbroken run fails with an explanation: the gap is
  named ("v0.3 is not selected") and a selection spanning two branches is refused
  instead of guessed.

### Fixed

- **The graph build's branch menu never appeared.** VS Code builds the ref menu
  of the Source Control Graph per reference and only picks up plain *commands*
  from `scm/historyItemRef/context` - a contributed submenu is silently dropped.
  The graph build now contributes **Rename Branch...** there (the one branch
  operation git has no equivalent for), so it shows up as a per-ref submenu of
  the commit row menu - `Rename Branch... > main`, right next to *Checkout > main*
  and *Delete Branch > main*.
- **The graph no longer lists the history an operation replaced.** The rows were
  read with `git log --all`, which includes the hidden recovery refs under
  `refs/geco/`; a reword or squash therefore showed the old commits as a second
  history. The rows now come from `--branches --remotes --tags`.

### Changed

- **The graph menus are flat instead of a "Git Easy Ops" submenu.** Every item
  now sits in the groups the built-in entries already use (squash/reword next to
  *Cherry Pick*, patch and fast-forward/force-push in their own sections after
  *Compare*), so nothing has to be looked up under an extension name. Duplicates
  with the built-in items (checkout, create branch, create tag, cherry pick, copy
  commit id, delete branch) were dropped from the graph build - the extension
  only adds what the built-in graph does not have.
- The sidebar view's menus are flat too - its rows are ours alone, and the items
  are grouped the same way instead of nesting a submenu one level deep.
- **"Enable Source Control Graph Menu..." offers two routes** and explains what
  each one costs: `product.json` (no command line, no launch flag - an editor
  update may replace it) and `argv.json` (per user, survives updates). The
  diagnosis now reports both files and says when a grant is already in place.
- "Why Don't I See the Menus?" explains the per-ref submenu behaviour and points
  at the sidebar graph first.

## 0.1.0

First release.

### Added

- **Reword any commit message** - replace, append, or find-and-replace text in a
  commit that is not the tip. Descendant commits are replayed with identical
  trees, parents and author dates; the branch is updated with an atomic
  `update-ref`, and detached HEAD is supported when the commit is HEAD.
- **Fast-forward a branch onto a commit** - the default branch (detected from
  `origin/HEAD`, `main`, `master` or the current branch) or any branch you pick.
  The previous tip is parked on a backup branch (`old`, `old-2`, ...) *before* the
  move, discarded commits are reported, and a diverged branch needs a second
  confirmation.
- **Force push** - `--force-with-lease` by default (refused when the
  remote-tracking information is stale), `--force` as an explicit second command.
  Reports what the remote had and what it has now, and can push the old sha back.
- **Apply a patch at its proper base** - takes a commit, a range, the staged or
  working-tree changes, or a patch file; scores candidate bases (exact blob
  match > clean apply > 3-way merge > 3-way with conflicts) and applies the patch
  where it belongs: on a new branch, in a separate worktree, or on the current
  branch. Mailbox patches go through `git am -3` so the message is kept.
- **Branch operations** - **Create Branch...** (starts at the commit or branch the
  menu was opened on, with a name suggested from the commit subject),
  **Rename Branch...** (and, when the branch tracks a remote one, a choice: leave
  it alone, rename it on the remote too, or just push the new name),
  **Delete Branch...** (refuses the checked-out branch, refuses commits that exist
  nowhere else until you say "Delete anyway", and can delete the remote branch as
  well) and **Check Out Branch...**. Each is a single journal entry, so **Undo**
  restores the name, the tip, the tracking configuration and a deleted remote
  branch in one click - and a remote branch we pushed is only removed again while
  it still points at the sha we left behind (`--force-with-lease`).
- **Safety net** - hidden recovery refs under `refs/geco/`, backup branches, and
  a journal in `.git/geco/journal.json`. **Undo Last Operation** rolls operations
  back newest-first (refs, branches, worktrees, checked-out branch, remote
  branches).
- **"Git Easy Ops" view** in the Source Control sidebar with commits, branches and
  recovery points, each with a context menu; plus entries in `scm/title`,
  `scm/sourceControl`, `timeline/item/context` and the Command Palette.
- **Copy Commit SHA**, **Show Backups and Recovery Points**, **Why Don't I See the
  Menus?** helpers.
- 13 `geco.*` settings and an output channel that logs every operation with the
  git commands it ran.
- **Source Control Graph commit *and branch* menus** as a separate build: `npm run package:graph`
  produces `<name>-<version>+graph.vsix` with `enabledApiProposals` and the
  `scm/historyItem/context`, `scm/historyItemRef/context` and `scm/history/title`
  contributions - commit rows get reword / fast-forward / patch / create branch,
  ref (branch) rows get create / rename / check out / delete branch, fast-forward,
  backup and force push (VS Code still gates those menus behind the proposed API
  `contribSourceControlHistoryItemMenu`). **Git Easy Ops: Enable Source Control
  Graph Menu...** writes the required `"enable-proposed-api"` entry into VS Code's
  `argv.json` - comments and other settings preserved, backup alongside - and
  reports which half (build or runtime argument) is still missing.
- Stable per-commit menus without any flag: the "Git Easy Ops" view, Timeline
  commit rows (`timelineItem == git:file:commit`), `scm/title`,
  `scm/sourceControl`, `scm/repository` and the Command Palette.
- Test suite: 377 headless tests that build throw-away git repositories (including
  bare remotes and linked worktrees) and drive the interactive flows through a
  scripted fake UI, plus a VS Code integration smoke test.
