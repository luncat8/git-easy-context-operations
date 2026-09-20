/**
 * Safety net: hidden recovery refs, a named backup branch, an operation journal
 * and the undo logic that reads it back.
 *
 * Nothing here rewrites history on its own - it only records what happened and
 * knows how to put the repository back the way it was.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { GecoError } from './errors';
import type { Git } from './git';
import type { Settings } from './config';

export type OperationKind = 'reword' | 'squash' | 'fastForward' | 'forcePush' | 'applyPatch' | 'backup' | 'branch' | 'cleanHistory';

export interface RefRestore {
	ref: string;
	restoreTo: string;
	/** Only restore when the ref still points here (guards against races). */
	expected?: string;
	/**
	 * Also resynchronise index and working tree (needed when the ref is the
	 * checked out branch and the undo must not leave a bogus "modified" state).
	 */
	resetHard?: boolean;
	/**
	 * Tracking configuration to restore with the branch (`branch.<name>.merge`
	 * and `branch.<name>.remote` are dropped when a branch is deleted or renamed).
	 */
	upstream?: string;
}

/**
 * A remote branch that has to be put back (or removed) when an operation is
 * undone - e.g. renaming a branch also renamed it on the remote.
 */
export interface RemoteRefRestore {
	remote: string;
	branch: string;
	/** Sha the remote branch should point at again (`action: 'restore'`). */
	restoreTo?: string;
	/**
	 * 'restore' (default) pushes `restoreTo` back; 'delete' removes the branch,
	 * but only while it still points at `expectedSha` (so a colleague's push is
	 * never clobbered by our undo).
	 */
	action?: 'restore' | 'delete';
	expectedSha?: string;
}

export type UndoSpec =
	| {
		type: 'refs';
		refs: RefRestore[];
		/** Refs to delete after restoring (recovery points we created). */
		deleteRefs?: string[];
		/** Branches to delete after restoring (backup branches we created). */
		deleteBranches?: string[];
		worktrees?: { path: string; branch?: string }[];
		/** Branch to check out before deleting branches (patch on a new branch). */
		checkoutRef?: string;
		/** Remote branches to put back / remove as part of the same undo. */
		remoteRefs?: RemoteRefRestore[];
	}
	| { type: 'remoteRef'; remote: string; branch: string; restoreTo: string }
	| { type: 'none'; hint: string };

export interface JournalEntry {
	id: string;
	kind: OperationKind;
	/** ISO timestamp. */
	at: string;
	repo: string;
	summary: string;
	undo: UndoSpec;
}

export interface UndoResult {
	entry: JournalEntry;
	restored: string[];
	messages: string[];
}

export interface RecoveryPoint {
	kind: 'ref' | 'branch';
	name: string;
	sha: string;
	createdAt?: string;
	description: string;
}

export interface BackupBranchResult {
	name: string;
	sha: string;
	/** True when an existing branch already pointed at `sha` and was reused. */
	reused: boolean;
	/** True when the requested name was taken and a suffix was added. */
	renamed: boolean;
}

export class SafetyNet {
	/**
	 * @param onChanged Fired right after the repository changed (an operation
	 * was journaled, or an undo put refs back) - the hook the UI layer uses to
	 * refresh its views. It runs *before* the flow reports its result, which is
	 * what makes the view current while the result notification is still up.
	 * Never let it break an operation: it is called inside a try/catch.
	 */
	constructor(private readonly git: Git, private readonly settings: Settings, private readonly onChanged?: () => void) {}

	/** Announce a change; a broken listener must never fail the operation. */
	private announceChange(): void {
		if (!this.onChanged) {
			return;
		}
		try {
			this.onChanged();
		} catch {
			// A refreshing view is a nicety, not part of the git operation.
		}
	}

	// ----------------------------------------------------------------- journal

	async journalPath(): Promise<string> {
		const common = await this.git.commonDir();
		return path.join(common, 'geco', 'journal.json');
	}

	async readJournal(): Promise<JournalEntry[]> {
		const file = await this.journalPath();
		try {
			const raw = await fsp.readFile(file, 'utf8');
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) {
				return [];
			}
			return parsed.filter(isJournalEntry);
		} catch {
			return [];
		}
	}

	async record(entry: { kind: OperationKind; summary: string; undo: UndoSpec; repo?: string; at?: string }): Promise<JournalEntry> {
		const full: JournalEntry = {
			id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			kind: entry.kind,
			at: entry.at ?? new Date().toISOString(),
			repo: entry.repo ?? this.git.cwd,
			summary: entry.summary,
			undo: entry.undo,
		};
		const journal = await this.readJournal();
		journal.push(full);
		const trimmed = journal.slice(-Math.max(1, this.settings.journalMaxEntries));
		const file = await this.journalPath();
		await fsp.mkdir(path.dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		await fsp.writeFile(tmp, `${JSON.stringify(trimmed, undefined, 2)}\n`, 'utf8');
		await fsp.rename(tmp, file);
		// Everything that changes the graph journals it, so this is the one
		// choke point where the views can be told to reload - no flow has to
		// remember to do it, and the journal row itself is up to date too.
		this.announceChange();
		return full;
	}

	async lastEntry(): Promise<JournalEntry | undefined> {
		const journal = await this.readJournal();
		return journal.length > 0 ? journal[journal.length - 1] : undefined;
	}

	async undo(entry: JournalEntry): Promise<UndoResult> {
		const restored: string[] = [];
		const messages: string[] = [];

		switch (entry.undo.type) {
			case 'refs': {
				for (const worktree of entry.undo.worktrees ?? []) {
					await this.removeWorktreeQuietly(worktree.path);
					messages.push(`Removed worktree ${worktree.path}`);
					if (worktree.branch && (await this.git.branchExists(worktree.branch))) {
						await this.git.deleteBranch(worktree.branch, { force: true });
						messages.push(`Deleted branch ${worktree.branch}`);
					}
				}
				// Remote first: restoring `branch.x.remote`/`merge` below needs the
				// remote-tracking ref to exist again.
				for (const remoteRef of entry.undo.remoteRefs ?? []) {
					await this.applyRemoteRef(remoteRef, restored, messages);
				}
				// Refs before `checkoutRef`: the checkout may point at a branch this
				// very entry has to recreate (renaming a branch back, for example).
				for (const restore of entry.undo.refs) {
					await this.restoreRef(restore);
					restored.push(`${restore.ref} -> ${shorten(restore.restoreTo)}`);
					if (restore.upstream) {
						messages.push(`Tracking ${restore.upstream} restored for ${restore.ref}`);
					}
				}
				if (entry.undo.checkoutRef && (await this.git.headBranch()) !== entry.undo.checkoutRef) {
					const checkout = await this.git.run(['checkout', entry.undo.checkoutRef]);
					messages.push(checkout.exitCode === 0
						? `Checked out ${entry.undo.checkoutRef} again`
						: `Could not check out ${entry.undo.checkoutRef}: ${checkout.stderr.trim()}`);
				}
				for (const ref of entry.undo.deleteRefs ?? []) {
					await this.deleteRefQuietly(ref, messages);
				}
				for (const branch of entry.undo.deleteBranches ?? []) {
					if (await this.git.branchExists(branch)) {
						await this.git.deleteBranch(branch, { force: true });
						messages.push(`Deleted backup branch ${branch}`);
					}
				}
				break;
			}
			case 'remoteRef': {
				const { remote, branch, restoreTo } = entry.undo;
				const result = await this.git.push(['--force', remote, `${restoreTo}:refs/heads/${branch}`]);
				if (result.exitCode !== 0) {
					throw new GecoError('rejected', `Could not restore ${remote}/${branch}.`, result.stderr.trim());
				}
				restored.push(`${remote}/${branch} -> ${shorten(restoreTo)}`);
				break;
			}
			case 'none': {
				messages.push(entry.undo.hint);
				break;
			}
		}

		const journal = await this.readJournal();
		const remaining = journal.filter((e) => e.id !== entry.id);
		if (remaining.length !== journal.length) {
			const file = await this.journalPath();
			await fsp.writeFile(file, `${JSON.stringify(remaining, undefined, 2)}\n`, 'utf8');
		}

		// An undo moves refs back: the views are stale in exactly the same way.
		this.announceChange();
		return { entry, restored, messages };
	}

	// --------------------------------------------------------------- backups

	/**
	 * Park `sha` on a real branch. Falls back to `name-2`, `name-3`, ... when the
	 * requested name is already taken by something that points elsewhere.
	 */
	async backupBranch(desiredName: string, sha: string): Promise<BackupBranchResult> {
		const base = desiredName.trim() || this.settings.defaultBackupBranchName;
		const existing = await this.git.revParse(`refs/heads/${base}`);
		if (existing === sha) {
			return { name: base, sha, reused: true, renamed: false };
		}
		const name = await this.resolveFreeBranchName(base);
		await this.git.createBranch(name, sha);
		return { name, sha, reused: false, renamed: name !== base };
	}

	/** Hidden recovery ref under `geco.backupRefPrefix` (never shows up as a branch). */
	async hiddenBackupRef(label: string, sha: string): Promise<string> {
		const prefix = this.settings.backupRefPrefix;
		const ref = `${prefix}${sanitizeLabel(label)}/${timestamp()}-${shorten(sha)}`;
		await this.git.updateRef(ref, sha, { message: 'geco recovery point' });
		return ref;
	}

	async resolveFreeBranchName(desired: string): Promise<string> {
		if (await this.isBranchNameFree(desired)) {
			return desired;
		}
		for (let i = 2; i < 1000; i++) {
			const candidate = `${desired}-${i}`;
			if (await this.isBranchNameFree(candidate)) {
				return candidate;
			}
		}
		return `${desired}-${timestamp()}`;
	}

	async isBranchNameFree(name: string): Promise<boolean> {
		if (!name || name.startsWith('-') || name.includes('..')) {
			return false;
		}
		if (await this.git.refExists(`refs/heads/${name}`)) {
			return false;
		}
		if (await this.git.refExists(`refs/tags/${name}`)) {
			return false;
		}
		// Git rejects names that would be ambiguous or invalid.
		const check = await this.git.run(['check-ref-format', '--branch', name]);
		return check.exitCode === 0;
	}

	async listRecoveryPoints(): Promise<RecoveryPoint[]> {
		const points: RecoveryPoint[] = [];
		const prefix = this.settings.backupRefPrefix;

		for (const ref of await this.git.refsUnder(prefix)) {
			points.push({
				kind: 'ref',
				name: ref.name,
				sha: ref.sha,
				createdAt: createdAtFromRefName(ref.name),
				description: ref.name.slice(prefix.length),
			});
		}

		for (const entry of await this.readJournal()) {
			if (entry.kind !== 'fastForward' || entry.undo.type !== 'refs') {
				continue;
			}
			for (const branch of entry.undo.deleteBranches ?? []) {
				const sha = await this.git.revParse(`refs/heads/${branch}`);
				if (!sha) {
					continue;
				}
				if (points.some((p) => p.name === branch)) {
					continue;
				}
				points.push({
					kind: 'branch',
					name: branch,
					sha,
					createdAt: entry.at,
					description: entry.summary,
				});
			}
		}

		return points.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
	}

	async deleteRecoveryPoint(point: RecoveryPoint): Promise<void> {
		if (point.kind === 'ref') {
			await this.git.deleteRef(point.name, { message: 'geco: recovery point deleted' });
			return;
		}
		await this.git.deleteBranch(point.name, { force: true });
	}

	// ----------------------------------------------------------------- private

	/**
	 * Put a ref back where it was. When the ref is the checked out branch and
	 * `resetHard` is set, the index and working tree are resynchronised too -
	 * otherwise the undo would leave the repository showing a bogus diff.
	 */
	/**
	 * Undo the remote half of an operation. Failures are reported, not thrown:
	 * the local repository has already been put back, and a refused push should
	 * not leave the user with a half-undone state and an error dialog.
	 */
	private async applyRemoteRef(restore: RemoteRefRestore, restored: string[], messages: string[]): Promise<void> {
		const target = `${restore.remote}/${restore.branch}`;
		if (restore.action === 'delete') {
			const lease = restore.expectedSha ? [`--force-with-lease=refs/heads/${restore.branch}:${restore.expectedSha}`] : [];
			const result = await this.git.push([...lease, restore.remote, '--delete', restore.branch]);
			if (result.exitCode === 0) {
				restored.push(`deleted ${target}`);
			} else {
				messages.push(`Could not delete ${target}: ${result.stderr.trim().split('\n')[0] ?? 'push refused'}`);
			}
			return;
		}
		if (!restore.restoreTo) {
			messages.push(`Cannot restore ${target}: no sha was recorded.`);
			return;
		}
		const result = await this.git.push(['--force', restore.remote, `${restore.restoreTo}:refs/heads/${restore.branch}`]);
		if (result.exitCode === 0) {
			restored.push(`${target} -> ${shorten(restore.restoreTo)}`);
		} else {
			messages.push(`Could not restore ${target}: ${result.stderr.trim().split('\n')[0] ?? 'push refused'}`);
		}
	}

	private async restoreRef(restore: RefRestore): Promise<void> {
		await this.git.updateRef(restore.ref, restore.restoreTo, {
			oldValue: restore.expected,
			message: 'geco undo',
		});
		if (restore.upstream && restore.ref.startsWith('refs/heads/')) {
			const branch = restore.ref.slice('refs/heads/'.length);
			const setUpstream = await this.git.run(['branch', `--set-upstream-to=${restore.upstream}`, branch]);
			if (setUpstream.exitCode !== 0) {
				// The remote-tracking ref may be gone; the branch itself is restored.
				await this.git.run(['config', '--unset', `branch.${branch}.merge`]);
			}
		}
		if (!restore.resetHard) {
			return;
		}
		const currentBranch = await this.git.headBranch();
		if (currentBranch && restore.ref === `refs/heads/${currentBranch}`) {
			await this.git.reset('hard', restore.restoreTo);
		}
	}

	private async removeWorktreeQuietly(target: string): Promise<void> {
		const result = await this.git.run(['worktree', 'remove', '--force', target]);
		if (result.exitCode !== 0) {
			await this.git.worktreePrune();
		}
	}

	private async deleteRefQuietly(ref: string, messages: string[]): Promise<void> {
		if (!(await this.git.refExists(ref))) {
			return;
		}
		// Never delete something we did not create ourselves.
		if (!ref.startsWith(this.settings.backupRefPrefix)) {
			messages.push(`Kept ${ref} (not a Git Easy Ops recovery point).`);
			return;
		}
		await this.git.deleteRef(ref, { message: 'geco undo' });
		messages.push(`Deleted recovery ref ${ref}`);
	}
}

// ------------------------------------------------------------------- helpers

function isJournalEntry(value: unknown): value is JournalEntry {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as Partial<JournalEntry>;
	return typeof candidate.id === 'string' && typeof candidate.kind === 'string' && typeof candidate.summary === 'string' && !!candidate.undo;
}

export function shorten(sha: string): string {
	return sha.length > 10 ? sha.slice(0, 10) : sha;
}

export function timestamp(date: Date = new Date()): string {
	return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function createdAtFromRefName(refName: string): string | undefined {
	const match = /(\d{8}T\d{6}Z)/.exec(refName);
	if (!match) {
		return undefined;
	}
	const raw = match[1];
	// raw is YYYYMMDDTHHMMSSZ: 0-4 year, 4-6 month, 6-8 day, 9-11 hour, 11-13 minute, 13-15 second.
	const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}.000Z`;
	const parsed = new Date(iso);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function sanitizeLabel(label: string): string {
	const cleaned = label.replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
	return cleaned || 'repo';
}

/** Ensure a journal file that is not valid JSON cannot crash the extension. */
export async function clearJournal(git: Git, settings: Settings): Promise<void> {
	const safety = new SafetyNet(git, settings);
	const file = await safety.journalPath();
	await fsp.rm(file, { force: true });
}
