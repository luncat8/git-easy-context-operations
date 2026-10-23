# Git Easy Context Operations

Right-click a commit or a branch and do the git surgery that is awkward on the
command line - **rename an old commit's message**, **squash a run of commits**,
**fast-forward `main` onto it**, **create / rename / delete a branch**, **force-push
safely**, **drop the branch names a fast-forward left behind**, **remove files that
exist only in old commits**, or **apply a patch at the base it actually belongs to**.

Every operation writes a recovery point first and can be undone. Works in VS Code
and VSCodium, no proposed API needed for the default install,  but to make context menu work in build-in graph - use *-graph.vsix.

## What it does

- **Squash N commits** - combine any contiguous run into one.
- **Change commit message** - rename, append, or search and replace in *any* commit's
  message, not just the last one.

- **Fast-forward `main`** - onto any commit, with the old tip parked on a backup
  branch first. The default cleanup flow checks out `main` when the worktree is
  clean, reviews local/remote branch names made redundant by the move, and can
  publish `main` with a normal push before deleting selected remote duplicates.
  The plain **Move** option is still available when you want no cleanup.
- **Branch work** - create / rename / check out / delete, from a commit row or a
  branch row, including what should happen to the remote branch it tracks.
- **Remove redundant branches** - one click deletes the names whose every commit
  another branch, tag or remote already has, so no file and no diff changes.
- **Clean the whole graph** - finds every file that exists only in old commits,
  backs the repository up as a bundle and rewrites the history so they are gone.
- **Force push** - `--force-with-lease` by default, so a colleague's push is never
  overwritten silently.
- **Apply a patch at its proper base** - finds the commit the patch was made
  against and applies it there, on a new branch or in a separate worktree.
  The patch buttons lead our block in the view header (in the graph build's
  header they sit right after the built-in buttons, still first of ours,
  **Apply Patch Automatically** ahead of the interactive apply); they work
  on the whole repository, not on a clicked commit -
  including **Apply Patch Automatically**, which re-applies the patch file you
  used last time with no questions at all, leaves the result **uncommitted**
  (staged, ready for you to commit under your own name) - applied directly on
  the current branch, with no new branch created, when the patch fits the latest
  HEAD - and only opens the file dialog when that file is missing, invalid or
  already in the graph.
- **Header history actions** - both headers share one order (after the
  header's original buttons): apply automatically, apply, fast-forward main,
  Squash, rename commit, rename branch, remove redundant, clean, undo,
  diagnose, link. On the stable view header the row-targeted four
  (**Fast-Forward Default Branch to Commit...**, **Squash with Previous
  Commits...**, **Rename Commit Message...**, **Rename Branch...**) open the
  same pickers as the Command Palette when no row is selected; the
  `+graph` header skips those four, because there they sit in the context
  menu of the very commit or branch instead. **Undo Last Operation** opens
  the newest-first undo list (the same list available from the palette).
- **Diagnose push / sync trouble** - one command that says why *Push* or *Sync* is
  refused (an unfinished merge, the same work committed twice under different
  hashes, a rewritten branch the remote still has, a stale `index.lock`, a missing
  upstream), warns that Sync merges the old history back in, and repairs what can
  be repaired. See [docs/STUCK-STATES.md](docs/STUCK-STATES.md).
- **Undo** - recovery refs under `refs/geco/`, backup branches and a journal of
  everything the extension did; **Undo Last Operation** rolls it back.
- **Customize the context menus** - switch every menu item on/off from a native
  checkbox tree (`Git Easy Ops: Customize Context Menus...`).
- **Remember dialog answers (opt-in)** - with `geco.rememberDialogDecisions` on,
  eligible confirmations offer an "(always)" button and skip that one question
  for that repository next time; **Git Easy Ops: Manage Dialog Decisions...**
  shows every question's state, with per-row reset and clear-all. Undo and
  other non-repeatable questions can never be saved.

## Where the menus are

Always available, in VS Code and VSCodium:

- **Source Control sidebar → "Git Easy Ops" → "Graph"** - the commit graph itself
  (lane art, ref badges, relative dates) with the full context menu on every row.
  Ctrl/Shift-click selects several commits for *Squash Selected Commits...*.
- **Timeline view**, the **Source Control title / repository menu** (`···`), and the
  **Command Palette** (`Git Easy Ops: ...`).

The built-in **Source Control Graph** needs a proposed VS Code API
(`contribSourceControlHistoryItemMenu`), which a published extension cannot
declare - so the repository ships a second build for it. *Install* from -graph.vsix to enable it.
That build reports itself as `<version>+graph` in the Extensions view (e.g.
`0.4.22+graph`); the distinct version is what makes VS Code offer the
*Restart Extensions* / *Reload Window* prompt after installing it over the
publishable build - accept it, otherwise the previous build keeps running.

## Safety

- Nothing is rewritten without a recovery point, and destructive steps show a
  confirmation with the concrete plan first (`geco.confirmDestructiveOperations`).
- A repository with a half-finished merge/rebase or a stale lock **stops the
  operations before they start**, with the reason and the way out.
- Ref updates are atomic, so a branch someone else moved is never clobbered.
- **Clean History** is the one operation git itself cannot undo: it refuses a dirty
  tree or a linked worktree up front, insists on a `git bundle` of every ref,
  excludes the recovery points from the rewrite, and journals where the bundle is.
  It needs [`git-filter-repo`](https://github.com/newren/git-filter-repo); when it
  is missing the extension offers to install it, and without it nothing is touched.


## Full reference
 commands, menu, setting and limit: **[docs/DETAILS.md](docs/DETAILS.md)**.

## License

MIT - see [LICENSE](LICENSE).
