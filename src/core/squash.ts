/**
 * Squash: combine a run of commits into one.
 *
 * The selection has to be an unbroken run along the first-parent chain (the
 * "line of history" a `git log --graph` row shows), for example the three rows
 * `wip` -> `fix tests` -> `review feedback`:
 *
 *   1. the combined commit gets the tree of the **newest** selected commit (it
 *      contains every change of the run), the parents of the **oldest** one and
 *      a message you can edit (default: the newest commit's message);
 *   2. every descendant of the newest commit up to the branch tip is replayed
 *      with `git commit-tree`, exactly like a reword does;
 *   3. the branch ref moves with `git update-ref <ref> <new> <old>` - atomic, so
 *      a branch that moved in the meantime makes the operation fail instead of
 *      being clobbered.
 *
 * No working tree, no index, no interactive rebase: like the other rewrite
 * operations this works with uncommitted changes and is undone by one
 * "Git Easy Ops: Undo Last Operation".
 */
import type { RepoContext } from './context';
import { GecoError } from './errors';
import type { CommitInfo, Git } from './git';
import { messageSubject, normalizeMessage } from './reword';
import { discardRecoveryRef, isSignedCommit, rewriteCommit } from './rewrite';
import { shorten, type JournalEntry } from './safety';

export interface SquashOptions {
	/** The commits to combine; any order, they are sorted oldest -> newest. */
	commits: readonly string[];
	/** Branch to rewrite (default: the checked out branch). */
	branch?: string;
	/** Message of the combined commit (default: the newest commit's message). */
	message?: string;
	/** Create a hidden recovery ref before rewriting (default: true). */
	createBackup?: boolean;
	/** Keep the original committer date (default: from settings). */
	preserveCommitterDate?: boolean;
}

export interface SquashedCommit {
	sha: string;
	shortSha: string;
	subject: string;
}

export interface RewrittenCommit {
	from: string;
	to: string;
	subject: string;
}

export interface SquashResult {
	branch: string;
	/** Oldest -> newest: the commits that became one. */
	squashed: SquashedCommit[];
	/** Parent of the combined commit (the commit before the run), if any. */
	base?: string;
	newSha: string;
	newTip: string;
	oldTip: string;
	message: string;
	defaultMessage: string;
	/** The combined commit first, then the replayed descendants. */
	rewritten: RewrittenCommit[];
	backupRef?: string;
	/** True when the rewritten commits are already on the remote. */
	needsForcePush: boolean;
	upstreamRef?: string;
	/** Local branches / tags that still point at the old (squashed) commits. */
	otherRefsOnOldHistory: string[];
	signatureDropped: boolean;
	/** True when the oldest commit was a merge: only its first parent is kept. */
	mergeParentsDropped: boolean;
	journal: JournalEntry;
}

// --------------------------------------------------------------- selection

/**
 * The message the combined commit gets by default: the newest selected
 * commit's message (it describes the state that survives the squash).
 */
export function composeSquashMessage(messages: readonly string[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = normalizeMessage(messages[i] ?? '');
		if (message) {
			return message;
		}
	}
	return '';
}

/** `"3"` -> 3; anything else (including 0 and > max) -> undefined. */
export function parseSquashCount(text: string, max = 50): number | undefined {
	const trimmed = (text ?? '').trim();
	if (!/^\d+$/.test(trimmed)) {
		return undefined;
	}
	const count = Number.parseInt(trimmed, 10);
	return count >= 1 && count <= max ? count : undefined;
}

/**
 * Sort commits oldest -> newest and make sure they are comparable at all.
 * Two commits on different branches have no order, and there is no sensible
 * squash for them - that is an error, not a guess.
 */
export async function orderSquashSelection(git: Git, commits: readonly string[]): Promise<string[]> {
	const resolved: string[] = [];
	for (const ref of commits) {
		const sha = await git.resolveCommit(ref);
		if (!resolved.includes(sha)) {
			resolved.push(sha);
		}
	}
	if (resolved.length < 2) {
		return resolved;
	}

	const depth = new Map<string, number>();
	for (const sha of resolved) {
		let ancestors = 0;
		for (const other of resolved) {
			if (other !== sha && (await git.isAncestor(other, sha))) {
				ancestors++;
			}
		}
		depth.set(sha, ancestors);
	}
	const ordered = [...resolved].sort((a, b) => (depth.get(a) ?? 0) - (depth.get(b) ?? 0));

	for (let i = 1; i < ordered.length; i++) {
		const older = ordered[i - 1]!;
		const newer = ordered[i]!;
		if (!(await git.isAncestor(older, newer))) {
			throw new GecoError(
				'not-a-chain',
				`${shorten(older)} and ${shorten(newer)} are not on the same line of history, so they cannot be squashed into one commit.`,
				'Select commits that follow each other along one branch (Ctrl/Shift-click in the Graph group), or use "Squash with Previous Commits..." for a run of commits.',
			);
		}
	}
	return ordered;
}

/**
 * The first-parent run between `oldest` and `newest` (inclusive), or `undefined`
 * when `oldest` is not on that line. One `git rev-list` call, walked in memory.
 */
async function firstParentRun(git: Git, newest: string, oldest: string): Promise<string[] | undefined> {
	const parents = await git.parentMap(newest, { firstParent: true });
	const run = [newest];
	let current = newest;
	while (run.length <= parents.size + 1) {
		const next = parents.get(current)?.[0];
		if (!next) {
			return undefined;
		}
		run.push(next);
		if (next === oldest) {
			return run;
		}
		current = next;
	}
	return undefined;
}

/**
 * Check that the selection covers an unbroken run: asking for 3 commits when
 * one in between is not selected would silently delete that commit's identity
 * (its message), so it is refused with the names of the missing commits.
 */
async function requireUnbrokenRun(git: Git, ordered: readonly string[]): Promise<string[]> {
	const oldest = ordered[0]!;
	const newest = ordered[ordered.length - 1]!;
	const run = await firstParentRun(git, newest, oldest);
	const selected = new Set(ordered);
	const covered = new Set(run ?? []);

	if (!run || ordered.some((sha) => !covered.has(sha))) {
		throw new GecoError(
			'not-a-chain',
			`${shorten(oldest)} and ${shorten(newest)} are connected through a merge, so they are not one unbroken run of commits.`,
			'Select commits that follow each other along one branch, or use "Squash with Previous Commits...".',
		);
	}
	const missing = run.filter((sha) => !selected.has(sha));
	if (missing.length > 0) {
		const names = await Promise.all(missing.slice(0, 5).map(async (sha) => `${shorten(sha)} (${messageSubject(await git.rawMessage(sha))})`));
		throw new GecoError(
			'not-a-chain',
			`The selection has a gap: ${missing.length === 1 ? '1 commit' : `${missing.length} commits`} between them ${missing.length === 1 ? 'is' : 'are'} not selected.`,
			`Not selected: ${names.join(', ')}${missing.length > 5 ? ', ...' : ''}.\nA squash has to cover an unbroken run of commits - select them too, or use "Squash with Previous Commits...".`,
		);
	}
	return run;
}

/**
 * The commit a menu hands us plus its `count` first-parent ancestors, oldest
 * first. Used by "Squash with Previous Commits..." (and works from any menu,
 * because it only needs the one commit the row stands for).
 */
export async function collectPreviousCommits(git: Git, target: string, count: number): Promise<string[]> {
	const newest = await git.resolveCommit(target);
	if (count < 1) {
		return [newest];
	}
	const parents = await git.parentMap(newest, { firstParent: true });
	const run = [newest];
	let current = newest;
	while (run.length < count + 1) {
		const next = parents.get(current)?.[0];
		if (!next) {
			break;
		}
		run.push(next);
		current = next;
	}
	return run.reverse();
}

// ------------------------------------------------------------------ operation

export async function squashCommits(ctx: RepoContext, options: SquashOptions): Promise<SquashResult> {
	const { git, safety, settings } = ctx;
	await git.requireRepository();

	const ordered = await orderSquashSelection(git, options.commits);
	if (ordered.length < 2) {
		throw new GecoError('nothing-to-do', 'A squash needs at least two commits.');
	}
	await requireUnbrokenRun(git, ordered);

	const oldest = ordered[0]!;
	const newest = ordered[ordered.length - 1]!;
	const infos: CommitInfo[] = await Promise.all(ordered.map((sha) => git.commitInfo(sha)));
	const oldestInfo = infos[0]!;
	const newestInfo = infos[infos.length - 1]!;

	const defaultMessage = composeSquashMessage(infos.map((info) => info.message));
	const message = options.message !== undefined ? normalizeMessage(options.message) : defaultMessage;
	if (!message) {
		throw new GecoError('nothing-to-do', 'The combined commit would have an empty message - type one.');
	}

	const preserveCommitterDate = options.preserveCommitterDate ?? settings.preserveCommitterDateOnReword;
	const createBackup = options.createBackup !== false;
	const branchName = options.branch ?? (await git.headBranch());
	if (!branchName) {
		throw new GecoError(
			'detached-head',
			'HEAD is detached, so there is no branch whose history should be rewritten.',
			'Check out the branch that contains these commits first.',
		);
	}
	const branchRef = `refs/heads/${branchName}`;
	const branchSha = await git.revParse(branchRef);
	if (!branchSha) {
		throw new GecoError('ref-not-found', `Branch "${branchName}" does not exist.`);
	}
	if (!(await git.isAncestor(newest, branchSha))) {
		const containing = (await git.branchesContaining(newest)).filter((name) => name !== 'HEAD');
		throw new GecoError(
			'commit-not-on-branch',
			`Commit ${shorten(newest)} is not part of branch "${branchName}".`,
			containing.length > 0
				? `It is on: ${containing.join(', ')}. Squash it on one of those branches instead.`
				: 'The commit is not reachable from any local branch.',
		);
	}

	const backupRef = createBackup ? await safety.hiddenBackupRef(`squash/${branchName}`, branchSha) : undefined;
	try {
		const map = new Map<string, string>();
		const parents = oldestInfo.parents.slice(0, 1);
		const combined = await git.commitTree({
			tree: newestInfo.tree,
			parents,
			message,
			author: oldestInfo.author,
			committer: preserveCommitterDate
				? oldestInfo.committer
				: { ...oldestInfo.committer, date: new Date().toISOString() },
		});
		for (const sha of ordered) {
			map.set(sha, combined);
		}

		const rewritten: RewrittenCommit[] = [
			{ from: newest, to: combined, subject: messageSubject(message) },
		];
		for (const sha of await git.ancestryPathOldestFirst(newest, branchSha)) {
			const preserved = await git.rawMessage(sha);
			const next = await rewriteCommit(git, sha, preserved, map, preserveCommitterDate);
			map.set(sha, next);
			rewritten.push({ from: sha, to: next, subject: messageSubject(preserved) });
		}

		const newTip = map.get(branchSha) ?? combined;
		await git.updateRef(branchRef, newTip, { oldValue: branchSha, message: `geco squash ${shorten(newest)}` });

		const upstream = await git.upstream(branchName);
		const needsForcePush = !!upstream?.sha && !(await git.isAncestor(upstream.sha, newTip));

		const elsewhere = new Set<string>();
		for (const sha of [oldest, newest]) {
			for (const name of await git.branchesContaining(sha)) {
				if (name !== 'HEAD' && name !== branchName) {
					elsewhere.add(name);
				}
			}
			for (const tag of await git.tagsContaining(sha)) {
				elsewhere.add(`tag:${tag}`);
			}
		}

		const squashed: SquashedCommit[] = infos.map((info) => ({
			sha: info.sha,
			shortSha: info.shortSha,
			subject: info.subject,
		}));
		const signed = await Promise.all(ordered.map((sha) => isSignedCommit(git, sha)));
		const journal = await safety.record({
			kind: 'squash',
			summary: `Squashed ${ordered.length} commits into ${shorten(combined)} on ${branchName} ("${messageSubject(message)}")`,
			undo: {
				type: 'refs',
				refs: [{ ref: branchRef, restoreTo: branchSha, expected: newTip }],
				deleteRefs: backupRef ? [backupRef] : [],
			},
		});

		return {
			branch: branchName,
			squashed,
			base: parents[0],
			newSha: combined,
			newTip,
			oldTip: branchSha,
			message,
			defaultMessage,
			rewritten,
			backupRef,
			needsForcePush,
			upstreamRef: upstream ? `${upstream.remote}/${upstream.branch}` : undefined,
			otherRefsOnOldHistory: [...elsewhere],
			signatureDropped: signed.some(Boolean),
			mergeParentsDropped: oldestInfo.parents.length > 1,
			journal,
		};
	} catch (error) {
		await discardRecoveryRef(git, backupRef);
		throw error;
	}
}
