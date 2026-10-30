# Changelog

All notable changes to **Git Easy Ops** are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
the project uses [semantic versioning](https://semver.org/).

## 0.4.28

### Added

- **Open Source for Edit in the changed-file context menu.** The changed-file
  rows of the built-in Source Control view open a (usually read-only) diff by
  default; right-clicking one now also offers **Open Source for Edit**, which
  opens the file itself in an editable editor tab. It sits at the end of the
  built-in open actions (after Open Changes / Open File / Open HEAD File),
  works for selected rows (all of them open), skips rows whose file is gone
  from the working tree, and is switchable like every other menu item
  (**Git Easy Ops: Customize Context Menus...**).

## 0.4.27

### Added

- **Binary patch handling.** Before applying, the extension now checks files directly beside the patch (not in subdirectories) against the binary diff’s new blob hash. A match is copied to the patch’s repository path, and the binary-only diff section is removed so the remaining patch can apply. Mailbox patches are handled too.

## 0.4.26

### Changed

- **Aggregate Undo is on by default.** 

## 0.4.25

### Fixed

- **Aggregate Undo now includes follow-up steps in the action that offered them.**
  Squash/reword/fast-forward/clean-history followed by their Force Push button,
  push/sync diagnosis repairs, and Create Branch followed by Check Out previously
  created fresh action ids, so the journal still showed separate `squash`,
  `forcePush`, `branch`, ... rows even with
  `geco.aggregateUndoLastOperation` enabled. These follow-ups now inherit the
  originating action id. One aggregated Undo applies all of their checkpoints
  newest-to-oldest; regression tests verify both the local history and remote
  after undoing squash + push, and the original checkout after undoing create +
  checkout. Separate menu commands remain separate actions, and legacy journal
  entries without an action id remain individually undoable.
- Refreshed the tracked development bundle; it had not contained the Aggregate
  Undo implementation even though the 0.4.24 VSIX packages did.

## 0.4.24

### Added

- **Optional aggregate Undo, one restore point per user action.** The new
  `geco.aggregateUndoLastOperation` checkbox is off by default, preserving the
  existing checkpoint-by-checkpoint behavior. Every journal checkpoint now also
  records the controller action that created it. With the checkbox on, **Undo
  Last Operation** and the journal rows in **Backups & Undo** show one item for
  the whole action; choosing it applies every detailed undo step newest to
  oldest, restoring the state from before the action. This covers the composite
  fast-forward + backup removal + redundant-branch cleanup flow with one Undo,
  including its branch checkout. The journal file and output log keep every
  checkpoint, and legacy entries without an action id remain individually
  undoable. An end-to-end regression test verifies the complete pre-action
  branch/worktree state and the remaining journal.

## 0.4.23

### Changed

- **Fast-forward ends on the moved branch, so the old names can really go.**
  When the moved branch (usually `main`) was not the checked out one, the
  worktree now checks it out after the move - clean worktrees only, and never
  when the branch is checked out in another worktree. Before, the worktree
  stayed on the branch you were on: exactly the name the move made redundant,
  and a checked-out branch is never offered for deletion, so "Remove Redundant
  Branches" left it behind as a leftover. Now a plain *Move* leaves you on
  `main`, and the former feature branch (and the redundant `old` backup) can
  be removed right after, with the same command. The checkout is part of the
  move's own journal entry: one "Undo Last Operation" restores the old tip
  *and* leaves the branch again. When the worktree has uncommitted changes it
  is left where it is, and the report says so
  (`src/core/fastForward.ts`, `checkoutAfterMove`).

### Fixed

- **A diverged fast-forward no longer asks the same question twice.** When
  the move was not a real fast-forward (the branch has commits the target
  does not contain), the first confirmation already said so - "NOT a
  fast-forward: N commits would be left behind" with a *Move anyway* button.
  Answering it now performs the forced move instead of the flow catching its
  own `not-fast-forward` error and repeating the question verbatim. The
  follow-up "...Move it anyway?" dialog is still asked when the force question
  was not answered live: when confirmations are off, when the first answer
  came from a saved dialog decision (a saved *Move* still never authorizes a
  forced move on its own - `fastForward.moveAnyway` keeps its own gate), or
  when the branch diverges only after the user confirmed the plain move.

## 0.4.22

### Added

- **Saved dialog decisions (opt-in, off by default).** With the new
  `geco.rememberDialogDecisions` setting on, eligible confirmations offer a
  second button ("Force Push (always)") next to the ordinary one; picking it
  saves that affirmative answer for that repository only, and the same
  question is skipped next time. One-time answers, Cancel and dismissal
  never save anything, the ordinary button stays first, and skipping a
  question skips nothing else - repository checks, recovery points and
  journaling still run. **Git Easy Ops: Manage Dialog Decisions...** opens a
  native checkbox view listing every question with its state (Default /
  Enabled — always "…" / Saved — inactive), per-row reset and
  **Clear All Saved Decisions...** for the whole workspace. Force push with
  lease and hard `--force` are separate decisions, as are deleting a branch
  locally and everywhere. Undo, removing a lock file, rewriting without a
  backup bundle, installing git-filter-repo, editing the editor's config
  files and the fast-forward cleanup choice can never be saved and always
  ask, with the reason recorded in the registry
  (`src/core/dialogDecisions.ts`). Decisions live in workspace state, scoped
  by canonical repository, never synced; invalid or outdated entries and
  storage failures fall back to asking. The reviewed specification is
  `docs/next-actions-and-saved-decisions.md`.

### Fixed

- **A window that does not know the new views yet no longer breaks the
  extension.** VS Code fixes the list of contributed views when a window
  opens, so after an update that adds one (here: the *Dialog Decisions*
  view) a window that is still running the previous manifest - an extension
  updated in place, "Restart Extensions", a development host left open -
  rejects `createTreeView` with `No view is registered with id:
  geco.dialogDecisions`. That error used to escape `activate` and take the
  whole extension with it: no commands, no git hooks, no graph. A missing
  view is now logged, remembered and reported once - **"Reload Window ..."**
  finishes the update - and everything else starts normally
  (`src/core/viewAvailability.ts`). Ordinary failures are still rethrown, so
  a genuinely broken manifest is not hidden as an update artifact.

## 0.4.21

### Fixed

- An explicitly selected patch already present in the repository is reported as information, not a failed operation. Remembered-patch fallback behavior is unchanged.
- Confirmation dialogs supply the affirmative action first and an explicit Cancel close affordance last (including custom cancel labels). Multi-action dialogs put the primary action first, so Enter selects it; Escape/window close cancels. Native platform layout remains controlled by VS Code.

### Planning

- Added `docs/next-actions-and-saved-decisions.md`: opt-in saved decisions, including repeatable destructive approvals, with a complete action-state settings view and reset controls. Persistence was not implemented in that release (it arrived in 0.4.22). Additional Git-action ideas are deferred in `docs/deferred-context-actions.md`.

## 0.4.20

### Fixed

- **The `+graph` build now installs as `0.4.20+graph`, so VS Code actually
  asks for the reload that makes it run.** Installing
  `git-easy-context-operations-0.4.19+graph.vsix` over
  `git-easy-context-operations-0.4.19.vsix` (or the other way round) replaced
  the extension on disk but showed only *"Completed installing extension."* -
  no *Reload Now* / *Restart Extensions* - and the previously loaded build kept
  running, so the Source Control Graph menus never appeared and the install
  looked like a no-op. The build now stamps the graph manifest with
  `"version": "<version>+graph"`; the `.vsix` file name is unchanged.
  Anyone still on the 0.4.19 pair has to reload once by hand
  (*Developer: Reload Window*) to get out of the old state.

  Why the version was the problem: VS Code decides whether an install needs a
  reload by comparing version **strings** - `getRuntimeState()` in
  `src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts`
  returns the reload state only when
  `extension.version !== runningExtension.version` (or the target platform
  differs), and the *Install from VSIX...* command turns exactly that state
  into its *Reload Now* / *Restart Extensions* notification
  (`extensions.contribution.ts`). A VSIX install of the *same* version still
  deletes and re-extracts the extension folder
  (`InstallExtensionInProfileTask.doRun` in
  `src/vs/platform/extensionManagement/node/extensionManagementService.ts`),
  so the files on disk were new, the running extension host was old, and
  nothing told the user. That is a VS Code behaviour worth reporting upstream
  (the same-version case can only be detected by the install, not by the
  version comparison); the analysis and a ready issue text are in
  `docs/vscode-same-version-vsix.md`.

  Why build metadata and not another suffix: VS Code validates the manifest
  version with semver, so four-part versions (`0.4.20.1`,
  `0.4.20.1-graph`) are rejected outright; a prerelease (`0.4.20-graph`)
  sorts *below* `0.4.20` and makes the Extensions view offer an "update" back
  to the publishable build; `0.4.20+graph` is semver-equal to `0.4.20` (no
  update nag) while still being a different string (which triggers the
  reload prompt). The Extensions view shows the graph build as
  `0.4.20+graph`.

### Build

- `scripts/graph-version.mjs` centralises the version mapping and
  `scripts/check-graph-version.mjs` pins it in `npm test` (so CI fails if the
  two builds would ever share a version again); `npm run package:graph` refuses
  to package a manifest whose version does not match `<version>+graph`, and
  `build.py` restores and rejects a leftover graph version the same way it
  already did for `enabledApiProposals`.

## 0.4.19

### Fixed

- **No operation waits for its own result report any more - the endless
  progress bar is gone from every flow.** An operation handed its result to
  VS Code and then *awaited* the notification. VS Code resolves that promise
  only when the notification goes away - 10 s for an info toast, and never
  under Do Not Disturb, while the mouse hovers it, or while the window is
  unfocused - so the command stayed pending, and an action started from the
  built-in **Source Control Graph** runs under a progress indicator that lasts
  exactly as long as the command's promise. That is the spinner that kept
  turning after a reword, a squash, a fast-forward, a force push, a branch
  rename / delete / checkout, a fast-forward cleanup, a redundant-branch
  removal, Show Backups, Find Proper Base or the graph-menu setup was long
  done. Every one of them now hands the report over without waiting (one
  helper, `Controller.reportResult`, which is also the only way to do it - a
  comment in `AGENTS.md` says so), and the *Undo* / *Force Push* / *Open
  Worktree* buttons still run their follow-up when they are clicked later.
  This is the same bug class as 0.4.10 (plain messages) and 0.4.16 (the patch
  report), which had only been fixed where it was reported. A genuine question
  - whose answer the flow needs before it can go on, e.g. "install
  git-filter-repo now?" - is still awaited, as it must be.
- **Force Push is confirmed once, not twice.** After a squash, a fast-forward,
  a rewrite, a Clean History or a push/sync repair the result report offers
  **Force Push**; pressing it *is* the answer to "overwrite the remote?", and
  the flow then opened the modal dialog asking the very same question again.
  The already-given answer is now passed through
  (`forcePush(..., { confirmed: true })`), so the button does the push. A
  force push started from a menu or the Command Palette still asks for its
  modal confirmation - that one is the first and only gate.

### Tests

- New `endlessProgress.test.ts` stands in for the notification that is never
  dismissed (what the real adapter does under Do Not Disturb) and requires
  Rename Commit Message, Squash, Fast-Forward, Force Push, Remove Redundant
  Branches, Create / Check Out / Rename / Delete Branch and Show Backups to
  finish anyway; the same file pins that the report's Force Push button does
  not ask again (reword, squash, fast-forward, push/sync repair) while a
  force push from a menu still asks, and that a follow-up that fails is
  logged instead of becoming an unhandled rejection.
- `followUpWithoutWaiting` now returns a promise for the follow-up itself
  (it never rejects), which is what lets the controller - and the tests that
  drive it - know when the work that outlived a command is over.

## 0.4.18

### Changed

- **Both headers now share one button order, and the graph header skips the
  row-targeted operations.** After the header's original buttons (Refresh on
  our own view; the pickers, Fetch / Pull / Push / Publish and Refresh on the
  built-in Source Control Graph), ours run: **Apply Patch Automatically**,
  **Apply Patch at Proper Base...**, **Find Proper Base for Patch...**,
  **Fast-Forward Default Branch to Commit...**, **Squash with Previous
  Commits...**, **Rename Commit Message...**, **Rename Branch...**, **Remove
  Redundant Branches...**, **Clean History (Remove Dead Paths)...**, **Undo
  Last Operation**, **Diagnose Push / Sync Trouble...** and **Copy Repository
  Web Link** last (the **Customize Context Menus...** gear still closes our
  own view's header). **Apply Patch Automatically** now leads **Apply Patch
  at Proper Base...**, and **Remove Redundant Branches...** and **Undo Last
  Operation** moved ahead of **Clean History...** and **Diagnose Push / Sync
  Trouble...** respectively.
- **Fast-Forward Default Branch to Commit...**, **Rename Branch...** and
  **Copy Repository Web Link** are now buttons of the stable `Git Easy Ops`
  view header (the fast-forward opens the usual commit picker and moves the
  default branch; the rename opens the branch picker).
- **The `+graph` header contains no fast-forward, Squash, rename-commit or
  rename-branch button any more.** In that build they are context-menu items
  of the very commit row (fast-forward / Squash / rename commit) and branch
  badge (rename branch) they operate on, so a header button would only have
  to guess its target through a picker. The stable header keeps all four:
  without the proposed API there is no such context menu.
- **Our graph-header buttons now sit after the original ones**
  (`navigation@1010` and behind, past the workbench Refresh at order 1000
  and git's Fetch / Pull / Push / Publish at `navigation@900`-`903`), instead
  of interleaving with them at the front. A `|` separator between the
  originals and ours cannot be contributed - only the single `navigation`
  group renders as buttons in a view caption, so there is no group boundary
  a separator could sit on; a second group would move the buttons into the
  caption's overflow menu instead.

### Fixed

- **"Why Don't I See the Menus?" hides itself once the graph menus are
  actually visible.** Both header entries now also require that the proposed
  Source Control Graph menus are *not* on screen in the running session
  (`geco.graphMenuVisible`, set at activation from the proposals VS Code
  enabled for this session). That is deliberately the session's truth, not
  the grant files': an `argv.json` / `product.json` grant that still needs
  its restart keeps the entry, while a per-launch `--enable-proposed-api`
  (or an Extension Development Host) hides it the moment the menus show.
  The Customize Context Menus switch still governs the entry everywhere
  else, and the Command Palette always keeps the command. The same split
  fixes the diagnosis reading the two proposal lists as one: VS Code
  empties the runtime `enabledApiProposals` of a not-yet-granted `+graph`
  install, so "is this a graph build?" is now read from the untouched
  `originalEnabledApiProposals`, and the report states "ready" (build plus
  persistent grant) and "visible in this session" as the two separate
  facts they are.

### Tests

- The manifest/catalogue tests pin the exact button order of both headers,
  the four buttons the graph header skips (and that each of them is still on
  its graph row menu, so skipping loses nothing), and that every graph
  header button sorts behind the last original button.
- The graph-menu tests pin the "visible in this session" verdict (every menu
  key and both proposals, and the split from file-based "ready" in both
  directions), and the manifest/catalogue tests pin that only the two
  "Why Don't I See the Menus?" header entries carry the visibility gate
  while the palette keeps the command.

## 0.4.17

### Added

- **Undo is now a header button.** The Git Easy Ops view and the optional built-in
  Source Control Graph toolbar both expose **Undo Last Operation**. It opens the
  same newest-first journal picker as `Git Easy Ops: Undo Last Operation` in the
  Command Palette, including the existing option to roll back several newer
  operations when an older entry is selected.
- **Primary history actions are available from the headers.** **Squash with
  Previous Commits...** and **Rename Commit Message...** open their normal commit
  picker when no row is selected. Header actions now follow a predictable order:
  patch actions first, then squash and rename, repository maintenance, and Undo
  last.

### Tests

- The manifest/catalogue tests cover the new header surfaces, visibility switches,
  and ordering in both the stable view and the proposed graph build.

## 0.4.16

### Fixed

- **A single line break in a commit message survives a squash and a
  rename.** The message was rebuilt from git's *subject* (`%s`) and *body*
  (`%b`) when it was read: git folds the first paragraph of a message into
  one line (`123\n456` becomes the subject `123 456`) and the body is empty
  for a message without a blank line. A message with a paragraph break
  (`123\n\n456`) came out unchanged, but a message with a single line break
  lost it - the line break turned into a space. The raw message (`%B`) is
  now read instead, so every line break the message has is kept: the
  default message of **Squash Selected Commits...** / **Squash with
  Previous Commits...** and of **Rename Commit Message...** is the message
  as it is stored, and it is stored that way again.

### Tests

- New coverage for the message parsing (a single line break, a paragraph
  break, indentation, a message that is only a body) and for both flows:
  the default message keeps its line breaks when it is accepted.

## 0.4.15

### Fixed

- **Squash and Rename Commit Message preserve multiline messages when the
  default is accepted.** VS Code's single-line input used to strip line
  breaks. These prompts now show editable `\n` escapes for line breaks and
  `\\` for literal backslashes, decoded before the message is saved.
  Paragraphs, indentation and literal escape sequences survive unchanged.

## 0.4.14

### Changed

- **Apply Patch Automatically no longer creates a branch for a patch that
  fits the latest HEAD.** When the proper base *is* HEAD, the patch
  applies cleanly there (no 3-way merge needed) and no local change
  touches a file the patch touches, the change is applied directly on the
  current branch - **no new branch, no worktree, and still no commit**:
  it lands staged in your own checkout, ready to review and commit under
  your own name. A branch (or the configured worktree) is still created
  when the proper base is an older commit, when the patch would need a
  3-way merge at HEAD, or when a locally changed file is in its way (the
  new-branch destination then keeps its dirty-tree worktree fallback).
  The interactive *Apply Patch at Proper Base...* flow is unchanged: a
  destination picked there is always honoured.

### Fixed

- **The patch operations no longer leave an endless progress bar.** The
  result report of an apply (shared by *Apply Patch at Proper Base...*
  and *Apply Patch Automatically*) was awaited by the command, and VS
  Code only resolves a notification's promise when the notification goes
  away - never under Do Not Disturb, while it is hovered, or while the
  window is unfocused. The command therefore stayed pending after the
  patch was long applied, and the Source Control Graph draws its
  progress indicator for exactly as long as a command of its toolbar is
  pending. This is the same bug class fixed in 0.4.10 for plain messages,
  reintroduced by the apply report's *Undo* / *Open Worktree* buttons.
  The report is now handed over without waiting
  (`followUpWithoutWaiting`, next to the existing
  `reportWithoutWaiting`): the command finishes with the apply, and the
  follow-up still runs if the button is clicked later.

### Tests

- New coverage for both: a patch that fits HEAD lands on the current
  branch with no branch/commit (core and automatic flow), a locally
  changed file in the patch's way keeps the branch/worktree, an explicit
  interactive branch at HEAD is still created, and an automatic apply
  whose result notification *never* settles still finishes the command.

## 0.4.13

### Changed

- **Apply Patch Automatically no longer commits.** The change now lands
  *staged but uncommitted* - on the new branch, in the worktree or on the
  current branch - and the commit is made by you, with your own message and
  authorship; that is the point of the change. This now also holds for
  `format-patch` mailbox files: previously a mailbox was always replayed
  through `git am`, which commits by definition, so the automatic flow
  produced a finished commit with the *original* author, date and message.
  The mailbox diff is applied with `git apply` instead (3-way when
  `geco.threeWayApply` is on, as before); only the interactive *Apply Patch
  at Proper Base...* flow still uses `git am` for mailboxes on a new branch
  / in a worktree, where committing is what you asked for. The result
  report says explicitly that nothing was committed, and *Undo* of an
  uncommitted apply discards the staged change and deletes the branch it
  created. A repeat click recognises the patch as "already in the graph"
  (by `git patch-id`) once you have committed it; clicking again *before*
  committing applies the file once more - the new-branch destination then
  falls back to a separate worktree because the tree is dirty, and the
  report says so.

### Fixed

- **Branch names derived from patch subjects are always valid refs now.**
  A subject ending in a period ("fix typo.") used to produce `geco/fix-typo.`,
  which git rejects, and subjects containing `..` were rejected too - the
  automatic apply failed for them and fell back to the file dialog, which
  then failed the same way. Trailing dots/slashes are stripped and repeated
  dots collapsed before the branch is created.
- **A failed patch apply on a new branch rolls back completely.** When the
  3-way apply stopped with conflicts, the rollback could not check the
  previous branch back out (git refuses with a dirty index) and could not
  delete the half-built branch either (it was still checked out), so the
  user was stranded on it with conflict markers. The rollback now discards
  what *its own* apply left behind first - safe, because that destination
  is only chosen when the tracked files were clean - and a previously
  detached HEAD is restored as detached.
- **Huge git output can no longer exhaust memory.** The output cap of a
  spawned git process was only checked per read chunk, so a stream of many
  chunks grew without bound; it is now cumulative per stream, and the
  `truncated` flag actually gets set.
- **A timed-out git call reports "timed out" instead of "failed (exit -1)"**
  in the error headline (the detail always had it).

### Performance

- **"Is this patch already in the graph?" went from up to 400 git processes
  to 2.** The check hashed every one of the newest 200 commits of `--all`
  with its own `git show` + `git patch-id` pair on every click of *Apply
  Patch Automatically*; both sides are now hashed in one `git show` and one
  `git patch-id` each. The duplicate-detection half of *Diagnose Push /
  Sync Trouble* batches the same way.
- **The safety check that runs before almost every command went from ~13
  git processes to 1.** The unfinished-operation markers (MERGE_HEAD,
  rebase-merge, ...) and the lock files (index.lock, ...) each cost their
  own `git rev-parse --git-path`; one `rev-parse` call with repeated
  `--git-path` flags resolves them all (git too old for that falls back to
  the per-name resolution).

### Tests

- The automatic-apply test asserts the new contract: branch tip still at
  the base, change staged in the working tree, report says nothing was
  committed. New cases: mailbox with `commit: false`, undo of an
  uncommitted apply, rollback of a conflicting new-branch apply, branch
  name from a subject ending in a period, mailbox on the current branch.

### Checked, unchanged

- The built-in **Source Control Graph** menus still need a proposed VS Code
  API: `scm/historyItem/context`, `scm/historyItemRef/context` and
  `scm/history/title` are gated behind `contribSourceControlHistoryItemMenu`
  / `contribSourceControlHistoryTitleMenu` on `microsoft/vscode` `main` as
  of 2026-10-16 (VS Code 1.142), and the tracking issues
  [#201997](https://github.com/microsoft/vscode/issues/201997) and
  [#226144](https://github.com/microsoft/vscode/issues/226144) are open.
  The Marketplace keeps rejecting `enabledApiProposals`, so the two builds
  stay: the publishable manifest without the graph menus, and the `+graph`
  vsix for a local install.

## 0.4.12

### Added

- **Apply Patch Automatically** (`geco.applyPatchAutomatically`, ⚡ in the
  view header and in the built-in graph's toolbar) - the question-free
  sibling of *Apply Patch at Proper Base...*. The first click opens the
  patch-file dialog, applies the file at its proper base with the default
  destination (`geco.applyPatchDestination`) and a branch name derived from
  the patch, and remembers the file **per repository** (editor workspace
  state - a patch path is machine-local, so it never becomes a setting).
  Every later click re-applies that same file with no dialog, no picker,
  no branch-name input and no confirmation; a plain diff is committed on
  the new branch / in the worktree so one click leaves a finished commit.
  The file dialog reopens - instead of failing - whenever the remembered
  file cannot be used for any reason: it is missing or unreadable, it is
  not a patch, it **is already in the graph** (the commit it was made from
  is reachable from a branch, a tag or HEAD, or every commit of it has a
  `git patch-id` twin among the newest 200 commits of `--all`), or it does
  not apply. A file picked in that dialog that also fails is reported as an
  error rather than reopening the dialog, and only a successfully applied
  file becomes the remembered one.

### Changed

- **The patch operations moved from the commit rows to the headers.**
  *Apply Patch at Proper Base...* and *Find Proper Base for Patch...* (and
  the new automatic one) are now buttons in the **Git Easy Ops view
  toolbar** - and in the built-in Source Control Graph's toolbar in the
  `+graph` build - and no longer sit on commit rows or in the commit
  submenu. A patch is operated on the whole repository: it is read from a
  file and applied at the base the search finds, so the clicked commit was
  never its target (at most an optional *source* the interactive flow can
  still pick after clicking). This follows the precedent of *Clean
  History* and *Diagnose Push / Sync Trouble*, which already live only on
  the headers. Trade-off, consciously taken: the one-click "turn this
  commit into a patch and re-apply it at its base" shortcut is gone - the
  interactive command still offers a selected commit as a patch source
  from the Command Palette, and asking is what that flow is for.

## 0.4.11

### Added

- **Diagnose Push / Sync Trouble...** (`geco.diagnosePushSync`) - one command
  that answers "why can I not push or sync?" from the repository itself. It
  recognizes the states that stop both buttons and says what a push would do
  (*rejected: non-fast-forward*, *it would work*, *blocked by an unfinished
  merge*, ...):

  - an **unfinished merge / rebase / cherry-pick / revert / am** and the
    conflict markers it left behind;
  - a stale **`index.lock`** left by a killed git process (shown with its age);
  - a branch with **no upstream**, or one whose tracked branch is **gone from
    the server**;
  - a **rewritten branch the remote still has** (after a reword, squash,
    forced move or Clean History), where the *Sync* button would merge the old
    history back in;
  - and the reported accident: **the same work committed twice** - the local
    commit and a commit on the remote carry byte-identical trees under
    different hashes, so `git push` is rejected as non-fast-forward while
    GitHub is already correct. `git cherry` (patch equivalence) and `patch-id`
    are compared, so the counterpart commit is *named*, and the report explains
    why Sync's `git pull` half turns this into duplicate history or into a
    conflict that leaves the repository "unfinished" (`MERGE_HEAD`).

  Offered repairs, one at a time, re-reading the repository after each:
  **abort** the unfinished operation, **remove** the stale lock (always
  confirmed), **rebase** onto the remote copy (git drops the already-applied
  commits itself - "skipped previously applied commit"), **point the branch at
  the remote copy** when nothing local is unique (old tip parked on a backup
  branch first), **Force Push (with lease)**, **fetch** (60-second timeout, so
  "the network is down" is an answer instead of a hang; `--prune` drops tracking
  refs the server no longer has) and **publish** (`git push -u`). Every repair
  that touches a ref is journaled - one **Undo** puts it back. A rebase that
  stops on a real conflict is aborted again before the error is rethrown, so
  the command never leaves behind the state it exists to clean up.
- **[docs/STUCK-STATES.md](docs/STUCK-STATES.md)** - the investigation behind it:
  every state reproduced against real repositories (including the two-clone
  accident with byte-identical trees), what the Sync button does in each one,
  why a lost connection on its own leaves *nothing* behind (a failed push or
  fetch is the safe case; the stuck state comes from the merge half of a sync, or
  from a killed process), and a recovery cheat sheet.

### Changed

- **Every operation that rewrites or moves refs refuses to start on top of a
  half-finished repository.** Rename Commit Message, Squash, Fast-Forward, Force
  Push, Clean History, Remove Redundant Branches and branch rename/delete now
  stop with `repo-busy` when a merge, rebase, cherry-pick or revert is still in
  progress, when conflict markers are left in the index, or when a lock file is
  in the way - with the state named, the command that finishes or aborts it, and
  a pointer at the diagnosis. Nothing is changed by such a command. The patch
  flow is exempt from the `git am` (and the `--3way` conflicts) it produces
  itself, because continuing or aborting them is part of that flow.
- **The report after a reword, a squash or a forced move now warns about the
  Sync button** when a force push is needed: Sync pulls (merges) first and would
  fold the old remote history - including the commits the operation replaced -
  back into the branch. The output line says it too.

### Changed (continued)

- `dist/` carries the current build (0.4.11) and the previous release (0.4.10)
  for one step of rollback; 0.4.11 also drops the `refs/remotes/...` spelling
  from the diagnosis text - the upstream is named the way a human reads it
  (`origin/main`).

### Tests

- 30 new tests (`src/test/core/pushSync.test.ts`): the duplicate-commit accident
  (identical trees, `alreadyThere`, the named counterpart), a divergent rewrite,
  being behind, a missing and a deleted upstream, a detached HEAD, an unfinished
  merge with conflict markers, a stale lock, the whole repair set (including a
  conflicting rebase that is aborted again, and a move that refuses to drop a
  unique commit), the guard (`repo-busy`) in front of the flows, and the
  interactive flow with the fake UI: the picker's rows, the confirmations, the
  journal/undo, and the "dismiss the picker" path.

## 0.4.10

### Fixed

- **"Copy Repository Web Link" no longer leaves a progress bar running.** The
  0.4.9 change removed the `git.refresh` that every command used to trigger -
  that was real, but it was not the spinner the report was about. VS Code
  resolves the promise of a **non-modal notification when the notification goes
  away**, not when it is shown: 10 s for an info message, 12 s for a warning,
  15 s for an error, never while the mouse hovers it or the window is
  unfocused, and with *Do Not Disturb* on it is only placed in the notification
  centre and never closes by itself. `message()` awaited that promise, so the
  **command** stayed pending long after the link was on the clipboard - and an
  action started from the built-in **Source Control Graph** runs under a
  progress indicator that lasts exactly as long as the command's promise (VS
  Code wraps every action of that view in `withProgress`). A message is a
  report, not a question: it is logged, shown and done with
  (`reportWithoutWaiting`), and only the messages whose *answer* the flow needs
  (`ask`, the notification with buttons) are still awaited. Every command that
  merely reports - Copy SHA, Copy Repository Web Link, Show Backups, Why Don't I
  See the Menus?, the menu editor - now finishes when its work does, so the
  graph's spinner stops with it.
- **Noticing a different repository no longer re-scans git.** The hook that
  follows the repository a command ran in (`rememberRepo`, also driven by the
  active editor) asked the git extension to re-sync whenever the repository our
  own view shows changed - a full `git.refresh` (status, refs, remotes,
  submodules, worktrees) for a change that exists only in our view, e.g. the
  first *Copy Repository Web Link* in a window with several repositories open,
  or switching to a file of another repository. Nothing about that can have
  changed git state, so only the repaint is scheduled now.
- **The menu editor's "reset" notification is not waited for** either - same
  rule, same reason (its command lives on a view toolbar, where a pending
  command is only pointless rather than visible).

### Tests

- `reportWithoutWaiting` is covered by the headless suite (a notification that
  never settles must not hold a command back, and a failing one must not
  surface as an unhandled rejection), and the VS Code integration smoke test
  runs the real command and fails if its promise does not settle with the work
  instead of with the notification.

### Changed

- `dist/` carries the current build (0.4.10) and the previous release (0.4.9);
  the superseded 0.4.7 / 0.4.8 artifacts are gone.

## 0.4.9

### Fixed

- **A command that only reads no longer starts a scan of the Source Control
  view.** Every Git Easy Ops command used to ask the built-in git extension to
  re-sync the repository, so pressing **Copy Repository Web Link** (or **Copy
  Commit SHA**, **Show Backups**, **Why Don't I See the Menus?**, ...) made the
  Source Control view show its progress bar and the repository count as busy
  while the git extension re-scanned status, refs, remotes, submodules and
  worktrees - for nothing, because nothing had changed. The re-sync now only
  happens when something really can have changed the repository: a journaled
  operation, an undo, or a change on disk. A command that did change something
  still reaches the built-in graph through those two paths, and the command
  wrapper repaints the *Git Easy Ops* view as before.
- **Re-syncs can no longer stack.** At most one `git.refresh` runs at a time; a
  burst that arrives while the git extension is still busy queues exactly one
  follow-up run instead of issuing another one right away, so our own bursts
  cannot keep the Source Control progress bar alive. The *Git Easy Ops* output
  channel now logs how long each re-sync took ("... is current again (n ms)") -
  that is the line to look at when the bar does not go away.
- **The watcher ignores what a plain `git status` writes.** Reacting to
  `.git/index` (and to the message drafts `COMMIT_EDITMSG`, `MERGE_MSG`,
  `SQUASH_MSG`) sent a refresh straight back into the git extension, whose own
  scans are what wrote those files. Only entries that can mean "history
  changed" schedule a refresh now, and a manual **Refresh** keeps the existing
  watcher instead of tearing it down and creating a new one.

## 0.4.8

### Fixed

- **The fast-forward cleanup offers only branches on the moved line.** After
  “Move and clean up redundant branches…”, the checkbox list used to include any
  branch whose commits were held by another ref - including side branches off
  the line that merely shared a commit with another name. It now only offers
  branches whose tip is on the history of the new default-branch tip (what the
  fast-forward just moved onto). Side branches are never listed there. The
  general “Remove Redundant Branches...” command is unchanged.

### Added

- **Copy Repository Web Link** - a button on the Source Control Graph caption
  (graph build) that copies the web address of the repository, built from
  `origin` (or the first remote with a web address). Credentials in the remote
  URL are never copied.

## 0.4.7

### Improved

- **Fast-forward can now finish the cleanup workflow.** Choose “Move and clean up
  redundant branches…” to move the default branch, check it out when the worktree
  is clean, and review the branch names made redundant by the move. Local branch
  deletion remains undoable; remote branch deletion is separately opted into.
  When deleting remote duplicates, the action offers to make an ordinary push of
  the updated default branch first (when it has an upstream). This replaces the
  manual checkout / sync / local cleanup steps without silently deleting remote
  refs or force-pushing.

## 0.4.6

### Fixed

- **A long commit message no longer stretches the prompts and dialogs past the
  screen.** Every place a commit message is *shown* - the "New commit message
  (currently ...)" prompt of Rename Commit Message, the Append / Search and
  Replace prompts, the rename, squash, fast-forward and branch-deletion
  confirmation dialogs, the result notifications and the undo journal entries -
  now embeds a one-line preview clipped at 120 characters with an ellipsis
  instead of the full text. The editable input of Rename still carries the
  complete message, and the output-channel log keeps the full old/new subjects;
  only the visible previews are shortened. Confirmation dialogs that list many
  commits (squash, branch deletion, fast-forward left-behind lists) also cap
  the list at ten named commits plus "... and N more".

- **Blank commit messages are accepted everywhere, stored as a single space.**
  Rename Commit Message already did this (0.4.3), but the sibling paths still
  refused: **Squash** answered *A commit message cannot be empty.* for an
  empty/whitespace combined message, and **Search and Replace in Commit
  Message** failed with *The new commit message is empty.* when the replace
  step emptied the message. Both now store one space instead - useful for
  temporary commits that should stay quiet - and repeating a blank rename stays
  a reported no-op. Squashing commits whose messages are all blank also
  produces the single space instead of an error.

## 0.4.5

### Fixed

- **The Source Control Graph caption no longer shows two refresh buttons.**
  The `+graph` build contributed `geco.refresh` to the graph toolbar
  (`scm/history/title`) on top of the refresh button the built-in graph
  already has - two identical icons for the same action. The graph toolbar
  now only adds what the built-in caption lacks (**Clean History**,
  **Remove Redundant Branches**, **Why Don't I See the Menus?**). The
  built-in refresh button keeps working as before, and every Git Easy Ops
  operation already asks the git extension to re-sync its state, so the
  second button was never doing anything the first one does not. The
  extension's own view toolbar keeps **Refresh** - that caption has no
  built-in equivalent.
- **The rebuilt artifacts carry the "Git Easy Ops Menu Editor" panel name end
  to end.** The committed `dist/` bundle predated the 0.4.3 rename (its
  source map still carried the old "Git Easy Ops Menus" title), and
  reinstalling the same 0.4.4 version can leave the previously installed
  copy in place. `dist/extension.js` and both `.vsix` files are rebuilt from
  the current sources, and the version number moves on so VS Code replaces
  the installed 0.4.4 instead of skipping a same-version install. The old
  `0.4.4` artifacts are removed from `dist/`.

### Added

- **Extension icon** (`resources/icon.png`, 128×128) - a white branch-and-bolt
  glyph on an indigo tile - so the extension carries a face in the Extensions
  list and on the Marketplace. The second proposed candidate (a white
  fast-forward commit chain with a check on a teal tile) is kept in
  `archive/icons/icon-candidate-b-commit-chain.png`, out of the `.vsix`.

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
