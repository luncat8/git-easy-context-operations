/**
 * Saved dialog decisions — the typed registry, the stored shape and the
 * state machine behind "Git Easy Ops: Manage Dialog Decisions…".
 *
 * A *decision* is one saved affirmative answer ("yes") to one named
 * confirmation question, for one repository. It is never a saved set of
 * command arguments: the branch, commit, remote and message of a future run
 * still come from that run's own selections, and every repository-state
 * check, recovery point and journal entry of the operation still happens —
 * only the named modal question is skipped.
 *
 * Safety rails (see `docs/next-actions-and-saved-decisions.md`):
 *
 * - Saving is opt-in twice over: the master setting
 *   `geco.rememberDialogDecisions` (default off) *and* an explicit
 *   "<action> (always)" pick in the dialog — or an explicit enable in the
 *   management view. A one-time answer, Cancel, Escape and dismissal never
 *   save anything.
 * - Only binary questions with a stable meaning are eligible, and each
 *   distinct question is its own id: force push with lease and hard
 *   `--force` never share an id, and neither do deleting a branch locally
 *   and deleting it everywhere.
 * - Questions whose answer depends on fresh state (Undo, a possibly-held
 *   lock file, a failed backup bundle, installing software, writing the
 *   editor's own config files, multi-choice dialogs that select
 *   side-effects) stay interactive forever; the registry records *why*.
 * - Stored data is versioned per question (`policyVersion`). Unknown ids,
 *   unknown answers and stale policy versions parse as "unset", so a build
 *   that changes what a question means can never inherit old consent.
 */

/** The only answer that can be saved in this version: the affirmative one. */
export type SavedAnswer = 'yes';

/** Stable prompt ids. Never rename, never reuse — they are storage keys. */
export type DialogDecisionId =
	| 'reword.rename'
	| 'squash.confirm'
	| 'fastForward.move'
	| 'fastForward.moveAnyway'
	| 'forcePush.lease'
	| 'forcePush.force'
	| 'patch.applyToCurrent'
	| 'pushSync.abortUnfinished'
	| 'pushSync.rebaseOntoUpstream'
	| 'pushSync.moveOntoUpstream'
	| 'cleanHistory.rewrite'
	| 'cleanHistory.dropRecoveryPoints'
	| 'branch.renameOverwrite'
	| 'branch.renamePushRemote'
	| 'branch.deleteLocal'
	| 'branch.deleteEverywhere'
	| 'branch.deleteUnmergedAnyway'
	| 'branch.removeRedundant'
	| 'undo.confirm'
	| 'pushSync.removeLock'
	| 'cleanHistory.rewriteWithoutBundle'
	| 'cleanHistory.installFilterRepo'
	| 'cleanHistory.removeLinkedWorktrees'
	| 'fastForward.cleanupChoice'
	| 'graphMenu.updateEditorConfig'
	| 'result.followUps'
	| 'input.textEntry'
	| 'selection.pickers';

export type DialogDecisionKind = 'eligible' | 'ineligible' | 'notApplicable';

export interface DialogDecisionDef {
	/** Stable id — also the storage key. */
	id: DialogDecisionId;
	/** Human-readable action name, as the management view shows it. */
	action: string;
	/** Exactly which question this row controls, in the user's words. */
	question: string;
	/** The affirmative button label of the dialog (for eligible rows). */
	confirmLabel?: string;
	kind: DialogDecisionKind;
	/** For ineligible rows: why this question must stay interactive. */
	ineligibleReason?: string;
	/** Enabling this skips a destructive confirmation — the view warns. */
	destructive?: boolean;
	/**
	 * Bump when the meaning of the question changes. Stored answers written
	 * under another version parse as unset instead of being reused.
	 */
	policyVersion: number;
}

const eligible = (
	id: DialogDecisionId,
	action: string,
	question: string,
	confirmLabel: string,
	destructive = true,
): DialogDecisionDef => ({ id, action, question, confirmLabel, kind: 'eligible', destructive, policyVersion: 1 });

const ineligible = (
	id: DialogDecisionId,
	action: string,
	question: string,
	ineligibleReason: string,
): DialogDecisionDef => ({ id, action, question, kind: 'ineligible', ineligibleReason, destructive: true, policyVersion: 1 });

const notApplicable = (
	id: DialogDecisionId,
	action: string,
	question: string,
	ineligibleReason: string,
): DialogDecisionDef => ({ id, action, question, kind: 'notApplicable', ineligibleReason, policyVersion: 1 });

/**
 * Every question the extension asks, in the order the management view shows
 * them: eligible confirmations first (grouped by operation), then the
 * questions that must stay interactive, then the prompts that are not
 * confirmations at all. Actions with no question of their own (creating or
 * checking out a branch, copying a SHA, showing backups…) only ever meet
 * the last three rows.
 */
export const DIALOG_DECISIONS: readonly DialogDecisionDef[] = [
	eligible('reword.rename', 'Rename Commit Message', '“Rename the message of <commit> on <branch>?”', 'Rename'),
	eligible('squash.confirm', 'Squash Commits', '“Squash <N> commits into one on <branch>?”', 'Squash'),
	eligible('fastForward.move', 'Fast-Forward / Move Branch', '“Move <branch> to <commit>?” (the plain two-button form)', 'Move'),
	eligible('fastForward.moveAnyway', 'Move Branch Anyway (diverged)', '“<branch> has commits that <target> does not. Move it anyway?”', 'Move anyway'),
	eligible('forcePush.lease', 'Force Push (with lease)', '“Force push <branch> to <remote>/<branch>?” with --force-with-lease', 'Force Push (with lease)'),
	eligible('forcePush.force', 'Force Push (--force)', '“Force push <branch> to <remote>/<branch>?” with hard --force', 'Force Push'),
	eligible('patch.applyToCurrent', 'Apply Patch to Current Branch', '“Apply this patch to the current branch?”', 'Apply', false),
	eligible('pushSync.abortUnfinished', 'Abort Unfinished Operation (Push/Sync Repair)', '“Abort the unfinished merge/rebase/…?”', 'Abort it'),
	eligible('pushSync.rebaseOntoUpstream', 'Rebase onto Upstream (Push/Sync Repair)', '“Rebase <branch> onto <upstream>?”', 'Rebase'),
	eligible('pushSync.moveOntoUpstream', 'Point Branch at Upstream (Push/Sync Repair)', '“Point <branch> at <upstream>?”', 'Move the branch'),
	eligible('cleanHistory.rewrite', 'Clean History', '“Remove <N> dead path(s) from the entire history?”', 'Clean History'),
	eligible('cleanHistory.dropRecoveryPoints', 'Drop Recovery Points after Clean History', '“Drop the <N> Git Easy Ops recovery point(s) and reclaim the space?” — a separate question from the rewrite itself', 'Drop & GC'),
	eligible('branch.renameOverwrite', 'Rename Branch onto an Existing Name', '“A branch called <name> already exists. Overwrite it?”', 'Overwrite'),
	eligible('branch.renamePushRemote', 'Push a Branch Rename to the Remote', '“Push the rename to <remote>?” (the remote handling itself is still picked each time)', 'Rename on the Remote / Push New Name'),
	eligible('branch.deleteLocal', 'Delete Branch (local only)', '“Delete branch <name>?”', 'Delete Branch'),
	eligible('branch.deleteEverywhere', 'Delete Branch (local and remote)', '“Delete <name> locally and <remote>/<name> on the remote?” — never approved by the local-only decision', 'Delete Everywhere'),
	eligible('branch.deleteUnmergedAnyway', 'Delete Unmerged Branch Anyway', '“<branch> has unmerged commits. Delete it anyway?”', 'Delete Anyway'),
	eligible('branch.removeRedundant', 'Remove Redundant Branches (fallback confirmation)', '“Delete <N> redundant branch(es)?” — only asked when no checkbox list is available; the checkbox list itself is never skipped', 'Delete Branches'),

	ineligible('undo.confirm', 'Undo Last Operation', '“Undo <operation>?”', 'Undo restores the specific journal entry picked at that moment. A standing “yes” could roll back work the user has not reviewed, so Undo always asks — and an Undo button on a result report never runs on its own.'),
	ineligible('pushSync.removeLock', 'Remove a Lock File (Push/Sync Repair)', '“Remove <lock file>?”', 'A lock that looks stale can be held by a git process running right now. Whether it is safe to remove has to be judged fresh each time.'),
	ineligible('cleanHistory.rewriteWithoutBundle', 'Rewrite History without a Backup Bundle', '“The backup bundle could not be created. Rewrite the history anyway?”', 'This is only asked after the safety net failed, and proceeding leaves no way back. Consent has to be fresh for that specific failure.'),
	ineligible('cleanHistory.installFilterRepo', 'Install git-filter-repo', '“git-filter-repo is not installed — install it now?”', 'Installing software runs a machine-specific command chosen at that moment; the choice and the consent stay fresh each time.'),
	ineligible('cleanHistory.removeLinkedWorktrees', 'Remove Linked Worktrees (Clean History blocker)', '“Remove the linked worktrees that block the rewrite?”', 'Which worktrees exist and what they hold is fresh repository state; removing them is never pre-approved.'),
	ineligible('fastForward.cleanupChoice', 'Fast-Forward Cleanup Choice', '“Move <branch>…?” with “Move and clean up…” / “Move and remove <backup>” options', 'This dialog does not ask yes/no — it selects side-effects (removing the backup, cleaning up other branches). A saved “yes” cannot say which, so it always asks.'),
	ineligible('graphMenu.updateEditorConfig', 'Enable the Source Control Graph Menu', '“Allow proposed APIs … in product.json/argv.json?”', 'This writes the editor’s own configuration files, picked at that moment and outside any repository. It always asks.'),

	notApplicable('result.followUps', 'Result Reports (Undo / Force Push / Open Worktree…)', 'The buttons on an end-of-operation report', 'A report is not a confirmation. Its follow-up buttons only run when clicked, never automatically.'),
	notApplicable('input.textEntry', 'Text Entry (messages, branch names…)', 'Commit-message, branch-name and backup-name inputs', 'These need fresh text each time — there is no answer to save. Existing preferences stay ordinary settings (`geco.applyPatchDestination` and friends).'),
	notApplicable('selection.pickers', 'Pickers and Checkbox Lists', 'Commit/branch/file/destination/scope pickers and the redundant-branch checkbox list', 'These need a fresh selection each time. A checkbox list that shows exactly what will be deleted is itself the review, so it is never skipped.'),
];

export const DIALOG_DECISION_BY_ID: ReadonlyMap<DialogDecisionId, DialogDecisionDef> = new Map(
	DIALOG_DECISIONS.map((def) => [def.id, def]),
);

export function dialogDecisionById(id: string): DialogDecisionDef | undefined {
	return DIALOG_DECISION_BY_ID.get(id as DialogDecisionId);
}

export function isEligibleDecision(id: string): boolean {
	return dialogDecisionById(id)?.kind === 'eligible';
}

/** The workspace-state key under which all saved decisions live. */
export const DIALOG_DECISIONS_STATE_KEY = 'geco.dialogDecisions.v1';
/** Shape version of the stored object; anything else parses as empty. */
export const DIALOG_DECISIONS_FORMAT_VERSION = 1;

export interface StoredDialogDecision {
	answer: SavedAnswer;
	policyVersion: number;
}

/** `repository key -> prompt id -> saved decision`, already validated. */
export type ParsedDialogDecisions = Record<string, Partial<Record<DialogDecisionId, StoredDialogDecision>>>;

/**
 * The repository identity decisions are scoped by: the path as the caller
 * knows it, normalised so the same repository always maps to one key
 * (forward slashes, no trailing slash, no `.` segments; case-folded on
 * request for case-insensitive file systems). The VS Code layer passes the
 * real path of the repository root, so two workspace folders that reach the
 * same repository share its decisions — and no other repository does.
 */
export function normalizeRepoKey(repoPath: string, options: { caseInsensitive?: boolean } = {}): string {
	let key = repoPath.trim().replace(/\\/g, '/');
	key = key
		.split('/')
		.filter((part, index) => part !== '.' && !(part === '' && index > 0))
		.join('/');
	if (key.length > 1) {
		key = key.replace(/\/+$/, '');
	}
	return options.caseInsensitive ? key.toLowerCase() : key;
}

/**
 * Tolerant reader for the stored decisions: accepts anything, keeps only
 * known eligible ids with the saved answer `yes` and a current policy
 * version. Everything else — unknown ids, obsolete answers, stale policies,
 * junk shapes — means "unset", never "approved".
 */
export function parseDialogDecisions(raw: unknown): ParsedDialogDecisions {
	const byRepo: ParsedDialogDecisions = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return byRepo;
	}
	const record = raw as Record<string, unknown>;
	if (record.version !== DIALOG_DECISIONS_FORMAT_VERSION) {
		return byRepo;
	}
	const storedByRepo = record.byRepo;
	if (!storedByRepo || typeof storedByRepo !== 'object' || Array.isArray(storedByRepo)) {
		return byRepo;
	}
	for (const [repoKey, entries] of Object.entries(storedByRepo as Record<string, unknown>)) {
		if (!repoKey || !entries || typeof entries !== 'object' || Array.isArray(entries)) {
			continue;
		}
		const kept: Partial<Record<DialogDecisionId, StoredDialogDecision>> = {};
		for (const [id, value] of Object.entries(entries as Record<string, unknown>)) {
			const def = dialogDecisionById(id);
			if (!def || def.kind !== 'eligible' || !value || typeof value !== 'object') {
				continue;
			}
			const stored = value as Record<string, unknown>;
			if (stored.answer === 'yes' && stored.policyVersion === def.policyVersion) {
				kept[def.id] = { answer: 'yes', policyVersion: def.policyVersion };
			}
		}
		if (Object.keys(kept).length > 0) {
			byRepo[normalizeRepoKey(repoKey)] = kept;
		}
	}
	return byRepo;
}

/** The raw (storable) shape for a parsed decision map. */
export function serializeDialogDecisions(byRepo: ParsedDialogDecisions): { version: number; byRepo: ParsedDialogDecisions } {
	return { version: DIALOG_DECISIONS_FORMAT_VERSION, byRepo };
}

export function savedDecision(raw: unknown, repoPath: string, id: DialogDecisionId): SavedAnswer | undefined {
	if (!repoPath.trim()) {
		// No repository identity, no approval: fail closed and ask.
		return undefined;
	}
	return parseDialogDecisions(raw)[normalizeRepoKey(repoPath)]?.[id]?.answer;
}

/** A new raw value with one decision saved (input is re-validated first). */
export function withSavedDecision(raw: unknown, repoPath: string, id: DialogDecisionId): unknown {
	const def = dialogDecisionById(id);
	const byRepo = parseDialogDecisions(raw);
	if (!def || def.kind !== 'eligible' || !repoPath.trim()) {
		return serializeDialogDecisions(byRepo);
	}
	const key = normalizeRepoKey(repoPath);
	byRepo[key] = { ...byRepo[key], [id]: { answer: 'yes', policyVersion: def.policyVersion } };
	return serializeDialogDecisions(byRepo);
}

/** A new raw value with one decision reset to Default (unset). */
export function withoutSavedDecision(raw: unknown, repoPath: string, id: DialogDecisionId): unknown {
	const byRepo = parseDialogDecisions(raw);
	const key = normalizeRepoKey(repoPath);
	const entries = byRepo[key];
	if (entries) {
		delete entries[id];
		if (Object.keys(entries).length === 0) {
			delete byRepo[key];
		}
	}
	return serializeDialogDecisions(byRepo);
}

/** The ids with a saved decision for one repository, in registry order. */
export function savedDecisionIds(raw: unknown, repoPath: string): DialogDecisionId[] {
	if (!repoPath.trim()) {
		return [];
	}
	const entries = parseDialogDecisions(raw)[normalizeRepoKey(repoPath)] ?? {};
	return DIALOG_DECISIONS.filter((def) => entries[def.id]).map((def) => def.id);
}

/** How many repositories hold at least one saved decision (clear-all scope). */
export function countDecisionRepositories(raw: unknown): number {
	return Object.keys(parseDialogDecisions(raw)).length;
}

/**
 * The pluggable store the controller and the management view talk to.
 * Production backs it with extension workspace state (per workspace, never
 * synced); tests back it with {@link InMemoryDialogDecisionStore}. Any
 * method may throw — callers treat a failed read as "ask" and a failed
 * write as "the one-time answer still stands, nothing was saved".
 */
export interface DialogDecisionMemory {
	get(repoPath: string, id: DialogDecisionId): Promise<SavedAnswer | undefined> | SavedAnswer | undefined;
	save(repoPath: string, id: DialogDecisionId): Promise<void> | void;
	reset(repoPath: string, id: DialogDecisionId): Promise<void> | void;
	/** Removes every saved decision of every repository in this store. */
	clearAll(): Promise<void> | void;
}

/** In-memory {@link DialogDecisionMemory} — for tests and as documentation. */
export class InMemoryDialogDecisionStore implements DialogDecisionMemory {
	private raw: unknown = serializeDialogDecisions({});

	get(repoPath: string, id: DialogDecisionId): SavedAnswer | undefined {
		return savedDecision(this.raw, repoPath, id);
	}

	save(repoPath: string, id: DialogDecisionId): void {
		this.raw = withSavedDecision(this.raw, repoPath, id);
	}

	reset(repoPath: string, id: DialogDecisionId): void {
		this.raw = withoutSavedDecision(this.raw, repoPath, id);
	}

	clearAll(): void {
		this.raw = serializeDialogDecisions({});
	}

	/** The stored shape, for assertions. */
	snapshot(): unknown {
		return this.raw;
	}
}

export type DialogDecisionState = 'enabled' | 'default' | 'inactive' | 'ineligible' | 'notApplicable';

export interface DialogDecisionRow {
	def: DialogDecisionDef;
	saved: boolean;
	state: DialogDecisionState;
	/** Short state text, e.g. `Enabled — always Force Push`. */
	stateLabel: string;
}

/**
 * What the management view shows for one repository: every registry row
 * with its effective state. `masterEnabled` is the
 * `geco.rememberDialogDecisions` setting; a saved row with the mode off is
 * `inactive` (kept, but never used and never offered in a dialog).
 */
export function dialogDecisionRows(raw: unknown, repoPath: string, masterEnabled: boolean): DialogDecisionRow[] {
	const saved = new Set(savedDecisionIds(raw, repoPath));
	return DIALOG_DECISIONS.map((def) => {
		const isSaved = saved.has(def.id);
		if (def.kind === 'ineligible') {
			return { def, saved: false, state: 'ineligible' as const, stateLabel: 'Default — not eligible' };
		}
		if (def.kind === 'notApplicable') {
			return { def, saved: false, state: 'notApplicable' as const, stateLabel: 'Not applicable' };
		}
		if (!isSaved) {
			return { def, saved: false, state: 'default' as const, stateLabel: 'Default (not enabled)' };
		}
		return masterEnabled
			? { def, saved: true, state: 'enabled' as const, stateLabel: `Enabled — always “${def.confirmLabel}”` }
			: { def, saved: true, state: 'inactive' as const, stateLabel: `Saved — inactive: mode disabled (always “${def.confirmLabel}” when on)` };
	});
}
