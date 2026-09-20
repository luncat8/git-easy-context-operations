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
 * Two kinds of branches are looked at:
 *
 *   - **local branches** (`refs/heads/...`) - the original scope of the
 *     command, deleted with `git branch -D`;
 *   - **remote-tracking branches** (`refs/remotes/origin/...`) - a name that a
 *     merge left behind *on the remote* (`origin/fix/x` while `origin/main`
 *     already holds every commit of it) carries nothing either. The local ref
 *     goes either way; the branch on the remote itself is only deleted when the
 *     caller asks for it (`git push <remote> --delete`, i.e. `deleteRemote`),
 *     because that is the one part of this operation that other people see.
 *
 * Safety rails:
 *   - the checked-out branch, branches checked out in another worktree and the
 *     default branch are never offered, however redundant they look;
 *   - on the remote side the same holds for the remote's own default branch
 *     (`origin/main`), for the remote copy of the branch that is checked out
 *     (`origin/<current>`) and for any remote branch a *surviving* local branch
 *     tracks - deleting that would tear the tracking configuration apart. When
 *     the local branch goes in the same batch, its remote branch may go too;
 *   - `refs/geco/` recovery points do **not** count as keeping a branch alive
 *     (they are our own throw-away backups, not history somebody relies on);
 *   - two branches on the same commit keep each other alive, so a duplicate
 *     pair never disappears completely - one of the two always survives;
 *   - every tip is re-verified right before it is deleted (or pushed), so a
 *     scan that went stale (a commit landed meanwhile) cannot delete unique
 *     work;
 *   - the whole batch is **one** journal entry, so a single Undo brings every
 *     branch back, tracking configuration included - and pushes the remote
 *     branches back that were deleted there.
 */
import type { RepoContext } from './context';
import { GecoError } from './errors';
import type { RefInfo } from './git';
import { shorten, type RefRestore, type RemoteRefRestore } from './safety';

/** Refs that can keep a branch alive (our own recovery refs deliberately cannot). */
const HISTORY_REF_PATTERNS = ['refs/heads', 'refs/remotes', 'refs/tags'];
/** Where remote-tracking branches live. */
const REMOTE_REF_PREFIX = 'refs/remotes/';

/** What has to happen on the remote when a remote-tracking branch goes. */
export interface RemoteBranchRef {
	/** The remote the tracking ref belongs to (`origin`). */
	remote: string;
	/** Branch name on that remote (`fix/refresh-committer-date`). */
	branch: string;
	/** Full ref name in the local repository (`refs/remotes/origin/fix/...`). */
	ref: string;
	/**
	 * Local branches whose upstream is this ref. While one of them survives, the
	 * ref is not offered - and a delete that is asked for anyway is refused.
	 */
	trackedBy: string[];
}

export interface RedundantBranch {
	/** Local branch name, or the tracking name (`origin/fix/x`) for a remote branch. */
	name: string;
	sha: string;
	/** Subject of the tip commit, for the report. */
	subject: string;
	upstream?: string;
	/** The refs that already contain this tip - the reason deleting it is a no-op. */
	keptAliveBy: string[];
	/** Set when this is a remote-tracking branch (see {@link RemoteBranchRef}). */
	remote?: RemoteBranchRef;
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
	/** Local branches first, then remote-tracking branches. */
	redundant: RedundantBranch[];
	kept: KeptBranch[];
	/** Total number of local branches looked at. */
	branchCount: number;
	/** Total number of remote-tracking branches looked at. */
	remoteCount: number;
}

/**
 * Which local and remote-tracking branches carry no commit of their own.
 *
 * Local branches are resolved first, greedily: branches we would rather drop
 * (no upstream first, then alphabetically) are considered first, and a branch
 * already marked for deletion no longer counts as a keeper for the next one.
 * The remote-tracking branches are resolved afterwards against that same set,
 * so a remote branch is only offered when something *outside* the batch holds
 * its commits.
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

	const remoteCandidates = await redundantRemoteBranches(ctx, branches, doomed);
	redundant.push(...remoteCandidates);

	// Report only the refs that actually survive the batch: a branch scanned
	// early can be held by one that is deleted later, and naming it would make
	// the reason look like it disappears with the branch. The filtered list is
	// never empty - whatever kept a doomed keeper alive also contains this tip.
	// `keptAliveBy` holds short names, so all three spellings are checked.
	const doomedName = (name: string) => doomed.has(name) || doomed.has(`refs/heads/${name}`) || doomed.has(`${REMOTE_REF_PREFIX}${name}`);
	for (const branch of redundant) {
		const survivors = branch.keptAliveBy.filter((name) => !doomedName(name));
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

	const remoteCount = (await git.listRefs(['refs/remotes'])).filter((ref) => !ref.name.endsWith('/HEAD')).length;
	return { redundant, kept: kept.sort((a, b) => a.name.localeCompare(b.name)), branchCount: branches.length, remoteCount };
}

/**
 * The remote-tracking branches that carry no commit of their own.
 *
 * Besides the plain reachability test every remote branch has to pass the
 * "nobody is using this name" check above - a remote branch a surviving local
 * branch tracks is not a candidate, and neither is the remote's trunk
 * (`origin/main`) or the remote copy of the branch the user is on.
 */
async function redundantRemoteBranches(
	ctx: RepoContext,
	branches: readonly RefInfo[],
	doomed: Set<string>,
): Promise<RedundantBranch[]> {
	const { git } = ctx;
	const remotes = await git.remotes();
	const defaultBranch = (await git.detectDefaultBranch()).branch;
	const head = await git.headBranch();
	const refs = await git.listRefs(['refs/remotes']);
	const trackedBy = trackersByRef(branches, refs);
	const out: RedundantBranch[] = [];

	for (const ref of refs) {
		const name = ref.name;
		if (name.endsWith('/HEAD')) {
			continue;
		}
		const full = `${REMOTE_REF_PREFIX}${name}`;
		const parsed = parseRemoteRef(name, remotes);
		if (!parsed) {
			continue;
		}
		// The trunk of a remote and the remote copy of the checked out branch:
		// never offered, whatever the reachability says.
		if (defaultBranch && parsed.branch === defaultBranch) {
			continue;
		}
		if (head && parsed.branch === head) {
			continue;
		}
		// In use: a local branch that is not going anywhere tracks this name.
		const tracking = trackedBy.get(full) ?? [];
		if (tracking.some((branch) => !doomed.has(`refs/heads/${branch}`))) {
			continue;
		}
		const containing = await git.listRefs(HISTORY_REF_PATTERNS, { contains: ref.sha });
		const keepers = containing
			.map((candidate) => fullRefName(candidate))
			.filter((keeper) => keeper !== full && !doomed.has(keeper));
		if (keepers.length === 0) {
			continue;
		}
		doomed.add(full);
		out.push({
			name,
			sha: ref.sha,
			subject: await tipSubject(ctx, ref.sha),
			keptAliveBy: keepers.map(shortRefName),
			remote: { remote: parsed.remote, branch: parsed.branch, ref: full, trackedBy: tracking },
		});
	}
	return out;
}

export interface DeleteRedundantBranchesOptions {
	/** `false` skips the journal entry (used by callers that record their own). */
	record?: boolean;
	/**
	 * Also delete the branch on the remote (`git push <remote> --delete`) instead
	 * of only removing the local tracking ref. Only meaningful for
	 * remote-tracking branches; remote branches are never touched otherwise.
	 */
	deleteRemote?: boolean;
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
	options: DeleteRedundantBranchesOptions = {},
): Promise<DeleteRedundantBranchesResult> {
	const { git, safety } = ctx;
	await git.requireRepository();

	if (branches.length === 0) {
		throw new GecoError('nothing-to-do', 'No branches were selected.');
	}

	const protectedNames = await protectedBranchNames(ctx, await git.branches());
	const batch = new Set(branches.map((branch) => (branch.remote ? branch.remote.ref : `refs/heads/${branch.name}`)));
	const deleted: RedundantBranch[] = [];
	const skipped: { name: string; reason: string }[] = [];
	const notes: string[] = [];
	const refs: RefRestore[] = [];
	const remoteRefs: RemoteRefRestore[] = [];
	let deletedOnRemote = 0;

	for (const branch of branches) {
		if (branch.remote) {
			const result = await deleteRemoteBranch(ctx, branch, {
				deleteRemote: options.deleteRemote === true,
				batch,
				alreadyGone: refs,
			});
			if (!result.ok) {
				skipped.push({ name: branch.name, reason: result.reason });
				continue;
			}
			deleted.push({ ...branch, keptAliveBy: result.keptAliveBy });
			refs.push({ ref: branch.remote.ref, restoreTo: result.sha });
			if (options.deleteRemote) {
				remoteRefs.push({ remote: branch.remote.remote, branch: branch.remote.branch, restoreTo: result.sha });
				deletedOnRemote += 1;
			}
			continue;
		}

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

	if (deletedOnRemote > 0) {
		notes.push(
			deletedOnRemote === 1
				? 'The remote branch was deleted on the remote too (git push --delete); Undo pushes it back.'
				: `${deletedOnRemote} remote branches were deleted on their remotes too (git push --delete); Undo pushes them back.`,
		);
	} else if (deleted.some((branch) => branch.remote)) {
		notes.push('Only the local remote-tracking refs were removed - the branches on the remote are untouched.');
	}
	if (deleted.some((branch) => !branch.remote)) {
		notes.push('No commit was lost: every deleted branch pointed at history another ref still has.');
	}

	if (options.record !== false) {
		await safety.record({
			kind: 'branch',
			summary: `Removed ${deleted.length} redundant branch(es): ${deleted.map((b) => `${b.name} (${shorten(b.sha)})`).join(', ')}`,
			// One entry for the whole batch: a single Undo brings all of them back.
			undo: { type: 'refs', refs, remoteRefs },
		});
	}

	return { deleted, skipped, notes };
}

// ------------------------------------------------------------------- helpers

/**
 * One remote-tracking branch. Everything is re-verified here (existence, tip,
 * tracking, reachability), so nothing but a stale scan can get this far.
 */
async function deleteRemoteBranch(
	ctx: RepoContext,
	branch: RedundantBranch,
	options: { deleteRemote: boolean; batch: ReadonlySet<string>; alreadyGone: readonly RefRestore[] },
): Promise<{ ok: true; sha: string; keptAliveBy: string[] } | { ok: false; reason: string }> {
	const { git } = ctx;
	const { remote, branch: remoteBranch, ref, trackedBy } = branch.remote!;

	const survivingTracker = trackedBy.find((name) => !options.batch.has(`refs/heads/${name}`));
	if (survivingTracker) {
		return { ok: false, reason: `the local branch "${survivingTracker}" still tracks it` };
	}

	const current = await git.revParse(ref);
	if (!current) {
		return { ok: false, reason: 'it no longer exists' };
	}
	if (current !== branch.sha) {
		return { ok: false, reason: `it moved to ${shorten(current)} since the scan` };
	}
	const containing = (await git.listRefs(HISTORY_REF_PATTERNS, { contains: current }))
		.map(fullRefName)
		.filter((name) => name !== ref && !options.alreadyGone.some((restore) => restore.ref === name));
	if (containing.length === 0) {
		return { ok: false, reason: 'it now has commits no other ref has' };
	}

	if (options.deleteRemote) {
		// The lease keeps a colleague's push from being deleted with it: the
		// remote refuses when the branch no longer points where the scan saw it.
		const result = await git.push([
			remote,
			'--delete',
			remoteBranch,
			`--force-with-lease=refs/heads/${remoteBranch}:${current}`,
		]);
		if (result.exitCode !== 0) {
			return { ok: false, reason: `the remote refused it: ${firstLine(result.stderr, result.stdout, String(result.exitCode))}` };
		}
		// A successful push-delete takes the local tracking ref with it. Should
		// an unusual setup leave it behind, drop it explicitly.
		if (await git.revParse(ref)) {
			await git.deleteRef(ref, { oldValue: current });
		}
	} else {
		await git.deleteRef(ref, { oldValue: current });
	}
	return { ok: true, sha: current, keptAliveBy: containing.map(shortRefName) };
}

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

/**
 * Which remote a tracking ref belongs to. The configured remotes are matched
 * longest first, so a remote whose name contains a slash still wins over the
 * first slash of the ref.
 */
function parseRemoteRef(name: string, remotes: readonly string[]): { remote: string; branch: string } | undefined {
	for (const remote of [...remotes].sort((a, b) => b.length - a.length)) {
		if (remote && name.startsWith(`${remote}/`)) {
			const branch = name.slice(remote.length + 1);
			if (branch) {
				return { remote, branch };
			}
		}
	}
	const slash = name.indexOf('/');
	if (slash <= 0 || slash === name.length - 1) {
		return undefined;
	}
	return { remote: name.slice(0, slash), branch: name.slice(slash + 1) };
}

/** Full ref name -> the local branches whose upstream it is. */
function trackersByRef(branches: readonly RefInfo[], remoteRefs: readonly RefInfo[]): Map<string, string[]> {
	const known = new Set(remoteRefs.map((ref) => ref.name));
	const map = new Map<string, string[]>();
	for (const branch of branches) {
		if (!branch.upstream || !known.has(branch.upstream)) {
			continue;
		}
		const ref = `${REMOTE_REF_PREFIX}${branch.upstream}`;
		map.set(ref, [...(map.get(ref) ?? []), branch.name]);
	}
	return map;
}

async function tipSubject(ctx: RepoContext, sha: string): Promise<string> {
	try {
		return (await ctx.git.commitInfo(sha)).subject;
	} catch {
		return '';
	}
}

function firstLine(...candidates: string[]): string {
	for (const candidate of candidates) {
		const line = candidate.trim().split('\n')[0]?.replace(/\x1b\[[0-9;]*m/g, '').trim();
		if (line) {
			return line;
		}
	}
	return 'push refused';
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
