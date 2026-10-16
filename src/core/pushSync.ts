/**
 * "Why can I not push or sync?" - the diagnosis behind
 * *Git Easy Ops: Diagnose Push / Sync Trouble...*
 *
 * VS Code's **Sync** button does two things in a row: `git pull` (merge or
 * rebase, depending on the user's setting) and then `git push`. That means a
 * repository can end up in a state where *both* buttons stop working, and the
 * error messages point at git plumbing rather than at the cause. The states
 * that do this are rare, are not caused by the extension, and are almost
 * always one of these:
 *
 *   1. **An unfinished operation.** A pull/merge/rebase/cherry-pick stopped on
 *      a conflict and was never finished. `git push` is refused, `git pull`
 *      refuses to start ("You have not concluded your merge (MERGE_HEAD
 *      exists)"), and the worktree carries conflict markers. A lost network
 *      connection can *start* this (the fetch half of a sync dies, the merge
 *      half never runs), but the state itself comes from the interrupted merge.
 *   2. **The same work committed twice.** A commit was made locally *and* the
 *      same change arrived on the remote from another clone, another session or
 *      a web edit. The trees can be byte-identical while the commit hashes
 *      differ, so `git push` is rejected as non-fast-forward. Nothing is
 *      unique - but "Sync" then merges the remote copy back in, which either
 *      duplicates the work or (when the file was edited on both sides) stops
 *      half-way with a conflict: state 1.
 *   3. **A rewritten branch the remote still has.** After a reword, a squash,
 *      "Clean History" or a forced move, the local branch no longer descends
 *      from the remote copy; the extension says "a force push is needed" and
 *      the *Sync* button instead merges the old history back in - resurrecting
 *      the commits the rewrite removed.
 *   4. **A stale lock.** A killed git process (network timeout, VS Code
 *      reloaded mid-operation) can leave `index.lock` behind. Every operation
 *      that writes the index then fails with "Another git process seems to be
 *      running in this repository".
 *   5. **A missing upstream.** The branch was never published, or the branch it
 *      tracks was deleted/renamed on the server. Sync has nothing to sync.
 *
 * This module recognizes all five from the repository itself (plus an optional
 * `git fetch` when the user asks for it), and repairs the ones that have a
 * safe repair:
 *
 *   - abort an unfinished merge/rebase/cherry-pick/revert/am;
 *   - remove a stale lock file (confirmed by the caller, never automatically);
 *   - rebase the local commits onto the remote copy - the patch-equivalent
 *     ones are dropped by git itself, so the duplicate work disappears
 *     instead of being merged in;
 *   - move the branch onto the remote copy when *nothing* local is unique
 *     (the old tip is parked on a backup branch first, exactly like
 *     "Fast-Forward Default Branch");
 *   - fetch (the one network call, with a short timeout, so "the connection is
 *     down" is a statement and not a hang);
 *   - publish the branch (`git push -u`), which also sets the upstream.
 *
 * Everything that changes a ref is journaled, so one Undo puts it back.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { RepoContext } from './context';
import { GecoError } from './errors';
import { fastForwardBranch, type FastForwardResult } from './fastForward';
import { shorten } from './safety';

/** An operation git left half-finished (the marker file is the proof). */
export type UnfinishedKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'am' | 'bisect';

export interface UnfinishedOperation {
	kind: UnfinishedKind;
	/** How a human should name it ("merge", "rebase -i", ...). */
	label: string;
	/** The marker inside the git dir, relative to it (`MERGE_HEAD`). */
	marker: string;
	/** Arguments that abort it (`['merge', '--abort']`). */
	abortArgs: string[];
	/** What git was doing, in one line. */
	detail: string;
}

export interface LockFile {
	path: string;
	/** File name, e.g. `index.lock`. */
	name: string;
	/** Age in milliseconds - a *stale* lock is the one nobody is holding. */
	ageMs: number;
}

/** One commit on the local branch that the upstream does not have. */
export interface LocalOnlyCommit {
	sha: string;
	shortSha: string;
	subject: string;
	/**
	 * True when the exact same change is already on the upstream side under a
	 * different hash (`git cherry`): the commit is redundant, not unique work.
	 */
	alreadyThere: boolean;
	/** The upstream commit carrying that same change, when it was found. */
	equivalentTo?: string;
	/** True when the two commits' trees are byte-identical (not just the patch). */
	identicalContent?: boolean;
}

export interface UpstreamState {
	remote: string;
	branch: string;
	/** Short form for humans: `origin/main`. */
	ref: string;
	/** The tracking ref itself: `refs/remotes/origin/main`. */
	fullRef: string;
	/** Missing when the remote-tracking ref is gone (deleted on the server). */
	sha?: string;
}

export interface SyncState {
	branch: string;
	head: string;
	/** Where the branch points on the last known state of the remote. */
	upstream: UpstreamState;
	/** Commits the upstream adds (`git pull` would bring them in). */
	behind: number;
	/** Commits the branch adds (`git push` publishes them). */
	ahead: number;
	localOnly: LocalOnlyCommit[];
	/** Local-only commits whose change is already on the upstream. */
	duplicates: LocalOnlyCommit[];
	/** Local-only commits that would really be new on the upstream. */
	unique: LocalOnlyCommit[];
	/** Merge commits on the local side (never patch-equivalent). */
	mergeCommitsAhead: number;
}

export type FindingSeverity = 'blocker' | 'attention' | 'info';

export type FindingId =
	| 'unfinished-operation'
	| 'conflict'
	| 'lock-file'
	| 'detached-head'
	| 'no-remote'
	| 'no-upstream'
	| 'upstream-missing'
	| 'diverged-duplicates'
	| 'diverged-unique'
	| 'behind'
	| 'ahead'
	| 'in-sync';

export interface PushSyncFinding {
	id: FindingId;
	severity: FindingSeverity;
	/** One line for the notification. */
	headline: string;
	/** Detail lines for the output channel. */
	lines: string[];
}

/** A repair the flow may offer. Every one of them is save-by-construction. */
export type PushSyncRepair =
	| 'abort-operation'
	| 'remove-lock'
	| 'rebase-onto-upstream'
	| 'move-onto-upstream'
	| 'force-push'
	| 'fetch'
	| 'publish';

export interface PushSyncReport {
	cwd: string;
	/** The checked out branch, `undefined` for a detached HEAD. */
	branch?: string;
	head: string;
	detached: boolean;
	unfinished: UnfinishedOperation[];
	conflicts: string[];
	locks: LockFile[];
	remotes: string[];
	sync?: SyncState;
	findings: PushSyncFinding[];
	repairs: PushSyncRepair[];
	/** One-line answer to "why can I not push or sync?". */
	verdict: string;
	/** True when nothing would stop a push or a sync right now. */
	clean: boolean;
}

export interface InspectOptions {
	/** Cap for the local-only commits that are read and compared (default 50). */
	commitLimit?: number;
}

/** `index.lock` and friends: what a killed git process leaves behind. */
const LOCK_NAMES = ['index.lock', 'HEAD.lock', 'config.lock', 'packed-refs.lock', 'shallow.lock'];

/**
 * The marker files of an interrupted operation. `rebase-apply` serves both
 * `git am` and the old apply-based rebase; the file inside tells them apart.
 */
const OPERATION_MARKERS: readonly { kind: UnfinishedKind; label: string; marker: string; abortArgs: string[]; detail: string }[] = [
	{ kind: 'merge', label: 'merge', marker: 'MERGE_HEAD', abortArgs: ['merge', '--abort'], detail: 'A merge (usually the first half of "Sync"/"git pull") stopped before the merge commit was made.' },
	{ kind: 'rebase', label: 'rebase', marker: 'rebase-merge', abortArgs: ['rebase', '--abort'], detail: 'An interactive rebase is waiting for the next step or for a conflict to be resolved.' },
	{ kind: 'rebase', label: 'rebase', marker: 'rebase-apply/rebasing', abortArgs: ['rebase', '--abort'], detail: 'A rebase is waiting for the next step or for a conflict to be resolved.' },
	{ kind: 'am', label: 'patch application (git am)', marker: 'rebase-apply/applying', abortArgs: ['am', '--abort'], detail: 'A patch stopped in the middle of being applied.' },
	{ kind: 'am', label: 'patch application (git am)', marker: 'rebase-apply', abortArgs: ['am', '--abort'], detail: 'A patch stopped in the middle of being applied.' },
	{ kind: 'cherry-pick', label: 'cherry-pick', marker: 'CHERRY_PICK_HEAD', abortArgs: ['cherry-pick', '--abort'], detail: 'A cherry-pick stopped before committing (usually a conflict).' },
	{ kind: 'revert', label: 'revert', marker: 'REVERT_HEAD', abortArgs: ['revert', '--abort'], detail: 'A revert stopped before committing (usually a conflict).' },
	{ kind: 'bisect', label: 'bisect', marker: 'BISECT_LOG', abortArgs: ['bisect', 'reset'], detail: 'A bisect session is still running; it changes which commit HEAD points at.' },
];

// ------------------------------------------------------------------ inspection

/**
 * Read the repository and answer "would push / sync work, and if not, why?".
 * Never writes anything - the repairs below are separate, explicit steps.
 */
export async function inspectPushSync(ctx: RepoContext, options: InspectOptions = {}): Promise<PushSyncReport> {
	const { git } = ctx;
	await git.requireRepository();
	const limit = options.commitLimit ?? 50;

	const branch = await git.headBranch();
	const head = (await git.revParse('HEAD')) ?? '';
	const unfinished = await findUnfinishedOperations(ctx);
	const conflicts = await git.conflictedPaths();
	const locks = await findLockFiles(ctx);
	const remotes = await git.remotes();

	const findings: PushSyncFinding[] = [];
	const repairs: PushSyncRepair[] = [];

	for (const operation of unfinished) {
		findings.push({
			id: 'unfinished-operation',
			severity: 'blocker',
			headline: `An unfinished ${operation.label} blocks push and sync.`,
			lines: [
				`${operation.detail} (marker: ${operation.marker})`,
				'Neither button gets past it: the push is refused while it is in progress, and the Sync button starts with a pull - which refuses too ("You have not concluded your merge (MERGE_HEAD exists)" for a merge).',
				`Finish it by hand, or abort it with: git ${operation.abortArgs.join(' ')}`,
			],
		});
		repairs.push('abort-operation');
	}
	if (conflicts.length > 0) {
		findings.push({
			id: 'conflict',
			severity: unfinished.length > 0 ? 'attention' : 'blocker',
			headline: `${conflicts.length} file${conflicts.length === 1 ? ' still has' : 's still have'} conflict markers.`,
			lines: [
				...conflicts.slice(0, 10).map((file) => `  ${file}`),
				conflicts.length > 10 ? `  ... and ${conflicts.length - 10} more` : '',
				unfinished.length === 0
					? 'The conflict is staged but not committed - a push is refused until the merge/rebase is concluded.'
					: 'Resolving means editing the file and committing (or `git add` + `git rebase --continue`).',
			].filter(Boolean),
		});
	}
	for (const lock of locks) {
		findings.push({
			id: 'lock-file',
			severity: 'blocker',
			headline: `${lock.name} is left over in the git directory (${formatAge(lock.ageMs)} old).`,
			lines: [
				`${lock.path}`,
				'Every operation that writes the index fails while it exists: "fatal: Unable to create index.lock: File exists. Another git process seems to be running in this repository".',
				'If no git or VS Code operation is running, it is stale - a killed git process (network timeout, VS Code reloaded) never got to delete it.',
			],
		});
		repairs.push('remove-lock');
	}

	if (!branch) {
		findings.push({
			id: 'detached-head',
			severity: 'attention',
			headline: 'HEAD is detached, so there is no branch to push or sync.',
			lines: [`HEAD is at ${shorten(head)}.`, 'Check out a branch first ("Git Easy Ops: Check Out Branch...").'],
		});
	}

	let sync: SyncState | undefined;
	if (branch) {
		const upstream = await git.upstream(branch);
		const localSha = await git.revParse(`refs/heads/${branch}`);

		if (!upstream) {
			if (remotes.length === 0) {
				findings.push({
					id: 'no-remote',
					severity: 'info',
					headline: 'This repository has no remote, so there is nothing to push to.',
					lines: ['Add one with `git remote add origin <url>`, then publish the branch.'],
				});
			} else {
				findings.push({
					id: 'no-upstream',
					severity: 'attention',
					headline: `"${branch}" has no upstream branch, so Sync does not know where to push it.`,
					lines: [
						`Known remotes: ${remotes.join(', ')}.`,
						`Publish it with: git push -u ${remotes[0]} ${branch}`,
					],
				});
				repairs.push('publish');
			}
		} else if (!upstream.sha) {
			findings.push({
				id: 'upstream-missing',
				severity: 'attention',
				headline: `"${branch}" tracks ${upstream.remote}/${upstream.branch}, but that branch is gone from the last fetch.`,
				lines: [
					'It was deleted or renamed on the server (or the fetch that would have told us did not run).',
					'Push and Sync fail against a tracking ref that does not exist; a fetch shows the truth.',
				],
			});
			repairs.push('fetch', 'publish');
		} else {
			const upstreamRef = `${upstream.remote}/${upstream.branch}`;
			const upstreamSha = upstream.sha;
			sync = await analyzeSync(ctx, {
				branch,
				head: localSha ?? head,
				upstream: { remote: upstream.remote, branch: upstream.branch, ref: upstreamRef, fullRef: upstream.ref, sha: upstreamSha },
				limit,
			});
			if (sync.behind > 0 && sync.ahead > 0) {
				const duplicateCount = sync.duplicates.length;
				findings.push({
					id: duplicateCount > 0 ? 'diverged-duplicates' : 'diverged-unique',
					severity: sync.unique.length > 0 ? 'blocker' : 'attention',
					headline: duplicateCount > 0
						? `"${branch}" has duplicate commits: the same work is already on ${upstreamRef} under different hashes.`
						: `"${branch}" and ${upstreamRef} have both moved on: a plain push is rejected (non-fast-forward).`,
					lines: [
						`${branch} is ${sync.ahead} commit${sync.ahead === 1 ? '' : 's'} ahead and ${sync.behind} commit${sync.behind === 1 ? '' : 's'} behind ${upstreamRef}.`,
						...describeLocalOnly(sync.localOnly, upstreamRef),
						...syncHint(sync),
					],
				});
			} else if (sync.behind > 0) {
				findings.push({
					id: 'behind',
					severity: 'info',
					headline: `"${branch}" is ${sync.behind} commit${sync.behind === 1 ? '' : 's'} behind ${upstreamRef}; Sync fast-forwards it.`,
					lines: [`Nothing local would be lost - this is the case the Sync button handles well.`],
				});
			} else if (sync.ahead > 0) {
				findings.push({
					id: 'ahead',
					severity: 'info',
					headline: `"${branch}" is ${sync.ahead} commit${sync.ahead === 1 ? '' : 's'} ahead; a normal push publishes them.`,
					lines: [`${upstreamRef} does not have anything you do not have, so no force push is needed.`],
				});
			} else {
				findings.push({
					id: 'in-sync',
					severity: 'info',
					headline: `"${branch}" is in step with ${upstreamRef}.`,
					lines: ['A push would say "Everything up-to-date".'],
				});
			}
		}

		if (sync) {
			if (sync.behind > 0 && sync.localOnly.length > 0) {
				repairs.push('rebase-onto-upstream');
			}
			if (sync.behind > 0 && sync.localOnly.length > 0 && sync.unique.length === 0) {
				repairs.push('move-onto-upstream');
			}
			if (sync.behind > 0 && sync.unique.length > 0) {
				repairs.push('force-push');
			}
		}
		// The fetch is only *offered* while there is something to check - in a
		// repository that is in step with its remote it would be a picker with a
		// single pointless entry. It is still the honest answer to "is the
		// network down, or did the history really diverge?".
		if (remotes.length > 0 && findings.some((finding) => finding.severity !== 'info')) {
			repairs.push('fetch');
		}
	}

	// "Clean" means: press Sync now and it does the right thing. A blocker stops
	// it outright, and an attention-worthy finding (no upstream, a missing
	// tracking branch, a duplicate commit) is a state Sync handles the wrong way
	// - exactly the states this command exists for.
	const clean = findings.every((finding) => finding.severity === 'info');
	return {
		cwd: ctx.cwd,
		branch,
		head,
		detached: !branch,
		unfinished,
		conflicts,
		locks,
		remotes,
		sync,
		findings,
		repairs: [...new Set(repairs)],
		verdict: verdictFor({ branch, findings, sync }),
		clean,
	};
}

function verdictFor(input: { branch?: string; findings: readonly PushSyncFinding[]; sync?: SyncState }): string {
	const blocker = input.findings.find((finding) => finding.severity === 'blocker');
	if (blocker) {
		return `Push and sync are blocked: ${blocker.headline}`;
	}
	const diverged = input.findings.find((finding) => finding.id === 'diverged-duplicates' || finding.id === 'diverged-unique');
	if (diverged) {
		return `A plain push is rejected (non-fast-forward): ${diverged.headline}`;
	}
	const attention = input.findings.find((finding) => finding.severity === 'attention');
	if (attention) {
		return attention.headline;
	}
	if (input.sync && input.sync.behind > 0) {
		return `Nothing blocks you: ${input.branch} is ${input.sync.behind} commit(s) behind - a pull (Sync) fast-forwards it.`;
	}
	return `No push/sync blockers found${input.branch ? `: "${input.branch}" is in step with its remote` : ''}.`;
}

async function findUnfinishedOperations(ctx: RepoContext): Promise<UnfinishedOperation[]> {
	const { git } = ctx;
	const found: UnfinishedOperation[] = [];
	const seen = new Set<UnfinishedKind>();
	// One git call resolves every marker path (previously one
	// `rev-parse --git-path` per marker) - this runs before almost every
	// command through `assertStartable`.
	const paths = await git.gitPaths(OPERATION_MARKERS.map((marker) => marker.marker));
	const exists = (name: string) => pathExists(paths.get(name) ?? '');
	for (const marker of OPERATION_MARKERS) {
		if (seen.has(marker.kind)) {
			continue;
		}
		if (!(await exists(marker.marker))) {
			continue;
		}
		// `rebase-apply` alone is an am; the specific files inside it were
		// already checked above, so the generic marker only fires for a rebase
		// directory whose flavour file is missing (an old git wrote neither).
		if (marker.marker === 'rebase-apply') {
			const rebasing = await exists('rebase-apply/rebasing');
			const applying = await exists('rebase-apply/applying');
			if (rebasing || applying) {
				continue;
			}
		}
		seen.add(marker.kind);
		found.push({ kind: marker.kind, label: marker.label, marker: marker.marker, abortArgs: marker.abortArgs, detail: marker.detail });
	}
	return found;
}

async function findLockFiles(ctx: RepoContext): Promise<LockFile[]> {
	const { git } = ctx;
	const locks: LockFile[] = [];
	const now = Date.now();
	const paths = await git.gitPaths(LOCK_NAMES);
	for (const name of LOCK_NAMES) {
		const target = paths.get(name);
		if (!target) {
			continue;
		}
		try {
			const stat = await fsp.stat(target);
			locks.push({ path: target, name: path.basename(target), ageMs: Math.max(0, now - stat.mtimeMs) });
		} catch {
			// No lock - the normal case.
		}
	}
	return locks;
}

async function analyzeSync(
	ctx: RepoContext,
	input: { branch: string; head: string; upstream: UpstreamState & { sha: string }; limit: number },
): Promise<SyncState> {
	const { git } = ctx;
	const { branch, head, upstream, limit } = input;
	const upstreamSha = upstream.sha;

	const counts = await git.counts(upstreamSha, head);
	const localShas = await git.revList([`${upstreamSha}..${head}`, '--no-merges', `--max-count=${limit}`]);
	const remoteShas = await git.revList([`${head}..${upstreamSha}`, '--no-merges', `--max-count=${limit}`]);

	// Which local commits are patch-equivalent to one on the upstream side.
	const cherry = await git.cherry(upstreamSha, head);
	const alreadyThere = new Set(cherry.filter((entry) => entry.alreadyThere).map((entry) => entry.sha));

	// The counterpart of a duplicated commit: the remote commit with the same
	// patch id (the same edit, a different hash). Only computed when a duplicate
	// candidate exists at all - `git cherry` is the cheap first pass. When it
	// does, both sides are hashed together in two git processes instead of two
	// per commit.
	const duplicates = localShas.filter((sha) => alreadyThere.has(sha));
	const patchIdsBySha = duplicates.length > 0
		? await git.patchIdsOfCommits([...remoteShas, ...duplicates])
		: new Map<string, string>();
	const remoteByPatchId = new Map<string, string>();
	for (const sha of remoteShas) {
		const patchId = patchIdsBySha.get(sha);
		if (patchId) {
			remoteByPatchId.set(patchId, sha);
		}
	}

	const localOnly: LocalOnlyCommit[] = [];
	for (const sha of localShas) {
		const info = await git.commitInfo(sha);
		const isDuplicate = alreadyThere.has(sha);
		const entry: LocalOnlyCommit = { sha, shortSha: info.shortSha, subject: info.subject, alreadyThere: isDuplicate };
		if (isDuplicate) {
			const patchId = patchIdsBySha.get(sha);
			const counterpart = patchId ? remoteByPatchId.get(patchId) : undefined;
			if (counterpart) {
				entry.equivalentTo = counterpart;
				entry.identicalContent = (await git.treeOf(sha)) === (await git.treeOf(counterpart));
			}
		}
		localOnly.push(entry);
	}

	const merges = await git.countCommits(`${upstreamSha}..${head}`);
	return {
		branch,
		head,
		upstream: { remote: upstream.remote, branch: upstream.branch, ref: upstream.ref, fullRef: upstream.fullRef, sha: upstreamSha },
		behind: counts.left,
		ahead: counts.right,
		localOnly,
		duplicates: localOnly.filter((commit) => commit.alreadyThere),
		unique: localOnly.filter((commit) => !commit.alreadyThere),
		mergeCommitsAhead: Math.max(0, merges - localShas.length),
	};
}

function describeLocalOnly(commits: readonly LocalOnlyCommit[], upstreamRef: string): string[] {
	const lines: string[] = [];
	const duplicates = commits.filter((commit) => commit.alreadyThere);
	for (const commit of duplicates) {
		const counterpart = commit.equivalentTo ? ` = ${shorten(commit.equivalentTo)} on ${upstreamRef}` : ` (already on ${upstreamRef})`;
		lines.push(`  ${commit.shortSha} ${commit.subject}${counterpart}${commit.identicalContent ? ' (identical content)' : ''}`);
	}
	for (const commit of commits.filter((c) => !c.alreadyThere)) {
		lines.push(`  ${commit.shortSha} ${commit.subject}  (new - ${upstreamRef} does not have it)`);
	}
	return lines;
}

/** Why the naive reaction ("press Sync") makes it worse. */
function syncHint(sync: SyncState): string[] {
	if (sync.duplicates.length > 0) {
		return [
			'',
			`Sync would run "git pull" first: it *merges* ${sync.upstream.ref} into ${sync.branch}, folds the already-present copy back in as a second commit, and pushes that - duplicate history instead of a clean branch. When the same file was also edited on the other side, the merge stops with a conflict and the repository is left unfinished (MERGE_HEAD) - after that neither push nor sync works.`,
			'Rebasing onto the remote copy drops the duplicates: git recognizes them as already applied. Nothing unique is lost when every local commit is one of them.',
		];
	}
	return [
		'',
		`The remote has commits the local branch does not. "Sync" merges them back in (or rebases, depending on git.pullRebase) - with a rewrite in ${sync.branch} that either resurrects the old commits or stops with a conflict. That is the half-finished state this command exists to get out of.`,
	];
}

/** How a repair is named in the report (the ids are internal). */
export const REPAIR_LABELS: Readonly<Record<PushSyncRepair, string>> = {
	'abort-operation': 'abort the unfinished operation',
	'remove-lock': 'remove the lock file',
	'rebase-onto-upstream': 'rebase the local commits onto the remote copy',
	'move-onto-upstream': 'point the branch at the remote copy (nothing local is unique)',
	'force-push': 'force push with lease',
	fetch: 'fetch the remote and check again',
	publish: 'publish the branch (git push -u)',
};

/** The text block that goes to the output channel. */
export function formatPushSyncReport(report: PushSyncReport): string {
	const lines: string[] = [
		`Push / sync diagnosis for ${report.cwd}`,
		`  HEAD: ${report.detached ? `detached at ${shorten(report.head)}` : `${report.branch} (${shorten(report.head)})`}`,
	];
	if (report.sync) {
		const { sync } = report;
		lines.push(`  upstream: ${sync.upstream.ref} (${shorten(sync.upstream.sha ?? '')}) - ahead ${sync.ahead}, behind ${sync.behind}`);
	} else if (report.remotes.length > 0) {
		lines.push(`  remotes: ${report.remotes.join(', ')}`);
	}
	if (report.unfinished.length > 0) {
		lines.push(`  unfinished: ${report.unfinished.map((operation) => `${operation.label} (${operation.marker})`).join(', ')}`);
	}
	if (report.conflicts.length > 0) {
		lines.push(`  conflicts: ${report.conflicts.join(', ')}`);
	}
	if (report.locks.length > 0) {
		lines.push(`  lock files: ${report.locks.map((lock) => `${lock.name} (${formatAge(lock.ageMs)} old)`).join(', ')}`);
	}
	lines.push('');
	for (const finding of report.findings) {
		const tag = finding.severity === 'blocker' ? 'BLOCKER' : finding.severity === 'attention' ? 'PROBLEM' : 'OK';
		lines.push(`[${tag}] ${finding.headline}`);
		for (const line of finding.lines) {
			lines.push(line === '' ? '' : `    ${line}`);
		}
		lines.push('');
	}
	lines.push(`Verdict: ${report.verdict}`);
	if (report.repairs.length > 0) {
		lines.push(`Offered repairs: ${report.repairs.map((repair) => REPAIR_LABELS[repair]).join('; ')}`);
	}
	return lines.join('\n');
}

export function formatAge(ageMs: number): string {
	const seconds = Math.round(ageMs / 1000);
	if (seconds < 90) {
		return `${seconds}s`;
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 90) {
		return `${minutes} min`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 48) {
		return `${hours} h`;
	}
	return `${Math.round(hours / 24)} d`;
}

// --------------------------------------------------------------------- repairs

export interface AbortResult {
	operation: UnfinishedOperation;
	headBefore: string;
	message: string;
}

/**
 * Undo the half-finished operation: `git merge --abort` and friends. The
 * commits that were already made are untouched (an abort puts the branch back
 * where the operation started), the conflict edits are dropped.
 */
export async function abortUnfinished(ctx: RepoContext, operation: UnfinishedOperation): Promise<AbortResult> {
	const { git, safety } = ctx;
	await git.requireRepository();
	const headBefore = (await git.revParse('HEAD')) ?? '';
	const branch = await git.headBranch();
	const branchBefore = branch ? await git.revParse(`refs/heads/${branch}`) : undefined;

	const result = await git.run(operation.abortArgs, { env: { GIT_EDITOR: 'true' }, timeoutMs: 120_000 });
	if (result.exitCode !== 0) {
		throw new GecoError(
			'git-failed',
			`Could not abort the unfinished ${operation.label}.`,
			[result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n'),
		);
	}

	const headAfter = (await git.revParse('HEAD')) ?? '';
	await safety.record({
		kind: 'branch',
		summary: `Aborted the unfinished ${operation.label} (HEAD ${shorten(headBefore)} -> ${shorten(headAfter)})`,
		// An abort cannot be recreated: the conflicted state and the marker are
		// gone. Nothing is lost either - the commits stay in the reflog, and the
		// pointer is back where the operation started.
		undo: { type: 'none', hint: `The ${operation.label} was aborted; the commits it worked on are still in the reflog (git reflog).` },
	});

	const moved = branchBefore !== undefined && branchBefore !== headAfter;
	return {
		operation,
		headBefore,
		message: moved
			? `Aborted the unfinished ${operation.label}; "${branch}" is back at ${shorten(headAfter)}.`
			: `Aborted the unfinished ${operation.label}; the branch was not moved by it.`,
	};
}

/**
 * Delete lock files. Only ever called after the user confirmed: the caller has
 * to say out loud that no git operation is running, because a lock that is
 * *held* cannot be told from a stale one by looking at it.
 */
export async function removeLockFiles(ctx: RepoContext, locks: readonly LockFile[]): Promise<string[]> {
	const { git } = ctx;
	await git.requireRepository();
	const removed: string[] = [];
	for (const lock of locks) {
		if (!lock.name.endsWith('.lock')) {
			continue;
		}
		try {
			await fsp.rm(lock.path, { force: true });
			removed.push(lock.path);
		} catch (error) {
			throw new GecoError('git-failed', `Could not remove ${lock.path}.`, error instanceof Error ? error.message : String(error));
		}
	}
	return removed;
}

export interface RebaseResult {
	branch: string;
	from: string;
	to: string;
	upstreamRef: string;
	/** Commits that were dropped because the upstream already had their change. */
	dropped: number;
	/** Hidden recovery point (`refs/geco/...`) holding the pre-rebase tip. */
	recoveryRef?: string;
}

/**
 * `git rebase <upstream>`: replay the local-only commits on top of the remote
 * copy. Commits whose change is already there are dropped by git itself
 * ("skipped previously applied commit"), which is exactly what makes the
 * duplicated work disappear instead of being merged back in.
 *
 * A rebase that stops (a real conflict) is aborted again before the error is
 * rethrown: this command never leaves behind the state it is meant to clean up.
 */
export async function rebaseOntoUpstream(
	ctx: RepoContext,
	input: { branch: string; upstreamSha: string; upstreamRef: string; duplicates?: number; createRecoveryPoint?: boolean },
): Promise<RebaseResult> {
	const { git, safety } = ctx;
	await git.requireRepository();

	const head = await git.headBranch();
	if (head !== input.branch) {
		throw new GecoError(
			'rejected',
			`"${input.branch}" is not checked out, so it cannot be rebased.`,
			`Check it out first, or publish the rewritten history with "Git Easy Ops: Force Push (with lease)...".`,
		);
	}
	if (await git.isDirty()) {
		throw new GecoError('dirty-worktree', 'The worktree has uncommitted changes; a rebase would refuse to start.', 'Commit or stash them first.');
	}
	const from = (await git.revParse(`refs/heads/${input.branch}`)) ?? '';
	if (!from) {
		throw new GecoError('ref-not-found', `Branch "${input.branch}" does not exist.`);
	}

	const recoveryRef = input.createRecoveryPoint === false
		? undefined
		: await safety.hiddenBackupRef(`rebase/${input.branch}`, from);

	const result = await git.rebase(input.upstreamSha);
	if (result.exitCode !== 0) {
		const abort = await git.rebaseAbort();
		if (recoveryRef && (await git.refExists(recoveryRef))) {
			await git.deleteRef(recoveryRef, { message: 'geco: rebase aborted' }).catch(() => undefined);
		}
		const firstLine = firstLineOf(result.stderr) ?? firstLineOf(result.stdout) ?? 'the rebase stopped';
		throw new GecoError(
			'git-failed',
			`The rebase onto ${input.upstreamRef} stopped: ${firstLine}`,
			[
				abort.exitCode === 0
					? 'The rebase was aborted again, so the repository is exactly as it was - nothing was changed.'
					: 'The rebase is still in progress; abort it with: git rebase --abort',
				'Publish the rewritten history with "Git Easy Ops: Force Push (with lease)..." instead, or resolve the conflict by hand.',
			].join('\n'),
		);
	}

	const to = (await git.revParse(`refs/heads/${input.branch}`)) ?? '';
	await safety.record({
		kind: 'rebase',
		summary: `Rebased ${input.branch} onto ${input.upstreamRef} (${shorten(from)} -> ${shorten(to)})${input.duplicates ? `, dropped ${input.duplicates} already-applied commit(s)` : ''}`,
		undo: {
			type: 'refs',
			refs: [{ ref: `refs/heads/${input.branch}`, restoreTo: from, expected: to, resetHard: true }],
			deleteRefs: recoveryRef ? [recoveryRef] : [],
		},
	});
	return { branch: input.branch, from, to, upstreamRef: input.upstreamRef, dropped: input.duplicates ?? 0, recoveryRef };
}

export interface MoveResult {
	fastForward: FastForwardResult;
	backup?: string;
}

/**
 * Point the branch at the remote copy. Only for the case where *nothing*
 * local is unique (every local-only commit is already there under another
 * hash) - the old tip is parked on a backup branch first and the move is
 * journaled, so even a mistaken call is one Undo away from being reversed.
 */
export async function moveBranchOntoUpstream(
	ctx: RepoContext,
	input: { branch: string; upstreamSha: string; upstreamRef: string; backupName?: string },
): Promise<MoveResult> {
	await assertNothingUnique(ctx, input.branch, input.upstreamSha);
	const result = await fastForwardBranch(ctx, {
		target: input.upstreamSha,
		branch: input.branch,
		force: true,
		createBackup: true,
		backupName: input.backupName,
	});
	return { fastForward: result, backup: result.backup?.name };
}

/** Refuse to move a branch when a local-only commit is not already there. */
async function assertNothingUnique(ctx: RepoContext, branch: string, upstreamSha: string): Promise<void> {
	const { git } = ctx;
	const head = await git.revParse(`refs/heads/${branch}`);
	if (!head) {
		throw new GecoError('ref-not-found', `Branch "${branch}" does not exist.`);
	}
	if (await git.isAncestor(head, upstreamSha)) {
		return; // a plain fast-forward: nothing local is left behind
	}
	const localOnly = await git.revList([`${upstreamSha}..${head}`, '--no-merges']);
	if (localOnly.length === 0) {
		return;
	}
	const alreadyThere = new Set((await git.cherry(upstreamSha, head)).filter((entry) => entry.alreadyThere).map((entry) => entry.sha));
	const unique = localOnly.filter((sha) => !alreadyThere.has(sha));
	if (unique.length > 0) {
		throw new GecoError(
			'not-fast-forward',
			`"${branch}" has ${unique.length} commit${unique.length === 1 ? '' : 's'} that ${shorten(upstreamSha)} does not have.`,
			'Moving the branch would leave them behind. Use Force Push (with lease) to publish them, or rebase onto the remote copy first.',
		);
	}
}

export interface FetchOutcome {
	ok: boolean;
	remote: string;
	output: string;
	timedOut: boolean;
	/** True when the remote is a local path (no network involved). */
	localPath: boolean;
}

/**
 * `git fetch --prune <remote>` with a short timeout. A failure is *not* an
 * error of the diagnosis: "the connection is down" is one of the answers the
 * user asked for.
 */
export async function fetchRemote(ctx: RepoContext, remote: string, options?: { timeoutMs?: number }): Promise<FetchOutcome> {
	const { git } = ctx;
	const url = await git.tryRun(['remote', 'get-url', remote]);
	const result = await git.fetch(remote, { prune: true, timeoutMs: options?.timeoutMs ?? 60_000 });
	const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
	return {
		ok: result.exitCode === 0 && !result.timedOut,
		remote,
		output,
		timedOut: result.timedOut,
		localPath: Boolean(url && !/^[a-z+]+:\/\//i.test(url) && !url.includes('@')),
	};
}

export interface PublishResult {
	remote: string;
	branch: string;
	sha: string;
	output: string;
}

/** `git push -u <remote> <branch>`: create the remote branch and track it. */
export async function publishBranch(ctx: RepoContext, input: { branch: string; remote: string }): Promise<PublishResult> {
	const { git, safety } = ctx;
	const sha = await git.revParse(`refs/heads/${input.branch}`);
	if (!sha) {
		throw new GecoError('ref-not-found', `Branch "${input.branch}" does not exist.`);
	}
	const result = await git.push(['-u', input.remote, `${input.branch}:refs/heads/${input.branch}`]);
	if (result.exitCode !== 0) {
		const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
		throw new GecoError(
			'rejected',
			`Could not push "${input.branch}" to ${input.remote}.`,
			[output, 'A rejected or failed push leaves the repository unchanged - the remote may be unreachable, or somebody else may own that branch name.'].join('\n'),
		);
	}
	await safety.record({
		kind: 'branch',
		summary: `Published ${input.branch} to ${input.remote}/${input.branch} (${shorten(sha)}) and set its upstream`,
		undo: { type: 'refs', refs: [], remoteRefs: [{ remote: input.remote, branch: input.branch, action: 'delete', expectedSha: sha }] },
	});
	return { remote: input.remote, branch: input.branch, sha, output: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n') };
}

// ---------------------------------------------------------------------- guard

export interface StartBlockers {
	unfinished: UnfinishedOperation[];
	conflicts: string[];
	locks: LockFile[];
}

/**
 * What stops an operation from starting: an interrupted merge/rebase/…, or a
 * lock file. Cheap on purpose (markers + one `git diff` + three stats) - the
 * controller calls this before every flow that rewrites or moves refs, so a
 * half-finished repository is never built upon by accident.
 */
export async function findStartBlockers(ctx: RepoContext, options?: { allowAm?: boolean }): Promise<StartBlockers> {
	const unfinished = (await findUnfinishedOperations(ctx)).filter((operation) => !(options?.allowAm && operation.kind === 'am'));
	return { unfinished, conflicts: await ctx.git.conflictedPaths(), locks: await findLockFiles(ctx) };
}

/**
 * Throw the actionable {@link GecoError} when the repository is in a state
 * that no rewrite, move or cleanup should be started from.
 *
 * `allowAm` is for the patch flow: applying a patch is the one operation that
 * *produces* an interrupted `git am` (and, with `--3way`, unmerged paths
 * without any marker file) on purpose, and it explains how to finish or abort
 * it. So that flow is not stopped by those two states - only by a merge,
 * rebase, cherry-pick or revert it did not start, or by a lock file.
 */
export async function assertStartable(ctx: RepoContext, options?: { allowAm?: boolean }): Promise<void> {
	const blockers = await findStartBlockers(ctx, options);
	const conflictsBlock = options?.allowAm !== true && blockers.conflicts.length > 0;
	if (blockers.unfinished.length === 0 && blockers.locks.length === 0 && !conflictsBlock) {
		return;
	}
	const names = [...new Set(blockers.unfinished.map((operation) => operation.label))];
	const headline = blockers.unfinished.length > 0
		? `This repository has an unfinished ${names.join(' / ')} in it.`
		: blockers.locks.length > 0
			? `${blockers.locks[0]!.name} is left over in the git directory, so git cannot write the index.`
			: `${blockers.conflicts.length} file(s) still have conflict markers.`;
	throw new GecoError(
		'repo-busy',
		headline,
		[
			...blockers.unfinished.map((operation) => `${operation.label}: abort it with "git ${operation.abortArgs.join(' ')}", or finish it by hand.`),
			...blockers.conflicts.slice(0, 5).map((file) => `conflict: ${file}`),
			...blockers.locks.map((lock) => `lock: ${lock.path} (${formatAge(lock.ageMs)} old - stale unless a git operation is running right now)`),
			'',
			'"Git Easy Ops: Diagnose Push / Sync Trouble..." explains the state and can clean it up.',
			'Nothing was changed by this command.',
		].join('\n'),
	);
}

// -------------------------------------------------------------------- helpers

async function pathExists(target: string): Promise<boolean> {
	try {
		await fsp.stat(target);
		return true;
	} catch {
		return false;
	}
}

function firstLineOf(text: string): string | undefined {
	const line = text.split('\n').map((entry) => entry.trim()).find(Boolean);
	return line && line.length > 0 ? line : undefined;
}
