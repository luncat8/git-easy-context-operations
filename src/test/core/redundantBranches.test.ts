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

/**
 * What a merge leaves behind *on the remote*: `origin/fix/x` while `origin/main`
 * already holds every commit of it. The local tracking ref goes with the
 * cleanup; the branch itself only when the caller asks for it - and never while
 * a surviving local branch still tracks it.
 */
async function repoWithMergedRemoteBranch(): Promise<{ repo: TempRepo; remoteDir: string; fixSha: string }> {
	const repo = await createTempRepo();
	await repo.commit('v0.1', { 'a.txt': 'a\n' });
	await repo.gitOk(['checkout', '--quiet', '-b', 'fix/x']);
	const fixSha = await repo.commit('fix work', { 'f.txt': 'f\n' });
	await repo.gitOk(['checkout', '--quiet', 'main']);
	const remoteDir = await repo.addBareRemote('origin', ['main']);
	await repo.gitOk(['push', '--quiet', 'origin', 'fix/x']);
	// The merge that makes the remote branch redundant - and the local name goes.
	await repo.gitOk(['merge', '--quiet', '--no-edit', '-m', 'merge fix/x', 'fix/x']);
	await repo.gitOk(['push', '--quiet', 'origin', 'main']);
	await repo.gitOk(['branch', '-D', 'fix/x']);
	return { repo, remoteDir, fixSha };
}

const REMOTE_FIX = 'refs/remotes/origin/fix/x';

describe('redundant branches - remote-tracking branches', () => {
	it('offers a merged remote branch and removes only the local ref by default', async () => {
		const { repo, remoteDir, fixSha } = await repoWithMergedRemoteBranch();
		try {
			const scan = await findRedundantBranches(repo.ctx);
			const remote = scan.redundant.find((branch) => branch.name === 'origin/fix/x');
			assert.ok(remote, `the merged remote branch must be offered: ${JSON.stringify(scan.redundant)}`);
			assert.equal(remote!.sha, fixSha);
			assert.deepEqual(remote!.remote, { remote: 'origin', branch: 'fix/x', ref: REMOTE_FIX, trackedBy: [] });
			assert.ok(remote!.keptAliveBy.includes('origin/main'), `kept alive by origin/main: ${remote!.keptAliveBy}`);

			const result = await deleteRedundantBranches(repo.ctx, scan.redundant);
			assert.deepEqual(result.deleted.map((branch) => branch.name), ['origin/fix/x']);
			assert.equal(await repo.hasRef(REMOTE_FIX), false, 'the local tracking ref is gone');
			assert.equal(await repo.remoteBranchSha(remoteDir, 'fix/x'), fixSha, 'the remote itself was not touched');
			assert.match(result.notes.join('\n'), /Only the local remote-tracking refs were removed/);

			// The whole batch is one entry, and Undo brings the ref back.
			const journal = await repo.ctx.safety.readJournal();
			assert.equal(journal.length, 1);
			await repo.ctx.safety.undo(journal[0]!);
			assert.equal(await repo.hasRef(REMOTE_FIX), true);
		} finally {
			repo.cleanup();
		}
	});

	it('deletes the branch on the remote when asked, and Undo pushes it back', async () => {
		const { repo, remoteDir, fixSha } = await repoWithMergedRemoteBranch();
		try {
			// With the local branch still there, tracking the remote one: both are
			// redundant, and the cleanup may take the pair in one go.
			await repo.checkout('fix/x');
			await repo.gitOk(['branch', '--set-upstream-to=origin/fix/x', 'fix/x']);
			await repo.checkout('main');
			const scan = await findRedundantBranches(repo.ctx);
			const remote = scan.redundant.find((branch) => branch.name === 'origin/fix/x');
			assert.deepEqual(remote?.remote?.trackedBy, ['fix/x'], 'the tracking configuration is recorded');

			const result = await deleteRedundantBranches(repo.ctx, scan.redundant, { deleteRemote: true });
			assert.deepEqual(result.deleted.map((branch) => branch.name), ['fix/x', 'origin/fix/x']);
			assert.equal(await repo.hasBranch('fix/x'), false);
			assert.equal(await repo.remoteBranchSha(remoteDir, 'fix/x'), undefined, 'the remote branch is gone');
			assert.match(result.notes.join('\n'), /deleted on the remote too/);

			const journal = await repo.ctx.safety.readJournal();
			assert.equal(journal.length, 1, 'one entry for local and remote together');
			await repo.ctx.safety.undo(journal[0]!);
			assert.equal(await repo.remoteBranchSha(remoteDir, 'fix/x'), fixSha, 'Undo pushed the branch back');
			assert.equal(await repo.branchSha('fix/x'), fixSha, 'and recreated the local branch');
			assert.equal((await repo.ctx.git.upstream('fix/x'))?.ref, 'refs/remotes/origin/fix/x');
		} finally {
			repo.cleanup();
		}
	});

	it('never offers the remote trunk, the remote HEAD or the remote copy of the checked out branch', async () => {
		const { repo } = await repoWithMergedRemoteBranch();
		try {
			// A second redundant name on the remote (`extra` == `main`).
			await repo.gitOk(['push', '--quiet', 'origin', 'main:refs/heads/extra']);
			await repo.fetch();
			const names = (await findRedundantBranches(repo.ctx)).redundant.map((branch) => branch.name);
			assert.equal(names.includes('origin/main'), false, 'the trunk of the remote is protected');
			assert.equal(names.includes('origin/HEAD'), false, 'the symbolic HEAD is not a branch');
			assert.equal(names.includes('origin/extra'), true, `a merged, unused name is offered: ${names}`);

			// With a local branch of that name checked out, its remote copy is in use.
			await repo.checkout('extra', { create: true });
			await repo.gitOk(['branch', '--set-upstream-to=origin/extra', 'extra']);
			const after = (await findRedundantBranches(repo.ctx)).redundant.map((branch) => branch.name);
			assert.equal(after.includes('origin/extra'), false, 'the remote copy of the checked out branch is protected');
		} finally {
			repo.cleanup();
		}
	});

	it('keeps a remote branch a surviving local branch tracks, and refuses it in a delete', async () => {
		const { repo } = await repoWithMergedRemoteBranch();
		try {
			// The local branch keeps one commit of its own - it survives, so the
			// remote name it tracks is not offered.
			await repo.gitOk(['checkout', '--quiet', '-b', 'fix/x', 'origin/fix/x']);
			await repo.gitOk(['branch', '--set-upstream-to=origin/fix/x', 'fix/x']);
			await repo.commit('unpushed work', { 'w.txt': 'w\n' });
			await repo.checkout('main');

			const scan = await findRedundantBranches(repo.ctx);
			assert.deepEqual(scan.redundant.map((branch) => branch.name), [], `nothing may go: ${JSON.stringify(scan.redundant)}`);
			assert.match(scan.kept.find((branch) => branch.name === 'fix/x')!.reason, /only ref that has these commits/);

			// Asked directly, the delete still refuses: the tracker survives.
			const remoteSha = await repo.sha('origin/fix/x');
			const result = await deleteRedundantBranches(repo.ctx, [
				{ name: 'origin/fix/x', sha: remoteSha, subject: 'fix work', keptAliveBy: ['origin/main'], remote: { remote: 'origin', branch: 'fix/x', ref: REMOTE_FIX, trackedBy: ['fix/x'] } },
			], { deleteRemote: true });
			assert.deepEqual(result.deleted, []);
			assert.match(result.skipped[0]!.reason, /the local branch "fix\/x" still tracks it/);
			assert.equal(await repo.hasRef(REMOTE_FIX), true);
		} finally {
			repo.cleanup();
		}
	});

	it('refuses a remote branch whose tip moved since the scan', async () => {
		const { repo } = await repoWithMergedRemoteBranch();
		try {
			const scan = await findRedundantBranches(repo.ctx);
			const remote = scan.redundant.find((branch) => branch.name === 'origin/fix/x')!;
			// Meanwhile somebody moved the tracking ref (a fetch of a moved branch).
			// The merge above fast-forwarded, so `main` is the fix commit itself -
			// use the commit before it, which really is a different tip.
			const moved = await repo.sha('main~1');
			assert.notEqual(moved, remote.sha);
			await repo.gitOk(['update-ref', REMOTE_FIX, moved]);

			const result = await deleteRedundantBranches(repo.ctx, [remote]);
			assert.deepEqual(result.deleted, []);
			assert.match(result.skipped[0]!.reason, /it moved to/);
			assert.equal(await repo.hasRef(REMOTE_FIX), true);
		} finally {
			repo.cleanup();
		}
	});

	it('refuses to delete a remote branch a colleague moved (the lease protects their push)', async () => {
		const { repo, remoteDir } = await repoWithMergedRemoteBranch();
		try {
			const scan = await findRedundantBranches(repo.ctx);
			const remote = scan.redundant.find((branch) => branch.name === 'origin/fix/x')!;
			// A colleague pushes to the very branch on the remote; our tracking ref
			// is stale, so the delete must be refused instead of clobbering it.
			await repo.pushFromElsewhere(remoteDir, 'colleague work', 'fix/x');
			const colleague = await repo.remoteBranchSha(remoteDir, 'fix/x');

			const result = await deleteRedundantBranches(repo.ctx, [remote], { deleteRemote: true });
			assert.deepEqual(result.deleted, []);
			assert.match(result.skipped[0]!.reason, /the remote refused it/);
			assert.equal(await repo.remoteBranchSha(remoteDir, 'fix/x'), colleague, 'their commit is still there');
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
