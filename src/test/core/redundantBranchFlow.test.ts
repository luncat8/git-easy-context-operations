/**
 * The interactive half of the two 0.4 features:
 *
 *   1. "Remove Redundant Branches..." end to end - what the user is shown,
 *      what an unticked checkbox does, what a cancel does, and the Undo
 *      follow-up action;
 *   2. the refresh hook - every operation that changes the graph (and every
 *      undo) tells the view to reload, *before* the flow returns, which is
 *      what keeps the sidebar from showing a stale graph after a squash.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_SETTINGS, type Settings } from '../../core/config';
import { Controller } from '../../core/controller';
import { ACTIONS } from '../../core/ui';
import { createTempRepo, createLinearRepo, TempRepo } from '../helpers/tempRepo';
import { FakeUI } from '../helpers/fakeUi';

function controllerFor(ui: FakeUI, repo: TempRepo, settings: Settings = DEFAULT_SETTINGS, onRepositoryChanged?: () => void): Controller {
	return new Controller({ ui, settings, exec: repo.exec, onRepositoryChanged });
}

/** main at v0.4, plus `old` at v0.2 (what a fast-forward leaves behind). */
async function repoWithLeftover(): Promise<{ repo: TempRepo; shas: Record<string, string> }> {
	const { repo, shas } = await createLinearRepo();
	await repo.gitOk(['branch', 'old', shas.v02]);
	return { repo, shas };
}

describe('controller - remove redundant branches flow', () => {
	it('lists what would go, deletes it and offers Undo', async () => {
		const { repo, shas } = await repoWithLeftover();
		try {
			const ui = new FakeUI();
			await controllerFor(ui, repo).removeRedundantBranches(repo.dir);

			// The picker explains *why* each branch is redundant.
			assert.equal(ui.multiPickCalls.length, 1, `expected a multi-select: ${ui.transcript}`);
			const [pick] = ui.multiPickCalls;
			assert.deepEqual(pick!.items.map((item) => item.label), ['old']);
			assert.equal(pick!.items[0]!.picked, true, 'redundant branches are pre-ticked');
			assert.match(pick!.items[0]!.detail!, /already contained in main/);

			// The modal confirmation states the safety property in plain words.
			assert.equal(ui.confirmCalls.length, 1);
			assert.match(ui.confirmCalls[0]!.message, /Delete the redundant branch "old"\?/);
			assert.match(ui.confirmCalls[0]!.options!.detail!, /No commit is lost/);
			assert.equal(ui.confirmCalls[0]!.options!.destructive, true);

			assert.equal(await repo.hasBranch('old'), false);
			assert.equal(await repo.sha('main'), shas.v04, 'main is untouched');
			assert.match(ui.askCalls[0]!.message, /Removed the redundant branch "old"\./);
			assert.deepEqual(ui.askCalls[0]!.options.actions, [ACTIONS.undo]);
		} finally {
			repo.cleanup();
		}
	});

	it('brings the branch back when the user picks Undo', async () => {
		const { repo, shas } = await repoWithLeftover();
		try {
			const ui = new FakeUI({ asks: ACTIONS.undo });
			await controllerFor(ui, repo).removeRedundantBranches(repo.dir);

			assert.equal(await repo.branchSha('old'), shas.v02, 'Undo restored the branch at its old tip');
			assert.deepEqual(await repo.ctx.safety.readJournal(), [], 'the journal entry is consumed');
		} finally {
			repo.cleanup();
		}
	});

	it('keeps a branch the user unticks', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			await repo.gitOk(['branch', 'old', shas.v02]);
			await repo.gitOk(['branch', 'older', shas.v01]);

			// Tick only "older"; "old" stays behind.
			const ui = new FakeUI({ multiPicks: [['older']] });
			await controllerFor(ui, repo).removeRedundantBranches(repo.dir);

			assert.equal(await repo.hasBranch('older'), false);
			assert.equal(await repo.branchSha('old'), shas.v02, 'the unticked branch survives');
			assert.match(ui.confirmCalls[0]!.message, /Delete the redundant branch "older"\?/);
		} finally {
			repo.cleanup();
		}
	});

	it('does nothing when the picker is dismissed', async () => {
		const { repo, shas } = await repoWithLeftover();
		try {
			const ui = new FakeUI({ multiPicks: null });
			await controllerFor(ui, repo).removeRedundantBranches(repo.dir);

			assert.equal(await repo.branchSha('old'), shas.v02);
			assert.equal(ui.confirmCalls.length, 0, 'a dismissed picker must not fall through to a delete');
			assert.match(ui.allLogs(), /cancelled, every branch was kept/);
		} finally {
			repo.cleanup();
		}
	});

	it('does nothing when the confirmation is declined', async () => {
		const { repo, shas } = await repoWithLeftover();
		try {
			const ui = new FakeUI({ confirms: false });
			await controllerFor(ui, repo).removeRedundantBranches(repo.dir);

			assert.equal(await repo.branchSha('old'), shas.v02);
			assert.deepEqual(await repo.ctx.safety.readJournal(), []);
		} finally {
			repo.cleanup();
		}
	});

	it('explains that there is nothing to clean up when every branch has its own work', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			await repo.gitOk(['checkout', '--quiet', '-b', 'feature', shas.v03]);
			await repo.commit('feature work', { 'f.txt': 'f\n' });
			await repo.checkout('main');

			const ui = new FakeUI();
			await controllerFor(ui, repo).removeRedundantBranches(repo.dir);

			assert.equal(ui.multiPickCalls.length, 0);
			assert.equal(ui.confirmCalls.length, 0);
			assert.match(ui.allMessages(), /No redundant branches/);
			assert.equal(await repo.hasBranch('feature'), true);
		} finally {
			repo.cleanup();
		}
	});

	it('reports the protected branches instead of silently skipping them', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			await repo.gitOk(['branch', 'old', shas.v02]);
			const ui = new FakeUI();
			await controllerFor(ui, repo).removeRedundantBranches(repo.dir);

			assert.match(ui.allLogs(), /kept: main .* - it is (checked out|the default branch)/);
			assert.match(ui.allLogs(), /redundant: old .* already in main/);
		} finally {
			repo.cleanup();
		}
	});
});

/** A branch that was merged on the remote and no longer exists locally. */
async function repoWithMergedRemoteBranch(): Promise<{ repo: TempRepo; remoteDir: string; fixSha: string }> {
	const repo = await createTempRepo();
	await repo.commit('v0.1', { 'a.txt': 'a\n' });
	await repo.gitOk(['checkout', '--quiet', '-b', 'fix/x']);
	const fixSha = await repo.commit('fix work', { 'f.txt': 'f\n' });
	await repo.gitOk(['checkout', '--quiet', 'main']);
	const remoteDir = await repo.addBareRemote('origin', ['main']);
	await repo.gitOk(['push', '--quiet', 'origin', 'fix/x']);
	await repo.gitOk(['merge', '--quiet', '--no-edit', '-m', 'merge fix/x', 'fix/x']);
	await repo.gitOk(['push', '--quiet', 'origin', 'main']);
	await repo.gitOk(['branch', '-D', 'fix/x']);
	return { repo, remoteDir, fixSha };
}

describe('controller - remove redundant branches flow, remote branches', () => {
	it('asks where the remote branch should go and, by default answer, keeps it on the remote', async () => {
		const { repo, remoteDir, fixSha } = await repoWithMergedRemoteBranch();
		try {
			// The extra question only appears because a remote branch was selected.
			const ui = new FakeUI({ picks: ['Remove them locally only'] });
			await controllerFor(ui, repo).removeRedundantBranches(repo.dir);

			assert.equal(ui.pickCalls.length, 1, `expected the scope question: ${ui.transcript}`);
			assert.deepEqual(ui.pickCalls[0]!.items.map((item) => item.label), ['Remove them locally only', 'Remove them locally and on the remote']);
			assert.match(ui.pickCalls[0]!.options!.title!, /remote branches/);

			assert.equal(await repo.hasRef('refs/remotes/origin/fix/x'), false, 'the local tracking ref is gone');
			assert.equal(await repo.remoteBranchSha(remoteDir, 'fix/x'), fixSha, 'the branch itself stays on the remote');
			assert.match(ui.confirmCalls[0]!.options!.detail!, /stay on the remote, only the local remote-tracking refs go/);
			assert.match(ui.allLogs(), /redundant: origin\/fix\/x .* \[remote branch on origin\]/);
		} finally {
			repo.cleanup();
		}
	});

	it('deletes it on the remote when that answer is chosen', async () => {
		const { repo, remoteDir } = await repoWithMergedRemoteBranch();
		try {
			const ui = new FakeUI({ picks: ['Remove them locally and on the remote'] });
			await controllerFor(ui, repo).removeRedundantBranches(repo.dir);

			assert.equal(await repo.remoteBranchSha(remoteDir, 'fix/x'), undefined, 'the branch is gone from the remote');
			assert.equal(await repo.hasRef('refs/remotes/origin/fix/x'), false);
			assert.match(ui.confirmCalls[0]!.options!.detail!, /deleted on origin as well/);
			assert.match(ui.askCalls[0]!.message, /Removed the redundant branch "origin\/fix\/x"/);
			assert.match(ui.allLogs(), /The remote branch was deleted on the remote too/);
		} finally {
			repo.cleanup();
		}
	});

	it('pushes the remote branch back when the user picks Undo', async () => {
		const { repo, remoteDir, fixSha } = await repoWithMergedRemoteBranch();
		try {
			// `asks: ACTIONS.undo` means the Undo runs before the flow returns.
			const ui = new FakeUI({ picks: ['Remove them locally and on the remote'], asks: ACTIONS.undo });
			await controllerFor(ui, repo).removeRedundantBranches(repo.dir);

			assert.equal(await repo.remoteBranchSha(remoteDir, 'fix/x'), fixSha, 'Undo pushed the branch back');
			assert.equal(await repo.hasRef('refs/remotes/origin/fix/x'), true, 'the tracking ref is back too');
			assert.deepEqual(await repo.ctx.safety.readJournal(), [], 'the journal entry is consumed');
		} finally {
			repo.cleanup();
		}
	});

	it('keeps every branch when the remote question is dismissed', async () => {
		const { repo, remoteDir, fixSha } = await repoWithMergedRemoteBranch();
		try {
			const ui = new FakeUI({ picks: -1 });
			await controllerFor(ui, repo).removeRedundantBranches(repo.dir);

			assert.equal(ui.confirmCalls.length, 0, 'a dismissed question must not fall through to a delete');
			assert.equal(await repo.hasRef('refs/remotes/origin/fix/x'), true);
			assert.equal(await repo.remoteBranchSha(remoteDir, 'fix/x'), fixSha);
			assert.match(ui.allLogs(), /cancelled, every branch was kept/);
		} finally {
			repo.cleanup();
		}
	});
});

describe('controller - the view is refreshed when the graph changes', () => {
	it('fires after a squash rewrote the history', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			let refreshes = 0;
			const ui = new FakeUI({ inputs: ['one commit'] });
			await controllerFor(ui, repo, DEFAULT_SETTINGS, () => refreshes++)
				.squashSelectedCommits(repo.dir, [shas.v03, shas.v04]);

			assert.equal((await repo.log('main')).length, 3, 'the squash really happened');
			assert.ok(refreshes >= 1, 'the view was told to reload after the squash');
		} finally {
			repo.cleanup();
		}
	});

	it('fires again for the Undo that runs after the flow reported its result', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const events: number[] = [];
			// "Undo" is chosen in the notification - the part that used to run
			// after the command had already returned and left a stale view.
			const ui = new FakeUI({ inputs: ['one commit'], asks: ACTIONS.undo });
			await controllerFor(ui, repo, DEFAULT_SETTINGS, () => events.push(events.length))
				.squashSelectedCommits(repo.dir, [shas.v03, shas.v04]);

			assert.equal(await repo.sha('main'), shas.v04, 'the undo restored the original tip');
			assert.ok(events.length >= 2, `squash and undo both refresh the view, got ${events.length}`);
		} finally {
			repo.cleanup();
		}
	});

	it('fires after a fast-forward, a branch delete and a redundant-branch cleanup', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			await repo.gitOk(['branch', 'old', shas.v02]);
			await repo.gitOk(['branch', 'topic', shas.v03]);
			await repo.gitOk(['checkout', '--quiet', '-b', 'work', shas.v02]);

			let refreshes = 0;
			const controller = controllerFor(new FakeUI(), repo, DEFAULT_SETTINGS, () => refreshes++);

			await controller.deleteBranch(repo.dir, [{ gecoKind: 'branch', name: 'topic', repoPath: repo.dir }]);
			assert.equal(await repo.hasBranch('topic'), false);
			const afterDelete = refreshes;
			assert.ok(afterDelete >= 1, 'deleting a branch refreshes the view');

			await repo.checkout('main');
			await controller.removeRedundantBranches(repo.dir);
			assert.equal(await repo.hasBranch('old'), false);
			assert.ok(refreshes > afterDelete, 'the cleanup refreshes the view too');
		} finally {
			repo.cleanup();
		}
	});

	it('never lets a broken refresh listener break the git operation', async () => {
		const { repo } = await repoWithLeftover();
		try {
			const ui = new FakeUI();
			await controllerFor(ui, repo, DEFAULT_SETTINGS, () => {
				throw new Error('the view blew up');
			}).removeRedundantBranches(repo.dir);

			assert.equal(await repo.hasBranch('old'), false, 'the branch was still deleted');
			assert.equal(ui.messages.filter((m) => m.kind === 'error').length, 0, `no error was shown: ${ui.allMessages()}`);
		} finally {
			repo.cleanup();
		}
	});

	it('does not fire for a read-only view query', async () => {
		const { repo } = await createLinearRepo();
		try {
			let refreshes = 0;
			const controller = controllerFor(new FakeUI(), repo, DEFAULT_SETTINGS, () => refreshes++);
			await controller.graphRows(repo.dir);
			await controller.listBranches(repo.dir);
			await controller.listRecoveryPoints(repo.dir);
			assert.equal(refreshes, 0, 'reading the graph must not schedule a repaint');
		} finally {
			repo.cleanup();
		}
	});
});
