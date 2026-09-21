/**
 * Feature 1 - rename / reword a commit message.
 *
 * `v0.2` -> `v0.2 add new button`
 *
 * How it works (no interactive rebase, no editor, no worktree changes):
 *
 *   1. a brand new commit object is created for the target with `git commit-tree`,
 *      reusing the *same tree*, the *same parents* and the *same author/committer*
 *      so only the message differs;
 *   2. every descendant between the target and the branch tip is replayed the
 *      same way (`git rev-list --ancestry-path --topo-order`), each with its
 *      message preserved byte-for-byte;
 *   3. the branch ref is moved with `git update-ref <ref> <new> <old>`, which is
 *      atomic: if anything else moved the branch in the meantime we fail instead
 *      of clobbering it.
 *
 * Because every rewritten commit keeps its original tree, the working directory
 * and the index are never touched - the operation works even with uncommitted
 * changes, and it also works for root commits and merge commits.
 */
import type { RepoContext } from './context';
import { GecoError } from './errors';
import { discardRecoveryRef, isSignedCommit, rewriteCommit } from './rewrite';
import { shorten } from './safety';

export type MessageEditMode = 'replace' | 'append' | 'prepend' | 'findReplace';

export interface MessageEdit {
	mode: MessageEditMode;
	/** Replacement / appended text. */
	text: string;
	/** Search text, only for `findReplace`. */
	find?: string;
	/**
	 * `true` (default) edits the subject line only, `false` edits the whole
	 * message. Ignored by `replace`.
	 */
	subjectOnly?: boolean;
}

export interface RewordOptions {
	/** Commit to reword (sha, `HEAD~2`, tag, ...). */
	commit: string;
	/** Final message. Takes precedence over `edit`. */
	message?: string;
	/** How to derive the final message from the current one. */
	edit?: MessageEdit;
	/** Branch whose history should be rewritten (default: the checked out branch). */
	branch?: string;
	/** Create a hidden recovery ref before rewriting (default: true). */
	createBackup?: boolean;
	/** Keep the original committer date (default: from settings). */
	preserveCommitterDate?: boolean;
}

export interface RewrittenCommit {
	from: string;
	to: string;
	subject: string;
}

export interface RewordResult {
	noChange: boolean;
	detachedHead: boolean;
	branch?: string;
	targetSha: string;
	newTargetSha: string;
	oldTip?: string;
	newTip?: string;
	/** Target commit first, then descendants oldest -> newest. */
	rewritten: RewrittenCommit[];
	oldMessage: string;
	newMessage: string;
	backupRef?: string;
	/** True when the rewritten commits are already on the remote. */
	needsForcePush: boolean;
	upstreamRef?: string;
	/** Local branches / tags that still contain the old (unrewritten) commit. */
	otherRefsOnOldHistory: string[];
	signatureDropped: boolean;
}

export interface RewriteBranchInfo {
	/** Branch that should be rewritten, when there is an obvious one. */
	branch?: string;
	/** All local branches that contain the commit. */
	candidates: string[];
	currentBranch?: string;
}

// --------------------------------------------------------------- message edits

/** Trim trailing whitespace per line and drop surrounding blank lines. */
export function normalizeMessage(raw: string): string {
	const lines = (raw ?? '').replace(/\r\n/g, '\n').split('\n').map((line) => line.replace(/\s+$/, ''));
	while (lines.length > 0 && lines[0] === '') {
		lines.shift();
	}
	while (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines.join('\n');
}

export function splitMessage(message: string): { subject: string; body: string } {
	const normalized = normalizeMessage(message);
	const newline = normalized.indexOf('\n');
	if (newline < 0) {
		return { subject: normalized, body: '' };
	}
	return {
		subject: normalized.slice(0, newline),
		body: normalized.slice(newline + 1).replace(/^\n+/, ''),
	};
}

export function messageSubject(message: string): string {
	return splitMessage(message).subject;
}

function oneLine(text: string): string {
	return normalizeMessage(text)
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.join(' ');
}

/**
 * Pure function: current message + edit -> new message.
 * Throws `nothing-to-do` when the edit cannot produce a different message.
 */
export function applyMessageEdit(original: string, edit: MessageEdit): string {
	const normalizedOriginal = normalizeMessage(original);
	const wholeMessage = edit.subjectOnly === false;

	switch (edit.mode) {
		case 'replace': {
			return normalizeMessage(edit.text) || ' ';
		}

		case 'append':
		case 'prepend': {
			const fragment = oneLine(edit.text);
			if (!fragment) {
				throw new GecoError('nothing-to-do', 'Nothing to add to the commit message.');
			}
			if (wholeMessage) {
				return edit.mode === 'append'
					? normalizeMessage(`${normalizedOriginal}\n\n${fragment}`)
					: normalizeMessage(`${fragment}\n\n${normalizedOriginal}`);
			}
			const { subject, body } = splitMessage(normalizedOriginal);
			const nextSubject = edit.mode === 'append' ? `${subject} ${fragment}` : `${fragment} ${subject}`;
			return body ? normalizeMessage(`${nextSubject}\n\n${body}`) : normalizeMessage(nextSubject);
		}

		case 'findReplace': {
			const find = edit.find ?? '';
			if (!find) {
				throw new GecoError('unsupported', 'find/replace needs a search text.');
			}
			const { subject, body } = splitMessage(normalizedOriginal);
			const scope = wholeMessage ? normalizedOriginal : subject;
			if (!scope.includes(find)) {
				throw new GecoError('nothing-to-do', `"${find}" does not appear in the commit message.`);
			}
			const replaced = scope.split(find).join(edit.text);
			if (wholeMessage) {
				return normalizeMessage(replaced);
			}
			return body ? normalizeMessage(`${replaced}\n\n${body}`) : normalizeMessage(replaced);
		}

		default: {
			const exhaustive: never = edit.mode;
			throw new GecoError('unsupported', `Unknown message edit mode "${String(exhaustive)}".`);
		}
	}
}

// ------------------------------------------------------------------ operations

/** Which branch would be rewritten for this commit? Used by the UI to ask. */
export async function findRewriteBranch(ctx: RepoContext, commit: string): Promise<RewriteBranchInfo> {
	const { git } = ctx;
	const sha = await git.resolveCommit(commit);
	const currentBranch = await git.headBranch();
	const candidates = await git.branchesContaining(sha);
	const local = candidates.filter((name) => name !== 'HEAD' && !name.includes(' -> '));
	return {
		branch: currentBranch && local.includes(currentBranch) ? currentBranch : local.length === 1 ? local[0] : undefined,
		candidates: local,
		currentBranch,
	};
}

export async function rewordCommitMessage(ctx: RepoContext, options: RewordOptions): Promise<RewordResult> {
	const { git, safety, settings } = ctx;
	await git.requireRepository();

	if (options.message === undefined && !options.edit) {
		throw new GecoError('unsupported', 'rewordCommitMessage needs either `message` or `edit`.');
	}

	const targetSha = await git.resolveCommit(options.commit);
	const oldMessage = await git.rawMessage(targetSha);
	const newMessage = options.message !== undefined
		? (normalizeMessage(options.message) || ' ')
		: applyMessageEdit(oldMessage, options.edit!);

	if (!newMessage) {
		throw new GecoError('nothing-to-do', 'The new commit message is empty.');
	}

	const preserveCommitterDate = options.preserveCommitterDate ?? settings.preserveCommitterDateOnReword;
	const createBackup = options.createBackup !== false;
	const headSha = await git.revParse('HEAD');
	const currentBranch = await git.headBranch();
	const branchName = options.branch ?? currentBranch;

	const base: Omit<RewordResult, 'rewritten'> = {
		noChange: false,
		detachedHead: !branchName,
		branch: branchName,
		targetSha,
		newTargetSha: targetSha,
		oldMessage,
		newMessage,
		needsForcePush: false,
		otherRefsOnOldHistory: [],
		signatureDropped: await isSignedCommit(git, targetSha),
	};

	if (normalizeMessage(oldMessage) === normalizeMessage(newMessage)) {
		return { ...base, noChange: true, rewritten: [] };
	}

	// ---- detached HEAD: only the checked out commit itself can be rewritten.
	if (!branchName) {
		if (targetSha !== headSha) {
			const containing = (await git.branchesContaining(targetSha)).filter((b) => b !== 'HEAD');
			throw new GecoError(
				'detached-head',
				'HEAD is detached, so only the checked out commit itself can be reworded.',
				containing.length > 0
					? `Check out one of the branches that contain ${shorten(targetSha)} first: ${containing.join(', ')}.`
					: `Commit ${shorten(targetSha)} is not on the checked out commit.`,
			);
		}
		const backupRef = createBackup ? await safety.hiddenBackupRef('reword/detached-head', targetSha) : undefined;
		try {
			const map = new Map<string, string>();
			const newTarget = await rewriteCommit(git, targetSha, newMessage, map, preserveCommitterDate);
			await git.updateRef('HEAD', newTarget, { oldValue: targetSha, message: `geco reword ${shorten(targetSha)}` });
			await safety.record({
				kind: 'reword',
				summary: `Renamed the message of ${shorten(targetSha)} (detached HEAD): "${messageSubject(oldMessage)}" -> "${messageSubject(newMessage)}"`,
				undo: {
					type: 'refs',
					refs: [{ ref: 'HEAD', restoreTo: targetSha, expected: newTarget }],
					deleteRefs: backupRef ? [backupRef] : [],
				},
			});
			return {
				...base,
				newTargetSha: newTarget,
				newTip: newTarget,
				oldTip: targetSha,
				backupRef,
				rewritten: [{ from: targetSha, to: newTarget, subject: messageSubject(newMessage) }],
			};
		} catch (error) {
			await discardRecoveryRef(git, backupRef);
			throw error;
		}
	}

	// ---- normal case: rewrite the branch that contains the commit.
	const branchRef = `refs/heads/${branchName}`;
	const branchSha = await git.revParse(branchRef);
	if (!branchSha) {
		throw new GecoError('ref-not-found', `Branch "${branchName}" does not exist.`);
	}
	if (!(await git.isAncestor(targetSha, branchSha))) {
		const containing = (await git.branchesContaining(targetSha)).filter((b) => b !== 'HEAD');
		throw new GecoError(
			'commit-not-on-branch',
			`Commit ${shorten(targetSha)} is not part of branch "${branchName}".`,
			containing.length > 0
				? `It is on: ${containing.join(', ')}. Reword it on one of those branches instead.`
				: 'The commit is not reachable from any local branch.',
		);
	}

	const backupRef = createBackup ? await safety.hiddenBackupRef(`reword/${branchName}`, branchSha) : undefined;
	try {
		const map = new Map<string, string>();
		const newTarget = await rewriteCommit(git, targetSha, newMessage, map, preserveCommitterDate);
		map.set(targetSha, newTarget);

		const rewritten: RewrittenCommit[] = [
			{ from: targetSha, to: newTarget, subject: messageSubject(newMessage) },
		];

		const descendants = await git.ancestryPathOldestFirst(targetSha, branchSha);
		for (const sha of descendants) {
			const preserved = await git.rawMessage(sha);
			const rewrittenSha = await rewriteCommit(git, sha, preserved, map, preserveCommitterDate);
			map.set(sha, rewrittenSha);
			rewritten.push({ from: sha, to: rewrittenSha, subject: messageSubject(preserved) });
		}

		const newTip = map.get(branchSha) ?? newTarget;
		await git.updateRef(branchRef, newTip, { oldValue: branchSha, message: `geco reword ${shorten(targetSha)}` });

		// A force push is needed whenever the remote tip is no longer an ancestor
		// of the rewritten tip - that stays true across repeated rewrites.
		const upstream = await git.upstream(branchName);
		let needsForcePush = false;
		if (upstream?.sha) {
			needsForcePush = !(await git.isAncestor(upstream.sha, newTip));
		}

		const containingBranches = (await git.branchesContaining(targetSha)).filter((b) => b !== 'HEAD' && b !== branchName);
		const containingTags = await git.tagsContaining(targetSha);

		await safety.record({
			kind: 'reword',
			summary: `Renamed the message of ${shorten(targetSha)} on ${branchName}: "${messageSubject(oldMessage)}" -> "${messageSubject(newMessage)}" (${rewritten.length} commit${rewritten.length === 1 ? '' : 's'} rewritten)`,
			undo: {
				type: 'refs',
				refs: [{ ref: branchRef, restoreTo: branchSha, expected: newTip }],
				deleteRefs: backupRef ? [backupRef] : [],
			},
		});

		return {
			...base,
			branch: branchName,
			newTargetSha: newTarget,
			oldTip: branchSha,
			newTip,
			rewritten,
			backupRef,
			needsForcePush,
			upstreamRef: upstream ? `${upstream.remote}/${upstream.branch}` : undefined,
			otherRefsOnOldHistory: [...containingBranches, ...containingTags.map((t) => `tag:${t}`)],
		};
	} catch (error) {
		await discardRecoveryRef(git, backupRef);
		throw error;
	}
}
