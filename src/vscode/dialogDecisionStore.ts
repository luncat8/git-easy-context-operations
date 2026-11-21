/**
 * Saved dialog decisions, backed by extension *workspace* state.
 *
 * Workspace state is the right home: it belongs to this workspace, is never
 * Settings-Synced to other machines, and stores no setting a user could be
 * tricked into sharing. The stored shape is the versioned raw value the
 * core parser validates (`src/core/dialogDecisions.ts`) — unknown ids,
 * obsolete answers and stale policy versions read as unset.
 *
 * Repository identity: keys are the real path of the repository root the
 * caller passed, so two folders reaching the same repository (or a linked
 * worktree of it, whose root resolves inside the same checkout family the
 * user opened) share one scope and different repositories never do. When
 * the real path cannot be taken the resolved absolute path is used — still
 * scoped, still fail-closed, because an empty identity never reads a
 * decision at all (the core enforces that).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import {
	DIALOG_DECISIONS_STATE_KEY,
	decisionRepoKey,
	normalizeRepoKey,
	savedDecision,
	serializeDialogDecisions,
	withSavedDecision,
	withoutSavedDecision,
	type DialogDecisionId,
	type DialogDecisionMemory,
	type SavedAnswer,
	type StorageScope,
} from '../core/dialogDecisions';

/** The canonical key a repository path maps to in the decision store. */
export function canonicalRepoKey(repoPath: string): string {
	let resolved = repoPath;
	try {
		resolved = fs.realpathSync.native(repoPath);
	} catch {
		resolved = path.resolve(repoPath);
	}
	return normalizeRepoKey(resolved, { caseInsensitive: process.platform === 'win32' });
}

export class WorkspaceDialogDecisionStore implements DialogDecisionMemory {
	constructor(
		private readonly state: vscode.Memento,
		private readonly getScope: () => StorageScope,
		private readonly onChanged?: () => void,
	) {}

	/** The raw stored value (already safe to hand to the core helpers). */
	raw(): unknown {
		return this.state.get(DIALOG_DECISIONS_STATE_KEY);
	}

	/** Map a repository path onto its storage key for the active scope. */
	private resolveKey(repoPath: string): string {
		return decisionRepoKey(repoPath, this.getScope());
	}

	get(repoPath: string, id: DialogDecisionId): SavedAnswer | undefined {
		if (!repoPath.trim()) {
			return undefined;
		}
		return savedDecision(this.raw(), this.resolveKey(repoPath), id);
	}

	async save(repoPath: string, id: DialogDecisionId): Promise<void> {
		if (!repoPath.trim()) {
			throw new Error('no repository identity to save a decision for');
		}
		await this.state.update(DIALOG_DECISIONS_STATE_KEY, withSavedDecision(this.raw(), this.resolveKey(repoPath), id));
		this.onChanged?.();
	}

	async reset(repoPath: string, id: DialogDecisionId): Promise<void> {
		if (!repoPath.trim()) {
			return;
		}
		await this.state.update(DIALOG_DECISIONS_STATE_KEY, withoutSavedDecision(this.raw(), this.resolveKey(repoPath), id));
		this.onChanged?.();
	}

	/** Every repository's decisions in this workspace — the clear-all scope. */
	async clearAll(): Promise<void> {
		await this.state.update(DIALOG_DECISIONS_STATE_KEY, serializeDialogDecisions({}));
		this.onChanged?.();
	}
}
