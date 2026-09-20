/**
 * "Remove Redundant Branches": the definition of redundant (no commit of its
 * own), the branches that are protected from it whatever the reachability
 * says, the duplicate-pair rule, the stale-scan re-check and the single
 * journal entry that undoes the whole batch.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { deleteRedundantBranches, findRedundantBranches } from '../../core/redundantBranches';
import { isGecoError } from '../../core/errors';
import { createLinearRepo, createTempRepo, TempRepo } from '../helpers/tempRepo';

/** The scenario the feature exists for: main was fast-forwarded past `old`. */
async function repoWithLeftovers(): Promise<{ repo: TempRepo; shas: Record<string, string> }> {
	const { repo, shas } = await createLinearRepo();
	// `old` is where main used to be - every commit on it is now on main.
	await repo.gitOk(['branch', 'old', shas.v02]);
	// A branch that still has work of its own.
	await repo.gitOk(['checkout', '--quiet', '-b', 'feature', shas.v03]);
	shas.feature = await repo.commit('feature work', { 'f.txt': 'f\n' });
	await repo.checkout('main');
	return { repo, shas };
}

describe('redundant branches - what counts as redundant', () => {
	it('finds the branch a fast-forward left behind and keeps the one with its own work', async () => {
		const { repo, shas } = await repoWithLeftovers();
		try {
			const scan = await findRedundantBranches(repo.ctx);

			assert.deepEqual(scan.redundant.map((b) => b.name), ['old']);
			assert.equal(scan.redundant[0]!.sha, shas.v02);
			assert.ok(scan.redundant[0]!.keptAliveBy.includes('main'), `kept alive by main: ${scan.redundant[0]!.keptAliveBy}`);
			assert.equal(scan.branchCount, 3);

			const feature = scan.kept.find((b) => b.name === 'feature');
			assert.ok(feature, `feature must be kept: ${JSON.stringify(scan.kept)}`);
			assert.equal(feature!.uniqueCommits, 1, 'feature has one commit of its own');
			assert.match(feature!.reason, /only ref that has these commits/);
		} finally {
			repo.cleanup();
		}
	});

	it('never offers the checked-out branch, even when another branch contains it', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			// `main` is checked out and fully contained in `longer`.
			await repo.gitOk(['branch', 'longer', shas.v04]);
			await repo.gitOk(['checkout', '--quiet', 'main']);
			await repo.gitOk(['reset', '--hard', '--quiet', shas.v02]);

			const scan = await findRedundantBranches(repo.ctx);
			assert.equal(scan.redundant.some((b) => b.name === 'main'), false, 'the checked-out branch must never be offered');
			assert.match(scan.kept.find((b) => b.name === 'main')!.reason, /checked out|default branch/);
		} finally {
			repo.cleanup();
		}
	});

	it('never offers the default branch, even when a longer branch contains it', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			await repo.gitOk(['branch', 'longer', shas.v04]);
			// Check out something else first, so only the "default branch" rule
			// is left - git refuses to force-move a branch that is checked out.
			await repo.gitOk(['checkout', '--quiet', 'longer']);
			await repo.gitOk(['branch', '-f', 'main', shas.v02]);

			const scan = await findRedundantBranches(repo.ctx);
			assert.equal(scan.redundant.some((b) => b.name === 'main'), false, 'main is the trunk');
			assert.equal(scan.kept.find((b) => b.name === 'main')!.reason, 'it is the default branch');
		} finally {
			repo.cleanup();
		}
	});

	it('keeps one of two branches that point at the same commit', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			// Two extra names on a commit main already contains: both can go.
			await repo.gitOk(['branch', 'copy-a', shas.v02]);
			await repo.gitOk(['branch', 'copy-b', shas.v02]);

			const scan = await findRedundantBranches(repo.ctx);
			const names = scan.redundant.map((b) => b.name);
			assert.equal(names.includes('copy-a') && names.includes('copy-b'), true, 'both are contained in main');

			// And after deleting them, main still points where it did.
			await deleteRedundantBranches(repo.ctx, scan.redundant);
			assert.deepEqual(await repo.branches(), ['main']);
			assert.equal(await repo.branchSha('main'), shas.v04);
		} finally {
			repo.cleanup();
		}
	});

	it('does not delete both halves of a duplicate pair when nothing else holds them', async () => {
		const repo = await createTempRepo();
		try {
			const first = await repo.commit('v0.1', { 'a.txt': 'a\n' });
			await repo.gitOk(['checkout', '--quiet', '-b', 'work']);
			const tip = await repo.commit('work', { 'w.txt': 'w\n' });
			await repo.gitOk(['branch', 'work-copy', tip]);
			await repo.gitOk(['checkout', '--quiet', 'main']);
			assert.equal(await repo.sha('main'), first);

			const scan = await findRedundantBranches(repo.ctx);
			// Exactly one of the pair may go - the other is the only ref left.
			const pair = scan.redundant.filter((b) => b.name === 'work' || b.name === 'work-copy');
			assert.equal(pair.length, 1, `only one of the pair is redundant: ${scan.redundant.map((b) => b.name)}`);

			await deleteRedundantBranches(repo.ctx, scan.redundant);
			const left = await repo.branches();
			assert.equal(left.includes('work') || left.includes('work-copy'), true, 'the commits survive under one name');
			assert.equal(await repo.sha(left.includes('work') ? 'work' : 'work-copy'), tip);
		} finally {
			repo.cleanup();
		}
	});

	it('treats a tag as a keeper but our own recovery refs as disposable', async () => {
		const repo = await createTempRepo();
		try {
			await repo.commit('v0.1', { 'a.txt': 'a\n' });
			await repo.gitOk(['checkout', '--quiet', '-b', 'tagged']);
			const tagged = await repo.commit('tagged work', { 't.txt': 't\n' });
			await repo.gitOk(['tag', 'v1', tagged]);

			await repo.gitOk(['checkout', '--quiet', '-b', 'backed-up', 'main']);
			const hidden = await repo.commit('only in a recovery ref', { 'h.txt': 'h\n' });
			await repo.ctx.safety.hiddenBackupRef('test/backed-up', hidden);
			await repo.checkout('main');

			const scan = await findRedundantBranches(repo.ctx);
			const names = scan.redundant.map((b) => b.name);
			assert.ok(names.includes('tagged'), 'a tag keeps the commits, so the branch name is redundant');
			assert.equal(names.includes('backed-up'), false, 'our own recovery ref must not make a branch look disposable');
			assert.equal(scan.redundant.find((b) => b.name === 'tagged')!.keptAliveBy.includes('tag:v1'), true);
		} finally {
			repo.cleanup();
		}
	});

	it('names only refs that survive the batch as the reason', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			// Both are redundant, and `b` is one of the refs containing `a`.
			await repo.gitOk(['branch', 'a-old', shas.v02]);
			await repo.gitOk(['branch', 'b-old', shas.v03]);

			const scan = await findRedundantBranches(repo.ctx);
			assert.deepEqual(scan.redundant.map((b) => b.name).sort(), ['a-old', 'b-old']);
			for (const branch of scan.redundant) {
				assert.deepEqual(
					branch.keptAliveBy.filter((name) => name === 'a-old' || name === 'b-old'),
					[],
					`${branch.name} must not be justified by a branch that goes with it: ${branch.keptAliveBy}`,
				);
				assert.ok(branch.keptAliveBy.includes('main'));
			}
		} finally {
			repo.cleanup();
		}
	});

	it('reports nothing to do in a repository with a single branch', async () => {
		const { repo } = await createLinearRepo();
		try {
			const scan = await findRedundantBranches(repo.ctx);
			assert.deepEqual(scan.redundant, []);
			assert.equal(scan.branchCount, 1);
		} finally {
			repo.cleanup();
		}
	});
});

describe('redundant branches - deleting them', () => {
	it('deletes the branch, keeps every file and commit, and journals one undoable entry', async () => {
		const { repo, shas } = await repoWithLeftovers();
		try {
			const before = await repo.log('main');
			const scan = await findRedundantBranches(repo.ctx);
			const result = await deleteRedundantBranches(repo.ctx, scan.redundant);

			assert.deepEqual(result.deleted.map((b) => b.name), ['old']);
			assert.equal(await repo.hasBranch('old'), false);
			// The point of the feature: nothing about the content changed.
			assert.deepEqual(await repo.log('main'), before);
			assert.equal(await repo.sha('main'), shas.v04);
			assert.equal(await repo.hasBranch('feature'), true);

			const journal = await repo.ctx.safety.readJournal();
			assert.equal(journal.length, 1, 'one entry for the whole batch');
			assert.equal(journal[0]!.kind, 'branch');
			assert.match(journal[0]!.summary, /Removed 1 redundant branch/);

			await repo.ctx.safety.undo(journal[0]!);
			assert.equal(await repo.branchSha('old'), shas.v02, 'undo brings the branch back at its old tip');
		} finally {
			repo.cleanup();
		}
	});

	it('undoes a whole batch of branches in one step', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			await repo.gitOk(['branch', 'old', shas.v01]);
			await repo.gitOk(['branch', 'older', shas.v02]);
			await repo.gitOk(['branch', 'oldest', shas.v03]);

			const scan = await findRedundantBranches(repo.ctx);
			assert.deepEqual(scan.redundant.map((b) => b.name).sort(), ['old', 'older', 'oldest']);
			await deleteRedundantBranches(repo.ctx, scan.redundant);
			assert.deepEqual(await repo.branches(), ['main']);

			const journal = await repo.ctx.safety.readJournal();
			assert.equal(journal.length, 1);
			await repo.ctx.safety.undo(journal[0]!);
			assert.deepEqual((await repo.branches()).sort(), ['main', 'old', 'older', 'oldest']);
			assert.equal(await repo.branchSha('older'), shas.v02);
		} finally {
			repo.cleanup();
		}
	});

	it('restores the tracking configuration of a deleted branch', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			await repo.addBareRemote('origin', ['main']);
			await repo.gitOk(['branch', 'old', shas.v02]);
			await repo.gitOk(['branch', '--set-upstream-to=origin/main', 'old']);

			const scan = await findRedundantBranches(repo.ctx);
			assert.equal(scan.redundant.find((b) => b.name === 'old')!.upstream, 'origin/main');
			await deleteRedundantBranches(repo.ctx, scan.redundant);
			assert.equal(await repo.hasBranch('old'), false);
			// The remote is never touched by this operation.
			assert.equal(await repo.hasRef('refs/remotes/origin/main'), true);

			const [entry] = await repo.ctx.safety.readJournal();
			await repo.ctx.safety.undo(entry!);
			assert.equal(await repo.branchSha('old'), shas.v02);
			assert.equal((await repo.ctx.git.upstream('old'))?.ref, 'refs/remotes/origin/main');
		} finally {
			repo.cleanup();
		}
	});

	it('refuses a branch whose tip moved since the scan (a stale scan deletes less, never more)', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			await repo.gitOk(['branch', 'old', shas.v02]);
			const scan = await findRedundantBranches(repo.ctx);
			assert.deepEqual(scan.redundant.map((b) => b.name), ['old']);

			// Meanwhile a commit lands on the branch the scan called redundant.
			await repo.gitOk(['checkout', '--quiet', 'old']);
			const newWork = await repo.commit('new work on old', { 'n.txt': 'n\n' });
			await repo.checkout('main');

			const result = await deleteRedundantBranches(repo.ctx, scan.redundant);
			assert.deepEqual(result.deleted, []);
			assert.equal(result.skipped.length, 1);
			assert.match(result.skipped[0]!.reason, /moved to/);
			assert.equal(await repo.branchSha('old'), newWork, 'the branch and its commit are untouched');
			assert.deepEqual(await repo.ctx.safety.readJournal(), [], 'nothing to undo when nothing was deleted');
		} finally {
			repo.cleanup();
		}
	});

	it('refuses a branch that became the only holder of its commits', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			await repo.gitOk(['branch', 'old', shas.v04]);
			const scan = await findRedundantBranches(repo.ctx);
			assert.deepEqual(scan.redundant.map((b) => b.name), ['old']);

			// main is rewound: `old` is now the only ref with v0.3 and v0.4.
			await repo.gitOk(['reset', '--hard', '--quiet', shas.v02]);

			const result = await deleteRedundantBranches(repo.ctx, scan.redundant);
			assert.deepEqual(result.deleted, []);
			assert.match(result.skipped[0]!.reason, /no other ref has/);
			assert.equal(await repo.branchSha('old'), shas.v04);
		} finally {
			repo.cleanup();
		}
	});

	it('refuses to delete a branch checked out in another worktree', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			await repo.gitOk(['branch', 'parked', shas.v02]);
			await repo.gitOk(['worktree', 'add', '--quiet', `${repo.root}/wt`, 'parked']);

			const scan = await findRedundantBranches(repo.ctx);
			assert.equal(scan.redundant.some((b) => b.name === 'parked'), false);
			assert.match(scan.kept.find((b) => b.name === 'parked')!.reason, /checked out in/);

			// Even when asked directly, it is skipped rather than attempted.
			const result = await deleteRedundantBranches(repo.ctx, [
				{ name: 'parked', sha: shas.v02, subject: 'v0.2', keptAliveBy: ['main'] },
			]);
			assert.deepEqual(result.deleted, []);
			assert.equal(await repo.hasBranch('parked'), true);
		} finally {
			repo.cleanup();
		}
	});

	it('rejects an empty selection instead of silently doing nothing', async () => {
		const { repo } = await createLinearRepo();
		try {
			await assert.rejects(
				() => deleteRedundantBranches(repo.ctx, []),
				(error: unknown) => isGecoError(error) && error.code === 'nothing-to-do',
			);
		} finally {
			repo.cleanup();
		}
	});
});
