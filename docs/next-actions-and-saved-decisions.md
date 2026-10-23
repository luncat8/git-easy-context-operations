# Plan: remembered dialog decisions

Status: revised proposal, not implemented. Additional Git-action ideas are [deferred for later review](deferred-context-actions.md); they are not part of this work.

## Agreed direction

- Saving decisions is disabled by default.
- Repeatable choices may be saved even for dangerous actions, including force push. Danger alone does not make a decision ineligible.
- Settings should show the complete action list and current state, not hide remembered answers in opaque storage.
- Undo cannot have a reusable default decision and must not save one.
- Provide a reset control that returns saved decisions to the default/unset state.

## Settings and state model

Proposed master setting: `geco.rememberDialogDecisions`, default `false`.

Add a dedicated **Dialog Decisions** settings view, opened by **Git Easy Ops: Manage Dialog Decisions…** and linked from the master setting description. The small action inventory should fit in one list. Do not present a raw JSON map as the main interface.

Each action row shows:

- A human-readable action name and explanation of exactly which question it controls.
- **Default (not enabled)**: no saved choice; ask every time.
- **Enabled — <saved answer>**: the explicit answer to use when the mode is on.
- A reset-to-default control and, for eligible actions, a control to configure the answer.
- For Undo and other genuinely non-repeatable questions: **Default — not eligible**, with an explanation, rather than a misleading enabled toggle.

When the master switch is off, saved rows remain visible but are marked **inactive: mode disabled**. No saved answer is used or newly written. Re-enabling resumes saved choices; resetting deletes them.

“Enabled” must mean that an exact answer is configured, not merely that saving might happen later. For a yes/no confirmation, enabling requires explicit approval of the affirmative answer. For a multi-choice dialog, enabling requires selecting the answer. Cancel, Escape, window-close and dismissal never become saved answers.

Inventory every current action, including actions without a reusable confirmation (shown as not applicable). Where an action has distinct questions, show named subrows: one broad action toggle must not silently answer all its prompts. Existing preferences, such as patch destination, stay ordinary settings rather than creating conflicting defaults.

## Enabling from a dialog

When the master mode is on, eligible dialogs may offer:

`Force Push | Force Push (always) | Cancel`

The ordinary action remains first and is the Enter default; enrolling in persistent behavior always requires the explicit “always” action. Multi-choice dialogs must identify which answer is being saved; avoid doubling every button in a crowded dialog and link to Manage Dialog Decisions when necessary.

A checkbox would be cleaner, but VS Code's public native message-dialog API does not expose one. Prefer native dialogs and the settings view over introducing a custom dialog solely for a checkbox.

The settings view must explain that enabling a destructive choice skips future confirmations for that specific question. Saving is explicit consent, not inferred from frequent use.

## Dangerous actions and safety boundaries

Force Push, Move Anyway, overwrite, deletion and history-rewrite confirmations may qualify when their answer has a stable meaning. Review each actual prompt individually rather than excluding it solely because it is destructive.

- Keep force push with lease and hard `--force` as separate decision IDs and separate settings rows. Saving approval for one must never approve the other or authorize escalation after a rejected lease.
- Save a decision about the question, not command arguments: future targets still come from the user's current command selection.
- Saving approval skips only the named confirmation. Continue all repository-state checks, target validation, operation preconditions, lease checks, recovery backups and journaling that the operation normally requires.
- A new conflict, dirty worktree, changed remote or different question must not inherit approval from a superficially similar prompt. Revalidate after asynchronous work where required.
- Multi-step cleanup approvals must not silently authorize unrelated remote deletion, worktree removal or other sub-actions. Each reusable approval needs its own documented policy.
- Undo, optional result follow-ups, conflict-resolution choices and prompts requiring fresh file/ref selections are not reusable defaults. Do not turn an Undo result button into an automatic operation.
- Ineligible safety/security questions stay interactive. Record the specific reason in the inventory rather than treating all dangerous Git operations as ineligible.

## Storage and reset

- Use a typed, versioned registry of stable prompt IDs, allowed answers and eligibility. Do not key decisions by localized button text.
- Store decisions in extension workspace state, scoped by canonical repository identity for multi-root workspaces. The management view clearly identifies the repository being edited. Do not sync approvals across repositories or machines.
- Do not store credentials, dialog text, SHAs or file contents as decisions.
- Invalid, unknown or obsolete answers mean unset. A policy-version change returns that prompt to Default rather than reusing consent with changed semantics.
- Provide per-row **Reset to Default** and **Clear All Saved Decisions…**. The latter clears every repository's decisions in this workspace after a fresh, non-rememberable confirmation. Clearly label that scope.
- Reset removes saved values, including inactive ones, but does not change the master switch. The resulting action state is Default (not enabled).
- If saving fails, perform only the explicitly selected one-time action; report/log that persistence failed. If reading fails, ask normally. Update displayed state after writes and resets.

## Implementation sequence

1. Inventory all existing actions and their questions; record repeatable answers, scope and ineligibility reasons. Include force-push variants and Undo explicitly.
2. Implement the typed registry and repository-scoped workspace-state store.
3. Add the disabled-by-default master setting and complete action-state management view with accessible labels, keyboard navigation, per-row reset and clear-all.
4. Wire eligible prompts to the store, including explicit “always” consent where it fits. Keep result notifications non-blocking and preserve the one-decision/one-confirmation rule.
5. Document exactly what saved approval skips and how to disable or reset it.

## Acceptance tests

- Fresh installation: mode off, every action Default, existing behavior unchanged.
- Enable one answer: settings shows Enabled with its exact answer; only its corresponding question is skipped.
- Force-push approval never authorizes hard force or bypasses a rejected lease; normal safety checks still run.
- One-time approval, Cancel, Escape and dismissal never save anything. Enter uses the ordinary action, not “always”.
- Undo remains ineligible. Result follow-ups never run automatically.
- Master off ignores stored choices; re-enable resumes them. Per-row reset and clear-all restore unset state, including inactive values.
- Invalid data, policy changes, missing repository identity and storage failure fall back to asking, not approval.
- Multi-root repositories remain isolated; settings shows the active scope and refreshes after a change.
- Manually verify native dialog keyboard behavior on supported platforms and screen-reader/keyboard access to every settings row.

## Native dialog limitation

The extension supplies affirmative-first order and an explicit final close affordance. VS Code and the OS control actual native placement and focus; the public API cannot guarantee physical left/right ordering on every platform.
