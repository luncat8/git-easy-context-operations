/**
 * Branch operations that the Source Control Graph / branch menus offer:
 * create, rename and delete - each one journaled so **Undo** puts things back.
 *
 * The rules that keep these safe:
 *   - creating never overwrites an existing branch unless `force` is given;
 *   - renaming keeps the sha (nothing is rewritten) and, when asked, follows the
 *     branch onto the remote;
 *   - deleting refuses an unmerged branch unless `force` is given, refuses the
 *     checked-out branch outright, and remembers the sha (and the upstream) so
 *     undo can recreate the branch exactly as it was.
 */
import type { RepoContext } from './context';
import { GecoError } from './errors';
import { previewSubject } from './reword';
import { shorten, type RemoteRefRestore } from './safety';

/**
 * A branch name suggestion built from a commit subject:
 * "v0.2 add new button" -> "v0.2-add-new-button".
 */
export function suggestBranchName(subject: string): string {
	const slug = subject
		.toLowerCase()
		.replace(/[^a-z0-9._/-]+/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^[./-]+/, '')
		.slice(0, 48)
		.replace(/[./-]+$/, '');
	return slug || 'new-branch';
}

export interface CreateBranchOptions {
	name: string;
	/** Commit the branch starts at (default: HEAD). */
	startPoint?: string;
	/** Check the new branch out after creating it. */
	checkout?: boolean;
	/** Overwrite an existing branch of the same name. */
	force?: boolean;
	/** Journal the operation for Undo (default: true). */
	record?: boolean;
}

export interface CreateBranchResult {
	name: string;
	sha: string;
	startPoint: string;
	checkedOut: boolean;
	overwritten?: string;
	notes: string[];
}

export async function createBranch(ctx: RepoContext, options: CreateBranchOptions): Promise<CreateBranchResult> {
	const { git, safety } = ctx;
	await git.requireRepository();

	const name = options.name.trim();
	if (!name) {
		throw new GecoError('invalid-ref', 'A branch name is required.');
	}
	const startSha = await git.resolveCommit(options.startPoint ?? 'HEAD');
	const notes: string[] = [];

	const existing = await git.revParse(`refs/heads/${name}`);
	if (existing && !options.force) {
		if (existing === startSha) {
			throw new GecoError('invalid-ref', `Branch "${name}" already exists and already points at ${shorten(startSha)}.`, 'Nothing was created. Rename it or pick another name.');
		}
		throw new GecoError('invalid-ref', `Branch "${name}" already exists (at ${shorten(existing)}).`, 'Rename it, pick another name, or force the operation to move it.');
	}
	if (!existing && !(await safety.isBranchNameFree(name))) {
		throw new GecoError('invalid-ref', `"${name}" cannot be used as a branch name.`, 'Git rejects it, or a tag/ref with that name already exists.');
	}

	const previousBranch = await git.headBranch();
	await git.createBranch(name, startSha, { force: options.force });
	if (existing) {
		notes.push(`"${name}" moved from ${shorten(existing)} to ${shorten(startSha)}.`);
	}

	let checkedOut = false;
	if (options.checkout) {
		await git.checkout(name);
		checkedOut = true;
	}

	if (options.record !== false) {
		await safety.record({
			kind: 'branch',
			summary: existing
				? `Moved branch ${name} ${shorten(existing)} -> ${shorten(startSha)}${checkedOut ? ' and checked it out' : ''}`
				: `Created branch ${name} at ${shorten(startSha)}${checkedOut ? ' and checked it out' : ''}`,
			undo: existing
				? { type: 'refs', refs: [{ ref: `refs/heads/${name}`, restoreTo: existing, expected: startSha }], checkoutRef: checkedOut ? previousBranch : undefined }
				: { type: 'refs', refs: [], deleteBranches: [name], checkoutRef: checkedOut ? previousBranch : undefined },
		});
	}

	return { name, sha: startSha, startPoint: options.startPoint ?? 'HEAD', checkedOut, overwritten: existing, notes };
}

export interface RenameBranchOptions {
	from: string;
	to: string;
	/**
	 * What to do with the remote branch the old name tracked:
	 *   'keep'   - leave the remote alone, keep tracking the old remote branch;
	 *   'rename' - push the new name and delete the old remote branch;
	 *   'push'   - push the new name, leave the old remote branch in place.
	 */
	remote?: 'keep' | 'rename' | 'push';
	force?: boolean;
	record?: boolean;
}

export interface RenameBranchResult {
	from: string;
	to: string;
	sha: string;
	wasCurrent: boolean;
	upstreamBefore?: string;
	upstreamAfter?: string;
	remoteAction?: 'keep' | 'rename' | 'push';
	pushedRemoteBranch?: string;
	deletedRemoteBranch?: string;
	notes: string[];
}

export async function renameBranch(ctx: RepoContext, options: RenameBranchOptions): Promise<RenameBranchResult> {
	const { git, safety } = ctx;
	await git.requireRepository();

	const from = options.from.trim();
	const to = options.to.trim();
	if (!from || !to) {
		throw new GecoError('invalid-ref', 'Both the old and the new branch name are required.');
	}
	if (from === to) {
		throw new GecoError('nothing-to-do', `Branch "${from}" is already called that.`);
	}
	const sha = await git.revParse(`refs/heads/${from}`);
	if (!sha) {
		throw new GecoError('ref-not-found', `Branch "${from}" does not exist.`);
	}
	const targetExists = await git.refExists(`refs/heads/${to}`);
	if (targetExists && !options.force) {
		throw new GecoError('invalid-ref', `A branch called "${to}" already exists.`, 'Pick another name, or force the rename to overwrite it.');
	}
	if (!targetExists && !(await safety.isBranchNameFree(to))) {
		throw new GecoError('invalid-ref', `"${to}" cannot be used as a branch name.`);
	}

	const notes: string[] = [];
	const wasCurrent = (await git.headBranch()) === from;
	const upstreamBefore = await git.upstream(from);
	const overwritten = targetExists ? await git.revParse(`refs/heads/${to}`) : undefined;

	await git.ok(['branch', options.force ? '-M' : '-m', from, to]);

	// Tracking configuration belongs to the old name; decide what happens to it.
	const remoteAction = options.remote ?? 'keep';
	let upstreamAfter: string | undefined;
	let pushedRemoteBranch: string | undefined;
	let deletedRemoteBranch: string | undefined;

	if (upstreamBefore) {
		const { remote, branch: remoteBranch } = upstreamBefore;
		if (remoteAction === 'keep') {
			await git.ok(['branch', `--set-upstream-to=${remote}/${remoteBranch}`, to]);
			upstreamAfter = `${remote}/${remoteBranch}`;
			notes.push(`"${to}" still tracks ${remote}/${remoteBranch} - the remote branch was not renamed.`);
		} else {
			const push = await git.push(['-u', remote, `${to}:refs/heads/${to}`]);
			if (push.exitCode !== 0) {
				throw new GecoError('rejected', `Renamed the branch locally but could not push "${to}" to ${remote}.`, push.stderr.trim());
			}
			pushedRemoteBranch = `${remote}/${to}`;
			upstreamAfter = `${remote}/${to}`;
			if (remoteAction === 'rename') {
				const remove = await git.push([remote, '--delete', remoteBranch]);
				if (remove.exitCode === 0) {
					deletedRemoteBranch = `${remote}/${remoteBranch}`;
					notes.push(`${remote}/${remoteBranch} was deleted; the remote branch is now ${remote}/${to}.`);
				} else {
					notes.push(`Could not delete ${remote}/${remoteBranch}: ${remove.stderr.trim().split('\n')[0] ?? 'push refused'}`);
				}
			} else {
				notes.push(`${remote}/${remoteBranch} was left in place on the remote.`);
			}
		}
	} else if (remoteAction !== 'keep') {
		const remotes = await git.remotes();
		const remote = remotes[0];
		if (!remote) {
			notes.push('This repository has no remote, so only the local branch was renamed.');
		} else {
			const push = await git.push(['-u', remote, `${to}:refs/heads/${to}`]);
			if (push.exitCode === 0) {
				pushedRemoteBranch = `${remote}/${to}`;
				upstreamAfter = `${remote}/${to}`;
			} else {
				notes.push(`Could not push "${to}" to ${remote}: ${push.stderr.trim().split('\n')[0] ?? 'push refused'}`);
			}
		}
	}

	if (options.record !== false) {
		const undoRefs = [{ ref: `refs/heads/${from}`, restoreTo: sha, upstream: shortUpstream(upstreamBefore?.ref) }];
		// One journal entry per user action: the local rename and whatever it did
		// on the remote are undone together.
		const remoteRefs: RemoteRefRestore[] = [];
		if (upstreamBefore) {
			if (deletedRemoteBranch) {
				remoteRefs.push({ remote: upstreamBefore.remote, branch: upstreamBefore.branch, restoreTo: sha });
			}
			if (pushedRemoteBranch) {
				// Remove the branch we pushed - but only while it still points at
				// the sha we left behind, so nobody else's work is clobbered.
				remoteRefs.push({ remote: upstreamBefore.remote, branch: to, action: 'delete', expectedSha: sha });
			}
		}
		await safety.record({
			kind: 'branch',
			summary: `Renamed branch ${from} -> ${to}${upstreamAfter && upstreamAfter !== upstreamBefore?.ref ? ` (remote: ${upstreamAfter})` : ''}`,
			undo: {
				type: 'refs',
				refs: overwritten ? [...undoRefs, { ref: `refs/heads/${to}`, restoreTo: overwritten }] : undoRefs,
				deleteBranches: overwritten ? [] : [to],
				// Renaming the checked-out branch moves HEAD with it; undo has to
				// come back before the new name can be deleted.
				checkoutRef: wasCurrent ? from : undefined,
				remoteRefs,
			},
		});
	}

	return { from, to, sha, wasCurrent, upstreamBefore: shortUpstream(upstreamBefore?.ref), upstreamAfter, remoteAction, pushedRemoteBranch, deletedRemoteBranch, notes };
}

export interface DeleteBranchOptions {
	name: string;
	/** Delete even when the branch has commits that are not merged/pushed. */
	force?: boolean;
	/** Also delete the branch on its remote. */
	deleteRemote?: boolean;
	record?: boolean;
}

export interface DeleteBranchResult {
	name: string;
	sha: string;
	forced: boolean;
	unmergedCommits: number;
	upstream?: string;
	deletedRemoteBranch?: string;
	notes: string[];
}

/** What would be lost - used by the UI to ask before forcing. */
export async function inspectBranchDeletion(ctx: RepoContext, name: string): Promise<{ sha: string; isCurrent: boolean; upstream?: string; unmergedCommits: number; unmerged: { sha: string; subject: string }[] }> {
	const { git } = ctx;
	const sha = await git.revParse(`refs/heads/${name}`);
	if (!sha) {
		throw new GecoError('ref-not-found', `Branch "${name}" does not exist.`);
	}
	const upstream = await git.upstream(name);
	const isCurrent = (await git.headBranch()) === name;
	// Commits that exist only on this branch: not in HEAD and not on its upstream.
	const exclude = upstream?.sha ? [upstream.sha] : ['HEAD'];
	const unmergedShas = await git.revList([name, '--not', ...exclude]);
	const unmerged: { sha: string; subject: string }[] = [];
	for (const candidate of unmergedShas.slice(0, 10)) {
		const info = await git.commitInfo(candidate);
		unmerged.push({ sha: info.sha, subject: info.subject });
	}
	return { sha, isCurrent, upstream: shortUpstream(upstream?.ref), unmergedCommits: unmergedShas.length, unmerged };
}

export async function deleteBranch(ctx: RepoContext, options: DeleteBranchOptions): Promise<DeleteBranchResult> {
	const { git, safety } = ctx;
	await git.requireRepository();

	const name = options.name.trim();
	const inspection = await inspectBranchDeletion(ctx, name);
	const notes: string[] = [];

	if (inspection.isCurrent) {
		throw new GecoError('unsupported', `"${name}" is the branch you have checked out, so it cannot be deleted.`, 'Check out another branch first (or fast-forward it onto the branch you want to keep).');
	}
	if (inspection.unmergedCommits > 0 && !options.force) {
		throw new GecoError(
			'unmerged-branch',
			`"${name}" has ${inspection.unmergedCommits} commit${inspection.unmergedCommits === 1 ? '' : 's'} that ${inspection.upstream ? `${inspection.upstream} does not have` : 'HEAD does not have'}.`,
			`${inspection.unmerged.slice(0, 10).map((c) => `  ${shorten(c.sha)} ${previewSubject(c.subject)}`).join('\n')}${inspection.unmerged.length > 10 ? `\n  ... and ${inspection.unmerged.length - 10} more` : ''}\nDelete it anyway and these commits are only reachable through the journal / reflog.`,
		);
	}

	// Local first: if git refuses the branch, the remote copy is still there.
	await git.deleteBranch(name, { force: options.force });

	let deletedRemoteBranch: string | undefined;
	let remoteParts: [string, string] | undefined;
	if (options.deleteRemote && inspection.upstream) {
		remoteParts = splitUpstream(inspection.upstream);
		const push = await git.push([remoteParts[0], '--delete', remoteParts[1]]);
		if (push.exitCode === 0) {
			deletedRemoteBranch = inspection.upstream;
			notes.push(`Deleted ${remoteParts[0]}/${remoteParts[1]} on the remote.`);
		} else {
			remoteParts = undefined;
			notes.push(`The local branch is gone but ${inspection.upstream} could not be deleted: ${push.stderr.trim().split('\n')[0] ?? 'push refused'}`);
		}
	}

	if (options.record !== false) {
		const remoteRefs: RemoteRefRestore[] = remoteParts
			? [{ remote: remoteParts[0], branch: remoteParts[1], restoreTo: inspection.sha }]
			: [];
		await safety.record({
			kind: 'branch',
			summary: `Deleted branch ${name} (${shorten(inspection.sha)})${deletedRemoteBranch ? ` and ${deletedRemoteBranch}` : ''}${inspection.unmergedCommits > 0 ? ` with ${inspection.unmergedCommits} unmerged commit(s)` : ''}`,
			undo: {
				type: 'refs',
				refs: [{ ref: `refs/heads/${name}`, restoreTo: inspection.sha, upstream: inspection.upstream }],
				remoteRefs,
			},
		});
	}

	return {
		name,
		sha: inspection.sha,
		forced: options.force === true,
		unmergedCommits: inspection.unmergedCommits,
		upstream: inspection.upstream,
		deletedRemoteBranch,
		notes,
	};
}

/** Check out a branch (used by the "Check Out" follow-up action), journaled. */
export async function checkoutBranch(ctx: RepoContext, name: string): Promise<{ from?: string; to: string }> {
	const { git, safety } = ctx;
	const from = await git.headBranch();
	if (from === name) {
		throw new GecoError('nothing-to-do', `"${name}" is already checked out.`);
	}
	await git.checkout(name);
	await safety.record({
		kind: 'branch',
		summary: `Checked out ${name}${from ? ` (was ${from})` : ''}`,
		undo: from ? { type: 'refs', refs: [], checkoutRef: from } : { type: 'none', hint: `Detach or check out another branch manually - there was no branch checked out before.` },
	});
	return { from, to: name };
}

/** `refs/remotes/origin/main` -> `origin/main` (what humans and git config use). */
function shortUpstream(ref: string | undefined): string | undefined {
	if (!ref) {
		return undefined;
	}
	return ref.startsWith('refs/remotes/') ? ref.slice('refs/remotes/'.length) : ref;
}

function splitUpstream(upstream: string): [string, string] {
	const name = shortUpstream(upstream) ?? upstream;
	const index = name.indexOf('/');
	if (index <= 0 || index === name.length - 1) {
		throw new GecoError('unsupported', `Cannot work out the remote and branch from "${upstream}".`);
	}
	return [name.slice(0, index), name.slice(index + 1)];
}
