# Changelog

All notable changes to **Git Easy Ops** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
the project uses [semantic versioning](https://semver.org/).

## 0.4.4

### Fixed

- **Clean History (Remove Dead Paths)... now actually rewrites the history.**
  On every repository that had a Git Easy Ops recovery point under `refs/geco/`
  - i.e. after any reword, squash, branch or fast-forward operation - the
  rewrite died with *git filter-repo failed - the history was not rewritten.*
  The command handed `git-filter-repo` the ref selection
  `--refs --branches --remotes --tags`, but `--refs` is parsed by argparse,
  which stops collecting values at the first token that looks like an option:
  `git-filter-repo` answered `error: argument --refs: expected at least one
  argument` and exited 2, before touching anything. `--refs` takes **ref
  names**, not rev-list flags, so the plan now lists the public refs by name
  (`refs/heads/...`, `refs/remotes/...`, `refs/tags/...`) - the recovery points
  stay out of the rewrite exactly as intended, and **Undo** keeps working.
  Repositories without any recovery point were unaffected (they never passed
  `--refs` at all), which is why the failure looked random.
- **Glob patterns are rejected as ref names too.** `--refs 'refs/heads/*'` is
  handed to `git rev-list` unexpanded, which rev-list refuses - and
  `git-filter-repo` ignores that failure and then rewrites *every* ref,
  recovery points included. Ref names are now validated before they are used.
- When a repository has more public refs than fit on a command line (500, the
  same limit the backup bundle already used), the `--refs` limit is dropped
  instead of silently producing a broken command: the confirmation dialog and
  the output log say that the recovery points are rewritten too, so Undo of
  earlier operations stops working and the backup bundle is the way back.

### Added

- `build.py` - one cross-platform command (Linux, macOS, Windows) that checks
  for Python, git and Node.js, installs the npm packages when they are missing
  (and Node.js itself with `--install-node`), then builds both `.vsix` files
  into `dist/`. `--install` installs the graph build, `--tests` runs the suite
  first, `--clean` starts from scratch. It verifies on the way out that
  `package.json` declares no `enabledApiProposals`, so a crash halfway through
  the graph build cannot leave an unpublishable manifest behind.
- A test that runs the **real** `git-filter-repo` (skipped when the tool is not
  installed; CI installs it) and checks that the dead paths are gone while the
  recovery refs still point where they did. The fake runner used everywhere
  else accepts any argv, so it could never have caught this.
- The long reference (every command, menu surface, setting and known limit)
  moved out of `README.md` into `docs/DETAILS.md`; the README is the short
  version the Marketplace listing shows.

## 0.4.3

- Rename the menu customization panel to **Git Easy Ops Menu Editor**.
- Add **Copy item name** to the context menu of its action rows.
- Accept empty or whitespace-only Rename Commit Message input, storing a single
  space. Cancelling still does nothing; repeated blank renames are no-ops.

## 0.4.2

The graphs actually refresh now, fast-forward can clean up after itself in one
click, and the commit-message items get names that say what they do.

### Fixed

- **The built-in Source Control Graph refreshes again.** The previous fix
  (0.4.0) made *our own* view repaint after every operation, but the graph most
  users are looking at is the **built-in Source Control Graph**, which belongs
  to the `vscode.git` extension and only redraws when *that* extension
  re-syncs its state - our own `onDidChangeTreeData` cannot touch it. After
  every operation (and every undo, force push, ...) the extension now asks the
  git extension to re-sync the open repository (`git.refresh` with the
  repository root as the hint, so it never pops a repository picker), and a
  watcher on the repository's **common git directory** picks up changes made
  elsewhere - another window, the terminal, a colleague's push - which also
  covers operations journaled by other windows (the journal lives in that
  directory). Bursts are coalesced (~150 ms), and every refresh is logged to
  the *Git Easy Ops* output channel with its reason, so a stale graph is no
  longer a mystery: the log shows whether a refresh happened and why.
- **Branch badges under an expanded commit are re-queried from git.** The
  badges (and their context menus) were read from the row's ref snapshot,
  which was painted when the row was first fetched - a branch created or
  deleted in the meantime showed up stale until the row itself was repainted.
  Expanding a commit row now asks the controller for the branches at that sha
  (falling back to the snapshot if the query fails).

### Added

- **Fast-forward cleans up after itself.** When the move is a true
  fast-forward, the confirmation is now a three-button dialog -
  **Cancel | Move | Move and remove "old"** - so the result the user usually
  wants (branch moved *and* the redundant backup gone) is one click. The
  removal is only offered when it cannot possibly lose anything: the move must
  be a true fast-forward (the old tip has no commit of its own), and the backup
  branch must be a *new* one (a reused or pre-existing branch keeps its own
  commits). The actual removal goes through the same re-verifying,
  independently journaled path as **Remove Redundant Branches...** - one
  **Undo** brings the backup back without touching the move, and a second
  **Undo** rolls the move back. Diverged moves keep the old two-button
  confirmation (the backup would carry real commits).

### Changed

- **"Reword Commit Message..." is now "Rename Commit Message..."** - the
  command id (`geco.rewordCommit`) is unchanged, so no menu configuration or
  keybinding breaks; the confirmations, prompts, progress and journal summaries
  say *rename* now ("Renamed the message of …").
- **"Rename Text in Commit Message..." is now "Search and Replace in Commit
  Message..."** - the same find/replace operation under a name that
  describes it. It is also **hidden by default** (the box in
  **Customize Context Menus...** starts unchecked, marked *hidden by
  default*); ticking it keeps it, and an explicit `geco.hiddenMenuItems: []`
  means "show everything". The command id (`geco.rewordCommitRename`) is
  unchanged.
- **`geco.hiddenMenuItems` no longer declares a manifest default.** An absent
  value means "the built-in defaults apply" (the default-hidden rows hidden);
  a stored value - even `[]` - is authoritative, so re-enabling a row can
  never be silently reverted by a settings default.
- **"Reset Hidden Menu Items" is now "Restore Default Menu Items"** and
  restores the built-in defaults (clearing the stored list in every scope
  where one exists) instead of forcing everything visible.
- **VSIX Output Location**: artifacts are named
  `dist/git-easy-context-operations-0.4.3.vsix` /
  `dist/git-easy-context-operations-0.4.3+graph.vsix`.

## 0.4.1

### Added

- **Clean History: Remove Linked Worktrees Dialog Option**: When linked worktrees
  (e.g. automatically created by AI tools like Kilo or other agents) are detected,
  Clean History no longer halts with a flat refusal. The dialog now offers a
  **"Remove Linked Worktrees"** option that removes the extra worktrees and prunes
  metadata on the spot, then automatically proceeds with the clean history flow.

### Changed

- **VSIX Output Location**: Both standard and `+graph` `.vsix` packages are now
  output to `dist/` (e.g. `dist/git-easy-context-operations-0.4.1+graph.vsix`)
  instead of the repository root, keeping the root directory clean.
- **Build Versioning Rule**: Added rule to `AGENTS.md` to ensure the extension
  version is bumped on every build so users can inspect the Extensions view and
  verify that the newly built package is installed.
- **Remove Redundant Branches... no longer sits on the branch badges of the
  `+graph` build** (`scm/historyItemRef/context`). VS Code expands every entry
  contributed there into a per-ref sub-item of the commit menu, so the cleanup
  showed up as *Remove Redundant Branches... › main*, one sub-item per branch
  of the clicked commit - which reads as "this branch gets deleted", the exact
  opposite of what the command does. It remains one flat entry on the graph
  commit rows, the graph toolbar, and every sidebar/ submenu surface it had
  before; **Rename Branch...** stays on the badge (it genuinely is about that
  one branch).
- **The checkbox list is now the confirmation.** The flow is: one click, the
  list of redundant branches with checkboxes (all pre-ticked, each entry
  naming the ref that already holds its commits), untick anything you want to
  keep, OK removes exactly the ticked names. The extra modal confirmation that
  repeated the same list afterwards is gone; only a UI without checkbox
  pickers falls back to it as its gate. The safety rails are unchanged - every
  tip is re-verified right before deletion, and one **Undo** restores the
  whole batch.

## 0.4.0

The sidebar stops going stale, and the branch names a fast-forward leaves
behind get a one-click cleanup.

### Added

- **Remove Redundant Branches...** (`geco.removeRedundantBranches`) - deletes
  the local branches that carry no commit of their own. A branch is *redundant*
  when every commit it points at is already reachable from another branch, tag
  or remote-tracking branch, so deleting it changes no file, no diff and no
  `git log` - only the list of names gets shorter. That is exactly what piles up
  after "Fast-Forward Default Branch to Commit..." parks the old tip on `old`,
  after a merged branch is never cleaned up, or when the same commit collected a
  second name.
  - The flow shows a **checkbox list of what would go**, each entry naming the
    ref that already holds its commits, then a modal confirmation that spells
    out the safety property. Everything is pre-ticked; unticking keeps a name.
  - **Never offered:** the checked-out branch, a branch checked out in another
    worktree, and the default branch - however redundant they look. Branches
    with commits only *they* have are kept and reported with the count.
  - Recovery refs under `refs/geco/` deliberately do **not** count as keepers
    (they are our own throw-away backups), while tags and remote-tracking
    branches do. Two branches on the same commit keep each other alive, so a
    duplicate pair never disappears completely.
  - Every tip is **re-verified immediately before deletion**, so a scan that
    went stale (a commit landed meanwhile) deletes less, never more.
  - **Remote-tracking branches are covered too.** A branch that was merged on
    the remote (`origin/fix/x` while `origin/main` holds every commit of it)
    carries nothing either, so it lands in the same list, marked *remote
    branch on origin*. Its local remote-tracking ref goes with the cleanup;
    the branch on the remote is a second question, asked once per batch (and
    only when a remote branch was selected): remove the local ref only (the
    default - the branch stays on the remote) or delete it there too with
    `git push --delete` - the same choice **Delete Branch...** offers. Never
    offered: the remote's default branch, the remote copy of the checked-out
    branch, and a remote branch a surviving local branch still tracks; the
    remote delete itself uses `--force-with-lease`, so a colleague's newer
    push is never clobbered.
  - The whole batch is **one** journal entry: a single **Undo** restores
    every branch with its tracking configuration and pushes back the remote
    branches it deleted (also with a lease, and it re-attaches the local
    branch to the remote one).
  - Available on branch rows **and commit rows** in the sidebar, in the view's
    `···` menu, in the *Git Easy Ops* commit/branch submenus, on the graph
    toolbar *and* on the commit rows and branch badges of the `+graph` build, and
    from the Command Palette. Wherever it lands it is the **last** entry of the
    branch group, directly behind **Create Branch...** - and like every other
    item it can be switched off in **Customize Context Menus...**.

### Fixed

- **The view now refreshes itself when the graph changes.** After a squash (and
  after reword, fast-forward, branch create/rename/delete, patch apply, clean
  history and undo) the "Git Easy Ops" sidebar kept showing the *old* graph
  until the user hit Refresh. The command wrapper did refresh, but only around
  the command call itself - the follow-up actions offered in the result
  notification ("Undo", "Force Push") run *after* that, so the one operation
  most likely to change the graph again always left a stale view behind.
  The refresh is now driven by the repository instead of the command wrapper:
  `SafetyNet` fires an `onChanged` hook wherever an operation is journaled or
  undone - the choke point every graph-changing operation already passes
  through - and the extension repaints the tree from it. No flow has to
  remember to refresh, and follow-up actions are covered. Repaints are coalesced
  (50 ms), so a multi-step undo reloads the view once instead of per step, and a
  listener that throws can never break a git operation.

## 0.3.0

The menus become user-configurable, "Clean History" installs its own
prerequisite, and two bugs that made the shipped clean button weaker than the
workflow notes promise are fixed.

### Added

- **Customize Context Menus...** - the menu editor (`0.3-plan-interactive-menu-editor.md`,
  shipped as its Plan B): a hidden **"Git Easy Ops Menus"** view with one
  collapsible surface per real menu and one native checkbox per command.
  Unchecking hides that command from *every* menu that shows it - immediately,
  no reload; the Command Palette always keeps it. The state machine
  (`src/core/menuCatalog.ts` + `menuVisibility.ts`) is pure and drift-tested:
  `src/test/core/menuCatalog.test.ts` fails the moment `package.json`, the graph
  patcher script and the catalogue disagree, in either direction.
- **Fail-open safety rails**: every `when` clause gained
  `(!geco.menuFilter || geco.menuVisible.<row>)` - with the extension disabled,
  crashed or not yet activated nothing can be hidden; the required
  *Customize Context Menus...* entry stays in every menu we contribute as the
  way back; a submenu whose rows are all hidden collapses its parent entry
  (`geco.menuHasItems.*`); unknown ids in `geco.hiddenMenuItems` are kept, so a
  downgrade never loses customizations.
- **The editor costs nothing until used**: the view ships with
  `"visibility": "hidden"` and is a native tree (no webview, no second bundle,
  no assets) - the deliberate choice over the plan's webview replica, which
  stays a `TODO(v1.0)` re-review.
- **Ask and install `git-filter-repo`** instead of only informing: when the
  rewrite tool is missing, Clean History offers *Install with pip3 / brew /
  python3 -m pip / ...*, falls through to the next candidate when one fails
  (PEP 668 "externally managed" gets its own explanation), offers the distro
  packages only when `sudo -n` proves no password would be asked for, and
  continues the cleanup automatically after a successful install. The
  copy-paste script remains the last resort and the refusal path.
- **`--user` pip installs work**: after installing, the probe also accepts the
  `git-filter-repo` binary form (not only the `git filter-repo` subcommand) and
  the generated script uses whichever invocation works.

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

- **The shipped extension could never detect an installed `git-filter-repo`**:
  the probe handed `git filter-repo --version` to the git-only process runner,
  which actually spawned `git git filter-repo --version`. Every run degraded to
  the script handout even with the tool present. (Found by running the real
  tool end to end.)
- **The rewrite failed with `--replace-refs update-no`**: that choice does not
  exist in `git filter-repo` (valid: `delete-no-add`, `delete-and-add`,
  `update-no-add`, `update-or-add`, `update-and-add`, `old-default`). The
  command now uses `delete-no-add`, which is also the actual intent - leave no
  `refs/replace/` behind that would silently translate old SHAs for colleagues.
  The workflow notes in `archive/` are corrected too.
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
