/**
 * The interactive branch flows: exactly what a user sees when they right-click a
 * commit or a branch row in the Source Control Graph (or in our own view) and
 * pick **Create / Rename / Delete / Check Out Branch**.
 *
 * The argument shapes below are the ones VS Code hands a graph menu command:
 * the provider first, then the row - `{id: '<sha>'}` for a commit and
 * `{id: 'refs/heads/<branch>', name: '<branch>'}` for a ref.
 */
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { Controller } from '../../core/controller';
import { ACTIONS } from '../../core/ui';
import { createLinearRepo, createTempRepo, type TempRepo } from '../helpers/tempRepo';
import { FakeUI } from '../helpers/fakeUi';
import type { Settings } from '../../core/config';

const open: TempRepo[] = [];

afterEach(() => {
	while (open.length > 0) {
		open.pop()!.cleanup();
	}
});

/** The controller always sees the same settings the repository context uses. */
function controllerFor(ui: FakeUI, repo: TempRepo): Controller {
	return new Controller({ ui, settings: repo.ctx.settings, exec: repo.exec });
}

async function linear(settings?: Partial<Settings>) {
	const { repo, shas } = await createLinearRepo({ settings });
	open.push(repo);
	return { repo, shas };
}

async function withRemote(settings?: Partial<Settings>) {
	const { repo, shas } = await linear(settings);
	const remoteDir = await repo.addBareRemote('origin', ['main']);
	return { repo, shas, remoteDir };
}

/** A pushed branch that is not the remote's default one (renaming that is refused). */
async function withPushedTopic(repo: TempRepo, shas: Record<string, string>) {
	await repo.gitOk(['checkout', '--quiet', '-b', 'topic', shas.v02]);
	await repo.gitOk(['push', '--quiet', '-u', 'origin', 'topic:topic']);
	return repo.sha('topic');
}

const provider = (repo: TempRepo) => ({ id: 'git', rootUri: { scheme: 'file', fsPath: repo.dir, path: repo.dir } });
const graphCommit = (repo: TempRepo, sha: string, label = 'a commit') => [provider(repo), { id: sha, label }];
const graphRef = (repo: TempRepo, branch: string) => [provider(repo), { id: `refs/heads/${branch}`, name: branch, kind: 'branch' }];

const noPrompts = (ui: FakeUI) => {
	assert.deepEqual(ui.pickCalls.map((c) => c.options?.title), [], `unexpected picker: ${ui.transcript}`);
};

describe('controller - create branch flow', () => {
	it('creates a branch at the commit the graph row points to and suggests a name from its subject', async () => {
		const { repo, shas } = await linear();
		const ui = new FakeUI({ inputs: [], asks: [ACTIONS.checkout] });

		await controllerFor(ui, repo).createBranch(repo.dir, graphCommit(repo, shas.v02, 'v0.2'));

		assert.equal(ui.inputCalls.length, 1);
		assert.match(ui.inputCalls[0]!.prompt, /New branch at [0-9a-f]{7} - "v0\.2"/);
		assert.equal(ui.inputCalls[0]!.value, 'v0.2', 'the suggested name comes from the commit subject');
		assert.equal(await repo.branchSha('v0.2'), shas.v02);
		noPrompts(ui);
		assert.equal(await repo.api.headBranch(), 'v0.2', 'the "Check Out" follow-up action ran');
		assert.deepEqual(ui.askCalls[0]!.options.actions, [ACTIONS.checkout, ACTIONS.undo]);
	});

	it('accepts a typed name instead of the suggestion', async () => {
		const { repo, shas } = await linear();
		const ui = new FakeUI({ inputs: ['feature/new-button'], asks: [undefined] });

		await controllerFor(ui, repo).createBranch(repo.dir, graphCommit(repo, shas.v03));

		assert.equal(await repo.branchSha('feature/new-button'), shas.v03);
		assert.equal(await repo.api.headBranch(), 'main', 'without the follow-up action nothing is checked out');
	});

	it('starts at the tip of the branch row it was opened on', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'side', shas.v02]);
		const ui = new FakeUI({ inputs: ['from-side'], asks: [undefined] });

		await controllerFor(ui, repo).createBranch(repo.dir, graphRef(repo, 'side'));

		assert.equal(await repo.branchSha('from-side'), shas.v02);
		assert.match(ui.inputCalls[0]!.prompt, /New branch at [0-9a-f]{7} - "v0\.2"/);
	});

	it('from the palette (no arguments) it starts at HEAD', async () => {
		const { repo } = await linear();
		const head = await repo.sha('HEAD');
		const ui = new FakeUI({ inputs: ['scratch'], asks: [undefined] });

		await controllerFor(ui, repo).createBranch(repo.dir, []);

		assert.equal(await repo.branchSha('scratch'), head);
	});

	it('Escape in the name prompt creates nothing and journals nothing', async () => {
		const { repo } = await linear();
		const ui = new FakeUI({ inputs: () => undefined });

		await controllerFor(ui, repo).createBranch(repo.dir, []);

		assert.deepEqual(await repo.branches(), ['main']);
		assert.equal((await repo.ctx.safety.readJournal()).length, 0);
	});

	it('an empty name is refused with a warning', async () => {
		const { repo } = await linear();
		const ui = new FakeUI({ inputs: ['   '] });

		await controllerFor(ui, repo).createBranch(repo.dir, []);

		assert.equal(ui.messages[0]!.kind, 'warn');
		assert.deepEqual(await repo.branches(), ['main']);
	});

	it('an existing name is reported instead of silently overwriting it', async () => {
		const { repo } = await linear();
		const ui = new FakeUI({ inputs: ['main'] });

		await controllerFor(ui, repo).createBranch(repo.dir, []);

		assert.equal(ui.messages[0]!.kind, 'error');
		assert.match(ui.messages[0]!.message, /already exists/);
		assert.equal((await repo.ctx.safety.readJournal()).length, 0);
	});

	it('the Undo follow-up action removes the branch again', async () => {
		const { repo } = await linear();
		const ui = new FakeUI({ inputs: ['scratch'], asks: [ACTIONS.undo], confirms: [true] });

		await controllerFor(ui, repo).createBranch(repo.dir, []);

		assert.equal(await repo.hasBranch('scratch'), false);
		assert.equal(await repo.api.headBranch(), 'main');
	});
});

describe('controller - rename branch flow', () => {
	it('renames the branch from the graph ref row without asking which one', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'side', shas.v02]);
		const ui = new FakeUI({ inputs: ['feature/side'], asks: [undefined] });

		await controllerFor(ui, repo).renameBranch(repo.dir, graphRef(repo, 'side'));

		noPrompts(ui);
		assert.equal(ui.inputCalls[0]!.prompt, 'New name for "side"');
		assert.equal(ui.inputCalls[0]!.value, 'side', 'the old name is pre-filled');
		assert.equal(await repo.branchSha('feature/side'), shas.v02);
		assert.equal(await repo.hasBranch('side'), false);
		assert.equal(ui.askCalls[0]!.message, '"side" is now called "feature/side".');
		assert.deepEqual(ui.askCalls[0]!.options.actions, [ACTIONS.undo]);
	});

	it('from the palette it asks which branch, checked-out one first', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'aaa', shas.v01]);
		const ui = new FakeUI({ picks: [0], inputs: ['renamed'], asks: [undefined] });

		await controllerFor(ui, repo).renameBranch(repo.dir, []);

		assert.equal(ui.pickCalls.length, 1);
		assert.equal(ui.pickCalls[0]!.options!.title, 'Rename which branch?');
		assert.equal(ui.pickCalls[0]!.items[0]!.label, 'main');
		assert.equal(ui.pickCalls[0]!.items[0]!.description, 'checked out');
		assert.equal(ui.pickCalls[0]!.items[1]!.label, 'aaa');
		assert.equal(await repo.hasBranch('renamed'), true);
	});

	it('a tag row is not mistaken for a branch', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['tag', 'v1', shas.v02]);
		const ui = new FakeUI({ picks: [0], inputs: ['renamed'], asks: [undefined] });

		await controllerFor(ui, repo).renameBranch(repo.dir, [provider(repo), { id: 'refs/tags/v1', name: 'v1', kind: 'tag' }]);

		assert.equal(ui.pickCalls.length, 1, 'the tag name was ignored and the picker opened');
		assert.equal(await repo.gitOk(['tag', '--list', 'v1']), 'v1', 'the tag itself is untouched');
		assert.equal(await repo.hasBranch('renamed'), true);
	});

	it('asks what should happen on the remote when the branch tracks one', async () => {
		const { repo, shas, remoteDir } = await withRemote();
		const topicSha = await withPushedTopic(repo, shas);
		const ui = new FakeUI({ inputs: ['feature/topic'], picks: [1], confirms: [true], asks: [undefined] });

		await controllerFor(ui, repo).renameBranch(repo.dir, graphRef(repo, 'topic'));

		assert.equal(ui.pickCalls[0]!.options!.title, 'topic tracks origin/topic');
		assert.equal(ui.pickCalls[0]!.items[1]!.label, 'Rename it on origin too');
		assert.equal(ui.confirmCalls[0]!.message, 'Push the rename to origin?');
		assert.equal(ui.confirmCalls[0]!.options!.destructive, true);
		assert.match(ui.confirmCalls[0]!.options!.detail!, /Creates origin\/feature\/topic and deletes origin\/topic\./);
		assert.equal(await repo.branchSha('feature/topic'), topicSha);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'feature/topic'), topicSha);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'topic'), undefined);
		assert.equal(ui.askCalls[0]!.message, '"topic" is now called "feature/topic".');
	});

	it('undo of a remote rename repairs both sides in one click', async () => {
		const { repo, shas, remoteDir } = await withRemote();
		const topicSha = await withPushedTopic(repo, shas);
		const ui = new FakeUI({ inputs: ['feature/topic'], picks: [1], confirms: [true, true], asks: [ACTIONS.undo] });

		await controllerFor(ui, repo).renameBranch(repo.dir, graphRef(repo, 'topic'));

		assert.equal(await repo.branchSha('topic'), topicSha, 'the old local name is back');
		assert.equal(await repo.hasBranch('feature/topic'), false);
		assert.equal(await repo.api.headBranch(), 'topic');
		assert.equal(await repo.remoteBranchSha(remoteDir, 'topic'), topicSha, 'the deleted remote branch came back');
		assert.equal(await repo.remoteBranchSha(remoteDir, 'feature/topic'), undefined, 'the pushed one is gone again');
		assert.match(ui.allLogs(), /Tracking origin\/topic restored/);
	});

	it('answering the remote question with "Local Only" leaves the remote alone', async () => {
		const { repo, shas, remoteDir } = await withRemote();
		const topicSha = await withPushedTopic(repo, shas);
		const ui = new FakeUI({ inputs: ['feature/topic'], picks: [1], confirms: [false], asks: [undefined] });

		await controllerFor(ui, repo).renameBranch(repo.dir, graphRef(repo, 'topic'));

		assert.equal(await repo.branchSha('feature/topic'), topicSha, 'renamed locally');
		assert.equal(await repo.remoteBranchSha(remoteDir, 'topic'), topicSha, 'nothing was pushed');
		assert.equal(await repo.remoteBranchSha(remoteDir, 'feature/topic'), undefined);
		assert.match(ui.allLogs(), /locally only/);
	});

	it('without an upstream there is no remote question at all', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'local-only', shas.v02]);
		const ui = new FakeUI({ inputs: ['renamed'], asks: [undefined] });

		await controllerFor(ui, repo).renameBranch(repo.dir, graphRef(repo, 'local-only'));

		noPrompts(ui);
		assert.equal(ui.confirmCalls.length, 0);
		assert.equal(await repo.branchSha('renamed'), shas.v02);
	});

	it('keeps the branch when the new name is the old one', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'side', shas.v02]);
		const ui = new FakeUI({ inputs: ['side'], asks: [undefined] });

		await controllerFor(ui, repo).renameBranch(repo.dir, graphRef(repo, 'side'));

		assert.equal(ui.messages[0]!.kind, 'info');
		assert.match(ui.messages[0]!.message, /already called that/);
		assert.equal((await repo.ctx.safety.readJournal()).length, 0);
	});

	it('asks before overwriting an existing branch and stops on "Cancel"', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'other', shas.v01]);
		const ui = new FakeUI({ inputs: ['other'], confirms: [false] });

		await controllerFor(ui, repo).renameBranch(repo.dir, graphRef(repo, 'main'));

		assert.equal(ui.confirmCalls[0]!.message, 'A branch called "other" already exists. Overwrite it?');
		assert.equal(ui.confirmCalls[0]!.options!.destructive, true);
		assert.equal(await repo.branchSha('other'), shas.v01);
		assert.equal(await repo.hasBranch('main'), true);
		assert.equal((await repo.ctx.safety.readJournal()).length, 0);
	});

	it('overwrites an existing branch when the user says so', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'other', shas.v01]);
		const mainSha = await repo.sha('main');
		const ui = new FakeUI({ inputs: ['other'], confirms: [true], asks: [undefined] });

		await controllerFor(ui, repo).renameBranch(repo.dir, graphRef(repo, 'main'));

		assert.equal(await repo.hasBranch('main'), false);
		assert.equal(await repo.branchSha('other'), mainSha);
		assert.equal(await repo.api.headBranch(), 'other');
	});

	it('undo of an overwrite puts both branches back where they were', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'other', shas.v01]);
		const mainSha = await repo.sha('main');
		const ui = new FakeUI({ inputs: ['other'], confirms: [true, true], asks: [ACTIONS.undo] });

		await controllerFor(ui, repo).renameBranch(repo.dir, graphRef(repo, 'main'));

		assert.equal(await repo.branchSha('main'), mainSha, 'the renamed branch is back');
		assert.equal(await repo.branchSha('other'), shas.v01, 'the overwritten branch points where it did');
		assert.equal(await repo.api.headBranch(), 'main');
	});

	it('falls back to the picker when the argument names a branch that is not there', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'real', shas.v02]);
		const ui = new FakeUI({ picks: ['real'], inputs: ['fresh'], asks: [undefined] });

		await controllerFor(ui, repo).renameBranch(repo.dir, [{ name: 'ghost' }]);

		assert.match(ui.allLogs(), /Ignoring "ghost" from the menu arguments/);
		assert.equal(ui.pickCalls.length, 1);
		assert.equal(await repo.branchSha('fresh'), shas.v02);
	});
});

describe('controller - delete branch flow', () => {
	it('deletes the branch from the ref row after one confirmation', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'stale', shas.v02]);
		const ui = new FakeUI({ confirms: [true], asks: [undefined] });

		await controllerFor(ui, repo).deleteBranch(repo.dir, graphRef(repo, 'stale'));

		noPrompts(ui);
		assert.equal(ui.confirmCalls.length, 1);
		assert.equal(ui.confirmCalls[0]!.message, 'Delete branch "stale"?');
		assert.equal(ui.confirmCalls[0]!.options!.destructive, true);
		assert.match(ui.confirmCalls[0]!.options!.detail!, /points at [0-9a-f]{7}/);
		assert.match(ui.confirmCalls[0]!.options!.detail!, /Every commit on it is reachable from elsewhere/);
		assert.equal(await repo.hasBranch('stale'), false);
		assert.equal(ui.askCalls[0]!.message, 'Deleted branch "stale".');
	});

	it('the Undo follow-up action recreates the branch', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'stale', shas.v02]);
		const ui = new FakeUI({ confirms: [true, true], asks: [ACTIONS.undo] });

		await controllerFor(ui, repo).deleteBranch(repo.dir, graphRef(repo, 'stale'));

		assert.equal(await repo.branchSha('stale'), shas.v02);
	});

	it('asks whether the remote branch goes too, and undo puts both back', async () => {
		const { repo, shas, remoteDir } = await withRemote();
		await repo.gitOk(['branch', 'stale', shas.v02]);
		await repo.gitOk(['push', '--quiet', '-u', 'origin', 'stale:stale']);
		const ui = new FakeUI({ picks: [1], confirms: [true, true], asks: [ACTIONS.undo] });

		await controllerFor(ui, repo).deleteBranch(repo.dir, graphRef(repo, 'stale'));

		assert.equal(ui.pickCalls[0]!.options!.placeholder, 'stale tracks origin/stale');
		assert.equal(ui.pickCalls[0]!.items[1]!.label, 'Delete the local and the remote branch');
		assert.equal(ui.confirmCalls[0]!.message, 'Delete "stale" locally and origin/stale on the remote?');
		assert.equal(ui.confirmCalls[0]!.options!.confirmLabel, 'Delete Everywhere');
		assert.equal(ui.askCalls[0]!.message, 'Deleted branch "stale" and origin/stale.');

		// Undo restored the local branch ...
		assert.equal(await repo.branchSha('stale'), shas.v02);
		// ... and pushed the remote branch back.
		assert.equal(await repo.remoteBranchSha(remoteDir, 'stale'), shas.v02);
	});

	it('keeps the remote branch when the user picks "local only"', async () => {
		const { repo, shas, remoteDir } = await withRemote();
		await repo.gitOk(['branch', 'stale', shas.v02]);
		await repo.gitOk(['push', '--quiet', '-u', 'origin', 'stale:stale']);
		const ui = new FakeUI({ picks: [0], confirms: [true], asks: [undefined] });

		await controllerFor(ui, repo).deleteBranch(repo.dir, graphRef(repo, 'stale'));

		assert.equal(await repo.hasBranch('stale'), false);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'stale'), shas.v02);
		assert.equal(ui.confirmCalls[0]!.message, 'Delete branch "stale"?');
	});

	it('unmerged work needs a second, explicit yes', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['checkout', '--quiet', '-b', 'wip', shas.v02]);
		const wipSha = await repo.commit('wip only', { 'wip.txt': 'w\n' });
		await repo.checkout('main');

		const refused = new FakeUI({ confirms: [true, false], asks: [undefined] });
		await controllerFor(refused, repo).deleteBranch(repo.dir, graphRef(repo, 'wip'));
		assert.equal(await repo.hasBranch('wip'), true, 'the branch was kept');
		assert.match(refused.confirmCalls[1]!.message, /1 commit that HEAD does not have\. Delete it anyway\?/);
		assert.match(refused.confirmCalls[1]!.options!.detail!, /wip only/);
		assert.equal(refused.messages.at(-1)!.message, '"wip" was kept.');

		const insisted = new FakeUI({ confirms: [true, true], asks: [ACTIONS.undo] });
		await controllerFor(insisted, repo).deleteBranch(repo.dir, graphRef(repo, 'wip'));
		assert.equal(insisted.confirmCalls[1]!.options!.confirmLabel, 'Delete Anyway');
		assert.equal(insisted.askCalls[0]!.message, 'Deleted branch "wip".', 'the forced delete happened');
		assert.equal(insisted.progressTitles.filter((t) => t === 'Deleting wip').length, 2, 'tried once, then with force');
		// Undo brings the unmerged commit back.
		assert.equal(await repo.branchSha('wip'), wipSha);
	});

	it('the first confirmation already warns about unmerged commits', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['checkout', '--quiet', '-b', 'wip', shas.v02]);
		await repo.commit('wip only', { 'wip.txt': 'w\n' });
		await repo.checkout('main');
		const ui = new FakeUI({ confirms: [false] });

		await controllerFor(ui, repo).deleteBranch(repo.dir, graphRef(repo, 'wip'));

		assert.match(ui.confirmCalls[0]!.options!.detail!, /1 commit\(s\) exist only here: [0-9a-f]{7,} wip only/);
		assert.equal(await repo.hasBranch('wip'), true);
	});

	it('refuses the checked-out branch before asking anything', async () => {
		const { repo } = await linear();
		const ui = new FakeUI({ confirms: [true] });

		await controllerFor(ui, repo).deleteBranch(repo.dir, graphRef(repo, 'main'));

		assert.equal(ui.messages[0]!.kind, 'error');
		assert.match(ui.messages[0]!.message, /"main" is checked out, so it cannot be deleted\./);
		assert.match(ui.messages[0]!.detail!, /Check out another branch first/);
		assert.equal(ui.confirmCalls.length, 0, 'no destructive question was asked');
		assert.equal(await repo.hasBranch('main'), true);
	});

	it('with confirmations switched off it still asks about unmerged commits', async () => {
		const { repo, shas } = await linear({ confirmDestructiveOperations: false });
		await repo.gitOk(['checkout', '--quiet', '-b', 'wip', shas.v02]);
		await repo.commit('wip only', { 'wip.txt': 'w\n' });
		await repo.checkout('main');
		const ui = new FakeUI({ confirms: [true], asks: [undefined] });

		await controllerFor(ui, repo).deleteBranch(repo.dir, graphRef(repo, 'wip'));

		assert.equal(ui.confirmCalls.length, 1, 'only the unmerged question');
		assert.match(ui.confirmCalls[0]!.message, /Delete it anyway\?/);
		assert.equal(await repo.hasBranch('wip'), false);
	});

	it('with confirmations switched off a merged branch just goes', async () => {
		const { repo, shas } = await linear({ confirmDestructiveOperations: false });
		await repo.gitOk(['branch', 'stale', shas.v02]);
		const ui = new FakeUI({ asks: [undefined] });

		await controllerFor(ui, repo).deleteBranch(repo.dir, graphRef(repo, 'stale'));

		assert.equal(ui.confirmCalls.length, 0);
		assert.equal(await repo.hasBranch('stale'), false);
	});

	it('cancelling the scope question deletes nothing', async () => {
		const { repo, shas } = await withRemote();
		await repo.gitOk(['branch', 'stale', shas.v02]);
		await repo.gitOk(['push', '--quiet', '-u', 'origin', 'stale:stale']);
		const ui = new FakeUI({ picks: [99] });

		await controllerFor(ui, repo).deleteBranch(repo.dir, graphRef(repo, 'stale'));

		assert.equal(await repo.hasBranch('stale'), true);
		assert.equal(ui.confirmCalls.length, 0);
	});
});

describe('controller - check out branch flow', () => {
	it('checks out the branch from the ref row', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'other', shas.v02]);
		const ui = new FakeUI({ asks: [undefined] });

		await controllerFor(ui, repo).checkoutBranch(repo.dir, graphRef(repo, 'other'));

		noPrompts(ui);
		assert.equal(await repo.api.headBranch(), 'other');
		assert.equal(await repo.sha('HEAD'), shas.v02);
		assert.equal(ui.askCalls[0]!.message, '"other" is checked out.');
	});

	it('the Undo action returns to the previous branch', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'other', shas.v02]);
		const ui = new FakeUI({ asks: [ACTIONS.undo], confirms: [true] });

		await controllerFor(ui, repo).checkoutBranch(repo.dir, graphRef(repo, 'other'));

		assert.equal(await repo.api.headBranch(), 'main');
		assert.equal(await repo.sha('HEAD'), shas.v04);
	});

	it('from the palette it lists the branches', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'other', shas.v02]);
		const ui = new FakeUI({ picks: ['other'], asks: [undefined] });

		await controllerFor(ui, repo).checkoutBranch(repo.dir, []);

		assert.equal(ui.pickCalls[0]!.options!.title, 'Check out which branch?');
		assert.equal(await repo.api.headBranch(), 'other');
	});

	it('says so when the branch is already checked out', async () => {
		const { repo } = await linear();
		const ui = new FakeUI({ asks: [undefined] });

		await controllerFor(ui, repo).checkoutBranch(repo.dir, graphRef(repo, 'main'));

		assert.equal(ui.messages[0]!.kind, 'error');
		assert.match(ui.messages[0]!.message, /already checked out/);
	});
});

describe('controller - branch flows in a repository without branches to pick', () => {
	it('reports an empty branch list instead of showing an empty picker', async () => {
		const repo = await createTempRepo();
		open.push(repo);
		const ui = new FakeUI();

		await controllerFor(ui, repo).deleteBranch(repo.dir, []);

		assert.equal(ui.messages[0]!.kind, 'error');
		assert.match(ui.messages[0]!.message, /no branches yet/);
	});
});
