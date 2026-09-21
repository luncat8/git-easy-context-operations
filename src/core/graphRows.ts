/**
 * The rows our own Source Control panel shows: the graph lane art, the commit
 * text, and the refs (branches, remotes, tags) that point at each commit.
 *
 * The built-in Source Control Graph cannot be extended without a proposed API
 * (see `graphMenu.ts`), so this is the always-available alternative: the same
 * commits, the same refs, the same context menus - as a tree view, which is
 * what the stable menu API supports.
 *
 * Pure data in, pure data out - the VS Code layer only turns these rows into
 * `TreeItem`s.
 */
import { DEFAULT_MAX_LANES, layoutGraph, type GraphLaneCommit } from './graphLayout';
import { shorten } from './safety';
import type { CommitInfo, RefInfo } from './git';

/** A ref that points at a commit - rendered as a child node of the commit row. */
export interface GraphRefRow {
	/** Short branch name (`main`). */
	name: string;
	sha: string;
	kind: RefInfo['kind'];
	isHead: boolean;
	upstream?: string;
}

export interface GraphCommitRow {
	sha: string;
	shortSha: string;
	lane: number;
	/** `●─╮` style lane art; empty when lanes are turned off. */
	art: string;
	subject: string;
	author: string;
	date: string;
	/**
	 * The refs that become child nodes: local branches, HEAD first, then by
	 * name. Remote-tracking refs and tags have no branch operations, so they
	 * only show up in {@link refsLabel}.
	 */
	refs: GraphRefRow[];
	/** `main (HEAD), origin/main, v0.2` - shown as the row description. */
	refsLabel: string;
	isHead: boolean;
	tooltip: string;
}

export interface GraphRowOptions {
	/** Draw the lane art (default true). */
	lanes?: boolean;
	maxLanes?: number;
	/** Injectable clock, so "2 hours ago" is testable. */
	now?: Date;
}

export function buildGraphRows(
	commits: readonly CommitInfo[],
	refs: readonly RefInfo[],
	options: GraphRowOptions = {},
): GraphCommitRow[] {
	const now = options.now ?? new Date();
	const bySha = new Map<string, RefInfo[]>();
	for (const ref of refs) {
		const list = bySha.get(ref.sha);
		if (list) {
			list.push(ref);
		} else {
			bySha.set(ref.sha, [ref]);
		}
	}

	const laneCommits: GraphLaneCommit[] = commits.map((commit) => ({ sha: commit.sha, parents: commit.parents }));
	const lanes = layoutGraph(laneCommits, {
		draw: options.lanes ?? true,
		maxLanes: options.maxLanes ?? DEFAULT_MAX_LANES,
	});

	return commits.map((commit, index) => {
		const laneRow = lanes[index]!;
		const atCommit = (bySha.get(commit.sha) ?? []).slice().sort(sortRefs);
		const refs = refRowsAt(atCommit, commit.sha);
		const refsLabel = atCommit
			.map((ref) => (ref.isHead ? `${ref.name} (HEAD)` : ref.name))
			.join(', ');

		return {
			sha: commit.sha,
			shortSha: commit.shortSha || shorten(commit.sha),
			lane: laneRow.lane,
			art: laneRow.art,
			subject: commit.subject,
			author: commit.author.name,
			date: describeWhen(commit.author.date, now),
			refs,
			refsLabel,
			isHead: atCommit.some((ref) => ref.isHead),
			tooltip: commitTooltip(commit, refsLabel, now),
		};
	});
}

/**
 * The local-branch badges of one commit, straight from a ref list: the rows
 * the tree view expands under a commit, re-queried from git so a stale element
 * can never show a branch that was deleted (or a missing one that was created)
 * in the meantime.
 */
export function refRowsAt(refs: readonly RefInfo[], sha: string): GraphRefRow[] {
	return refs.filter((ref) => ref.kind === 'branch' && ref.sha === sha).map(toRefRow);
}

function toRefRow(ref: RefInfo): GraphRefRow {
	return { name: ref.name, sha: ref.sha, kind: ref.kind, isHead: ref.isHead, upstream: ref.upstream };
}

/** HEAD first, then local branches, remote-tracking refs, tags, then by name. */
function sortRefs(a: RefInfo, b: RefInfo): number {
	const rank = (ref: RefInfo) => (ref.isHead ? 0 : ref.kind === 'branch' ? 1 : ref.kind === 'remote' ? 2 : ref.kind === 'tag' ? 3 : 4);
	return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

function commitTooltip(commit: CommitInfo, refsLabel: string, now: Date): string {
	return [
		`${commit.shortSha} ${commit.subject}`,
		refsLabel ? `refs: ${refsLabel}` : '',
		`author: ${commit.author.name} <${commit.author.email}>`,
		`date:   ${commit.author.date} (${describeWhen(commit.author.date, now)})`,
		commit.parents.length > 1 ? `merge of ${commit.parents.map((parent) => shorten(parent)).join(', ')}` : '',
		'',
		'Right-click for the Git Easy Ops operations (reword, fast-forward, patch, create branch...).',
	]
		.filter((line) => line !== '')
		.join('\n');
}

/**
 * "2 hours ago" for recent commits, the plain date for older ones. Takes the
 * clock as an argument so the output is deterministic in tests.
 */
export function describeWhen(iso: string, now: Date = new Date()): string {
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) {
		return iso;
	}
	const seconds = Math.round((now.getTime() - then) / 1000);
	if (seconds < 0) {
		return iso;
	}
	if (seconds < 90) {
		return 'just now';
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours} hour${hours === 1 ? '' : 's'} ago`;
	}
	const days = Math.round(hours / 24);
	if (days < 30) {
		return `${days} day${days === 1 ? '' : 's'} ago`;
	}
	return iso.slice(0, 10);
}
