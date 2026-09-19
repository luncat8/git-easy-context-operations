/**
 * The lane layout is what makes our own panel *the graph* instead of a commit
 * list, so the interesting cases - a linear history, tips, a merge, an octopus
 * merge, a shared parent, a graph wider than the row - are pinned down here.
 * No repository and no editor involved.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { layoutGraph, renderLaneRow, DEFAULT_MAX_LANES } from '../../core/graphLayout';

const c = (sha: string, ...parents: string[]) => ({ sha, parents });

/** Lane occupancy as a string, for readable assertions: 'ab.' -> lanes a, b, free. */
const lanesOf = (lanes: readonly (string | null)[]): string => lanes.map((lane) => lane ?? '.').join('');

describe('graph layout - lanes', () => {
	it('keeps a linear history in one lane', () => {
		const rows = layoutGraph([c('c', 'b'), c('b', 'a'), c('a')]);
		assert.deepEqual(rows.map((row) => row.art), ['●', '●', '●']);
		assert.deepEqual(rows.map((row) => row.lane), [0, 0, 0]);
		assert.deepEqual(rows.map((row) => lanesOf(row.after)), ['b', 'a', '.']);
		// `before` already contains the free slot the first commit takes.
		assert.deepEqual(rows.map((row) => lanesOf(row.before)), ['.', 'b', 'a']);
	});

	it('gives every tip its own lane, and merges them into the shared parent', () => {
		// Two branch tips, then the ancestor they both point at.
		const rows = layoutGraph([c('b1', 'a'), c('b2', 'a'), c('a')]);
		assert.deepEqual(rows.map((row) => row.lane), [0, 1, 0]);
		assert.deepEqual(rows.map((row) => row.art), ['●', '│●', '●']);
		assert.equal(lanesOf(rows[0]!.after), 'a');
		assert.equal(lanesOf(rows[1]!.after), 'a.', 'the second tip merges into the lane that already waits for a');
		assert.equal(lanesOf(rows[2]!.after), '.', 'everything collapses at the root');
	});

	it('opens a new lane for the second parent of a merge', () => {
		// m merges a (lane 0) and b (new lane); b's parent is a again.
		const rows = layoutGraph([c('m', 'a', 'b'), c('b', 'a'), c('a')]);
		assert.equal(rows[0]!.lane, 0);
		assert.equal(rows[0]!.art, '●╮');
		assert.equal(lanesOf(rows[0]!.after), 'ab');
		assert.deepEqual(rows.map((row) => row.lane), [0, 1, 0]);
		assert.deepEqual(rows.map((row) => row.art), ['●╮', '│●', '●']);
	});

	it('merges into a lane that already waits for the parent', () => {
		// Both commits point at p, which is tracked in lane 0 after the first.
		const rows = layoutGraph([c('x', 'p'), c('y', 'p'), c('p')]);
		assert.deepEqual(rows.map((row) => row.lane), [0, 1, 0]);
		assert.deepEqual(rows.map((row) => row.art), ['●', '│●', '●']);
		assert.equal(lanesOf(rows[1]!.after), 'p.', 'y does not open a second lane for p');
	});

	it('handles an octopus merge', () => {
		const rows = layoutGraph([c('m', 'a', 'b', 'c'), c('a'), c('b'), c('c')]);
		assert.equal(rows[0]!.art, '●╮╮');
		assert.equal(lanesOf(rows[0]!.after), 'abc');
		// The parents stay in their lanes while there is something to their
		// right; the last one collapses back to the left edge as it ends.
		assert.deepEqual(rows.slice(1).map((row) => row.lane), [0, 1, 0]);
		assert.deepEqual(rows.slice(1).map((row) => row.art), ['●││', ' ●│', '●']);
	});

	it('collapses a lane as soon as nobody waits for it, like git does', () => {
		// A branch ends at v0.2 (which both tips share), so the row of v0.2 moves
		// back into the free lane on its left instead of drifting right.
		const rows = layoutGraph([
			c('m', 'main2', 'feature'),
			c('feature', 'v2'),
			c('main2', 'v3'),
			c('v3', 'v2'),
			c('v2', 'v1'),
			c('v1'),
		]);

		assert.deepEqual(rows.map((row) => row.art), ['●╮', '│●', '●│', '●│', '●', '●']);
		assert.deepEqual(rows.map((row) => row.lane), [0, 1, 0, 0, 0, 0]);
	});

	it('reuses a lane as soon as it is free again', () => {
		// Two unrelated roots: the second one does not need a second lane.
		const rows = layoutGraph([c('a'), c('b')]);
		assert.deepEqual(rows.map((row) => row.lane), [0, 0]);
	});

	it('draws nothing when the lanes are turned off', () => {
		const rows = layoutGraph([c('b', 'a'), c('a')], { draw: false });
		assert.deepEqual(rows.map((row) => row.art), ['', '']);
		assert.equal(rows[0]!.lane, 0, 'the layout is still computed');
	});
});

describe('graph layout - rendering', () => {
	it('keeps a commit visible when the graph is wider than the limit', () => {
		// Seven tips that each keep a lane alive for their parent.
		const tips = Array.from({ length: 7 }, (_, index) => c(`t${index}`, `p${index}`));
		const rows = layoutGraph(tips, { maxLanes: 3 });
		const last = rows[rows.length - 1]!;

		assert.equal(last.lane, 6);
		assert.ok(last.art.includes('●'), `the commit glyph survives: ${JSON.stringify(last.art)}`);
		assert.ok(last.art.startsWith('…'), `the cut is marked: ${JSON.stringify(last.art)}`);
		assert.ok(last.art.length <= 3, `the row stays narrow: ${JSON.stringify(last.art)}`);
	});

	it('does not cut away a commit that fits', () => {
		const art = renderLaneRow([null, null, null], ['a', 'b', 'c'], 0, 2);
		assert.equal(art, '●╮', 'the lanes it opens stay right next to it');
	});

	it('shows the lanes that pass by on the left', () => {
		assert.equal(renderLaneRow(['a', null], ['b', null], 1, 8), '│●');
		assert.equal(renderLaneRow([null, 'a'], [null, 'b'], 1, 8), ' ●');
	});

	it('trims the trailing empty lanes', () => {
		assert.equal(renderLaneRow(['a', null, null], ['b', null, null], 0, 8), '●');
	});

	it('has a sensible default width', () => {
		assert.equal(DEFAULT_MAX_LANES, 6);
	});
});
