/**
 * Reorder: the pure plan helpers (shifts, the new order, the conflict rule)
 * against real repositories, plus the rewrite itself - trees, SHAs, the
 * journal and the undo.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import {
	changedPaths,
	clampShift,
	collectCrossed,
	findCrossedBlocker,
	firstParentChain,
	formatShift,
	parseShift,
	planMove,
	planRebuild,
	reorderCommits,
	reorderedChain,
} from '../../core/reorder';
import { GecoError } from '../../core/errors';
import { createLinearRepo, createTempRepo, type TempRepo } from '../helpers/tempRepo';

let repo: TempRepo;
let shas: Record<string, string>;

beforeEach(async () => {
	({ repo, shas } = await createLinearRepo());
});

afterEach(() => {
	repo.cleanup();
});

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<GecoError> {
	try {
		await fn();
	} catch (error) {
		assert.ok(error instanceof GecoError, `expected a GecoError, got ${String(error)}`);
		assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.userMessage}`);
		return error;
	}
	throw new assert.AssertionError({ message: 'expected the operation to fail, but it succeeded' });
}

describe('reorder - plan helpers', () => {
	test('parseShift accepts signed whole numbers except zero', () => {
		assert.equal(parseShift('-1'), -1);
		assert.equal(parseShift(' 3 '), 3);
		assert.equal(parseShift('+2'), 2);
		assert.equal(parseShift('0'), undefined);
		assert.equal(parseShift('-0'), undefined);
		assert.equal(parseShift('two'), undefined);
		assert.equal(parseShift(''), undefined);
		assert.equal(parseShift('2 commits'), undefined);
	});

	test('formatShift is the button label', () => {
		assert.equal(formatShift(1), '+1');
		assert.equal(formatShift(-3), '-3');
	});

	test('clampShift stops at the ends of the list instead of refusing', () => {
		assert.equal(clampShift(99, 3, 5), 3, 'past the top moves to the top');
		assert.equal(clampShift(-99, 3, 5), -5, 'past the bottom moves to the bottom');
		assert.equal(clampShift(2, 3, 5), 2, 'a possible shift is kept');
		assert.equal(clampShift(-2, 3, 5), -2);
		assert.equal(clampShift(5, 0, 4), 0, 'no room up is zero, not a negative');
		assert.equal(clampShift(-5, 4, 0), 0, 'no room down is zero, not a positive');
		assert.equal(clampShift(0, 4, 4), 0);
	});

	test('reorderedChain splices the commit up or down', () => {
		const chain = ['d', 'c', 'b', 'a']; // newest first
		assert.deepEqual(reorderedChain(chain, 2, 1), ['d', 'b', 'c', 'a'], 'up swaps with the newer neighbour');
		assert.deepEqual(reorderedChain(chain, 1, -1), ['d', 'b', 'c', 'a'], 'down swaps with the previous commit');
		assert.deepEqual(reorderedChain(chain, 2, 2), ['b', 'd', 'c', 'a'], 'up to the top');
		assert.deepEqual(reorderedChain(chain, 1, -2), ['d', 'b', 'a', 'c'], 'down two passes both older commits');
		assert.deepEqual(reorderedChain(chain, 0, -3), ['c', 'b', 'a', 'd'], 'the tip can become the root');
	});

	test('planRebuild rewrites from the first changed link up, never below', () => {
		const chain = ['d', 'c', 'b', 'a'];
		const down = planRebuild(chain, 1, -1); // c moves down one
		assert.deepEqual(down.newChain, ['d', 'b', 'c', 'a']);
		assert.deepEqual([...down.rebuilt].sort(), ['b', 'c', 'd'], 'everything from the new position to the tip is rebuilt');

		const up = planRebuild(chain, 2, 2); // b moves to the top
		assert.deepEqual(up.newChain, ['b', 'd', 'c', 'a']);
		assert.deepEqual([...up.rebuilt].sort(), ['b', 'c', 'd'], 'the crossed commits and the moved one, plus the tip link');

		const toRoot = planRebuild(chain, 0, -3); // the tip travels to the root
		assert.deepEqual(toRoot.newChain, ['c', 'b', 'a', 'd']);
		assert.deepEqual([...toRoot.rebuilt].sort(), ['a', 'b', 'c', 'd'], 'everybody is below the new position of the tip');
	});

	test('collectCrossed lists the commits in travel order', () => {
		const chain = ['d', 'c', 'b', 'a'];
		assert.deepEqual(collectCrossed(chain, 2, 2), ['c', 'd'], 'up walks toward the tip, closest first');
		assert.deepEqual(collectCrossed(chain, 1, -2), ['b', 'a'], 'down walks toward the root');
		assert.deepEqual(collectCrossed(chain, 1, 1), ['d'], 'one step up crosses the tip');
	});

	test('firstParentChain walks tip to root', async () => {
		assert.deepEqual(await firstParentChain(repo.api, shas.v04!), [shas.v04, shas.v03, shas.v02, shas.v01]);
	});

	test('planMove finds the index and the room in both directions', async () => {
		const plan = await planMove(repo.api, 'main', shas.v03!);
		assert.equal(plan.index, 1, 'the tip is position 0 of the list');
		assert.equal(plan.maxUp, 1, 'one commit sits above v0.3');
		assert.equal(plan.maxDown, 2, 'two commits sit below it');
		assert.equal(plan.target, shas.v03);
	});

	test('planMove refuses a commit that is not on the branch line', async () => {
		await repo.gitOk(['checkout', '--quiet', '-b', 'side', shas.v02!]);
		const side = await repo.commit('side work', { 'side.txt': 's\n' });
		await repo.checkout('main');

		const error = await expectCode(() => planMove(repo.api, 'main', side), 'not-a-chain');
		assert.match(error.message, /not on the line of history of "main"/);
	});
});

describe('reorder - the conflict rule', () => {
	test('findCrossedBlocker stops at the first commit sharing a file', async () => {
		// oldest -> newest: base(a) / move me(a) / other(b) / later a(a)
		await repo.commit('base', { 'a.txt': '1\n' });
		const moved = await repo.commit('move me', { 'a.txt': '2\n' });
		const clean = await repo.commit('other', { 'b.txt': 'x\n' });
		await repo.commit('later a', { 'a.txt': '4\n' });

		const targetPaths = await changedPaths(repo.api, moved);
		const chain = await firstParentChain(repo.api, await repo.sha('HEAD'));
		const index = chain.indexOf(moved);

		const blocker = await findCrossedBlocker(repo.api, targetPaths, collectCrossed(chain, index, 2));
		assert.ok(blocker, 'the crossing is not disjoint');
		assert.equal(blocker!.distance, 2, 'the clean commit in between is crossed first');
		assert.deepEqual(blocker!.files, ['a.txt']);
		assert.equal(blocker!.sha, chain[0], 'the topmost commit is the one that conflicts');

		const onlyClean = await findCrossedBlocker(repo.api, targetPaths, [clean]);
		assert.equal(onlyClean, undefined, 'a disjoint crossing has no blocker');
	});

	test('a rename blocks on the old name as well as the new one', async () => {
		await repo.commit('base', { 'old.txt': 'same content\n' });
		await repo.gitOk(['mv', 'old.txt', 'new.txt']);
		const moved = await repo.commit('rename the file');
		// The next commit brings the old name back - crossing the rename
		// would have to touch both names.
		await repo.write('old.txt', 'back again\n');
		await repo.commit('touch the old name');

		const targetPaths = await changedPaths(repo.api, moved);
		assert.deepEqual([...targetPaths].sort(), ['new.txt', 'old.txt'], 'a rename reports both names');
		const blocker = await findCrossedBlocker(repo.api, targetPaths, [await repo.sha('HEAD')]);
		assert.ok(blocker, 'the recreated old name blocks the crossing');
		assert.deepEqual(blocker!.files, ['old.txt']);
	});
});

describe('reorderCommits', () => {
	test('moves a commit down one position and keeps the tip tree', async () => {
		const tipTree = await repo.tree('main');
		const plan = await planMove(repo.api, 'main', shas.v03!);
		const result = await reorderCommits(repo.ctx, { plan, shift: -1 });

		const log = await repo.log('main');
		assert.deepEqual(log.map((line) => line.subject), ['v0.4', 'v0.2', 'v0.3', 'v0.1']);
		assert.equal(log[0]!.tree, tipTree, 'the content of the tip does not change');
		assert.equal(log[3]!.sha, shas.v01, 'the untouched tail keeps its SHAs');
		assert.notEqual(log[1]!.sha, shas.v02, 'everything from the new position up is rebuilt');
		assert.equal(result.fromPosition, 2);
		assert.equal(result.toPosition, 3);
		assert.equal(result.shift, -1);
		assert.equal(result.newTip, log[0]!.sha);
		assert.equal(result.commit.from, shas.v03);
		assert.notEqual(result.commit.to, shas.v03, 'the moved commit gets a new SHA');
	});

	test('moves a commit up to the top of the list', async () => {
		const tipTree = await repo.tree('main');
		const plan = await planMove(repo.api, 'main', shas.v02!);
		const result = await reorderCommits(repo.ctx, { plan, shift: 2 });

		const log = await repo.log('main');
		assert.deepEqual(log.map((line) => line.subject), ['v0.2', 'v0.4', 'v0.3', 'v0.1']);
		assert.equal(log[0]!.tree, tipTree, 'the content of the tip does not change');
		assert.equal(result.fromPosition, 3);
		assert.equal(result.toPosition, 1);
	});

	test('the tip can travel all the way down to the root', async () => {
		const tipTree = await repo.tree('main');
		const plan = await planMove(repo.api, 'main', shas.v04!);
		const result = await reorderCommits(repo.ctx, { plan, shift: -3 });

		const log = await repo.log('main');
		assert.deepEqual(log.map((line) => line.subject), ['v0.3', 'v0.2', 'v0.1', 'v0.4']);
		assert.equal(log[0]!.tree, tipTree, 'still the same content, only the order moved');
		assert.equal(result.toPosition, 4);
		assert.equal(log[3]!.parents.length, 0, 'the moved commit is the new root');
	});

	test('journals one undoable entry and undo puts the order back', async () => {
		const plan = await planMove(repo.api, 'main', shas.v03!);
		const result = await reorderCommits(repo.ctx, { plan, shift: -1 });

		const journal = await repo.ctx.safety.readJournal();
		assert.equal(journal.length, 1);
		assert.equal(journal[0]!.kind, 'reorder');
		assert.match(journal[0]!.summary, /Moved [0-9a-f]{7,10} down 1 to position 3 on main/);
		assert.deepEqual(journal[0]!.undo, {
			type: 'refs',
			refs: [{ ref: 'refs/heads/main', restoreTo: shas.v04, expected: result.newTip }],
			deleteRefs: [result.backupRef],
		});

		await repo.ctx.safety.undo(journal[0]!);
		assert.equal(await repo.branchSha('main'), shas.v04);
		assert.deepEqual((await repo.log('main')).map((line) => line.subject), ['v0.4', 'v0.3', 'v0.2', 'v0.1']);
	});

	test('a shift past the end of the list is refused by the operation itself', async () => {
		const plan = await planMove(repo.api, 'main', shas.v03!);
		await expectCode(() => reorderCommits(repo.ctx, { plan, shift: -5 }), 'rejected');
		assert.equal(await repo.branchSha('main'), shas.v04, 'nothing moved');
	});

	test('a branch that moved while the plan was open is not rewritten', async () => {
		const plan = await planMove(repo.api, 'main', shas.v03!);
		await repo.commit('raced', { 'race.txt': 'r\n' });

		const error = await expectCode(() => reorderCommits(repo.ctx, { plan, shift: -1 }), 'rejected');
		assert.match(error.message, /moved while the move was being prepared/);
		assert.equal(await repo.branchSha('main'), await repo.sha('HEAD'), 'the new tip is untouched');
	});

	test('a one-commit repository has nowhere to move', async () => {
		const only = await createTempRepo();
		try {
			await only.commit('root', { 'a.txt': 'a\n' });
			const plan = await planMove(only.api, 'main', await only.sha('HEAD'));
			assert.equal(plan.maxUp, 0);
			assert.equal(plan.maxDown, 0);
		} finally {
			only.cleanup();
		}
	});
});
