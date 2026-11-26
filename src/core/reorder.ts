/**
 * Reorder: move one commit up or down the first-parent line of history.
 *
 * The list a user sees is newest-first, so "up" means *toward the newer
 * commits* (a positive shift) and "down" toward the older ones (negative;
 * `-1` swaps the commit with the previous one - its parent). The move is a
 * rewrite of the affected run, built entirely from commit-tree plumbing:
 *
 *   1. the first-parent chain of the branch is walked once and the commit's
 *      index is found; the new order is the same chain with that one entry
 *      spliced to its new position;
 *   2. every commit from the new position to the tip - the commits the move
 *      crosses, the moved commit itself and the newer commits that get
 *      replayed - is rebuilt: `git read-tree -m <old parent> <new parent>
 *      <commit>` into a throw-away index merges the commit's own changes onto
 *      its new base (stages the merge engine leaves for "one side did not
 *      touch it" are resolved the textbook way), `git write-tree` writes the
 *      result and `git commit-tree` recreates the commit with its message and
 *      identities (parents mapped to their rebuilt versions, side parents
 *      included). Commits below the affected range keep their SHAs;
 *   3. two checks run before the branch moves: the old commit must no longer
 *      be reachable from the new tip (a merge could keep it), and the tip's
 *      tree must be byte-identical to the old one - a reorder changes order,
 *      never content;
 *   4. `git update-ref <ref> <new> <old>` moves the branch atomically, so a
 *      branch that moved in the meantime fails instead of being clobbered.
 *
 * The conflict rule is deliberately file-level and checked *before* anything
 * is written: the moved commit may not share a single changed path with any
 * commit it would cross (`findCrossedBlocker`). When it does, the flow shows
 * which files changed in between and offers the farthest safe shift instead
 * of guessing - the merge in step 2 would only be a late, harder-to-explain
 * failure. No working tree, no index, no interactive rebase: like the other
 * rewrite operations this works with uncommitted changes and is undone by one
 * "Git Easy Ops: Undo Last Operation".
 */
import * as fsp from 'node:fs/promises';
import type { RepoContext } from './context';
import { GecoError } from './errors';
import { tempIndexPath, type Git, type UpstreamInfo } from './git';
import { discardRecoveryRef, isSignedCommit } from './rewrite';
import { shorten, type JournalEntry } from './safety';
import type { RewrittenCommit } from './squash';

// --------------------------------------------------------------- plan / pure

/** Where a move starts: the branch, its tip, the chain and the commit's index. */
export interface MovePlan {
	branch: string;
	branchRef: string;
	/** Tip of the branch when the plan was made - the rewrite's compare-and-swap. */
	branchSha: string;
	/** First-parent chain, newest (tip) first. */
	chain: string[];
	/** Index of the moved commit in {@link chain} (0 = tip of the list). */
	index: number;
	/** Resolved sha of the moved commit. */
	target: string;
	/** Positions the commit can still move: up toward the tip, down toward the root. */
	maxUp: number;
	maxDown: number;
}

/** `"-1"` / `" 3 "` -> the shift; anything else (0, junk) -> undefined. */
export function parseShift(text: string): number | undefined {
	const trimmed = (text ?? '').trim();
	if (!/^[+-]?\d+$/.test(trimmed)) {
		return undefined;
	}
	const shift = Number.parseInt(trimmed, 10);
	if (!Number.isSafeInteger(shift) || shift === 0) {
		return undefined;
	}
	return shift;
}

/** A requested shift as a button/message label: `+3`, `-1`. */
export function formatShift(shift: number): string {
	return shift > 0 ? `+${shift}` : `${shift}`;
}

/**
 * A shift too far for the list is clamped, not refused: asking to move a
 * commit "to the very top" means "as far up as the list allows". Zero comes
 * back only when that direction has no room at all.
 */
export function clampShift(requested: number, maxUp: number, maxDown: number): number {
	if (requested === 0) {
		return 0;
	}
	const limit = requested > 0 ? maxUp : maxDown;
	const clamped = requested > 0 ? Math.min(requested, limit) : Math.max(requested, -limit);
	// `Math.max(-5, -0)` is -0 - still "no room", but report it as plain 0.
	return clamped === 0 ? 0 : clamped;
}

/** The first-parent chain of `tip`, newest first, by walking parents in memory. */
export async function firstParentChain(git: Git, tip: string): Promise<string[]> {
	const parents = await git.parentMap(tip, { firstParent: true });
	const chain = [tip];
	let current = tip;
	while (chain.length <= parents.size + 1) {
		const next = parents.get(current)?.[0];
		if (!next) {
			break;
		}
		chain.push(next);
		current = next;
	}
	return chain;
}

/**
 * The chain with the commit spliced to its new position - the new order top
 * to bottom. `shift > 0` moves it up (toward index 0), `shift < 0` down.
 */
export function reorderedChain(chain: readonly string[], index: number, shift: number): string[] {
	const target = index - shift;
	if (shift > 0) {
		return [...chain.slice(0, target), chain[index]!, ...chain.slice(target, index), ...chain.slice(index + 1)];
	}
	return [...chain.slice(0, index), ...chain.slice(index + 1, target + 1), chain[index]!, ...chain.slice(target + 1)];
}

/**
 * Which commits the rebuild touches, decided from the two orders alone (no
 * git calls): a commit keeps its SHA when its first parent is the same commit
 * as before *and* that parent kept its SHA - which propagates from the
 * untouched tail below the move up to the first changed link.
 */
export function planRebuild(chain: readonly string[], index: number, shift: number): { newChain: string[]; rebuilt: string[] } {
	const newChain = reorderedChain(chain, index, shift);
	const oldParent = new Map<string, string | undefined>();
	chain.forEach((sha, position) => oldParent.set(sha, chain[position + 1]));
	const untouched = new Set<string>();
	const rebuilt: string[] = [];
	// Bottom-up: every commit below the first changed link is already known.
	for (let position = newChain.length - 1; position >= 0; position--) {
		const sha = newChain[position]!;
		const newParentOld = newChain[position + 1];
		const parent = oldParent.get(sha);
		if (parent === newParentOld && (newParentOld === undefined || untouched.has(newParentOld))) {
			untouched.add(sha);
		} else {
			rebuilt.push(sha);
		}
	}
	return { newChain, rebuilt };
}

/** Every path a commit changed (rename targets *and* sources), for the conflict rule. */
export async function changedPaths(git: Git, sha: string): Promise<Set<string>> {
	const changes = await git.changedFiles(sha);
	const paths = new Set<string>();
	for (const change of changes) {
		paths.add(change.path);
		if (change.oldPath) {
			paths.add(change.oldPath);
		}
	}
	return paths;
}

/** The commits a shift would cross, in travel order (first one it meets first). */
export function collectCrossed(chain: readonly string[], index: number, shift: number): string[] {
	const crossed: string[] = [];
	const steps = Math.abs(shift);
	for (let step = 1; step <= steps; step++) {
		crossed.push(chain[index + (shift > 0 ? -step : step)]!);
	}
	return crossed;
}

export interface CrossedBlocker {
	/** The first crossed commit that shares a file with the moved commit. */
	sha: string;
	/** 1-based: how many positions the commit could move before meeting it. */
	distance: number;
	/** The shared paths, sorted - the "files changed in between". */
	files: string[];
}

/**
 * The first crossed commit that changed one of the moved commit's files, or
 * `undefined` when the whole crossing is disjoint (then the move is safe).
 */
export async function findCrossedBlocker(
	git: Git,
	targetPaths: ReadonlySet<string>,
	crossed: readonly string[],
): Promise<CrossedBlocker | undefined> {
	for (let step = 0; step < crossed.length; step++) {
		const paths = await changedPaths(git, crossed[step]!);
		const files = [...paths].filter((path) => targetPaths.has(path)).sort();
		if (files.length > 0) {
			return { sha: crossed[step]!, distance: step + 1, files };
		}
	}
	return undefined;
}

/** The plan for moving `target` on `branch`, or a refusal when it cannot move. */
export async function planMove(git: Git, branch: string, target: string): Promise<MovePlan> {
	const branchRef = `refs/heads/${branch}`;
	const branchSha = await git.revParse(branchRef);
	if (!branchSha) {
		throw new GecoError('ref-not-found', `Branch "${branch}" does not exist.`);
	}
	const resolved = await git.resolveCommit(target);
	const chain = await firstParentChain(git, branchSha);
	const index = chain.indexOf(resolved);
	if (index < 0) {
		throw new GecoError(
			'not-a-chain',
			`${shorten(resolved)} is not on the line of history of "${branch}" - it sits on a side branch that was merged in.`,
			'A commit can only be reordered where it is part of the first-parent chain. Check out the branch it belongs to directly, or pick another branch in the question above.',
		);
	}
	return {
		branch,
		branchRef,
		branchSha,
		chain,
		index,
		target: resolved,
		maxUp: index,
		maxDown: chain.length - 1 - index,
	};
}

// --------------------------------------------------------------- the operation

export interface ReorderOptions {
	plan: MovePlan;
	/** Signed positions to move (positive = up); already clamped by the flow. */
	shift: number;
}

export interface ReorderResult {
	branch: string;
	/** The moved commit: its old sha, its new sha and what it says. */
	commit: { from: string; to: string; shortSha: string; subject: string };
	shift: number;
	/** 1-based positions in the list (1 = topmost), before and after. */
	fromPosition: number;
	toPosition: number;
	/** Oldest first: every commit that got a new SHA. */
	rewritten: RewrittenCommit[];
	oldTip: string;
	newTip: string;
	backupRef?: string;
	/** True when the rewritten commits are already on the remote. */
	needsForcePush: boolean;
	upstreamRef?: string;
	/** Upstream observed before changing the branch, used for automatic lease pushes. */
	upstreamBefore?: UpstreamInfo;
	/** Local branches / tags that still point at the old (moved-around) commits. */
	otherRefsOnOldHistory: string[];
	signatureDropped: boolean;
	journal: JournalEntry;
}

const EMPTY_TREE_CACHE = new WeakMap<Git, string>();

/** The empty tree of this repository's hash algorithm, in one cheap call. */
async function emptyTree(git: Git): Promise<string> {
	const cached = EMPTY_TREE_CACHE.get(git);
	if (cached) {
		return cached;
	}
	const tree = (await git.ok(['mktree'], { input: '' })).trim();
	EMPTY_TREE_CACHE.set(git, tree);
	return tree;
}

/**
 * The tree a commit would have on its new base: a 3-way merge of the old
 * parent (base), the new parent (ours) and the commit (theirs) in a
 * throw-away index.
 *
 * `read-tree -m` handles disjoint changes itself, but it leaves the
 * textbook "one side deleted, the other side did not touch it" case as
 * unmerged stages - which happens on every rebuild, because the new parent
 * legitimately lacks files the old parent had. Those are resolved the way a
 * real merge resolves them: whichever side actually changed wins, only
 * overlapping changes are a conflict - and a conflict throws before
 * `write-tree`, which is the safety net behind the file-level pre-check.
 */
async function mergeTree(git: Git, base: string, ours: string, theirs: string): Promise<string> {
	const indexFile = tempIndexPath('reorder');
	const index = { env: { GIT_INDEX_FILE: indexFile } };
	try {
		const merged = await git.run(['read-tree', '-m', base, ours, theirs], index);
		if (merged.exitCode !== 0 || merged.timedOut || merged.truncated) {
			throw new GecoError('conflict', 'Could not combine the trees of the reordered commits.', merged.stderr.trim() || merged.stdout.trim());
		}
		await resolveStages(git, indexFile);
		const written = await git.run(['write-tree'], index);
		if (written.exitCode !== 0 || written.timedOut || written.truncated) {
			throw new GecoError('conflict', 'The reordered commits conflict - their changes overlap.', written.stderr.trim() || written.stdout.trim());
		}
		return written.stdout.trim();
	} finally {
		await fsp.rm(indexFile, { force: true }).catch(() => undefined);
	}
}

/** `<mode> <object> <stage>\t<path>` entries of `ls-files -u`, grouped by path. */
interface UnmergedEntry {
	mode: string;
	sha: string;
	stage: number;
}

async function resolveStages(git: Git, indexFile: string): Promise<void> {
	const options = { env: { GIT_INDEX_FILE: indexFile } };
	const listed = await git.run(['ls-files', '-u', '-z'], options);
	if (listed.exitCode !== 0 || listed.timedOut || listed.truncated) {
		throw new GecoError('conflict', 'Could not read the combined trees of the reordered commits.', listed.stderr.trim() || listed.stdout.trim());
	}
	const byPath = new Map<string, UnmergedEntry[]>();
	for (const record of listed.stdout.split('\0')) {
		const match = /^(\d+) ([0-9a-f]+) ([123])\t([\s\S]*)$/.exec(record);
		if (!match) {
			continue;
		}
		const entry: UnmergedEntry = { mode: match[1]!, sha: match[2]!, stage: Number(match[3]) };
		const path = match[4]!;
		byPath.set(path, [...(byPath.get(path) ?? []), entry]);
	}
	if (byPath.size === 0) {
		return;
	}

	const identity = (entry: UnmergedEntry | undefined) => (entry ? `${entry.mode} ${entry.sha}` : undefined);
	const fixes: string[] = [];
	const overlaps: string[] = [];
	for (const [path, entries] of byPath) {
		const stage = (number: number) => entries.find((entry) => entry.stage === number);
		const [oldEntry, ourEntry, theirEntry] = [stage(1), stage(2), stage(3)];
		const theirsUnchanged = !!oldEntry && !!theirEntry && identity(oldEntry) === identity(theirEntry);
		const oursUnchanged = !!oldEntry && !!ourEntry && identity(oldEntry) === identity(ourEntry);
		if (theirsUnchanged) {
			// Theirs did not touch it: ours wins, including its deletion.
			fixes.push(...(ourEntry ? ['--cacheinfo', `${ourEntry.mode},${ourEntry.sha},${path}`] : ['--force-remove', path]));
		} else if (oursUnchanged) {
			// Ours did not touch it: theirs wins, including its deletion.
			fixes.push(...(theirEntry ? ['--cacheinfo', `${theirEntry.mode},${theirEntry.sha},${path}`] : ['--force-remove', path]));
		} else {
			overlaps.push(path);
		}
	}
	if (overlaps.length > 0) {
		throw new GecoError('conflict', 'The reordered commits conflict - their changes overlap.', overlaps.slice(0, 20).join('\n'));
	}
	if (fixes.length > 0) {
		await git.ok(['update-index', ...fixes], options);
	}
}

/** Move `plan.target` by `shift` positions and journal the rewrite. */
export async function reorderCommits(ctx: RepoContext, options: ReorderOptions): Promise<ReorderResult> {
	const { git, safety, settings } = ctx;
	await git.requireRepository();

	const { plan, shift } = options;
	if (!Number.isInteger(shift) || shift === 0) {
		throw new GecoError('nothing-to-do', 'A reorder needs a non-zero shift.');
	}
	const toIndex = plan.index - shift;
	if (toIndex < 0 || toIndex >= plan.chain.length) {
		throw new GecoError('rejected', `The list only allows ${shift > 0 ? `+${plan.maxUp}` : `-${plan.maxDown}`} from this position.`);
	}
	// The chain was walked from a tip the branch no longer has: start over
	// rather than splice an order nobody sees any more.
	const currentTip = await git.revParse(plan.branchRef);
	if (currentTip !== plan.branchSha) {
		throw new GecoError('rejected', `Branch "${plan.branch}" moved while the move was being prepared - nothing was rewritten.`, 'Run the reorder again on the new history.');
	}
	const upstreamBefore = await git.upstream(plan.branch);

	const fromIndex = plan.index;
	const { newChain } = planRebuild(plan.chain, fromIndex, shift);
	const backupRef = await safety.hiddenBackupRef(`reorder/${plan.branch}`, plan.branchSha);

	try {
		const oldParentOf = new Map<string, string | undefined>();
		plan.chain.forEach((sha, position) => oldParentOf.set(sha, plan.chain[position + 1]));

		/** old sha -> new sha (identity for the untouched tail). */
		const map = new Map<string, string>();
		/** old sha -> its rebuilt tree, as "ours" for the commit above it. */
		const newTrees = new Map<string, string>();
		const treeCache = new Map<string, string>();
		const treeOf = async (sha: string): Promise<string> => {
			const cached = treeCache.get(sha);
			if (cached) {
				return cached;
			}
			const tree = await git.treeOf(sha);
			treeCache.set(sha, tree);
			return tree;
		};

		const rewritten: RewrittenCommit[] = [];
		// Bottom-up: a commit is rebuilt only when its first parent changed
		// (different sha, or a parent that itself was rebuilt).
		for (let position = newChain.length - 1; position >= 0; position--) {
			const oldSha = newChain[position]!;
			const newParentOld = newChain[position + 1];
			const oldParent = oldParentOf.get(oldSha);
			if (oldParent === newParentOld && (newParentOld === undefined || map.get(newParentOld) === newParentOld)) {
				map.set(oldSha, oldSha);
				continue;
			}

			const info = await git.commitInfo(oldSha);
			const baseTree = oldParent ? await treeOf(oldParent) : await emptyTree(git);
			const oursTree = newParentOld
				? (newTrees.get(newParentOld) ?? await treeOf(map.get(newParentOld) ?? newParentOld))
				: await emptyTree(git);
			const mergedTree = await mergeTree(git, baseTree, oursTree, info.tree);
			// The new first parent comes from the new order - the moved commit may
			// sit somewhere else entirely. Side parents keep their SHAs unless they
			// were rebuilt as part of the run (they are always processed first).
			const firstNewParent = newParentOld === undefined ? undefined : map.get(newParentOld);
			const parents = firstNewParent === undefined ? [] : [firstNewParent, ...info.parents.slice(1).map((parent) => map.get(parent) ?? parent)];
			const newSha = await git.commitTree({
				tree: mergedTree,
				parents,
				// Byte-for-byte, like every other replay in this extension.
				message: await git.rawMessage(oldSha),
				author: info.author,
				committer: settings.preserveCommitterDateOnReword
					? info.committer
					: { ...info.committer, date: new Date().toISOString() },
			});
			map.set(oldSha, newSha);
			newTrees.set(oldSha, mergedTree);
			treeCache.set(newSha, mergedTree);
			rewritten.push({ from: oldSha, to: newSha, subject: info.subject });
		}

		// The new tip is the top of the NEW order - moving the tip itself
		// (or the commit past it) puts a different commit at position 0.
		const newTip = map.get(newChain[0]!);
		if (!newTip || newTip === plan.branchSha) {
			throw new GecoError('nothing-to-do', 'The move did not change the branch - nothing was rewritten.');
		}
		// Nothing written yet: both checks abort with the repository untouched.
		if (await git.isAncestor(plan.target, newTip)) {
			throw new GecoError('rejected', 'The original commit is still reachable from the new history - a merge keeps it in place.', 'Nothing was rewritten. Reorder the commits around the merge instead, or squash the merge away first.');
		}
		if ((await git.treeOf(newTip)) !== (await git.treeOf(plan.branchSha))) {
			throw new GecoError('rejected', 'The reordered history would change the content of the branch tip - nothing was rewritten.', 'This means commits that were not checked against each other overlap. Report it with the Git Easy Ops output log.');
		}

		await git.updateRef(plan.branchRef, newTip, {
			oldValue: plan.branchSha,
			message: `geco reorder ${shorten(plan.target)}`,
		});

		const upstream = await git.upstream(plan.branch);
		const needsForcePush = !!upstream?.sha && !(await git.isAncestor(upstream.sha, newTip));

		// Branches / tags that still hold the old SHAs of the rewritten run.
		const oldestRebuilt = plan.chain[Math.max(fromIndex, toIndex)]!;
		const elsewhere = new Set<string>();
		for (const sha of new Set([plan.target, oldestRebuilt])) {
			for (const name of await git.branchesContaining(sha)) {
				if (name !== 'HEAD' && name !== plan.branch) {
					elsewhere.add(name);
				}
			}
			for (const tag of await git.tagsContaining(sha)) {
				elsewhere.add(`tag:${tag}`);
			}
		}

		const signatureDropped = (await Promise.all(rewritten.map((entry) => isSignedCommit(git, entry.from)))).some(Boolean);
		const journal = await safety.record({
			kind: 'reorder',
			summary: `Moved ${shorten(plan.target)} ${shift > 0 ? `up ${shift}` : `down ${-shift}`} to position ${toIndex + 1} on ${plan.branch}`,
			undo: {
				type: 'refs',
				refs: [{ ref: plan.branchRef, restoreTo: plan.branchSha, expected: newTip }],
				deleteRefs: backupRef ? [backupRef] : [],
			},
		});

		return {
			branch: plan.branch,
			commit: {
				from: plan.target,
				to: map.get(plan.target)!,
				shortSha: shorten(plan.target),
				subject: rewritten.find((entry) => entry.from === plan.target)?.subject ?? '',
			},
			shift,
			fromPosition: fromIndex + 1,
			toPosition: toIndex + 1,
			rewritten,
			oldTip: plan.branchSha,
			newTip,
			backupRef,
			needsForcePush,
			upstreamRef: upstream ? `${upstream.remote}/${upstream.branch}` : undefined,
			upstreamBefore,
			otherRefsOnOldHistory: [...elsewhere],
			signatureDropped,
			journal,
		};
	} catch (error) {
		await discardRecoveryRef(git, backupRef);
		throw error;
	}
}
