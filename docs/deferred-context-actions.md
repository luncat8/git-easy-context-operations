# Deferred: additional Git context actions

Status: deferred. Review later; these ideas are not part of the current implementation plan and have no committed priority.

Prefer workflows with a clear advantage over composing Git commands or the built-in graph's existing actions. Audit the minimum-supported and current VS Code graph menus before shipping: native feature availability varies, so do not promise these are universally missing.

## Candidate: Fix Up This Commit…

Right-click an older commit to attach current staged changes to it, with an optional autosquash step. This complements our reword and squash actions: a common review workflow is fixing a specific older change rather than adding an unrelated tip commit.

- First milestone: create `git commit --fixup=<sha>` from staged changes only. Display the target subject and staged file list; never stage unstaged/untracked files implicitly.
- Require a clean operation state, staged changes, and a target on the current branch. Reject merge targets initially.
- Second milestone: offer autosquash separately, preview affected commits, require a clean worktree, retain the old tip, journal the rewrite, and provide Undo plus the existing force-push-with-lease guidance.
- Stop safely on conflicts; expose Continue/Abort rather than retrying automatically. Any remembered rewrite approval must follow the separately reviewed saved-decision policy.
- Test dirty index/worktree distinctions, root commits, moved targets, published commits, cancellation, conflicts, recovery and non-blocking result reports.

## Other candidates

1. **Compare This Commit with…**: choose another commit/branch and open a read-only diff, without checking out either side. Useful as a two-endpoint graph workflow; check native coverage before adding a duplicate.
2. **Restore Files from This Commit…**: pick individual files and preview differences before restoring to the worktree only. Preserve staged changes, explicitly review overwrites, journal recoverable data, and never silently replace untracked files.
3. **Recover Branch from Reflog…**: preview lost tips and create a recovery branch without resetting the current checkout. A guided recovery flow is more valuable than another destructive Reset button.

Do not expand the default menu with all candidates at once. If these ideas are resumed, consider fixup first and expose optional actions through the menu customizer.

