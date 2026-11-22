import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Controller } from '../../core/controller';
import { DEFAULT_SETTINGS } from '../../core/config';
import { ACTIONS } from '../../core/ui';
import { forcePush } from '../../core/forcePush';
import type { GitExec } from '../../core/gitRunner';
import { createLinearRepo } from '../helpers/tempRepo';
import { FakeUI } from '../helpers/fakeUi';

const AUTO = { ...DEFAULT_SETTINGS, autoForcePushWithLease: true, forcePushMode: 'force' as const };

describe('automatic force push with lease', () => {
	it('rewords and pushes with lease, keeps undo, and does not wait for a notification', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const remote = await repo.addBareRemote();
			const calls: string[][] = [];
			const exec: GitExec = async (args, options) => { calls.push([...args]); return repo.exec(args, options); };
			class NeverDismissed extends FakeUI {
				override async ask(message: string, options: import('../../core/ui').AskOptions): Promise<string | undefined> {
					this.askCalls.push({ message, options });
					return new Promise(() => undefined);
				}
			}
			const ui = new NeverDismissed({ inputs: ['changed'] });
			const controller = new Controller({ ui, settings: AUTO, exec });
			await controller.rewordCommit(repo.dir, [shas.v04], 'replace');
			assert.equal(await repo.remoteBranchSha(remote, 'main'), await repo.sha('main'));
			const push = calls.find(call => call[0] === 'push');
			assert.ok(push?.some(arg => arg.startsWith('--force-with-lease=')));
			assert.ok(!push?.includes('--force'), 'hard force setting cannot affect automatic push');
			assert.equal(ui.askCalls.length, 1);
			assert.deepEqual(ui.askCalls[0]?.options.actions, [ACTIONS.undo]);
			assert.match(ui.askCalls[0]?.message ?? '', /automatically force-pushed/);
			const journal = await controller.listJournal(repo.dir);
			assert.ok(journal.some(entry => entry.kind === 'forcePush'));
			assert.equal(journal.find(entry => entry.kind === 'forcePush')?.operationId, journal.find(entry => entry.kind === 'reword')?.operationId, 'the push and rewrite are one undo action');
		} finally { repo.cleanup(); }
	});

	it('squashes then automatically pushes', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const remote = await repo.addBareRemote();
			const ui = new FakeUI({ inputs: ['combined'] });
			await new Controller({ ui, settings: AUTO, exec: repo.exec }).squashSelectedCommits(repo.dir, [
				{ gecoKind: 'commit', sha: shas.v04 }, { gecoKind: 'commit', sha: shas.v03 },
			]);
			assert.equal(await repo.remoteBranchSha(remote, 'main'), await repo.sha('main'));
			assert.ok(!ui.askCalls[0]?.options.actions.includes(ACTIONS.forcePush));
		} finally { repo.cleanup(); }
	});

	it('automatically pushes a moved branch', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const remote = await repo.addBareRemote();
			const ui = new FakeUI();
			await new Controller({ ui, settings: AUTO, exec: repo.exec }).fastForward(repo.dir, [shas.v02], { askBranch: false });
			assert.equal(await repo.remoteBranchSha(remote, 'main'), shas.v02);
			assert.ok(!ui.askCalls[0]?.options.actions.includes(ACTIONS.forcePush));
		} finally { repo.cleanup(); }
	});

	it('pushes the rewritten branch, not a different checked-out branch', async () => {
		const { repo } = await createLinearRepo();
		try {
			await repo.gitOk(['checkout', '--quiet', '-b', 'feature']);
			const featureTip = await repo.commit('feature work', { 'feature.txt': 'f\n' });
			const remote = await repo.addBareRemote('origin', ['main', 'feature']);
			await repo.checkout('main');
			const mainBefore = await repo.remoteBranchSha(remote, 'main');
			const ui = new FakeUI({ inputs: ['feature renamed'] });
			await new Controller({ ui, settings: AUTO, exec: repo.exec }).rewordCommit(repo.dir, [featureTip], 'replace');
			assert.equal(await repo.remoteBranchSha(remote, 'feature'), await repo.sha('feature'));
			assert.equal(await repo.remoteBranchSha(remote, 'main'), mainBefore);
			assert.equal(await repo.api.headBranch(), 'main');
		} finally { repo.cleanup(); }
	});

	it('does not push after cancellation or without an upstream', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const remote = await repo.addBareRemote();
			const before = await repo.remoteBranchSha(remote, 'main');
			const ui = new FakeUI({ inputs: ['changed'], confirms: [false] });
			await new Controller({ ui, settings: AUTO, exec: repo.exec }).rewordCommit(repo.dir, [shas.v04], 'replace');
			assert.equal(await repo.remoteBranchSha(remote, 'main'), before);
			assert.equal(await repo.sha('main'), before);
			await repo.gitOk(['branch', '--unset-upstream', 'main']);
			const noUpstream = new FakeUI({ inputs: ['changed'] });
			await new Controller({ ui: noUpstream, settings: AUTO, exec: repo.exec }).rewordCommit(repo.dir, [shas.v04], 'replace');
			assert.equal(await repo.remoteBranchSha(remote, 'main'), before);
			assert.ok(!noUpstream.askCalls[0]?.options.actions.includes(ACTIONS.forcePush));
		} finally { repo.cleanup(); }
	});

	it('is off by default and leaves the manual button', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const remote = await repo.addBareRemote();
			const old = await repo.remoteBranchSha(remote, 'main');
			const ui = new FakeUI({ inputs: ['changed'] });
			await new Controller({ ui, settings: DEFAULT_SETTINGS, exec: repo.exec }).rewordCommit(repo.dir, [shas.v04], 'replace');
			assert.equal(await repo.remoteBranchSha(remote, 'main'), old);
			assert.ok(ui.askCalls[0]?.options.actions.includes(ACTIONS.forcePush));
		} finally { repo.cleanup(); }
	});

	it('refuses a stale lease even if a background fetch changes the tracking ref', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const remote = await repo.addBareRemote();
			let other = '';
			let injected = false;
			const exec: GitExec = async (args, options) => {
				if (!injected && args[0] === 'push' && args.some(a => a.startsWith('--force-with-lease='))) {
					injected = true;
					await repo.pushFromElsewhere(remote, 'colleague work');
					other = (await repo.remoteBranchSha(remote, 'main'))!;
					await repo.fetch();
				}
				return repo.exec(args, options);
			};
			const ui = new FakeUI({ inputs: ['changed'] });
			await new Controller({ ui, settings: AUTO, exec }).rewordCommit(repo.dir, [shas.v04], 'replace');
			assert.ok(injected);
			assert.equal(await repo.remoteBranchSha(remote, 'main'), other);
			assert.ok(ui.messages.some(m => m.kind === 'error' && /Automatic force push/.test(m.message)));
			assert.ok(ui.askCalls[0]?.options.actions.includes(ACTIONS.forcePush));
		} finally { repo.cleanup(); }
	});

	it('does not automatically overwrite known remote work missing from the old local branch', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const remote = await repo.addBareRemote();
			await repo.pushFromElsewhere(remote, 'colleague work');
			const other = await repo.remoteBranchSha(remote, 'main');
			await repo.fetch();
			const ui = new FakeUI({ inputs: ['changed'] });
			await new Controller({ ui, settings: AUTO, exec: repo.exec }).rewordCommit(repo.dir, [shas.v04], 'replace');
			assert.equal(await repo.remoteBranchSha(remote, 'main'), other);
			assert.match(ui.allLogs(), /remote contains history not present/);
			assert.ok(ui.askCalls[0]?.options.actions.includes(ACTIONS.forcePush));
		} finally { repo.cleanup(); }
	});

	it('never pushes a changed local tip using a stale expected SHA', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const remote = await repo.addBareRemote();
			await repo.commit('new tip', { 'new.txt': 'new' });
			await assert.rejects(forcePush(repo.ctx, { branch: 'main', mode: 'lease', expectedLocalSha: shas.v04, expectedRemoteSha: shas.v04 }), /changed after the operation/);
			assert.equal(await repo.remoteBranchSha(remote, 'main'), shas.v04);
		} finally { repo.cleanup(); }
	});
});
