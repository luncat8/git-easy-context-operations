/**
 * Feature 2 - fast-forward a branch (usually `main`) to a selected commit and
 * park the old tip on a backup branch (`old`) first.
 *
 * Two situations are handled explicitly:
 *
 *   a) real fast-forward  - the branch tip is an ancestor of the target commit,
 *                           nothing is lost, `git update-ref` / `merge --ff-only`
 *                           is enough;
 *   b) diverged histories - the branch tip has commits the target does not.
 *                           Moving the branch would discard them, so this needs
 *                           `force: true`; the discarded commits are listed in
 *                           the result and stay reachable through the backup
 *                           branch.
 *
 * With `checkoutAfterMove`, a move that leaves the worktree somewhere else
 * (the branch was not the checked out one) ends with the moved branch
 * checked out - clean worktrees only, and never when the branch is checked
 * out in another worktree - so the branch the user was on, usually the name
 * the move made redundant, can actually go away with "Remove Redundant
 * Branches". The checkout is part of the same journal entry: one Undo
 * restores the old tip AND leaves the branch again.
 */
import type { RepoContext } from './context';
import { GecoError, toErrorMessage } from './errors';
import { previewSubject } from './reword';
import { shorten, type BackupBranchResult } from './safety';

export type CheckoutStrategy = 'auto' | 'ff-only' | 'reset-hard' | 'refuse';

export interface FastForwardOptions {
	/** Commit the branch should point at afterwards. */
	target: string;
	/** Branch to move (default: detected default branch, see {@link resolveBranch}). */
	branch?: string;
	/** Backup branch name for the old tip (default: `geco.defaultBackupBranchName`). */
	backupName?: string;
	/** Allow a non fast-forward (diverged) move. */
	force?: boolean;
	/** What to do when the branch is checked out (default: `auto`). */
	checkoutStrategy?: CheckoutStrategy;
	/** Create the backup branch (default: true). */
	createBackup?: boolean;
	/** Allow `reset --hard` with uncommitted changes (default: false). */
	allowDirty?: boolean;
	/**
	 * When the branch is not the checked out one, check it out after the move
	 * (clean worktrees only), so the worktree ends up on the branch that now
	 * owns the history. That is what makes the branch the user was on -
	 * usually the name the move just made redundant - removable with
	 * "Remove Redundant Branches": a checked-out branch is never offered.
	 */
	checkoutAfterMove?: boolean;
}

export interface DiscardedCommit {
	sha: string;
	subject: string;
}

export interface FastForwardResult {
	branch: string;
	branchHow: BranchChoice;
	from: string;
	fromSubject: string;
	to: string;
	toSubject: string;
	backup?: BackupBranchResult;
	wasFastForward: boolean;
	alreadyAtTarget: boolean;
	/** Commits the target adds to the branch. */
	ahead: number;
	/** Commits the old branch tip had that the target does not contain. */
	behind: number;
	discardedCommits: DiscardedCommit[];
	/** The branch was the checked out one when the move started. */
	checkedOut: boolean;
	/** The worktree ended on the moved branch although it started elsewhere. */
	checkedOutAfter: boolean;
	worktreeUpdated: boolean;
	needsForcePush: boolean;
	upstreamRef?: string;
	notes: string[];
}

export type BranchChoice = 'explicit' | 'originHead' | 'main' | 'master' | 'current';

export interface ResolvedBranch {
	branch?: string;
	how: BranchChoice | 'none';
	candidates: string[];
}

/** Pick the branch to move: explicit choice, origin/HEAD, main, master, current. */
export async function resolveBranch(ctx: RepoContext, explicit?: string): Promise<ResolvedBranch> {
	const { git } = ctx;
	const candidates = (await git.branches()).map((b) => b.name);
	if (explicit) {
		return { branch: explicit, how: 'explicit', candidates };
	}
	const detected = await git.detectDefaultBranch();
	if (detected.branch) {
		return { branch: detected.branch, how: detected.how as BranchChoice, candidates };
	}
	return { how: 'none', candidates };
}

export async function fastForwardBranch(ctx: RepoContext, options: FastForwardOptions): Promise<FastForwardResult> {
	const { git, safety, settings } = ctx;
	await git.requireRepository();

	const resolved = await resolveBranch(ctx, options.branch);
	if (!resolved.branch) {
		throw new GecoError('ref-not-found', 'Could not work out which branch to move.', resolved.candidates.length > 0 ? `Local branches: ${resolved.candidates.join(', ')}.` : 'This repository has no branches yet.');
	}
	const branch = resolved.branch;
	const branchRef = `refs/heads/${branch}`;

	const from = await git.revParse(branchRef);
	if (!from) {
		throw new GecoError('ref-not-found', `Branch "${branch}" does not exist.`, resolved.candidates.length > 0 ? `Local branches: ${resolved.candidates.join(', ')}.` : undefined);
	}
	const to = await git.resolveCommit(options.target);

	const fromInfo = await git.commitInfo(from);
	const toInfo = await git.commitInfo(to);
	const notes: string[] = [];

	const base = {
		branch,
		branchHow: resolved.how as BranchChoice,
		from,
		fromSubject: fromInfo.subject,
		to,
		toSubject: toInfo.subject,
		checkedOut: false,
		checkedOutAfter: false,
		worktreeUpdated: false,
		needsForcePush: false,
		notes,
	};

	if (from === to) {
		notes.push(`"${branch}" already points at ${shorten(to)} - nothing to do.`);
		return { ...base, wasFastForward: true, alreadyAtTarget: true, ahead: 0, behind: 0, discardedCommits: [] };
	}

	const counts = await git.counts(from, to);
	const behind = counts.left;
	const ahead = counts.right;
	const wasFastForward = behind === 0;

	const discardedCommits = await listDiscarded(ctx, to, from);
	if (!wasFastForward && !options.force) {
		throw new GecoError(
			'not-fast-forward',
			`"${branch}" cannot be fast-forwarded to ${shorten(to)}: ${behind} commit${behind === 1 ? '' : 's'} on "${branch}" would be left behind.`,
			[
				discardedCommits.length > 0
					? `Left behind:\n${discardedCommits.slice(0, 10).map((c) => `  ${shorten(c.sha)} ${previewSubject(c.subject)}`).join('\n')}${discardedCommits.length > 10 ? `\n  ... and ${discardedCommits.length - 10} more` : ''}`
					: '',
				'Run the operation again with force to move the branch anyway - the commits stay reachable through the backup branch.',
			].filter(Boolean).join('\n'),
		);
	}

	const headBranch = await git.headBranch();
	const headSha = await git.revParse('HEAD');
	const checkedOut = headBranch === branch;
	const strategy: CheckoutStrategy = options.checkoutStrategy ?? 'auto';
	const effective: CheckoutStrategy = strategy === 'auto' ? (wasFastForward ? 'ff-only' : 'reset-hard') : strategy;

	if (effective === 'refuse') {
		throw new GecoError('rejected', `"${branch}" is checked out and the checkout strategy is "refuse".`, 'Switch to another branch first, or use the ff-only / reset-hard strategy.');
	}
	if (effective === 'ff-only' && !wasFastForward) {
		throw new GecoError('not-fast-forward', `"${branch}" is checked out and cannot be fast-forwarded to ${shorten(to)}.`, `${behind} commit(s) would be discarded; use the reset-hard strategy (or move the branch while it is not checked out).`);
	}
	if (checkedOut && effective === 'reset-hard' && !options.allowDirty && (await git.isDirty())) {
		throw new GecoError('dirty-worktree', `"${branch}" is checked out and moving it to ${shorten(to)} needs "reset --hard", which would throw away uncommitted changes.`, 'Commit or stash your changes first (untracked files are kept).');
	}
	if (!checkedOut && headSha === from) {
		notes.push(`HEAD is detached at ${shorten(from)}; the worktree stays where it is.`);
	}

	// Park the old tip before anything is moved.
	const backup = options.createBackup === false
		? undefined
		: await safety.backupBranch(options.backupName ?? settings.defaultBackupBranchName, from);
	if (backup && backup.renamed) {
		notes.push(`Backup branch "${options.backupName ?? settings.defaultBackupBranchName}" was taken, so the old tip was saved as "${backup.name}".`);
	}

	try {
		if (!checkedOut) {
			await git.updateRef(branchRef, to, { oldValue: from, message: `geco fast-forward to ${shorten(to)}` });
		} else if (effective === 'ff-only') {
			await git.mergeFastForwardOnly(to);
		} else {
			await git.reset('hard', to);
			notes.push(`"${branch}" was checked out, so the working tree was reset to ${shorten(to)}.`);
		}
	} catch (error) {
		if (backup && !backup.reused && (await git.branchExists(backup.name))) {
			await git.deleteBranch(backup.name, { force: true }).catch(() => undefined);
		}
		throw error;
	}

	// Leaving the worktree on the moved branch: when the branch was not the
	// checked out one, the worktree keeps sitting on the branch whose name the
	// move just made redundant - and a checked-out branch is exactly the one
	// "Remove Redundant Branches" must keep, which is how leftovers pile up.
	// Clean worktrees only; the move stands even when the checkout cannot run.
	let checkedOutAfter = false;
	let previousBranch: string | undefined;
	if (options.checkoutAfterMove === true && !checkedOut) {
		previousBranch = await git.headBranch();
		const elsewhere = (await git.worktreeList()).find((worktree) => worktree.branch === `refs/heads/${branch}`);
		if (elsewhere) {
			notes.push(`"${branch}" is checked out in another worktree (${elsewhere.path}), so the worktree stays where it is.`);
		} else if (await git.isDirty({ includeUntracked: true })) {
			notes.push(`The worktree has uncommitted changes, so "${branch}" was not checked out - commit or stash them first if the old branch names should go away.`);
		} else {
			try {
				await git.checkout(branch);
				checkedOutAfter = true;
				notes.push(`Checked out ${branch} after moving it to ${shorten(to)}.`);
			} catch (error) {
				notes.push(`The move succeeded, but checking out "${branch}" failed: ${toErrorMessage(error)}`);
			}
		}
	}

	const upstream = await git.upstream(branch);
	let needsForcePush = false;
	if (upstream?.sha) {
		needsForcePush = !(await git.isAncestor(upstream.sha, to));
	}

	await safety.record({
		kind: 'fastForward',
		summary: `Moved ${branch} ${shorten(from)} -> ${shorten(to)} (${wasFastForward ? 'fast-forward' : 'forced'}, ${ahead} ahead / ${behind} behind)${backup ? `, old tip kept on ${backup.name}` : ''}${checkedOutAfter ? `, checked out ${branch}` : ''}`,
		undo: {
			type: 'refs',
			// `resetHard` must hold for the undo, not just the move: when the
			// move ended with the branch checked out, restoring its ref would
			// leave the worktree on the moved branch with stale files.
			refs: [{ ref: branchRef, restoreTo: from, expected: to, resetHard: checkedOut || checkedOutAfter }],
			deleteBranches: backup && !backup.reused ? [backup.name] : [],
			// ...and one Undo must also leave the branch again, back to the
			// branch (or detached HEAD - `undefined` restores nothing) the
			// worktree was on before the move.
			checkoutRef: checkedOutAfter ? previousBranch : undefined,
		},
	});

	return {
		...base,
		backup,
		wasFastForward,
		alreadyAtTarget: false,
		ahead,
		behind,
		discardedCommits,
		checkedOut,
		checkedOutAfter,
		worktreeUpdated: checkedOut || checkedOutAfter,
		needsForcePush,
		upstreamRef: upstream ? `${upstream.remote}/${upstream.branch}` : undefined,
	};
}

/** Commits reachable from `from` but not from `to` - i.e. what a forced move leaves behind. */
export async function listDiscarded(ctx: RepoContext, to: string, from: string, limit = 50): Promise<DiscardedCommit[]> {
	const shas = await ctx.git.revList([`${to}..${from}`, `--max-count=${limit}`]);
	const result: DiscardedCommit[] = [];
	for (const sha of shas) {
		const info = await ctx.git.commitInfo(sha);
		result.push({ sha, subject: info.subject });
	}
	return result;
}
