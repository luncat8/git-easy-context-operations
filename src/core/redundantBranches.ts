/**
 * "Remove Redundant Branches" - the cleanup that piles up after fast-forwarding.
 *
 * A branch is **redundant** when every commit it points at is already reachable
 * from another ref, so deleting it changes nothing about the files or the
 * history: `git log`, every checkout and every diff stay exactly the same. That
 * is what is left over after "Fast-Forward Default Branch to Commit..." parked
 * the old tip on `old`, after a PR was merged, or after the same commit got a
 * second branch name.
 *
 * The test is reachability, not the name and not the merge base: a branch tip
 * that another branch, tag or remote-tracking branch *contains* carries no
 * commit of its own. Everything else is kept and reported with the reason.
 *
 * Safety rails:
 *   - the checked-out branch, branches checked out in another worktree and the
 *     default branch are never offered, however redundant they look;
 *   - `refs/geco/` recovery points do **not** count as keeping a branch alive
 *     (they are our own throw-away backups, not history somebody relies on);
 *   - two branches on the same commit keep each other alive, so a duplicate
 *     pair never disappears completely - one of the two always survives;
 *   - every tip is re-verified right before it is deleted, so a scan that went
 *     stale (a commit landed meanwhile) cannot delete unique work;
 *   - the whole batch is **one** journal entry, so a single Undo brings every
 *     branch back, tracking configuration included. Remote branches are never
 *     touched.
 */
import type { RepoContext } from './context';
import { GecoError } from './errors';
import type { RefInfo } from './git';
import { shorten, type RefRestore } from './safety';

/** Refs that can keep a branch alive (our own recovery refs deliberately cannot). */
const HISTORY_REF_PATTERNS = ['refs/heads', 'refs/remotes', 'refs/tags'];

export interface RedundantBranch {
	name: string;
	sha: string;
	/** Subject of the tip commit, for the report. */
	subject: string;
	upstream?: string;
	/** The refs that already contain this tip - the reason deleting it is a no-op. */
	keptAliveBy: string[];
}

/** A branch that is *not* offered, with the reason a human can act on. */
export interface KeptBranch {
	name: string;
	sha: string;
	reason: string;
	/** Commits that exist only on this branch (0 for a protected branch). */
	uniqueCommits: number;
}

export interface RedundantBranchScan {
	redundant: RedundantBranch[];
	kept: KeptBranch[];
	/** Total number of local branches looked at. */
	branchCount: number;
}

/**
 * Which local branches carry no commit of their own.
 *
 * Duplicates are resolved greedily: branches we would rather drop (no upstream
 * first, then alphabetically) are considered first, and a branch already marked
 * for deletion no longer counts as a keeper for the next one.
 */
export async function findRedundantBranches(ctx: RepoContext): Promise<RedundantBranchScan> {
	const { git } = ctx;
	await git.requireRepository();

	const branches = await git.branches();
	const protectedNames = await protectedBranchNames(ctx, branches);

	const candidates = branches
		.filter((branch) => !protectedNames.has(branch.name))
		.sort((a, b) => Number(Boolean(a.upstream)) - Number(Boolean(b.upstream)) || a.name.localeCompare(b.name));

	const redundant: RedundantBranch[] = [];
	const kept: KeptBranch[] = [];
	const doomed = new Set<string>();

	for (const branch of candidates) {
		const ownRef = `refs/heads/${branch.name}`;
		// Every ref whose history includes this tip - including the branch itself.
		const containing = await git.listRefs(HISTORY_REF_PATTERNS, { contains: branch.sha });
		const keepers = containing
			.map((ref) => fullRefName(ref))
			.filter((name) => name !== ownRef && !doomed.has(name));

		if (keepers.length === 0) {
			kept.push({
				name: branch.name,
				sha: branch.sha,
				reason: 'it is the only ref that has these commits',
				uniqueCommits: await uniqueCommitCount(ctx, branch.name, doomed),
			});
			continue;
		}

		doomed.add(ownRef);
		redundant.push({
			name: branch.name,
			sha: branch.sha,
			subject: await tipSubject(ctx, branch.sha),
			upstream: branch.upstream,
			keptAliveBy: keepers.map(shortRefName),
		});
	}

	// Report only the refs that actually survive the batch: a branch scanned
	// early can be held by one that is deleted later, and naming it would make
	// the reason look like it disappears with the branch. The filtered list is
	// never empty - whatever kept a doomed keeper alive also contains this tip.
	for (const branch of redundant) {
		const survivors = branch.keptAliveBy.filter((name) => !doomed.has(`refs/heads/${name}`));
		if (survivors.length > 0) {
			branch.keptAliveBy = survivors;
		}
	}

	for (const branch of branches.filter((b) => protectedNames.has(b.name))) {
		kept.push({
			name: branch.name,
			sha: branch.sha,
			reason: await protectionReason(ctx, branch),
			uniqueCommits: 0,
		});
	}

	return { redundant, kept: kept.sort((a, b) => a.name.localeCompare(b.name)), branchCount: branches.length };
}

export interface DeleteRedundantBranchesResult {
	deleted: RedundantBranch[];
	/** Branches that were requested but skipped, with the reason. */
	skipped: { name: string; reason: string }[];
	notes: string[];
}

/**
 * Delete the branches a scan found redundant, as one undoable operation.
 * Each tip is re-checked immediately before the branch goes, so a stale scan
 * can only ever delete less, never more.
 */
export async function deleteRedundantBranches(
	ctx: RepoContext,
	branches: readonly RedundantBranch[],
	options: { record?: boolean } = {},
): Promise<DeleteRedundantBranchesResult> {
	const { git, safety } = ctx;
	await git.requireRepository();

	if (branches.length === 0) {
		throw new GecoError('nothing-to-do', 'No branches were selected.');
	}

	const protectedNames = await protectedBranchNames(ctx, await git.branches());
	const deleted: RedundantBranch[] = [];
	const skipped: { name: string; reason: string }[] = [];
	const notes: string[] = [];
	const refs: RefRestore[] = [];

	for (const branch of branches) {
		const ownRef = `refs/heads/${branch.name}`;
		const current = await git.revParse(ownRef);
		if (!current) {
			skipped.push({ name: branch.name, reason: 'it no longer exists' });
			continue;
		}
		if (protectedNames.has(branch.name)) {
			skipped.push({ name: branch.name, reason: 'it is checked out or the default branch' });
			continue;
		}
		if (current !== branch.sha) {
			skipped.push({ name: branch.name, reason: `it moved to ${shorten(current)} since the scan` });
			continue;
		}
		// The decisive re-check: is the tip still held by another ref *now*?
		const containing = (await git.listRefs(HISTORY_REF_PATTERNS, { contains: current }))
			.map(fullRefName)
			.filter((name) => name !== ownRef && !refs.some((restore) => restore.ref === name));
		if (containing.length === 0) {
			skipped.push({ name: branch.name, reason: 'it now has commits no other ref has' });
			continue;
		}

		await git.deleteBranch(branch.name, { force: true });
		deleted.push({ ...branch, keptAliveBy: containing.map(shortRefName) });
		refs.push({ ref: ownRef, restoreTo: current, upstream: branch.upstream });
	}

	if (deleted.length === 0) {
		return { deleted, skipped, notes };
	}

	if (options.record !== false) {
		await safety.record({
			kind: 'branch',
			summary: `Removed ${deleted.length} redundant branch(es): ${deleted.map((b) => `${b.name} (${shorten(b.sha)})`).join(', ')}`,
			// One entry for the whole batch: a single Undo brings all of them back.
			undo: { type: 'refs', refs },
		});
	}
	notes.push('No commit was lost: every deleted branch pointed at history another ref still has.');

	return { deleted, skipped, notes };
}

// ------------------------------------------------------------------- helpers

/** Branches that must never be deleted, whatever the reachability says. */
async function protectedBranchNames(ctx: RepoContext, branches: readonly RefInfo[]): Promise<Set<string>> {
	const { git } = ctx;
	const names = new Set<string>();

	const head = await git.headBranch();
	if (head) {
		names.add(head);
	}
	// A branch checked out in another worktree cannot be deleted by git at all.
	for (const worktree of await git.worktreeList()) {
		if (worktree.branch?.startsWith('refs/heads/')) {
			names.add(worktree.branch.slice('refs/heads/'.length));
		}
	}
	// The default branch is the trunk even when a longer branch contains it.
	const { branch: defaultBranch } = await git.detectDefaultBranch();
	if (defaultBranch && branches.some((branch) => branch.name === defaultBranch)) {
		names.add(defaultBranch);
	}
	return names;
}

async function protectionReason(ctx: RepoContext, branch: RefInfo): Promise<string> {
	if (branch.isHead || (await ctx.git.headBranch()) === branch.name) {
		return 'it is checked out';
	}
	for (const worktree of await ctx.git.worktreeList()) {
		if (worktree.branch === `refs/heads/${branch.name}`) {
			return `it is checked out in ${worktree.path}`;
		}
	}
	return 'it is the default branch';
}

/**
 * Commits that would really be lost: everything on the branch that no *other*
 * surviving ref can reach (branches already marked for deletion do not count).
 */
async function uniqueCommitCount(ctx: RepoContext, branch: string, doomed: ReadonlySet<string>): Promise<number> {
	const ownRef = `refs/heads/${branch}`;
	const others = (await ctx.git.listRefs(HISTORY_REF_PATTERNS))
		.map(fullRefName)
		.filter((name) => name !== ownRef && !doomed.has(name));
	if (others.length === 0) {
		return ctx.git.countCommits(ownRef);
	}
	return (await ctx.git.revList([ownRef, '--not', ...others])).length;
}

async function tipSubject(ctx: RepoContext, sha: string): Promise<string> {
	try {
		return (await ctx.git.commitInfo(sha)).subject;
	} catch {
		return '';
	}
}

function fullRefName(ref: RefInfo): string {
	if (ref.name.startsWith('refs/')) {
		return ref.name;
	}
	switch (ref.kind) {
		case 'branch':
			return `refs/heads/${ref.name}`;
		case 'remote':
			return `refs/remotes/${ref.name}`;
		case 'tag':
			return `refs/tags/${ref.name}`;
		default:
			return ref.name;
	}
}

/** `refs/remotes/origin/main` -> `origin/main`, `refs/tags/v1` -> `tag:v1`. */
export function shortRefName(ref: string): string {
	if (ref.startsWith('refs/heads/')) {
		return ref.slice('refs/heads/'.length);
	}
	if (ref.startsWith('refs/remotes/')) {
		return ref.slice('refs/remotes/'.length);
	}
	if (ref.startsWith('refs/tags/')) {
		return `tag:${ref.slice('refs/tags/'.length)}`;
	}
	return ref;
}
