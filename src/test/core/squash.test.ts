import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import {
	collectPreviousCommits,
	composeSquashMessage,
	orderSquashSelection,
	parseSquashCount,
	squashCommits,
} from '../../core/squash';
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

describe('squash - selection helpers', () => {
	test('composeSquashMessage keeps the newest message (that is the state that survives)', () => {
		assert.equal(composeSquashMessage(['wip', 'fix tests', 'review feedback']), 'review feedback');
		assert.equal(composeSquashMessage(['wip\n\nbody\n', '']), 'wip\n\nbody');
		assert.equal(composeSquashMessage(['only one']), 'only one');
		assert.equal(composeSquashMessage([]), '');
	});

	test('parseSquashCount accepts whole numbers in range only', () => {
		assert.equal(parseSquashCount('3'), 3);
		assert.equal(parseSquashCount(' 1 '), 1);
		assert.equal(parseSquashCount('50'), 50);
		assert.equal(parseSquashCount('0'), undefined);
		assert.equal(parseSquashCount('51'), undefined);
		assert.equal(parseSquashCount('-2'), undefined);
		assert.equal(parseSquashCount('two'), undefined);
		assert.equal(parseSquashCount(''), undefined);
		assert.equal(parseSquashCount('2 commits'), undefined);
	});

	test('orders a selection oldest -> newest however the menu listed it', async () => {
		const ordered = await orderSquashSelection(repo.api, [shas.v04!, shas.v02!, shas.v03!]);
		assert.deepEqual(ordered, [shas.v02, shas.v03, shas.v04]);
		assert.deepEqual(await orderSquashSelection(repo.api, ['HEAD', shas.v03!]), [shas.v03, shas.v04]);
	});

	test('refuses commits that are not on the same line of history', async () => {
		await repo.gitOk(['checkout', '--quiet', '-b', 'side', shas.v02!]);
		const side = await repo.commit('side work', { 'side.txt': 's\n' });
		await repo.checkout('main');

		const error = await expectCode(() => orderSquashSelection(repo.api, [shas.v03!, side]), 'not-a-chain');
		assert.match(error.message, /not on the same line of history/);
		assert.match(error.detail ?? '', /Squash with Previous Commits/);
	});

	test('collectPreviousCommits walks first parents, oldest first', async () => {
		assert.deepEqual(await collectPreviousCommits(repo.api, shas.v04!, 2), [shas.v02, shas.v03, shas.v04]);
		assert.deepEqual(await collectPreviousCommits(repo.api, shas.v04!, 1), [shas.v03, shas.v04]);
		// Asking for more than the history has stops at the root instead of failing.
		assert.deepEqual(await collectPreviousCommits(repo.api, shas.v02!, 5), [shas.v01, shas.v02]);
	});
});

describe('squashCommits', () => {
	test('combines the last three commits into one, keeping the newest tree and the oldest parent', async () => {
		const result = await squashCommits(repo.ctx, { commits: [shas.v02!, shas.v03!, shas.v04!] });

		assert.equal(result.branch, 'main');
		assert.equal(result.squashed.length, 3);
		assert.deepEqual(result.squashed.map((commit) => commit.subject), ['v0.2', 'v0.3', 'v0.4']);
		assert.equal(result.base, shas.v01);
		assert.equal(result.oldTip, shas.v04);
		assert.equal(result.newTip, result.newSha);
		assert.equal(await repo.branchSha('main'), result.newSha, 'the branch moved');
		assert.equal(result.message, 'v0.4', 'default message is the newest commit message');
		assert.equal(result.rewritten.length, 1, 'nothing after the selection to replay');

		const log = await repo.log('main');
		assert.deepEqual(log.map((line) => line.subject), ['v0.4', 'v0.1']);
		assert.equal(log[0]!.tree, await repo.tree(shas.v04!), 'the combined commit has the newest tree');
		assert.deepEqual(log[0]!.parents, [shas.v01]);
		assert.equal(log[0]!.authorDate, (await repo.log(shas.v02!, 1))[0]!.authorDate, 'author of the oldest commit is kept');
		assert.equal(result.backupRef?.startsWith('refs/geco/squash/main/'), true, 'a recovery point was created');
	});

		test('a blank combined message is accepted and stored as a single space', async () => {
			for (const typed of ['', '   ']) {
				const { repo: fresh, shas: freshShas } = await createLinearRepo();
				try {
					const result = await squashCommits(fresh.ctx, {
						commits: [freshShas.v02!, freshShas.v03!],
						message: typed,
					});
					assert.equal(result.message, ' ');
					assert.equal(await fresh.ctx.git.rawMessage(result.newSha), ' ');
					assert.equal(result.rewritten[0]!.subject, '', 'the combined commit shows an empty subject');
				} finally {
					fresh.cleanup();
				}
			}
		});

		test('squashing commits whose messages are all blank stores a single space', async () => {
			const fresh = await createTempRepo();
			try {
				fresh.write('a.txt', 'a\n');
				await fresh.gitOk(['add', '-A']);
				await fresh.gitOk(['commit', '--quiet', '--allow-empty-message', '-m', '']);
				fresh.write('b.txt', 'b\n');
				await fresh.gitOk(['add', '-A']);
				await fresh.gitOk(['commit', '--quiet', '--allow-empty-message', '-m', ' ']);
				const result = await squashCommits(fresh.ctx, { commits: ['HEAD~1', 'HEAD'] });
				assert.equal(result.message, ' ');
				assert.equal(await fresh.ctx.git.rawMessage(result.newSha), ' ');
			} finally {
				fresh.cleanup();
			}
		});

		test('replays the commits after the squash and journals one undoable entry', async () => {
		const before = await repo.log('main');
		const result = await squashCommits(repo.ctx, { commits: [shas.v02!, shas.v03!], message: 'v0.2 and v0.3 together' });

		assert.equal(result.newTip, await repo.branchSha('main'));
		assert.deepEqual(result.rewritten.map((entry) => entry.subject), ['v0.2 and v0.3 together', 'v0.4']);
		const after = await repo.log('main');
		assert.deepEqual(after.map((line) => line.subject), ['v0.4', 'v0.2 and v0.3 together', 'v0.1']);
		assert.equal(after[0]!.tree, before[0]!.tree, 'the replayed tip keeps its tree');
		assert.equal(after[0]!.authorDate, before[0]!.authorDate, 'and its author date');
		assert.equal(after[1]!.tree, before[1]!.tree, 'the combined commit keeps the tree of the newest squashed commit');

		const journal = await repo.ctx.safety.readJournal();
		assert.equal(journal.length, 1);
		assert.equal(journal[0]!.kind, 'squash');
		assert.deepEqual(journal[0]!.undo, {
			type: 'refs',
			refs: [{ ref: 'refs/heads/main', restoreTo: shas.v04, expected: result.newTip }],
			deleteRefs: [result.backupRef],
		});
	});

	test('undo puts every squashed commit back', async () => {
		const journalBefore = await repo.ctx.safety.readJournal();
		assert.equal(journalBefore.length, 0);

		const result = await squashCommits(repo.ctx, { commits: [shas.v02!, shas.v03!, shas.v04!] });
		const entry = (await repo.ctx.safety.readJournal()).at(-1)!;
		await repo.ctx.safety.undo(entry);

		assert.equal(await repo.branchSha('main'), shas.v04);
		assert.deepEqual((await repo.log('main')).map((line) => line.subject), ['v0.4', 'v0.3', 'v0.2', 'v0.1']);
		assert.notEqual(result.newSha, shas.v04);
	});

	test('a missing commit in the middle of the selection is refused, with the gap named', async () => {
		const error = await expectCode(
			() => squashCommits(repo.ctx, { commits: [shas.v02!, shas.v04!] }),
			'not-a-chain',
		);
		assert.match(error.message, /has a gap/);
		assert.match(error.detail ?? '', /v0\.3/);
	});

	test('the whole branch can become a single root commit', async () => {
		const result = await squashCommits(repo.ctx, { commits: Object.values(shas) });
		assert.equal(result.base, undefined);

		const log = await repo.log('main');
		assert.equal(log.length, 1);
		assert.deepEqual(log[0]!.parents, [], 'the combined commit has no parent');
		assert.equal(log[0]!.subject, 'v0.4');
		assert.equal(log[0]!.tree, await repo.tree(shas.v04!));
	});

	test('keeps only the first parent when the oldest squashed commit is a merge', async () => {
		await repo.gitOk(['checkout', '--quiet', '-b', 'feature', shas.v03!]);
		await repo.commit('feature work', { 'feature.txt': 'f\n' });
		await repo.checkout('main');
		const merge = await repo.mergeNoFastForward('feature', 'Merge feature');
		const tip = await repo.commit('after the merge', { 'after.txt': 'a\n' });

		const result = await squashCommits(repo.ctx, { commits: [merge, tip], message: 'merge and its follow-up' });
		assert.equal(result.mergeParentsDropped, true, 'only the first parent of the merge survives');
		const log = await repo.log('main');
		assert.deepEqual(log.map((line) => line.subject), ['merge and its follow-up', 'v0.4', 'v0.3', 'v0.2', 'v0.1']);
		assert.deepEqual(log[0]!.parents, [shas.v04], 'the merge is gone');
		assert.equal(log[0]!.tree, await repo.tree(tip), 'the tree is the one of the newer commit');
	});

	test('refuses a range that is only reachable through a merge', async () => {
		await repo.gitOk(['checkout', '--quiet', '-b', 'feature', shas.v02!]);
		const feature = await repo.commit('feature work', { 'feature.txt': 'f\n' });
		await repo.checkout('main');
		const merge = await repo.mergeNoFastForward('feature', 'Merge feature');

		// feature -> merge is not a first-parent run (main's own tip is the merge's first parent).
		const error = await expectCode(() => squashCommits(repo.ctx, { commits: [feature, merge] }), 'not-a-chain');
		assert.match(error.message, /connected through a merge/);
	});

	test('works with a dirty working tree and leaves it alone', async () => {
		repo.write('uncommitted.txt', 'not committed\n');
		const statusBefore = await repo.statusLines();

		const result = await squashCommits(repo.ctx, { commits: [shas.v03!, shas.v04!] });
		assert.equal(await repo.branchSha('main'), result.newSha);
		assert.deepEqual(await repo.statusLines(), statusBefore, 'the working tree is untouched');
		assert.equal(repo.read('c.txt'), 'c\n', 'and so are the files');
	});

	test('needs at least two commits and a branch', async () => {
		await expectCode(() => squashCommits(repo.ctx, { commits: [shas.v04!] }), 'nothing-to-do');

		await repo.gitOk(['checkout', '--quiet', '--detach', shas.v04!]);
		await expectCode(() => squashCommits(repo.ctx, { commits: [shas.v03!, shas.v04!] }), 'detached-head');
	});

	test('refuses a commit that is not on the branch being rewritten', async () => {
		await repo.gitOk(['checkout', '--quiet', '-b', 'side', shas.v02!]);
		const side = await repo.commit('side work', { 'side.txt': 's\n' });
		await repo.checkout('main');
		await repo.commit('main work', { 'main.txt': 'm\n' });

		const error = await expectCode(
			() => squashCommits(repo.ctx, { commits: [side, 'HEAD'] }),
			'not-a-chain',
		);
		assert.match(error.message, /not on the same line of history/);
	});

	test('reports whether a force push is needed for a pushed branch', async () => {
		const remote = await repo.addBareRemote('origin', ['main']);
		const result = await squashCommits(repo.ctx, { commits: [shas.v03!, shas.v04!] });

		assert.equal(result.needsForcePush, true);
		assert.equal(result.upstreamRef, 'origin/main');
		assert.equal(await repo.remoteBranchSha(remote, 'main'), shas.v04, 'the remote still has the old history');
	});
});
