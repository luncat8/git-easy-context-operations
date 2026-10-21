/**
 * "The progress bar never ends" - the bug class this project keeps meeting.
 *
 * VS Code resolves the promise of a notification only when the notification
 * goes away: 10 s for an info toast, and *never* under Do Not Disturb, while
 * the mouse hovers it, or while the window is unfocused. A command that awaits
 * its own result report therefore stays pending, and an action started from
 * the built-in Source Control Graph runs under a progress indicator that lasts
 * exactly as long as the command's promise - the endless spinner.
 *
 * The tests below stand in for that notification with one that never settles
 * (`NeverDismissedUI`) and require every flow to finish anyway. They are
 * behaviour-level on purpose: the flows were converted one by one, and each
 * conversion is only worth anything if the command really returns while its
 * report is still on screen.
 *
 * The second half pins the other half of the same UX report: after a squash, a
 * fast-forward or a rewrite the report offers **Force Push**, and pressing it
 * must not ask "push anyway?" again in a modal dialog - the button *is* the
 * answer. A force push started from a menu still asks.
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { Controller } from '../../core/controller';
import { DEFAULT_SETTINGS, type Settings } from '../../core/config';
import { ACTIONS, type AskOptions } from '../../core/ui';
import { createLinearRepo, type TempRepo } from '../helpers/tempRepo';
import { FakeUI, type UIScript } from '../helpers/fakeUi';

const open: TempRepo[] = [];

afterEach(() => {
	while (open.length > 0) {
		open.pop()!.cleanup();
	}
});

/**
 * A UI whose result notification is never dismissed - what the real adapter
 * does under Do Not Disturb, or while the toast is hovered. `askCalls` still
 * records the report, so a test can see that it *was* handed over.
 */
class NeverDismissedUI extends FakeUI {
	constructor(script: UIScript = {}) {
		super(script);
	}

	override async ask(message: string, options: AskOptions): Promise<string | undefined> {
		this.askCalls.push({ message, options });
		return new Promise<string | undefined>(() => undefined);
	}
}

function controllerFor(ui: FakeUI, repo: TempRepo, settings: Settings = DEFAULT_SETTINGS): Controller {
	return new Controller({ ui, settings, exec: repo.exec });
}

async function linear(settings?: Partial<Settings>) {
	const { repo, shas } = await createLinearRepo({ settings });
	open.push(repo);
	return { repo, shas };
}

/** Resolves to the value, or rejects after `ms` - a hang fails the test. */
function within<T>(what: string, promise: Promise<T>, ms = 5000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not finish while its result notification was still on screen`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => {
		if (timer) {
			clearTimeout(timer);
		}
	}) as Promise<T>;
}

describe('no flow waits for its result report', () => {
	it('Rename Commit Message', async () => {
		const { repo, shas } = await linear();
		const ui = new NeverDismissedUI({ inputs: ['renamed'], confirms: [true] });

		await within('a reword', controllerFor(ui, repo).rewordCommit(repo.dir, [shas.v04], 'replace'));

		assert.equal(await repo.subject('main'), 'renamed', 'the rewrite happened');
		assert.equal(ui.askCalls.length, 1, 'the result report was handed over');
		assert.deepEqual(ui.askCalls[0]!.options.actions, [ACTIONS.undo]);
	});

	it('Squash', async () => {
		const { repo, shas } = await linear();
		const ui = new NeverDismissedUI({ inputs: ['combined'], confirms: [true] });

		await within(
			'a squash',
			controllerFor(ui, repo).squashSelectedCommits(repo.dir, [
				{ gecoKind: 'commit', sha: shas.v04 },
				{ gecoKind: 'commit', sha: shas.v03 },
			]),
		);

		assert.equal((await repo.log('main')).length, 3, 'two commits became one');
		assert.equal(ui.askCalls.length, 1, 'the result report was handed over');
	});

	it('Fast-Forward', async () => {
		const { repo, shas } = await linear();
		const ui = new NeverDismissedUI({ confirms: [true] });

		await within('a fast-forward', controllerFor(ui, repo).fastForward(repo.dir, [shas.v02], { askBranch: false }));

		assert.equal(await repo.branchSha('main'), shas.v02, 'the branch moved');
		assert.equal(ui.askCalls.length, 1, 'the result report was handed over');
	});

	it('Force Push', async () => {
		const { repo } = await linear();
		const remoteDir = await repo.addBareRemote('origin');
		await repo.gitOk(['commit', '--quiet', '--amend', '-m', 'rewritten']);
		const ui = new NeverDismissedUI({ confirms: [true] });

		await within('a force push', controllerFor(ui, repo).forcePush(repo.dir, []));

		assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), await repo.sha('main'), 'the remote was overwritten');
		assert.equal(ui.askCalls.length, 1, 'the result report was handed over');
	});

	it('Remove Redundant Branches', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'old', shas.v02]);
		const ui = new NeverDismissedUI();

		await within('a redundant-branch cleanup', controllerFor(ui, repo).removeRedundantBranches(repo.dir));

		assert.equal(await repo.hasBranch('old'), false, 'the redundant name went');
		assert.equal(ui.askCalls.length, 1, 'the result report was handed over');
	});

	it('the branch commands (Create, Check Out, Rename, Delete)', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'other', shas.v02]);

		const create = new NeverDismissedUI({ inputs: ['scratch'] });
		await within('Create Branch', controllerFor(create, repo).createBranch(repo.dir, []));
		assert.equal(await repo.hasBranch('scratch'), true);
		assert.equal(create.askCalls.length, 1);

		const checkout = new NeverDismissedUI();
		await within('Check Out Branch', controllerFor(checkout, repo).checkoutBranch(repo.dir, [{ name: 'other' }]));
		assert.equal(await repo.api.headBranch(), 'other');
		assert.equal(checkout.askCalls.length, 1);

		const rename = new NeverDismissedUI({ inputs: ['renamed'] });
		await within('Rename Branch', controllerFor(rename, repo).renameBranch(repo.dir, [{ name: 'other' }]));
		assert.equal(await repo.hasBranch('renamed'), true);
		assert.equal(rename.askCalls.length, 1);

		// Leave the branch first: a checked-out branch cannot be deleted.
		await repo.checkout('main');
		const remove = new NeverDismissedUI({ confirms: [true] });
		await within('Delete Branch', controllerFor(remove, repo).deleteBranch(repo.dir, [{ name: 'renamed' }]));
		assert.equal(await repo.hasBranch('renamed'), false);
		assert.equal(remove.askCalls.length, 1);
	});

	it('Show Backups', async () => {
		const { repo } = await linear();
		const ui = new NeverDismissedUI();

		await within('Show Backups', controllerFor(ui, repo).showBackups(repo.dir));

		assert.equal(ui.askCalls.length, 1, 'the report was handed over');
	});

	it('a follow-up that fails is logged, never an unhandled rejection', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'old', shas.v02]);
		// The Undo is picked, and the modal it needs cannot be shown: the
		// command is over already, so that failure has to end up in the output
		// log instead of in the extension host.
		class BrokenDialogUI extends FakeUI {
			override async confirm(): Promise<boolean> {
				throw new Error('the dialog service is gone');
			}
		}
		const ui = new BrokenDialogUI({ asks: [ACTIONS.undo] });
		const controller = controllerFor(ui, repo);

		await within('a redundant-branch cleanup', controller.removeRedundantBranches(repo.dir));
		await controller.settled();

		assert.match(ui.allLogs(), /The follow-up of a result report failed: the dialog service is gone/);
		assert.equal(await repo.hasBranch('old'), false, 'the cleanup itself stands');
	});
});

describe('the Force Push button of a report is the confirmation', () => {
	const forcePushModals = (ui: FakeUI) => ui.confirmCalls.filter((call) => /^Force push .* to .*\?$/.test(call.message));

	it('does not ask again after a reword', async () => {
		const { repo, shas } = await linear();
		const remoteDir = await repo.addBareRemote('origin');
		const ui = new FakeUI({ inputs: ['renamed'], asks: [ACTIONS.forcePush] });
		const controller = controllerFor(ui, repo);

		await controller.rewordCommit(repo.dir, [shas.v04], 'replace');
		await controller.settled();

		assert.deepEqual(forcePushModals(ui), [], `only one confirmation for one decision: ${ui.transcript}`);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), await repo.sha('main'), 'the push still happened');
	});

	it('does not ask again after a squash', async () => {
		const { repo, shas } = await linear();
		const remoteDir = await repo.addBareRemote('origin');
		const ui = new FakeUI({ inputs: ['combined'], asks: [ACTIONS.forcePush] });
		const controller = controllerFor(ui, repo);

		await controller.squashSelectedCommits(repo.dir, [
			{ gecoKind: 'commit', sha: shas.v04 },
			{ gecoKind: 'commit', sha: shas.v03 },
		]);
		await controller.settled();

		assert.deepEqual(forcePushModals(ui), [], `only one confirmation for one decision: ${ui.transcript}`);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), await repo.sha('main'), 'the push still happened');
	});

	it('does not ask again after a fast-forward', async () => {
		const { repo, shas } = await linear();
		const remoteDir = await repo.addBareRemote('origin');
		await repo.gitOk(['checkout', '--quiet', '-b', 'feature', shas.v03]);
		const target = await repo.commit('feature work', { 'feature.txt': 'f\n' });
		await repo.checkout('main');
		await repo.commit('main moved on too', { 'main.txt': 'm\n' });

		const ui = new FakeUI({ asks: [ACTIONS.forcePush] });
		const controller = controllerFor(ui, repo);
		await controller.fastForward(repo.dir, [target], { askBranch: false });
		await controller.settled();

		assert.deepEqual(forcePushModals(ui), [], `only one confirmation for one decision: ${ui.transcript}`);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), target, 'the push still happened');
	});

	it('still asks when the force push is started on its own', async () => {
		const { repo } = await linear();
		await repo.addBareRemote('origin');
		await repo.gitOk(['commit', '--quiet', '--amend', '-m', 'rewritten']);
		const ui = new FakeUI();

		await controllerFor(ui, repo).forcePush(repo.dir, []);

		assert.equal(forcePushModals(ui).length, 1, `one confirmation, as a menu command must: ${ui.transcript}`);
	});

	it('does not ask again when the push/sync diagnosis was told to force push', async () => {
		const { repo } = await linear();
		const remoteDir = await repo.addBareRemote('origin');
		// The remote moved on, and this branch has work of its own: exactly the
		// state whose only honest repair is "Force Push (with lease)".
		await repo.pushFromElsewhere(remoteDir, 'a colleague was here');
		await repo.fetch();
		await repo.commit('my own work', { 'mine.txt': 'm\n' });
		// First answer: the force-push repair. Then dismiss the picker.
		const ui = new FakeUI({ picks: (index) => (index === 0 ? 'Force Push (with lease)' : -1) });

		await controllerFor(ui, repo).diagnosePushSync(repo.dir);

		assert.match(ui.transcript, /Force Push \(with lease\) to origin\/main/, 'the repair was offered and picked');
		assert.deepEqual(forcePushModals(ui), [], `the picked repair is the confirmation: ${ui.transcript}`);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), await repo.sha('main'), 'the push happened');
	});
});
