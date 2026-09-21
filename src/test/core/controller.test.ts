/**
 * End-to-end tests for the interactive layer: the controller is driven by a
 * scripted fake UI against real repositories, so every flow below is exactly
 * what the user sees (prompts, confirmations, reports, follow-up actions).
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import * as fs from 'node:fs';
import { DEFAULT_SETTINGS, type Settings } from '../../core/config';
import { Controller } from '../../core/controller';
import { ACTIONS } from '../../core/ui';
import { createLinearRepo, TempRepo } from '../helpers/tempRepo';
import { FakeUI } from '../helpers/fakeUi';

function controllerFor(ui: FakeUI, repo: TempRepo, settings: Settings = DEFAULT_SETTINGS): Controller {
	return new Controller({ ui, settings, exec: repo.exec });
}

/** v0.1 -> v0.2 -> v0.3 -> v0.4 (main) with a side branch off v0.2. */
async function withSideBranch(): Promise<{ repo: TempRepo; sideSha: string; baseSha: string }> {
	const { repo, shas } = await createLinearRepo();
	await repo.checkout(shas.v02, { create: false });
	await repo.gitOk(['checkout', '--quiet', '-b', 'side', shas.v02]);
	const sideSha = await repo.commit('side change', { 'side.txt': 's\n' });
	await repo.checkout('main');
	return { repo, sideSha, baseSha: shas.v02 };
}

describe('controller - reword flows', () => {
	let repo: TempRepo;
	let shas: Record<string, string>;

	before(async () => {
		({ repo, shas } = await createLinearRepo());
	});
	after(() => repo.cleanup());

	it(`appends to a commit subject: "v0.2" -> "v0.2 add new button"`, async () => {
		const ui = new FakeUI({ inputs: ['add new button'] });
		await controllerFor(ui, repo).rewordCommit(repo.dir, [shas.v02], 'append');

		const log = await repo.log('main');
		assert.equal(log[2]!.subject, 'v0.2 add new button');
		assert.equal(log.length, 4);
		assert.equal(ui.pickCalls.length, 0, `no picker needed: ${ui.transcript}`);
		assert.equal(ui.confirmCalls.length, 1);
		assert.match(ui.confirmCalls[0]!.message, /Rename the message of [0-9a-f]{7} on main\?/);
		assert.equal(ui.confirmCalls[0]!.options!.confirmLabel, 'Rename');
		assert.match(ui.confirmCalls[0]!.options!.detail!, /Recovery point: refs\/geco\//);
		assert.match(ui.confirmCalls[0]!.options!.detail!, /3 commits get a new SHA \([0-9a-f]{7} plus 2 after it\)/);
		assert.match(ui.askCalls[0]!.message, /Renamed the message of .* on main/);
		assert.match(ui.allLogs(), /recovery point: refs\/geco\//);
	});

	it('replaces a whole message and pre-fills the input with the current one', async () => {
		const tip = await repo.sha('main');
		const ui = new FakeUI({ inputs: ['v0.4 add the new button'] });
		await controllerFor(ui, repo).rewordCommit(repo.dir, [tip], 'replace');

		assert.equal(ui.inputCalls[0]!.title, `Rename ${tip.slice(0, 7)}`);
		assert.equal(ui.inputCalls[0]!.prompt, 'New commit message (currently "v0.4")');
		assert.equal((await repo.message('main')).trim(), 'v0.4 add the new button');
	});

	it('renames part of a message with find/replace', async () => {
		const tip = await repo.sha('main');
		const ui = new FakeUI({ inputs: ['add the new button', 'add a shiny new button'] });
		await controllerFor(ui, repo).rewordCommit(repo.dir, [tip], 'findReplace');

		assert.equal((await repo.message('main')).trim(), 'v0.4 add a shiny new button');
		assert.equal(ui.inputCalls[0]!.title, `Search and replace in ${tip.slice(0, 7)}`);
		assert.equal(ui.inputCalls[0]!.prompt, 'Find in the commit message');
		assert.equal(ui.inputCalls[0]!.value, 'v0.4 add the new button');
	});

	it('rewrites nothing when the user cancels the input box', async () => {
		const before = await repo.sha('main');
		const ui = new FakeUI({ inputs: [undefined] });
		await controllerFor(ui, repo).rewordCommit(repo.dir, [before], 'replace');

		assert.equal(await repo.sha('main'), before);
		assert.equal(ui.confirmCalls.length, 0);
	});

	it('rewrites nothing when the user declines the confirmation', async () => {
		const before = await repo.sha('main');
		const ui = new FakeUI({ inputs: ['should not happen'], confirms: [false] });
		await controllerFor(ui, repo).rewordCommit(repo.dir, [before], 'replace');

		assert.equal(await repo.sha('main'), before);
		assert.match(ui.allLogs(), /cancelled by the user/);
	});

	it('says so when the new message is identical to the old one', async () => {
		const before = await repo.sha('main');
		const ui = new FakeUI({ inputs: [await repo.message('main')] });
		await controllerFor(ui, repo).rewordCommit(repo.dir, [before], 'replace');

		assert.equal(await repo.sha('main'), before);
		assert.match(ui.allMessages(), /unchanged/);
	});

	it('falls back to a commit picker when the menu passed nothing', async () => {
		const ui = new FakeUI({ picks: [0], inputs: ['picked from the list'] });
		await controllerFor(ui, repo).rewordCommit(repo.dir, [], 'replace');

		assert.equal(ui.pickCalls[0]!.options!.title, 'Rename which commit?');
		assert.match(ui.pickCalls[0]!.items[0]!.label, /^\$\(git-commit\) [0-9a-f]{7}$/);
		assert.equal((await repo.message('main')).trim(), 'picked from the list');
	});

	it('lets the user type a reference instead of picking one', async () => {
		const ui = new FakeUI({
			// The commit list has 4 commits plus "Type a reference..." at index 4.
			picks: (call) => (call === 0 ? 4 : 0),
			inputs: ['HEAD~1', 'typed and reworded'],
		});
		await controllerFor(ui, repo).rewordCommit(repo.dir, [], 'replace');

		assert.equal(ui.inputCalls[0]!.prompt, 'Commit reference');
		const log = await repo.log('main');
		assert.equal(log[1]!.subject, 'typed and reworded');
	});

	it('asks which branch to rewrite when a commit is on several branches', async () => {
		const other = await createLinearRepo();
		try {
			await other.repo.gitOk(['branch', 'feature', other.shas.v02]);
			// With HEAD detached no branch is the obvious choice, so the user is asked.
			await other.repo.gitOk(['checkout', '--quiet', '--detach', other.shas.v04]);
			const ui = new FakeUI({ picks: ['feature'], inputs: ['on the feature branch'] });
			await controllerFor(ui, other.repo).rewordCommit(other.repo.dir, [other.shas.v02], 'append');

			assert.match(ui.pickCalls[0]!.options!.title!, /on which branch/);
			assert.deepEqual(ui.pickCalls[0]!.items.map((i) => i.label).sort(), ['feature', 'main']);
			const featureLog = await other.repo.log('feature');
			assert.equal(featureLog[0]!.subject, 'v0.2 on the feature branch');
			const mainLog = await other.repo.log('main');
			assert.equal(mainLog[2]!.subject, 'v0.2', 'main was left alone');
			assert.equal(await other.repo.sha('HEAD'), other.shas.v04, 'HEAD is still detached where it was');
		} finally {
			other.repo.cleanup();
		}
	});

	it('reports an error (instead of throwing) when the commit is on no branch', async () => {
		const other = await createLinearRepo();
		try {
			// A commit whose branch was deleted: still resolvable, but unrewritable.
			await other.repo.gitOk(['checkout', '--quiet', '-b', 'temp', other.shas.v04]);
			const dangling = await other.repo.commitEmpty('orphan work');
			await other.repo.gitOk(['checkout', '--quiet', 'main']);
			await other.repo.gitOk(['branch', '-D', 'temp']);

			const ui = new FakeUI({ inputs: ['nope'] });
			await controllerFor(ui, other.repo).rewordCommit(other.repo.dir, [dangling], 'append');

			assert.equal(ui.messages[0]!.kind, 'error');
			assert.match(ui.messages[0]!.message, /not reachable from any local branch/);
			assert.equal(await other.repo.sha('main'), other.shas.v04);
			assert.equal(ui.confirmCalls.length, 0);
		} finally {
			other.repo.cleanup();
		}
	});

	it('offers to force push straight after a rewrite, and does it when chosen', async () => {
		const other = await createLinearRepo();
		try {
			const remoteDir = await other.repo.addBareRemote('origin');
			const ui = new FakeUI({ inputs: ['pushed too'], asks: [ACTIONS.forcePush] });
			await controllerFor(ui, other.repo).rewordCommit(other.repo.dir, [other.shas.v04], 'append');

			assert.ok(ui.askCalls[0]!.options.actions.includes(ACTIONS.forcePush), ui.transcript);
			assert.equal(await other.repo.remoteBranchSha(remoteDir, 'main'), await other.repo.sha('main'));
			assert.equal(ui.confirmCalls.length, 2, 'the push asked for its own confirmation');
			assert.match(ui.confirmCalls[1]!.message, /Force push main to origin\/main\?/);
		} finally {
			other.repo.cleanup();
		}
	});

	it('offers Undo after a rewrite and restores the old history when chosen', async () => {
		const other = await createLinearRepo();
		try {
			const before = other.shas.v04;
			const ui = new FakeUI({ inputs: ['then undone'], asks: [ACTIONS.undo] });
			await controllerFor(ui, other.repo).rewordCommit(other.repo.dir, [before], 'append');

			assert.equal(ui.confirmCalls.length, 2, 'reword + undo confirmations');
			assert.match(ui.confirmCalls[1]!.message, /Undo "Renamed the message of /);
			assert.match(ui.allLogs(), /Renamed the message of [0-9a-f]{7,} -> [0-9a-f]{7,} on main/, 'the rewrite really happened');
			assert.equal(await other.repo.sha('main'), before, 'undo put the old history back');
			assert.equal((await other.repo.message('main')).trim(), 'v0.4');
			assert.match(ui.allMessages(), /Undone: Renamed the message of /);
		} finally {
			other.repo.cleanup();
		}
	});

	it('keeps trees, parents, authors and dates while rewriting', async () => {
		const other = await createLinearRepo();
		try {
			const before = await other.repo.log('main');
			const ui = new FakeUI({ inputs: ['same content, new words'] });
			await controllerFor(ui, other.repo).rewordCommit(other.repo.dir, [other.shas.v02], 'replace');

			const after = await other.repo.log('main');
			assert.deepEqual(after.map((c) => c.tree), before.map((c) => c.tree));
			assert.deepEqual(after.map((c) => c.authorDate), before.map((c) => c.authorDate));
			assert.deepEqual(after.map((c) => c.authorName), before.map((c) => c.authorName));
			assert.equal(after[3]!.parents.length, 0, 'the root commit stays a root commit');
			assert.equal(after[2]!.parents.length, 1);
			assert.equal(after[2]!.subject, 'same content, new words');
			assert.notEqual(after[2]!.sha, before[2]!.sha);
			assert.equal(after[3]!.sha, before[3]!.sha, 'the untouched root commit keeps its sha');
		} finally {
			other.repo.cleanup();
		}
	});
});

describe('controller - menu argument shapes', () => {
	const shapes: [string, (sha: string, repo: TempRepo) => unknown[]][] = [
		['a bare sha string', (sha) => [sha]],
		['{id} (Source Control Graph history item)', (sha) => [{ id: sha }]],
		['provider + history items (graph multi-select)', (sha, repo) => [{ rootUri: { fsPath: repo.dir } }, { id: sha }]],
		['{historyItem: {id}}', (sha) => [{ historyItem: { id: sha } }]],
		['{sha}', (sha) => [{ sha }]],
		['{commit: {sha}} (GitLens style)', (sha) => [{ commit: { sha } }]],
		['{hash}', (sha) => [{ hash: sha }]],
		['an array of history items', (sha) => [[{ id: sha }]]],
		['a timeline item with a uri', (sha, repo) => [{ uri: { fsPath: `${repo.dir}/a.txt` }, id: sha }]],
		['our own tree node', (sha, repo) => [{ gecoKind: 'commit', sha, repoPath: repo.dir }]],
		['a short sha', (sha) => [sha.slice(0, 8)]],
	];

	for (const [name, build] of shapes) {
		it(`resolves a commit from ${name}`, async () => {
			const { repo, shas } = await createLinearRepo();
			try {
				const ui = new FakeUI({ inputs: ['resolved'] });
				await controllerFor(ui, repo).rewordCommit(repo.dir, build(shas.v03, repo), 'append');

				assert.equal(ui.pickCalls.length, 0, `expected no picker for ${name}: ${ui.transcript}`);
				const log = await repo.log('main');
				assert.equal(log[1]!.subject, 'v0.3 resolved');
			} finally {
				repo.cleanup();
			}
		});
	}

	it('ignores a reference that does not exist and falls back to the picker', async () => {
		const { repo } = await createLinearRepo();
		try {
			const ui = new FakeUI({ picks: [0], inputs: ['fallback'] });
			await controllerFor(ui, repo).rewordCommit(repo.dir, ['deadbeefdeadbeef'], 'replace');

			assert.equal(ui.pickCalls.length, 1);
			assert.match(ui.allLogs(), /Ignoring "deadbeefdeadbeef"/);
			assert.equal((await repo.message('main')).trim(), 'fallback');
		} finally {
			repo.cleanup();
		}
	});

	it('takes the repository path from the menu arguments when it differs from the active one', async () => {
		const a = await createLinearRepo();
		const b = await createLinearRepo();
		try {
			const ui = new FakeUI({ inputs: ['elsewhere'] });
			// cwd points at repo A, but the graph menu says the commit lives in B.
			const resolved = await controllerFor(ui, a.repo).contextFor(b.repo.dir).git.revParse('HEAD');
			assert.equal(resolved, b.shas.v04);
			await controllerFor(ui, a.repo).rewordCommit(b.repo.dir, [{ rootUri: { fsPath: b.repo.dir } }, { id: b.shas.v04 }], 'append');
			assert.equal((await b.repo.message('main')).trim(), 'v0.4 elsewhere');
			assert.equal((await a.repo.message('main')).trim(), 'v0.4');
		} finally {
			a.repo.cleanup();
			b.repo.cleanup();
		}
	});
});

describe('controller - fast-forward flows', () => {
	async function diverged(): Promise<{ repo: TempRepo; featureSha: string; mainOnlySha: string }> {
		const { repo, shas } = await createLinearRepo();
		await repo.gitOk(['checkout', '--quiet', '-b', 'feature', shas.v03]);
		const featureSha = await repo.commit('feature work', { 'feature.txt': 'f\n' });
		await repo.checkout('main');
		const mainOnlySha = await repo.commit('main moved on too', { 'main.txt': 'm\n' });
		return { repo, featureSha, mainOnlySha };
	}

	it('moves the default branch, keeps the old tip on "old" and reports the plan', async () => {
		const { repo } = await createLinearRepo();
		try {
			// feature is ahead of main, so moving main is a real fast-forward.
			await repo.gitOk(['checkout', '--quiet', '-b', 'feature']);
			const target = await repo.commit('feature work', { 'feature.txt': 'f\n' });
			await repo.checkout('main');
			const from = await repo.sha('main');

			const ui = new FakeUI();
			await controllerFor(ui, repo).fastForward(repo.dir, [target], { askBranch: false });

			assert.equal(await repo.sha('main'), target);
			assert.equal(await repo.sha('old'), from);
			assert.equal(ui.pickCalls.length, 0, ui.transcript);
			// A true fast-forward gets the three-button dialog; the unscripted
			// fake UI clicks the primary button ("Move"), so the backup stays.
			assert.equal(ui.chooseCalls.length, 1, ui.transcript);
			assert.equal(ui.confirmCalls.length, 0, 'the dialog replaces the old two-button confirm');
			assert.match(ui.chooseCalls[0]!.message, /Move main to [0-9a-f]{7}\?/);
			assert.deepEqual(
				ui.chooseCalls[0]!.options.choices.map((choice) => choice.label),
				['Cancel', 'Move', 'Move and remove "old"'],
				'Cancel | Ok | Ok and remove redundant old branch',
			);
			assert.equal(ui.chooseCalls[0]!.options.choices[1]!.primary, true, 'Move is the default action');
			assert.match(ui.chooseCalls[0]!.options.detail!, /Fast-forward: 1 commit is added, nothing is lost\./);
			assert.match(ui.chooseCalls[0]!.options.detail!, /kept on branch "old"/);
			assert.match(ui.askCalls[0]!.message, /main now points at/);
			assert.match(ui.askCalls[0]!.message!, /old tip kept on old/);
			assert.match(ui.allLogs(), /Moved main: .* \(fast-forward\)/);
			assert.equal(await repo.sha('HEAD'), target, 'the checked-out branch really moved');
		} finally {
			repo.cleanup();
		}
	});

	it('asks for the branch and the backup name in the explicit variant', async () => {
		const { repo } = await createLinearRepo();
		try {
			await repo.gitOk(['checkout', '--quiet', '-b', 'feature']);
			const target = await repo.commit('feature work', { 'feature.txt': 'f\n' });
			await repo.checkout('main');

			const ui = new FakeUI({ picks: ['main'], inputs: ['archive'] });
			await controllerFor(ui, repo).fastForward(repo.dir, [target], { askBranch: true });

			assert.equal(ui.pickCalls[0]!.options!.title, 'Fast-forward which branch?');
			assert.deepEqual(ui.pickCalls[0]!.items.map((i) => i.label).sort(), ['feature', 'main']);
			assert.equal(ui.inputCalls[0]!.prompt, 'Keep the old main tip on a branch named');
			assert.equal(ui.inputCalls[0]!.value, 'old');
			assert.equal(await repo.sha('main'), target);
			assert.equal(await repo.hasBranch('archive'), true);
			assert.equal(await repo.hasBranch('old'), false);
		} finally {
			repo.cleanup();
		}
	});

	it('explains a diverged branch and only forces after a second confirmation', async () => {
		const { repo, featureSha, mainOnlySha } = await diverged();
		try {
			const ui = new FakeUI({ confirms: [true, true] });
			await controllerFor(ui, repo).fastForward(repo.dir, [featureSha], { askBranch: false });

			assert.equal(ui.chooseCalls.length, 0, 'a diverged move keeps the old confirm - the backup would carry real commits');
			assert.equal(ui.confirmCalls.length, 2);
			assert.match(ui.confirmCalls[0]!.options!.detail!, /NOT a fast-forward: 2 commits on main would be left behind\./);
			assert.match(ui.confirmCalls[1]!.message, /has commits that .* does not\. Move it anyway\?/);
			assert.equal(ui.confirmCalls[1]!.options!.destructive, true);
			assert.equal(await repo.sha('main'), featureSha);
			assert.equal(await repo.sha('old'), mainOnlySha, 'the discarded tip is on the backup branch');
			assert.match(ui.allLogs(), /\(forced\)/);
			assert.match(ui.allLogs(), /left behind: [0-9a-f]{7,} main moved on too, [0-9a-f]{7,} v0\.4/);
		} finally {
			repo.cleanup();
		}
	});

	it('stops at the second confirmation when the user declines the forced move', async () => {
		const { repo, featureSha, mainOnlySha } = await diverged();
		try {
			const before = await repo.sha('main');
			const ui = new FakeUI({ confirms: [true, false] });
			await controllerFor(ui, repo).fastForward(repo.dir, [featureSha], { askBranch: false });

			assert.equal(await repo.sha('main'), before, 'main did not move');
			assert.equal(await repo.hasBranch('old'), false, 'a refused move creates no backup branch');
			assert.equal(mainOnlySha, before);
		} finally {
			repo.cleanup();
		}
	});

	it('does nothing when the user cancels the dialog', async () => {
		const { repo } = await createLinearRepo();
		try {
			await repo.gitOk(['checkout', '--quiet', '-b', 'feature']);
			const target = await repo.commit('feature work', { 'feature.txt': 'f\n' });
			await repo.checkout('main');
			const before = await repo.sha('main');

			const ui = new FakeUI({ choices: ['cancel'] });
			await controllerFor(ui, repo).fastForward(repo.dir, [target], { askBranch: false });

			assert.equal(await repo.sha('main'), before);
			assert.equal(await repo.hasBranch('old'), false);
			assert.match(ui.allLogs(), /cancelled by the user/);
		} finally {
			repo.cleanup();
		}
	});

	it('does nothing when the user dismisses the dialog without choosing', async () => {
		const { repo } = await createLinearRepo();
		try {
			await repo.gitOk(['checkout', '--quiet', '-b', 'feature']);
			const target = await repo.commit('feature work', { 'feature.txt': 'f\n' });
			await repo.checkout('main');
			const before = await repo.sha('main');

			const ui = new FakeUI({ choices: [null] });
			await controllerFor(ui, repo).fastForward(repo.dir, [target], { askBranch: false });

			assert.equal(await repo.sha('main'), before);
			assert.equal(await repo.hasBranch('old'), false);
			assert.match(ui.allLogs(), /cancelled by the user/);
		} finally {
			repo.cleanup();
		}
	});

	it('moves and removes the redundant backup when the user picks the third button', async () => {
		const { repo } = await createLinearRepo();
		try {
			await repo.gitOk(['checkout', '--quiet', '-b', 'feature']);
			const target = await repo.commit('feature work', { 'feature.txt': 'f\n' });
			await repo.checkout('main');
			const from = await repo.sha('main');

			const ui = new FakeUI({ choices: ['move-remove'] });
			await controllerFor(ui, repo).fastForward(repo.dir, [target], { askBranch: false });

			assert.equal(await repo.sha('main'), target);
			assert.equal(await repo.hasBranch('old'), false, 'the redundant backup is gone');
			assert.match(ui.allLogs(), /Removed the redundant backup branch old \(/);
			assert.match(ui.askCalls[0]!.message!, /the redundant backup "old" was removed - nothing was lost/);
			// Two journaled operations: the move, then the removal of the backup.
			const journal = await repo.ctx.safety.readJournal();
			assert.equal(journal.length, 2, ui.allLogs());
			assert.match(journal[1]!.summary, /Removed 1 redundant branch/);
			assert.equal(from.length, 40, 'the old tip still exists in history');
		} finally {
			repo.cleanup();
		}
	});

	it('undoes the removal alone: the backup branch is back, the move stays', async () => {
		const { repo } = await createLinearRepo();
		try {
			await repo.gitOk(['checkout', '--quiet', '-b', 'feature']);
			const target = await repo.commit('feature work', { 'feature.txt': 'f\n' });
			await repo.checkout('main');
			const from = await repo.sha('main');

			const ui = new FakeUI({ choices: ['move-remove'] });
			await controllerFor(ui, repo).fastForward(repo.dir, [target], { askBranch: false });
			assert.equal(await repo.hasBranch('old'), false);

			const undoUi = new FakeUI({ picks: [0] });
			await controllerFor(undoUi, repo).undoLastOperation(repo.dir);
			assert.equal(await repo.hasBranch('old'), true, 'the backup branch is back');
			assert.equal(await repo.sha('old'), from);
			assert.equal(await repo.sha('main'), target, 'the move itself is untouched');
		} finally {
			repo.cleanup();
		}
	});

	it('offers to remove the suffixed backup when the base name is taken elsewhere', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			await repo.gitOk(['checkout', '--quiet', '-b', 'feature']);
			const target = await repo.commit('feature work', { 'feature.txt': 'f\n' });
			await repo.checkout('main');
			// "old" already exists at a different commit: the mover creates
			// "old-2" instead, and "old-2" - not the pre-existing "old" - is
			// the redundant branch the third button removes.
			await repo.gitOk(['branch', 'old', shas.v03]);

			const ui = new FakeUI({ choices: ['move-remove'] });
			await controllerFor(ui, repo).fastForward(repo.dir, [target], { askBranch: false });

			assert.equal(ui.chooseCalls.length, 1, ui.transcript);
			assert.equal(ui.chooseCalls[0]!.options.choices[2]!.label, 'Move and remove "old-2"');
			assert.equal(await repo.hasBranch('old-2'), false, 'the newly created backup was removed');
			assert.equal(await repo.sha('old'), shas.v03, 'the pre-existing branch is untouched');
			assert.equal(await repo.sha('main'), target);
		} finally {
			repo.cleanup();
		}
	});

	it('uses the old two-button confirm when the backup branch already sits at the old tip', async () => {
		const { repo } = await createLinearRepo();
		try {
			await repo.gitOk(['checkout', '--quiet', '-b', 'feature']);
			const target = await repo.commit('feature work', { 'feature.txt': 'f\n' });
			await repo.checkout('main');
			const from = await repo.sha('main');
			// "old" already points at the old tip: it gets reused, so nothing
			// new is created and there is nothing safe to remove.
			await repo.gitOk(['branch', 'old', from]);

			const ui = new FakeUI({ confirms: [true] });
			await controllerFor(ui, repo).fastForward(repo.dir, [target], { askBranch: false });

			assert.equal(ui.chooseCalls.length, 0, 'no third button for a reused backup');
			assert.equal(ui.confirmCalls.length, 1);
			assert.match(ui.confirmCalls[0]!.options!.detail!, /kept on branch "old"/);
			assert.equal(await repo.sha('main'), target);
			assert.equal(await repo.hasBranch('old'), true);
			assert.equal(await repo.sha('old'), from);
		} finally {
			repo.cleanup();
		}
	});

	it('reports when the branch is already at the target', async () => {
		const { repo } = await createLinearRepo();
		try {
			const ui = new FakeUI();
			await controllerFor(ui, repo).fastForward(repo.dir, [await repo.sha('main')], { askBranch: false });

			assert.match(ui.allMessages(), /already points at/);
			assert.equal(ui.confirmCalls.length, 0);
		} finally {
			repo.cleanup();
		}
	});

	it('offers a force push when the move rewrote what the remote has', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const remoteDir = await repo.addBareRemote('origin');
			// feature diverges from the pushed main, so moving main is not a fast-forward
			// and the remote ends up with a history that is no longer an ancestor.
			await repo.gitOk(['checkout', '--quiet', '-b', 'feature', shas.v03]);
			const target = await repo.commit('feature work', { 'feature.txt': 'f\n' });
			await repo.checkout('main');
			await repo.commit('main moved on too', { 'main.txt': 'm\n' });

			const ui = new FakeUI({ confirms: [true, true], asks: [ACTIONS.forcePush] });
			await controllerFor(ui, repo).fastForward(repo.dir, [target], { askBranch: false });

			assert.ok(ui.askCalls[0]!.options.actions.includes(ACTIONS.forcePush), ui.transcript);
			assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), target);
			assert.equal(ui.confirmCalls.length, 3, 'move + move anyway + push');
			assert.match(ui.confirmCalls[2]!.message, /Force push main to origin\/main\?/);
		} finally {
			repo.cleanup();
		}
	});

	it('picks a non-checked-out branch and moves it with update-ref', async () => {
		const { repo, featureSha } = await diverged();
		try {
			await repo.checkout('feature');
			const ui = new FakeUI({ picks: ['main'], inputs: ['old-main'] });
			await controllerFor(ui, repo).fastForward(repo.dir, [featureSha], { askBranch: true });

			// main is not checked out and the move is not a fast-forward, so it needs
			// the second confirmation.
			assert.equal(ui.confirmCalls.length, 2);
			assert.equal(await repo.sha('main'), featureSha);
			assert.equal(await repo.sha('HEAD'), featureSha, 'HEAD stayed on feature');
			assert.equal(await repo.hasBranch('old-main'), true);
		} finally {
			repo.cleanup();
		}
	});
});

describe('controller - force push flows', () => {
	it('shows the plan, asks for confirmation and pushes with a lease', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const remoteDir = await repo.addBareRemote('origin');
			await repo.gitOk(['commit', '--quiet', '--amend', '-m', 'v0.4 rewritten']);
			const local = await repo.sha('main');
			const remoteBefore = await repo.remoteBranchSha(remoteDir, 'main');

			const ui = new FakeUI();
			await controllerFor(ui, repo).forcePush(repo.dir, []);

			assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), local);
			assert.match(ui.confirmCalls[0]!.message, /Force push main to origin\/main\?/);
			assert.match(ui.confirmCalls[0]!.options!.detail!, new RegExp(`Overwrites origin/main: ${remoteBefore!.slice(0, 10)} -> ${local.slice(0, 10)}`));
			assert.match(ui.confirmCalls[0]!.options!.detail!, /--force-with-lease/);
			assert.equal(ui.confirmCalls[0]!.options!.confirmLabel, 'Force Push (with lease)');
			assert.match(ui.allLogs(), /Force pushed main -> origin\/main \(lease\)/);
			void shas;
		} finally {
			repo.cleanup();
		}
	});

	it('does not push when the user declines', async () => {
		const { repo } = await createLinearRepo();
		try {
			const remoteDir = await repo.addBareRemote('origin');
			await repo.gitOk(['commit', '--quiet', '--amend', '-m', 'v0.4 rewritten']);
			const remoteBefore = await repo.remoteBranchSha(remoteDir, 'main');

			const ui = new FakeUI({ confirms: [false] });
			await controllerFor(ui, repo).forcePush(repo.dir, []);

			assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), remoteBefore);
			assert.match(ui.allLogs(), /Force push cancelled by the user/);
		} finally {
			repo.cleanup();
		}
	});

	it('uses --force when that is what the user asked for', async () => {
		const { repo } = await createLinearRepo();
		try {
			const remoteDir = await repo.addBareRemote('origin');
			await repo.gitOk(['commit', '--quiet', '--amend', '-m', 'v0.4 rewritten']);

			const ui = new FakeUI();
			await controllerFor(ui, repo).forcePush(repo.dir, [], 'force');

			assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), await repo.sha('main'));
			assert.equal(ui.confirmCalls[0]!.options!.confirmLabel, 'Force Push');
			assert.match(ui.confirmCalls[0]!.options!.detail!, /--force overwrites whatever is on the remote/);
		} finally {
			repo.cleanup();
		}
	});

	it('reports a stale lease as an error message', async () => {
		const { repo } = await createLinearRepo();
		try {
			const remoteDir = await repo.addBareRemote('origin');
			await repo.gitOk(['commit', '--quiet', '--amend', '-m', 'v0.4 rewritten']);
			// A colleague moves the branch; our remote-tracking ref goes stale.
			await repo.pushFromElsewhere(remoteDir, 'someone else');

			const ui = new FakeUI();
			await controllerFor(ui, repo).forcePush(repo.dir, [], 'lease');

			assert.equal(ui.messages[0]!.kind, 'error');
			assert.match(ui.messages[0]!.message, /^Force push: /);
			assert.match(ui.allLogs(), /stale info|--force-with-lease/);
		} finally {
			repo.cleanup();
		}
	});

	it('offers Undo and puts the old sha back on the remote when chosen', async () => {
		const { repo } = await createLinearRepo();
		try {
			const remoteDir = await repo.addBareRemote('origin');
			await repo.gitOk(['commit', '--quiet', '--amend', '-m', 'v0.4 rewritten']);
			const remoteBefore = await repo.remoteBranchSha(remoteDir, 'main');
			const localBefore = await repo.sha('main');

			const ui = new FakeUI({ asks: [ACTIONS.undo] });
			await controllerFor(ui, repo).forcePush(repo.dir, []);

			assert.equal(ui.confirmCalls.length, 2);
			assert.match(ui.confirmCalls[1]!.options!.detail!, new RegExp(`origin/main -> ${remoteBefore!.slice(0, 10)}`));
			assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), remoteBefore);
			assert.equal(await repo.sha('main'), localBefore, 'the local branch is untouched by a remote undo');
		} finally {
			repo.cleanup();
		}
	});

	it('pushes the branch a tree node points at', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const remoteDir = await repo.addBareRemote('origin', ['main']);
			await repo.gitOk(['branch', 'topic', shas.v03]);
			const ui = new FakeUI();
			await controllerFor(ui, repo).forcePush(repo.dir, [{ gecoKind: 'branch', name: 'topic', repoPath: repo.dir }]);

			assert.match(ui.confirmCalls[0]!.message, /Force push topic to origin\/topic\?/);
			assert.equal(await repo.remoteBranchSha(remoteDir, 'topic'), shas.v03);
		} finally {
			repo.cleanup();
		}
	});
});

describe('controller - apply patch at the proper base', () => {
	it('applies a selected commit in a separate worktree at the base it found', async () => {
		const { repo, sideSha, baseSha } = await withSideBranch();
		try {
			const ui = new FakeUI({
				picks: ['Selected commit (patch + message)', 'Separate worktree'],
				inputs: ['geco/replay'],
			});
			await controllerFor(ui, repo).applyPatchAtProperBase(repo.dir, [sideSha]);

			assert.equal(ui.pickCalls[0]!.options!.title, 'Which patch?');
			assert.equal(ui.pickCalls[0]!.items[0]!.description, `${sideSha.slice(0, 7)} side change`);
			assert.equal(ui.pickCalls[1]!.options!.title, 'Where should the patch be applied?');
			assert.equal(ui.inputCalls[0]!.prompt, 'Branch for the new worktree');

			assert.equal(await repo.hasBranch('geco/replay'), true, (await repo.branches()).join(', '));
			assert.equal((await repo.message('geco/replay')).trim(), 'side change');
			assert.equal(await repo.sha('geco/replay^'), baseSha);
			assert.match(ui.allLogs(), /method: am-3/);
			assert.match(ui.askCalls[0]!.message, /Patch applied at [0-9a-f]{7}/);
			assert.equal((await repo.statusLines()).length, 0, 'the user checkout was never touched');
			assert.equal(await repo.sha('main'), await repo.sha('main'));
		} finally {
			repo.cleanup();
		}
	});

	it('opens the worktree when the user picks that follow-up action', async () => {
		const { repo, sideSha } = await withSideBranch();
		try {
			const ui = new FakeUI({
				picks: ['Selected commit (patch + message)', 'Separate worktree'],
				inputs: ['geco/open-me'],
				asks: [ACTIONS.openWorktree],
			});
			await controllerFor(ui, repo).applyPatchAtProperBase(repo.dir, [sideSha]);

			assert.equal(ui.openedPaths.length, 1);
			assert.match(ui.openedPaths[0]!, /geco-open-me/);
			assert.ok(fs.existsSync(`${ui.openedPaths[0]!}/side.txt`), 'the worktree holds the applied patch');
		} finally {
			repo.cleanup();
		}
	});

	it('applies staged changes in a clean worktree', async () => {
		const { repo } = await createLinearRepo();
		try {
			await repo.gitOk(['checkout', '--quiet', '-b', 'work']);
			await repo.commit('wip', { 'wip.txt': 'wip\n' });
			repo.write('staged.txt', 'staged content\n');
			await repo.gitOk(['add', 'staged.txt']);

			const ui = new FakeUI({ picks: ['Staged changes', 'Separate worktree'], inputs: ['staged-worktree'] });
			await controllerFor(ui, repo).applyPatchAtProperBase(repo.dir, []);

			assert.ok(ui.pickCalls[0]!.items.some((i) => i.label === 'Staged changes'));
			assert.ok(ui.pickCalls[0]!.items.every((i) => !i.label.startsWith('Selected commit')), 'no commit was preselected');
			assert.equal(await repo.hasBranch('staged-worktree'), true);
			assert.match(ui.allLogs(), /method: apply/);
			assert.ok((await repo.worktrees()).some((w) => w.endsWith('staged-worktree')));
		} finally {
			repo.cleanup();
		}
	});

	it('reports conflicted files and rolls the worktree back when the patch does not fit', async () => {
		const { repo } = await createLinearRepo();
		try {
			// f.txt exists with two different contents in history, so a 3-way merge of a
			// patch built on the older one can start but cannot finish.
			await repo.commit('f one', { 'f.txt': 'one\n' });
			const oldBlob = await repo.gitOk(['rev-parse', 'HEAD:f.txt']);
			await repo.commit('f changed on main', { 'f.txt': 'main version\n' });

			const patchText = [
				'From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001',
				'From: Test User <test@example.com>',
				'Date: Mon, 17 Sep 2026 10:00:00 +0000',
				'Subject: [PATCH] conflicting change',
				'',
				'---',
				'',
				' f.txt | 2 +-',
				' 1 file changed, 1 insertion(+), 1 deletion(-)',
				'',
				'diff --git a/f.txt b/f.txt',
				`index ${oldBlob}..1111111 100644`,
				'--- a/f.txt',
				'+++ b/f.txt',
				'@@ -1 +1 @@',
				'-one',
				'+conflicting',
				'',
			].join('\n');
			const patchPath = `${repo.root}/conflicting.patch`;
			fs.writeFileSync(patchPath, patchText, 'utf8');

			const ui = new FakeUI({ picks: ['Patch file...', 'Separate worktree'], files: [patchPath], inputs: ['geco/conflict'] });
			await controllerFor(ui, repo).applyPatchAtProperBase(repo.dir, []);

			assert.equal(ui.messages[0]!.kind, 'error');
			assert.match(ui.messages[0]!.message, /^Apply patch: /);
			assert.match(`${ui.messages[0]!.message}\n${ui.messages[0]!.detail ?? ''}`, /f\.txt/);
			assert.match(`${ui.messages[0]!.message}\n${ui.messages[0]!.detail ?? ''}`, /git am --abort|git am --continue/);
			assert.equal(await repo.hasBranch('geco/conflict'), false, 'a failed apply is rolled back');
			assert.equal((await repo.worktrees()).length, 1, 'the worktree is gone too');
			assert.equal((await repo.statusLines()).length, 0, 'the user checkout is clean');
		} finally {
			repo.cleanup();
		}
	});

	it('lists every candidate base with a score', async () => {
		const { repo, sideSha } = await withSideBranch();
		try {
			const ui = new FakeUI({ picks: ['Selected commit (patch + message)'] });
			await controllerFor(ui, repo).showProperBase(repo.dir, [sideSha]);

			assert.match(ui.allLogs(), /Candidate bases \(best first\):/);
			assert.match(ui.allLogs(), /exact/);
			assert.match(ui.allLogs(), /Proper base: [0-9a-f]{7}/);
			assert.match(ui.askCalls[0]!.message, /candidates were probed/);
			assert.ok(ui.askCalls[0]!.options.actions.includes(ACTIONS.applyPatch));
			assert.ok(ui.askCalls[0]!.options.actions.includes(ACTIONS.openLog));
		} finally {
			repo.cleanup();
		}
	});

	it('reveals the output log when asked', async () => {
		const { repo, sideSha } = await withSideBranch();
		try {
			const ui = new FakeUI({ picks: ['Selected commit (patch + message)'], asks: [ACTIONS.openLog] });
			await controllerFor(ui, repo).showProperBase(repo.dir, [sideSha]);

			assert.equal(ui.outputReveals.length, 1);
		} finally {
			repo.cleanup();
		}
	});

	it('reads a patch file picked from disk', async () => {
		const { repo, sideSha } = await withSideBranch();
		const clone = await createLinearRepo();
		try {
			const patchPath = `${repo.root}/exported.patch`;
			const patchText = await repo.gitOk(['format-patch', '-1', '--stdout', sideSha]);
			fs.writeFileSync(patchPath, patchText, 'utf8');

			const ui = new FakeUI({ picks: ['Patch file...', 'Separate worktree'], files: [patchPath], inputs: ['from-file'] });
			await controllerFor(ui, clone.repo).applyPatchAtProperBase(clone.repo.dir, []);

			assert.ok(ui.pickCalls[0]!.items.some((i) => i.label === 'Patch file...'));
			assert.equal(await clone.repo.hasBranch('from-file'), true, (await clone.repo.branches()).join(', '));
			assert.equal((await clone.repo.message('from-file')).trim(), 'side change');
		} finally {
			repo.cleanup();
			clone.repo.cleanup();
		}
	});

	it('applies changes only (no commit message) when that variant is picked', async () => {
		const { repo, sideSha, baseSha } = await withSideBranch();
		try {
			const ui = new FakeUI({ picks: ['Selected commit (changes only)', 'Separate worktree'], inputs: ['geco/diff-only'] });
			await controllerFor(ui, repo).applyPatchAtProperBase(repo.dir, [sideSha]);

			assert.equal(ui.pickCalls[0]!.items[1]!.label, 'Selected commit (changes only)');
			assert.equal(await repo.hasBranch('geco/diff-only'), true);
			assert.equal(await repo.sha('geco/diff-only'), baseSha, 'nothing was committed on top');
			const worktree = (await repo.worktrees()).find((w) => w.endsWith('geco-diff-only'));
			assert.ok(worktree && fs.existsSync(`${worktree}/side.txt`), 'the change is in the worktree, uncommitted');
			assert.match(ui.allLogs(), /method: apply/);
		} finally {
			repo.cleanup();
		}
	});
});

describe('controller - backups, undo and information', () => {
	it('creates a backup branch, journals it and can undo it', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const ui = new FakeUI({ inputs: ['my-backup'] });
			await controllerFor(ui, repo).createBackupBranch(repo.dir, []);

			assert.equal(await repo.sha('my-backup'), shas.v04);
			assert.match(ui.allMessages(), /Backup branch "my-backup"/);
			assert.equal((ui.inputCalls[0]!.value ?? '').startsWith('main-backup-'), true);

			const undoUi = new FakeUI({ picks: [0] });
			await controllerFor(undoUi, repo).undoLastOperation(repo.dir);
			assert.equal(await undoUi.confirmCalls[0]!.message, `Undo "Created backup branch my-backup at ${shas.v04.slice(0, 10)}"?`);
			assert.equal(await repo.hasBranch('my-backup'), false);
			assert.match(undoUi.allMessages(), /Undone: Created backup branch my-backup/);
		} finally {
			repo.cleanup();
		}
	});

	it('backs up a commit that is not on any branch', async () => {
		const { repo, sideSha } = await withSideBranch();
		try {
			await repo.gitOk(['branch', '-D', 'side']);
			const ui = new FakeUI({ inputs: ['rescued'] });
			await controllerFor(ui, repo).createBackupBranch(repo.dir, [sideSha]);

			assert.equal(await repo.sha('rescued'), sideSha);
		} finally {
			repo.cleanup();
		}
	});

	it('says there is nothing to undo on a fresh repository', async () => {
		const { repo } = await createLinearRepo();
		try {
			const ui = new FakeUI();
			await controllerFor(ui, repo).undoLastOperation(repo.dir);

			assert.equal(ui.pickCalls.length, 0);
			assert.match(ui.allMessages(), /Nothing to undo/);
		} finally {
			repo.cleanup();
		}
	});

	it('lets the user pick which journaled operation to undo', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const first = new FakeUI({ inputs: ['first edit'] });
			await controllerFor(first, repo).rewordCommit(repo.dir, [shas.v04], 'append');
			const second = new FakeUI({ inputs: ['second edit'] });
			await controllerFor(second, repo).rewordCommit(repo.dir, [await repo.sha('main')], 'append');

			const ui = new FakeUI({ picks: [1] }); // the older entry
			await controllerFor(ui, repo).undoLastOperation(repo.dir);

			assert.equal(ui.pickCalls[0]!.items.length, 2);
			assert.equal(ui.pickCalls[0]!.items[0]!.label.startsWith('reword - Renamed the message of'), true);
			assert.match(ui.pickCalls[0]!.items[1]!.description!, /also undoes 1 newer operation/);
			assert.match(ui.confirmCalls[0]!.message, /^Undo 2 operations, back to "Renamed the message of /);
			assert.match(ui.allMessages(), /Undone: 2 operations/);
			assert.equal(await repo.sha('main'), shas.v04, 'both rewrites are gone');
			assert.equal((await repo.message('main')).trim(), 'v0.4');
		} finally {
			repo.cleanup();
		}
	});

	it('lists recovery points and journal entries', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const rewordUi = new FakeUI({ inputs: ['journaled'] });
			await controllerFor(rewordUi, repo).rewordCommit(repo.dir, [shas.v04], 'append');

			const ui = new FakeUI();
			await controllerFor(ui, repo).showBackups(repo.dir);

			assert.match(ui.allLogs(), /Recovery points for /);
			assert.match(ui.allLogs(), /refs\/geco\//);
			assert.match(ui.allLogs(), /Journal \(1 entries, newest last\):/);
			assert.match(ui.allLogs(), /reword: Renamed the message of /);
			assert.ok(ui.askCalls[0]!.options.actions.includes(ACTIONS.undo));
			assert.match(ui.askCalls[0]!.message, /1 recovery point\(s\) and 1 journaled operation/);
		} finally {
			repo.cleanup();
		}
	});

	it('copies the full sha to the clipboard', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const ui = new FakeUI();
			await controllerFor(ui, repo).copyCommitSha(repo.dir, [shas.v03]);

			assert.equal(ui.copied[0], shas.v03);
			assert.match(ui.allMessages(), /Copied [0-9a-f]{7,} to the clipboard/);
		} finally {
			repo.cleanup();
		}
	});

	it('explains where the menus live and how to enable the graph menu', async () => {
		const { repo } = await createLinearRepo();
		try {
			const ui = new FakeUI();
			await controllerFor(ui, repo).explainMenus();

			assert.match(ui.allLogs(), /contribSourceControlHistoryItemMenu/);
			assert.match(ui.allLogs(), /npm run package:graph/);
			assert.match(ui.allLogs(), /--enable-proposed-api/);
			assert.match(ui.allLogs(), /Timeline view/);
			assert.equal(ui.messages[0]!.kind, 'info');
		} finally {
			repo.cleanup();
		}
	});

	it('feeds the tree view with commits, branches, recovery points and a summary', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			await repo.gitOk(['branch', 'feature', shas.v03]);
			await repo.gitOk(['tag', 'v0.3', shas.v03]);
			const controller = controllerFor(new FakeUI(), repo);

			const commits = await controller.listCommits(repo.dir);
			assert.equal(commits.length, 4);
			assert.equal(commits[0]!.label, shas.v04.slice(0, 7));
			assert.equal(commits[0]!.description, 'v0.4');
			assert.match(commits[0]!.detail!, /HEAD - main/);
			assert.match(commits[1]!.detail!, /tag:v0\.3/);
			assert.match(commits[1]!.detail!, /feature/);

			const branches = await controller.listBranches(repo.dir);
			assert.deepEqual(branches.map((b) => b.name).sort(), ['feature', 'main']);
			assert.equal(branches.find((b) => b.name === 'main')!.isHead, true);
			assert.equal(branches.find((b) => b.name === 'feature')!.isHead, false);

			assert.deepEqual(await controller.listRecoveryPoints(repo.dir), []);
			assert.deepEqual(await controller.listJournal(repo.dir), []);
			assert.deepEqual(await controller.repoSummary(repo.dir), { branch: 'main', sha: shas.v04, subject: 'v0.4', dirty: false });

			repo.write('untracked.txt', 'x\n');
			assert.equal((await controller.repoSummary(repo.dir)).dirty, true);
		} finally {
			repo.cleanup();
		}
	});

	it('builds the graph rows of our own panel: lanes, ref badges and HEAD', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			await repo.gitOk(['checkout', '--quiet', '-b', 'side', shas.v03]);
			const sideSha = await repo.commit('side change', { 'side.txt': 's\n' });
			await repo.checkout('main');
			await repo.mergeNoFastForward('side', 'Merge side');
			const mergesha = await repo.sha('main');

			const rows = await controllerFor(new FakeUI(), repo).graphRows(repo.dir);
			const bySide = rows.findIndex((row) => row.sha === sideSha);
			const byMerge = rows.findIndex((row) => row.sha === mergesha);

			assert.equal(rows[0]!.sha, mergesha, 'the merge is the tip');
			assert.equal(rows[0]!.art, '●╮', 'the merge opens the lane of its second parent');
			assert.equal(rows[0]!.lane, 0);
			assert.match(rows[0]!.refsLabel, /main \(HEAD\)/, 'the badge of the checked out branch');
			assert.deepEqual(rows[0]!.refs.map((entry) => entry.name), ['main'], 'only branches get child nodes');
			assert.ok(bySide > byMerge, 'parents come after their children, so the lanes line up');
			assert.equal(rows[bySide]!.refs[0]!.name, 'side');
			assert.equal(rows[bySide]!.lane, 1, 'the side branch is drawn in its own lane');
			assert.match(rows[bySide]!.tooltip, /side change/);
		} finally {
			repo.cleanup();
		}
	});

	it('turns the lane art off when the user asks for it', async () => {
		const { repo } = await createLinearRepo();
		try {
			const controller = controllerFor(new FakeUI(), repo, { ...DEFAULT_SETTINGS, showGraphLanes: false });
			const rows = await controller.graphRows(repo.dir);

			assert.equal(rows.length, 4);
			assert.deepEqual(rows.map((row) => row.art), ['', '', '', '']);
		} finally {
			repo.cleanup();
		}
	});

	it('never lets an error escape: a broken repository becomes an error message', async () => {
		const { repo } = await createLinearRepo();
		try {
			const ui = new FakeUI();
			const controller = controllerFor(ui, repo);
			await controller.rewordCommit(`${repo.dir}/definitely-not-a-repo`, [], 'append');

			assert.equal(ui.messages[0]!.kind, 'error');
			assert.match(ui.messages[0]!.message, /^Rename commit: /);
			assert.match(ui.allLogs(), /Rename commit failed:/);
		} finally {
			repo.cleanup();
		}
	});

	it('skips confirmations when the user turned them off', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const settings: Settings = { ...DEFAULT_SETTINGS, confirmDestructiveOperations: false };
			const ui = new FakeUI({ inputs: ['no confirmation'] });
			await controllerFor(ui, repo, settings).rewordCommit(repo.dir, [shas.v04], 'append');

			assert.equal(ui.confirmCalls.length, 0);
			assert.equal((await repo.message('main')).trim(), 'v0.4 no confirmation');
		} finally {
			repo.cleanup();
		}
	});

	it('honours a custom backup branch name and ref prefix from the settings', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const settings: Settings = { ...DEFAULT_SETTINGS, defaultBackupBranchName: 'previous', backupRefPrefix: 'refs/geco-test/' };
			await repo.gitOk(['checkout', '--quiet', '-b', 'feature']);
			const target = await repo.commit('feature work', { 'feature.txt': 'f\n' });
			await repo.checkout('main');

			const ui = new FakeUI();
			await controllerFor(ui, repo, settings).fastForward(repo.dir, [target], { askBranch: false });

			assert.equal(await repo.sha('previous'), shas.v04);
			assert.equal(await repo.hasBranch('old'), false);
			const controller = controllerFor(new FakeUI(), repo, settings);
			const points = await controller.listRecoveryPoints(repo.dir);
			assert.ok(points.length === 0 || points.every((p) => p.name.startsWith('refs/geco-test/') || p.kind === 'branch'));
		} finally {
			repo.cleanup();
		}
	});
});

describe('controller - squash flows', () => {
	it('squashes every selected commit row into one (multi-select passes them all)', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const ui = new FakeUI({ inputs: ['v0.2-v0.4 squashed'], confirms: [true], asks: [undefined] });
			// This is what VS Code sends for a multi-selection: the clicked node
			// first, then the whole selection as a second argument.
			const clicked = { gecoKind: 'commit', sha: shas.v04, repoPath: repo.dir };
			const selected = [clicked, { gecoKind: 'commit', sha: shas.v03, repoPath: repo.dir }, { gecoKind: 'commit', sha: shas.v02, repoPath: repo.dir }];
			await controllerFor(ui, repo).squashSelectedCommits(repo.dir, [clicked, selected]);

			assert.equal(ui.inputCalls[0]!.title, 'Squash 3 commits into one');
			assert.equal(ui.inputCalls[0]!.value, 'v0.4', 'pre-filled with the newest commit message');
			assert.match(ui.confirmCalls[0]!.message, /Squash 3 commits into one on main\?/);
			assert.match(ui.confirmCalls[0]!.options!.detail!, /v0\.2[\s\S]*v0\.3[\s\S]*v0\.4/);
			assert.match(ui.askCalls[0]!.message, /Squashed 3 commits into [0-9a-f]{10} on main: "v0\.2-v0\.4 squashed"/);

			const log = await repo.log('main');
			assert.deepEqual(log.map((line) => line.subject), ['v0.2-v0.4 squashed', 'v0.1']);
			assert.equal((await repo.ctx.safety.readJournal()).at(-1)!.kind, 'squash');
		} finally {
			repo.cleanup();
		}
	});

	it('offers undo after a squash and rolls the history back', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const ui = new FakeUI({ inputs: ['combined'], asks: [ACTIONS.undo] });
			await controllerFor(ui, repo).squashSelectedCommits(repo.dir, [{ gecoKind: 'commit', sha: shas.v04 }, { gecoKind: 'commit', sha: shas.v03 }]);

			assert.equal(await repo.branchSha('main'), shas.v04, 'undo restored the original tip');
			assert.deepEqual((await repo.log('main')).map((line) => line.subject), ['v0.4', 'v0.3', 'v0.2', 'v0.1']);
		} finally {
			repo.cleanup();
		}
	});

	it('explains how to select commits when only one row was passed', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const ui = new FakeUI();
			await controllerFor(ui, repo).squashSelectedCommits(repo.dir, [{ gecoKind: 'commit', sha: shas.v04 }]);

			assert.equal(ui.messages[0]!.kind, 'warn');
			assert.match(ui.messages[0]!.message, /Only one commit is selected/);
			assert.match(ui.messages[0]!.detail!, /Ctrl\/Shift-click/);
			assert.equal(await repo.branchSha('main'), shas.v04, 'nothing was rewritten');
		} finally {
			repo.cleanup();
		}
	});

	it('tells a palette user where to select commits', async () => {
		const { repo } = await createLinearRepo();
		try {
			const ui = new FakeUI();
			await controllerFor(ui, repo).squashSelectedCommits(repo.dir, []);

			assert.equal(ui.messages[0]!.kind, 'info');
			assert.match(ui.messages[0]!.message, /needs a selection in the Graph group/);
			assert.match(ui.messages[0]!.detail!, /Squash with Previous Commits/);
		} finally {
			repo.cleanup();
		}
	});

	it('does not guess when the selection spans two branches', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			await repo.gitOk(['checkout', '--quiet', '-b', 'side', shas.v02]);
			const side = await repo.commit('side work', { 'side.txt': 's\n' });
			await repo.checkout('main');

			const ui = new FakeUI({ inputs: ['combined'], confirms: [true] });
			await controllerFor(ui, repo).squashSelectedCommits(repo.dir, [{ gecoKind: 'commit', sha: shas.v03 }, { gecoKind: 'commit', sha: side }]);

			assert.equal(ui.messages[0]!.kind, 'error');
			assert.match(ui.messages[0]!.message, /not on the same line of history/);
			assert.equal(ui.confirmCalls.length, 0, 'no confirmation for a selection that cannot be squashed');
		} finally {
			repo.cleanup();
		}
	});

	it('squashes a commit with N previous commits, asking for N', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const ui = new FakeUI({ inputs: ['2', 'v0.3 and v0.4 together'], confirms: [true] });
			await controllerFor(ui, repo).squashWithPreviousCommits(repo.dir, [{ gecoKind: 'commit', sha: shas.v04 }]);

			assert.equal(ui.inputCalls[0]!.title, `Squash into ${shas.v04!.slice(0, 7)}`);
			assert.match(ui.inputCalls[0]!.prompt, /How many commits before "v0\.4"/);
			assert.equal(ui.inputCalls[0]!.value, '3', 'defaults to the three commits people usually mean');
			assert.equal(ui.inputCalls[1]!.value, 'v0.4', 'the message input is pre-filled with the newest message');
			assert.match(ui.confirmCalls[0]!.message, /Squash 3 commits into one on main\?/);
			assert.deepEqual((await repo.log('main')).map((line) => line.subject), ['v0.3 and v0.4 together', 'v0.1']);
		} finally {
			repo.cleanup();
		}
	});

	it('refuses to walk past the first commit of the repository', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const ui = new FakeUI();
			await controllerFor(ui, repo).squashWithPreviousCommits(repo.dir, [{ gecoKind: 'commit', sha: shas.v01 }]);

			assert.equal(ui.messages[0]!.kind, 'info');
			assert.match(ui.messages[0]!.message, /first commit of this repository/);
			assert.equal(ui.inputCalls.length, 0, 'no question when there is nothing to squash');
		} finally {
			repo.cleanup();
		}
	});

	it('reports how many commits are too many to walk back and rewrites nothing', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const ui = new FakeUI({ inputs: ['3'] });
			await controllerFor(ui, repo).squashWithPreviousCommits(repo.dir, [{ gecoKind: 'commit', sha: shas.v02 }]);

			assert.equal(ui.messages[0]!.kind, 'warn');
			assert.match(ui.messages[0]!.message, /has only 1 commit\(s\) before it/);
			assert.equal(await repo.branchSha('main'), shas.v04);
		} finally {
			repo.cleanup();
		}
	});

	it('leaves the history it replaced out of the graph (recovery refs are hidden)', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const ui = new FakeUI({ inputs: ['combined'], confirms: [true] });
			await controllerFor(ui, repo).squashSelectedCommits(repo.dir, [{ gecoKind: 'commit', sha: shas.v04 }, { gecoKind: 'commit', sha: shas.v03 }]);

			const rows = await controllerFor(new FakeUI(), repo).graphRows(repo.dir);
			assert.deepEqual(rows.map((row) => row.subject), ['combined', 'v0.2', 'v0.1'], 'the squashed-away commits are gone');
			assert.equal(await repo.hasRef((await repo.ctx.safety.listRecoveryPoints())[0]!.name), true, 'the recovery point is still there');
		} finally {
			repo.cleanup();
		}
	});

	it('flags a force push after squashing a pushed branch', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			await repo.addBareRemote('origin', ['main']);
			const ui = new FakeUI({ inputs: ['combined'], confirms: [true] });
			await controllerFor(ui, repo).squashSelectedCommits(repo.dir, [{ gecoKind: 'commit', sha: shas.v04 }, { gecoKind: 'commit', sha: shas.v03 }]);

			assert.match(ui.confirmCalls[0]!.options!.detail!, /main tracks origin\/main: a force push is needed afterwards/);
			assert.match(ui.askCalls[0]!.message, /origin\/main now needs a force push/);
			assert.ok(ui.askCalls[0]!.options.actions.includes(ACTIONS.forcePush));
		} finally {
			repo.cleanup();
		}
	});
});

for (const message of ['', ' ', '  \n\t']) {
 it(`controller accepts blank rename ${JSON.stringify(message)}`, async () => {
  const { repo } = await createLinearRepo();
  try {
   const ui = new FakeUI({ inputs: [message] });
   await controllerFor(ui, repo).rewordCommit(repo.dir, [await repo.sha('main')], 'replace');
   assert.equal(await repo.ctx.git.rawMessage('main'), ' ');
   assert.equal(ui.confirmCalls.length, 1);
  } finally { repo.cleanup(); }
 });
}
