# Git Easy Ops

Right-click a commit or a branch and do the git surgery that is awkward on the
command line - **reword an old commit**, **fast-forward `main` onto it** (keeping
the old tip as a backup branch), **create / rename / delete a branch**,
**force-push safely**, or **apply a patch at the base it actually belongs to**.
Every operation writes a recovery point first and can be undone.

Works in VS Code and VSCodium. No proposed APIs required for the default install.

## Features

| # | Command (palette: `Git Easy Ops: ...`) | What it does |
|---|----------------------------------------|--------------|
| 1 | **Reword Commit Message...** / **Append to Commit Message...** / **Rename Text in Commit Message...** | Rewrites the message of *any* commit, not just the last one: `v0.2` → `v0.2 add new button`. Descendant commits are replayed with identical trees, parents and author dates. |
| 2 | **Fast-Forward Default Branch to Commit...** / **Fast-Forward Branch to Commit...** | Moves `main` (or a branch you pick) onto the selected commit. The old tip is parked on a backup branch named `old` (or whatever you type) *before* anything moves. |
| 3 | **Force Push (with lease)...** / **Force Push (--force)...** | Pushes the rewritten history. `--force-with-lease` refuses to overwrite work a colleague pushed since your last fetch. |
| 4 | **Apply Patch at Proper Base...** / **Find Proper Base for Patch...** | Finds the commit a patch was made against (exact blob match, clean apply, then 3-way) and applies it there - on a new branch or in a separate worktree, so your checkout is never disturbed. |
| 5 | **Create Backup Branch...**, **Show Backups and Recovery Points**, **Undo Last Operation** | The safety net: hidden recovery refs under `refs/geco/`, backup branches, and a journal of everything the extension did. Undo rolls operations back, newest first. |

| 6 | **Create Branch...** / **Rename Branch...** / **Delete Branch...** / **Check Out Branch...** | Branch work from a commit row ("create a branch *here*") or from a branch row. Renaming asks what should happen to the remote branch it tracks (leave it, rename it there too, or just push the new name); deleting refuses the checked-out branch and refuses unmerged commits until you insist. One journal entry per action, so **Undo** restores names, tips, tracking configuration and deleted remote branches in one click. |

Plus: **Copy Commit SHA**.

## Where the menus are

**Always available, no flags, VS Code and VSCodium:**

- **Source Control sidebar → "Git Easy Ops" view** - recent commits, branches and
  recovery points, each with a full context menu (commit rows: reword, fast-forward,
  patch, **create branch**; branch rows: **create / rename / check out / delete**).
  This is the main entry point.
- **Timeline view** - right-click a commit row of the selected file
  (`timelineItem == git:file:commit`).
- **Source Control title / repository menu** (`···`) → *Git Easy Ops*.
- **Command Palette** → `Git Easy Ops: ...` (asks for the commit when nothing is selected).

### Right-clicking a commit or branch in the built-in **Source Control Graph**

Commit rows (`scm/historyItem/context`) get the commit menu - reword, fast-forward,
patch, **Create Branch...** - and the branch/ref rows (`scm/historyItemRef/context`)
get the branch menu: **Create / Rename / Check Out / Delete Branch**, fast-forward,
backup, force push.

Those two menu keys are a **proposed** VS Code API (proposal
`contribSourceControlHistoryItemMenu` - still proposed as of VS Code 1.10x), and
the Marketplace refuses manifests that declare `enabledApiProposals`. So it ships
as a second build, and VS Code needs *both* halves:

```bash
# 1. build the graph flavour and install it
npm run package:graph                       # -> git-easy-context-operations-<version>+graph.vsix
code --install-extension git-easy-context-operations-0.1.0+graph.vsix

# 2. allow the proposal (persistent) - Command Palette:
#    "Preferences: Configure Runtime Arguments", then add to ~/.vscode/argv.json:
#      { "enable-proposed-api": ["luncat8.git-easy-context-operations"] }
#    ...or per launch:
code --enable-proposed-api luncat8.git-easy-context-operations

# 3. restart VS Code
```

Shortcuts:

- `npm run package:graph -- --install` builds **and** installs it.
- Inside VS Code, run **Git Easy Ops: Enable Source Control Graph Menu...** - it
  writes that `argv.json` line for you (comments and other settings preserved,
  backup written next to it) and tells you exactly which half is still missing:
  the build, the runtime argument, or nothing at all.
- `npm run graph-menu:on|off|status` patches `package.json` by hand; `off` is what
  you want before publishing.

Running from source (`F5`) needs no flag at all: an Extension Development Host
grants the proposals listed in `enabledApiProposals`.

## Install

The built artifacts are **committed to this repository**, so a clone is enough -
no toolchain needed:

```bash
# the graph flavour: commit AND branch context menus in the built-in Source Control Graph
code   --install-extension git-easy-context-operations-0.1.0+graph.vsix
codium --install-extension git-easy-context-operations-0.1.0+graph.vsix
```

Then allow the proposal (once) - inside the editor run **Git Easy Ops: Enable
Source Control Graph Menu...**, or add this to `~/.vscode/argv.json`
(`~/.vscode-oss/argv.json` for VSCodium) and restart:

```json
{ "enable-proposed-api": ["luncat8.git-easy-context-operations"] }
```

`git-easy-context-operations-0.1.0.vsix` (no `+graph`) is the Marketplace-safe
build: same commands, but they appear in the sidebar view, Timeline, the Source
Control title/repository menus and the palette instead of the graph rows.
**Git Easy Ops: Why Don't I See the Menus?** tells you which half is missing.

Building them yourself:

```bash
npm install
npm run package         # publishable build: sidebar view, Timeline, SCM menus, palette
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

## Development

```bash
npm install
npm run compile        # type-check + bundle to dist/extension.js
npm test               # 377 headless tests (real git repositories, no editor)
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
- Rewording needs the commit to be reachable from a local branch.
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
