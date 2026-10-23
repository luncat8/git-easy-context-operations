# Saved dialog decisions — implemented specification

Status: **implemented in 0.4.22**. Additional Git-action ideas remain
[deferred for later review](deferred-context-actions.md); they are not part of
this work.

This document is the reviewed specification the code implements. Review
changes relative to the original proposal are marked **[review]** so the
reasoning stays visible; everything else is the agreed direction, now with
exact ids, files and tests.

## Agreed direction

- Saving decisions is disabled by default (`geco.rememberDialogDecisions`, `false`).
- Repeatable choices may be saved even for dangerous actions, including force
  push. Danger alone does not make a decision ineligible.
- Settings show the complete action list and current state, not remembered
  answers hidden in opaque storage.
- Undo cannot have a reusable default decision and must not save one.
- Reset controls return saved decisions to the default/unset state.

## Review improvements (what changed and why)

1. **Precedence with `geco.confirmDestructiveOperations` is now defined.**
   That older switch already suppresses the confirmations it gates. A saved
   decision is only consulted where a confirmation would otherwise be shown,
   so turning confirmations off keeps working exactly as before and nothing
   can be "learned" from a dialog that never appeared. Ungated questions
   (e.g. rebase-onto-upstream, unmerged-delete) consult their saved decision
   whenever they are asked. Neither switch changes the other.
2. **First release saves only binary (yes/no) answers.** A multi-choice
   dialog does not have one stable answer: the Fast-Forward cleanup dialog
   *selects side-effects* (move, move+remove backup, move+clean up), so it is
   recorded as ineligible with that reason instead of pretending "yes" could
   capture it. Multi-choice enrolment would need per-answer ids and is future
   work, not a silent generalisation.
3. **Repository identity is concrete.** The scope key is the canonical
   (real-path, normalised) repository root supplied by the VS Code layer
   (`canonicalRepoKey`). Linked worktrees opened through that root share its
   scope; different repositories never do. An empty/unresolvable identity
   fails closed: ask, never approve, never save.
4. **The management view is an explicit settings surface.** Editing it is
   allowed while the master switch is off — rows show *inactive: mode
   disabled*, enabling there only *stores* an answer, and dialogs neither
   offer "(always)" nor use a stored answer until the mode is turned on.
   (The original "no saved answer is newly written while off" applies to
   dialogs; a settings surface the user deliberately opened is the exception,
   otherwise inactive rows could never be prepared or reviewed.)
5. **Enabling a destructive row in the view asks once more.** VS Code cannot
   put a checkbox in a native modal, so the view uses the same native
   checkbox-tree pattern as the Menu Editor; for destructive questions the
   extension adds a fresh modal confirmation (itself never rememberable)
   before the checkbox takes effect. Unchecking/resetting is the safe
   direction and never asks.
6. **The inventory is by question, not by command.** Every `ui.confirm` /
   `ui.choose` call site maps to exactly one stable id (table below).
   Inputs, pickers, checkbox lists and result-report buttons are inventoried
   as named not-applicable rows instead of being silently absent.

## Settings and state model

Master setting: `geco.rememberDialogDecisions`, default `false`, linked from
its description to **Git Easy Ops: Manage Dialog Decisions…**, which reveals
the hidden **Git Easy Ops Dialog Decisions** view (native tree, keyboard
navigable; no raw JSON UI).

Each row shows a human-readable action name, exactly which question it
controls, and one of:

- **Default (not enabled)** — no saved choice; ask every time.
- **Enabled — always "\<label\>"** — the saved affirmative answer in use.
- **Saved — inactive: mode disabled** — stored, but unused while the mode is off.
- **Default — not eligible** — with the recorded reason (Undo & friends).
- **Not applicable** — inputs/pickers/reports; there is no answer to save.

The view header identifies the repository being edited. Per-row reset is the
row's checkbox/context command ("Reset Saved Decision to Default");
**Clear All Saved Decisions…** (view toolbar / Command Palette) clears every
repository's decisions *in this workspace* after a fresh, non-rememberable
confirmation that names that scope. Reset never touches the master switch.

"Enabled" means an exact answer is configured, never "saving might happen
later": enabling requires the explicit "(always)" button in a dialog or an
explicit enable in the view (plus the extra modal for destructive rows).
Cancel, Escape, window-close and dismissal never become saved answers, and
the ordinary action stays first, so Enter never enrols.

## Inventory (stable ids — storage keys, never renamed)

Eligible (saved answer = the affirmative button):

| Id | Question it controls |
|---|---|
| `reword.rename` | Rename the message of \<commit\> on \<branch\>? |
| `squash.confirm` | Squash \<N\> commits into one on \<branch\>? |
| `fastForward.move` | Move \<branch\> to \<commit\>? (plain two-button form) |
| `fastForward.moveAnyway` | \<branch\> has commits that \<target\> does not. Move it anyway? |
| `forcePush.lease` | Force push … with `--force-with-lease` |
| `forcePush.force` | Force push … with hard `--force` (never approved by the lease row) |
| `patch.applyToCurrent` | Apply this patch to the current branch? |
| `pushSync.abortUnfinished` | Abort the unfinished merge/rebase/…? |
| `pushSync.rebaseOntoUpstream` | Rebase \<branch\> onto \<upstream\>? |
| `pushSync.moveOntoUpstream` | Point \<branch\> at \<upstream\>? |
| `cleanHistory.rewrite` | Remove \<N\> dead path(s) from the entire history? |
| `cleanHistory.dropRecoveryPoints` | Drop recovery points and reclaim space? (separate from the rewrite) |
| `branch.renameOverwrite` | A branch called \<name\> already exists. Overwrite it? |
| `branch.renamePushRemote` | Push the rename to \<remote\>? (remote handling is still picked fresh each time) |
| `branch.deleteLocal` | Delete branch \<name\>? |
| `branch.deleteEverywhere` | Delete \<name\> locally and on the remote? (never approved by the local-only row) |
| `branch.deleteUnmergedAnyway` | \<branch\> has unmerged commits. Delete it anyway? |
| `branch.removeRedundant` | Delete redundant branch(es)? — fallback modal only; the checkbox list itself is never skipped |

Ineligible (stay interactive, reason recorded in the registry):

| Id | Why |
|---|---|
| `undo.confirm` | Restores the specific journal entry picked at that moment; a standing yes could roll back unreviewed work. Result-report Undo buttons likewise never run automatically. |
| `pushSync.removeLock` | A lock that looks stale may be held right now; safety must be judged fresh. |
| `cleanHistory.rewriteWithoutBundle` | Only asked after the backup bundle failed; proceeding leaves no way back, so consent is fresh for that failure. |
| `cleanHistory.installFilterRepo` | Installs software via a machine-specific command chosen at that moment. |
| `cleanHistory.removeLinkedWorktrees` | Which worktrees exist and what they hold is fresh state. |
| `fastForward.cleanupChoice` | Selects side-effects, not yes/no (review point 2). |
| `graphMenu.updateEditorConfig` | Writes the editor's own `product.json`/`argv.json`, picked at that moment, outside any repository. |

Not applicable: `result.followUps` (optional report buttons, never
automatic), `input.textEntry` (fresh text each time), `selection.pickers`
(fresh selection each time; preferences such as
`geco.applyPatchDestination` stay ordinary settings). Commands with no
question of their own (Create Branch, Check Out, Copy SHA, Show Backups…)
only ever meet these rows.

## Safety boundaries (unchanged from the proposal, now enforced by tests)

- Force push with lease and hard `--force` are separate ids/rows; lease
  approval never authorises hard force or escalation after a rejected lease.
- A decision is about the question, not arguments: future targets come from
  the current run's selections.
- Skipping a confirmation skips nothing else: repository-state checks,
  target validation, lease checks, recovery backups and journaling all run.
- A different question never inherits approval (`branch.deleteLocal` does
  not approve `branch.deleteEverywhere`; the redundant-branch checkbox list
  is the review itself and is never skipped).
- Already-answered internal calls (`forcePush(..., { confirmed: true })`
  from a result report or picker row) neither ask nor save — one decision,
  one confirmation.

## Storage and failure behaviour

- Typed, versioned registry in `src/core/dialogDecisions.ts`: stable ids,
  allowed answer (`yes` only), per-question `policyVersion`. Unknown ids,
  unknown answers and stale policy versions parse as unset.
- Storage is extension **workspace state** under `geco.dialogDecisions.v1`,
  keyed by canonical repository identity; never synced, never in settings.
  No credentials, dialog text, SHAs or file contents are stored.
- Read failure → ask normally (plain confirm, no "(always)" offer). Write
  failure → the explicitly chosen one-time action proceeds; the failure is
  logged and reported, nothing is pretended saved. Missing repository
  identity → ask. The management view repaints after every write/reset.

## Where it lives

| Piece | File |
|---|---|
| Registry, parser, in-memory store, row-state machine | `src/core/dialogDecisions.ts` |
| Asking path (skip / offer "(always)" / save) | `Controller.confirmDecision` in `src/core/controller.ts` |
| Master setting | `rememberDialogDecisions` in `src/core/config.ts` + `package.json` |
| Workspace-state store, canonical repo key | `src/vscode/dialogDecisionStore.ts` |
| Management view | `src/vscode/dialogDecisionsTree.ts`, wired in `src/extension.ts` |
| Tests | `src/test/core/dialogDecisions.test.ts` (+ manifest/config suites) |

## Acceptance tests (all covered)

- Fresh installation: mode off, every action Default, existing behaviour
  unchanged (the whole pre-existing suite runs with the mode off).
- "(always)" is the second button; Enter/the ordinary button, Cancel,
  Escape and dismissal save nothing; an explicit "(always)" saves and the
  next run of the *same* repository skips only that question.
- Lease approval never authorises hard force; master off ignores stored
  answers and re-enabling resumes them; per-row reset restores Default
  (including inactive rows); invalid data, policy changes, missing identity
  and storage failure fall back to asking, not approval.
- Undo remains ineligible and still asks with the mode on.
- Manual verification still owed on real VS Code: native dialog button
  order/focus per platform and screen-reader/keyboard access to every row
  of the management view (the view is a native tree, like the Menu Editor).

## Updating into the new view

The management view is new in this release, and VS Code resolves the
contributed-view list once per window. A window that was loaded before the
update answers `window.createTreeView('geco.dialogDecisions', ...)` with
`No view is registered with id: geco.dialogDecisions`
(microsoft/vscode#265001; *Developer: Reload Window* is the fix). The asking
path, the store and every command work without the view, so the extension
records the missing view, reports it once with a **Reload Window** button and
continues activation - the view cannot take the extension down with it.
Covered by `src/test/core/viewAvailability.test.ts`.

## Native dialog limitation

The extension supplies affirmative-first order and an explicit final close
affordance. VS Code and the OS control actual native placement and focus;
the public API cannot guarantee physical left/right ordering on every
platform.
