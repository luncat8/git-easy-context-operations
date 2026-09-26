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
- **Undo** - recovery refs under `refs/geco/`, backup branches and a journal of
  everything the extension did; **Undo Last Operation** rolls it back.
- **Customize the context menus** - switch every menu item on/off from a native
  checkbox tree (`Git Easy Ops: Customize Context Menus...`).

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

## Safety

- Nothing is rewritten without a recovery point, and destructive steps show a
  confirmation with the concrete plan first (`geco.confirmDestructiveOperations`).
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
