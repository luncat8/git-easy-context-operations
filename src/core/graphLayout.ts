/**
 * The lane layout our own Source Control panel draws next to the commits.
 *
 * The built-in Source Control Graph paints its lanes onto a canvas inside a tree
 * row - something only VS Code itself can do. An extension can only put text in
 * a label, so this module computes the same information (which lane a commit
 * sits in, which lanes continue, where a branch starts) and renders it as one
 * line of `●│╮…` characters, the way `git log --graph` does it.
 *
 * The layout is pure: commits in, rows out. That keeps the interesting part -
 * lane assignment for merges, octopus merges and shared parents - testable
 * without an editor or a repository.
 */

/** What the layout needs to know about a commit. */
export interface GraphLaneCommit {
	sha: string;
	parents: readonly string[];
}

export interface GraphLaneRow {
	sha: string;
	/** Column of the commit itself, 0-based. */
	lane: number;
	/** Which sha each lane expects *before* this commit (null = free lane). */
	before: readonly (string | null)[];
	/** Which sha each lane expects *after* this commit. */
	after: readonly (string | null)[];
	/** One character per visible lane: `●` the commit, `│` a lane, `╮` a lane it opens. */
	art: string;
}

export const FREE_LANE: null = null;
export const COMMIT_GLYPH = '●';
export const LANE_GLYPH = '│';
export const BRANCH_GLYPH = '╮';
export const ELLIPSIS_GLYPH = '…';

/** Enough columns for a busy repository without eating the whole row. */
export const DEFAULT_MAX_LANES = 6;

export interface GraphLayoutOptions {
	/** How many lanes are drawn; the commit stays visible if it is further right. */
	maxLanes?: number;
	/** Draw the lane art at all. `false` yields empty `art` strings. */
	draw?: boolean;
}

/**
 * Assign every commit a lane and render its row. `commits` must be in the order
 * `git log` prints them (newest first, parents after their children); the
 * caller gets exactly one row per commit, in the same order.
 */
export function layoutGraph(commits: readonly GraphLaneCommit[], options: GraphLayoutOptions = {}): GraphLaneRow[] {
	const maxLanes = Math.max(1, Math.trunc(options.maxLanes ?? DEFAULT_MAX_LANES));
	const draw = options.draw ?? true;
	const lanes: (string | null)[] = [];
	const rows: GraphLaneRow[] = [];

	for (const commit of commits) {
		let before = lanes.slice();

		let lane = before.indexOf(commit.sha);
		if (lane < 0) {
			// A tip, or a commit whose lane was already taken by another child.
			lane = before.indexOf(FREE_LANE);
			if (lane < 0) {
				before.push(FREE_LANE);
				lane = before.length - 1;
			}
		}

		// Collapse lanes nobody waits for any more, so the graph hugs the left
		// edge instead of drifting right as branches end - what `git log --graph`
		// does too. Only when this is the last lane in use: a commit between two
		// occupied lanes has to stay where it is, or it would leave a gap.
		if (before.slice(lane + 1).every((entry) => entry === FREE_LANE)) {
			while (lane > 0 && before[lane - 1] === FREE_LANE) {
				before[lane - 1] = before[lane];
				before[lane] = FREE_LANE;
				lane--;
			}
		}

		const after = before.slice();
		after[lane] = FREE_LANE;

		// The first parent keeps the commit's lane; further parents open a new
		// one - unless some other lane is already waiting for that commit, in
		// which case the edge runs into that lane (a shared parent).
		// The first parent keeps the commit's lane; further parents open one -
		// unless another lane already waits for that commit, in which case the
		// edge simply runs into that lane (a shared parent, e.g. after a rebase).
		let ownLaneTaken = false;
		for (const parent of commit.parents) {
			if (!parent || after.includes(parent)) {
				continue;
			}
			if (!ownLaneTaken) {
				after[lane] = parent;
				ownLaneTaken = true;
				continue;
			}
			let slot = after.indexOf(FREE_LANE);
			if (slot < 0) {
				after.push(FREE_LANE);
				slot = after.length - 1;
			}
			after[slot] = parent;
		}

		rows.push({
			sha: commit.sha,
			lane,
			before,
			after,
			art: draw ? renderLaneRow(before, after, lane, maxLanes) : '',
		});

		lanes.length = 0;
		lanes.push(...after);
		while (lanes.length > 0 && lanes[lanes.length - 1] === FREE_LANE) {
			lanes.pop();
		}
	}

	return rows;
}

/** One rendered line, without the commit text that follows it. */
export function renderLaneRow(
	before: readonly (string | null)[],
	after: readonly (string | null)[],
	lane: number,
	maxLanes: number = DEFAULT_MAX_LANES,
): string {
	const width = Math.max(before.length, after.length, lane + 1);
	const cells: string[] = [];

	for (let i = 0; i < width; i++) {
		if (i === lane) {
			cells.push(COMMIT_GLYPH);
		} else if (i < lane) {
			cells.push(before[i] ? LANE_GLYPH : ' ');
		} else if (after[i] && !before[i]) {
			// Opened by this commit: the lane starts here and runs downwards.
			cells.push(BRANCH_GLYPH);
		} else {
			cells.push(after[i] ? LANE_GLYPH : ' ');
		}
	}

	let art = cells.join('').replace(/\s+$/, '');

	// Keep wide graphs readable: never cut away the commit itself.
	if (art.length > maxLanes) {
		if (lane < maxLanes) {
			art = art.slice(0, maxLanes);
		} else {
			const start = lane - maxLanes + 2;
			art = `${ELLIPSIS_GLYPH}${art.slice(start, lane + 1)}`;
		}
	}

	return art;
}
