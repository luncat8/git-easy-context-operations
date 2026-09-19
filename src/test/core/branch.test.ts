/**
 * Branch operations behind the graph / branch menus: create, rename, delete and
 * check out - plus the journal entries that make **Undo** put everything back
 * (including the remote half of a rename or a delete).
 */
import { test, describe, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import {
	checkoutBranch,
	createBranch,
	deleteBranch,
	inspectBranchDeletion,
	renameBranch,
	suggestBranchName,
} from '../../core/branch';
import { GecoError } from '../../core/errors';
import { createLinearRepo, type TempRepo } from '../helpers/tempRepo';

const open: TempRepo[] = [];

afterEach(() => {
	while (open.length > 0) {
		open.pop()!.cleanup();
	}
});

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<GecoError> {
	try {
		await fn();
	} catch (error) {
		assert.ok(error instanceof GecoError, `expected a GecoError, got ${String(error)}`);
		assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.userMessage}`);
		return error;
	}
	throw new assert.AssertionError({ message: 'expected the operation to fail, but it succeeded' });
}

/** v0.1 -> v0.2 -> v0.3 -> v0.4 (main, HEAD). */
async function linear() {
	const { repo, shas } = await createLinearRepo();
	open.push(repo);
	return { repo, shas };
}

/** The same, with a real bare `origin` that has `main`. */
async function withRemote() {
	const { repo, shas } = await linear();
	const remoteDir = await repo.addBareRemote('origin', ['main']);
	return { repo, shas, remoteDir };
}

/** `git.upstream()` answers with full refs; tests care about remote + branch. */
function pick(upstream: { remote: string; branch: string } | undefined) {
	return upstream ? { remote: upstream.remote, branch: upstream.branch } : undefined;
}

/** A branch that is not the remote's default one, pushed and tracking origin. */
async function withPushedTopic(repo: TempRepo, shas: Record<string, string>) {
	await repo.gitOk(['checkout', '--quiet', '-b', 'topic', shas.v02]);
	await repo.gitOk(['push', '--quiet', '-u', 'origin', 'topic:topic']);
	return repo.sha('topic');
}

/** Undo the newest journal entry - what the "Undo" button does. */
async function undoLast(repo: TempRepo) {
	const entry = await repo.ctx.safety.lastEntry();
	assert.ok(entry, 'the operation was journaled');
	return repo.ctx.safety.undo(entry);
}

describe('branch - suggestBranchName', () => {
	test('turns a commit subject into a usable branch name', () => {
		assert.equal(suggestBranchName('v0.2 add new button'), 'v0.2-add-new-button');
		assert.equal(suggestBranchName('Fix: crash on start!'), 'fix-crash-on-start');
		assert.equal(suggestBranchName('  Merge branch "main" into feature/x  '), 'merge-branch-main-into-feature/x');
	});

	test('never suggests something git would reject', () => {
		assert.equal(suggestBranchName(''), 'new-branch');
		assert.equal(suggestBranchName('!!!'), 'new-branch');
		assert.equal(suggestBranchName('...'), 'new-branch');
		const long = suggestBranchName('x'.repeat(200));
		assert.ok(long.length <= 48, `expected <= 48 characters, got ${long.length}`);
		assert.doesNotMatch(long, /[./-]$/, 'no trailing separator');
	});
});

describe('branch - createBranch', () => {
	test('creates a branch at HEAD and leaves the worktree alone', async () => {
		const { repo } = await linear();
		const head = await repo.sha('HEAD');

		const result = await createBranch(repo.ctx, { name: 'feature/new-button' });

		assert.equal(result.sha, head);
		assert.equal(result.checkedOut, false);
		assert.equal(await repo.branchSha('feature/new-button'), head);
		assert.equal(await repo.api.headBranch(), 'main', 'still on the branch we were on');
		assert.deepEqual(await repo.statusLines(), []);
	});

	test('starts the branch at the commit the menu was opened on', async () => {
		const { repo, shas } = await linear();

		await createBranch(repo.ctx, { name: 'hotfix', startPoint: shas.v02 });

		assert.equal(await repo.branchSha('hotfix'), shas.v02);
		assert.equal(await repo.api.headBranch(), 'main');
	});

	test('checks the new branch out when asked, and undo comes back', async () => {
		const { repo } = await linear();

		const result = await createBranch(repo.ctx, { name: 'work', checkout: true });
		assert.equal(result.checkedOut, true);
		assert.equal(await repo.api.headBranch(), 'work');

		await undoLast(repo);
		assert.equal(await repo.hasBranch('work'), false, 'undo deleted the branch it created');
		assert.equal(await repo.api.headBranch(), 'main', 'undo checked the previous branch out again');
	});

	test('refuses to clobber an existing branch unless forced', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'old', shas.v01]);

		const error = await expectCode(() => createBranch(repo.ctx, { name: 'old', startPoint: shas.v03 }), 'invalid-ref');
		assert.match(error.userMessage, /already exists/);
		assert.equal(await repo.branchSha('old'), shas.v01, 'nothing moved');

		const forced = await createBranch(repo.ctx, { name: 'old', startPoint: shas.v03, force: true });
		assert.equal(forced.overwritten, shas.v01);
		assert.equal(await repo.branchSha('old'), shas.v03);
		assert.deepEqual(forced.notes.length > 0, true);

		await undoLast(repo);
		assert.equal(await repo.branchSha('old'), shas.v01, 'undo put the old tip back');
	});

	test('says so when the branch already points there', async () => {
		const { repo, shas } = await linear();
		const error = await expectCode(() => createBranch(repo.ctx, { name: 'main', startPoint: shas.v04 }), 'invalid-ref');
		assert.match(error.userMessage, /already points at/);
	});

	test('rejects names git rejects', async () => {
		const { repo } = await linear();
		for (const name of ['has space', '-leading-dash', 'a..b', 'main@{1}', '']) {
			const error = await expectCode(() => createBranch(repo.ctx, { name }), 'invalid-ref');
			assert.ok(error.userMessage.length > 0, `${name} was reported`);
		}
		assert.equal((await repo.branches()).length, 1, 'no stray branches were created');
	});

	test('undo removes exactly one journal entry per operation', async () => {
		const { repo } = await linear();
		await createBranch(repo.ctx, { name: 'one' });
		await createBranch(repo.ctx, { name: 'two' });
		assert.equal((await repo.ctx.safety.readJournal()).length, 2);

		await undoLast(repo);
		assert.equal(await repo.hasBranch('two'), false);
		assert.equal(await repo.hasBranch('one'), true);
	});

	test('reports a missing commit instead of branching from nothing', async () => {
		const { repo, shas } = await linear();
		void shas;
		await expectCode(() => createBranch(repo.ctx, { name: 'nope', startPoint: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }), 'commit-not-found');
		assert.equal(await repo.hasBranch('nope'), false);
	});
});

describe('branch - renameBranch', () => {
	test('renames, keeps the commit and moves HEAD with it', async () => {
		const { repo } = await linear();
		const sha = await repo.sha('main');

		const result = await renameBranch(repo.ctx, { from: 'main', to: 'trunk' });

		assert.equal(result.wasCurrent, true);
		assert.equal(result.sha, sha);
		assert.equal(await repo.branchSha('trunk'), sha);
		assert.equal(await repo.hasBranch('main'), false);
		assert.equal(await repo.api.headBranch(), 'trunk');
		assert.equal(await repo.sha('HEAD'), sha, 'nothing was rewritten');
	});

	test('undo brings the old name back and checks it out again', async () => {
		const { repo } = await linear();
		const sha = await repo.sha('main');
		await renameBranch(repo.ctx, { from: 'main', to: 'trunk' });

		await undoLast(repo);

		assert.equal(await repo.branchSha('main'), sha);
		assert.equal(await repo.hasBranch('trunk'), false, 'the new name is gone');
		assert.equal(await repo.api.headBranch(), 'main');
	});

	test('renames a branch that is not checked out without touching HEAD', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'wip', shas.v02]);

		const result = await renameBranch(repo.ctx, { from: 'wip', to: 'wip-renamed' });

		assert.equal(result.wasCurrent, false);
		assert.equal(await repo.branchSha('wip-renamed'), shas.v02);
		assert.equal(await repo.api.headBranch(), 'main');
		await undoLast(repo);
		assert.equal(await repo.branchSha('wip'), shas.v02);
		assert.equal(await repo.api.headBranch(), 'main');
	});

	test('refuses a taken name, and overwrites it with force (undo restores both)', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'other', shas.v01]);
		const mainSha = await repo.sha('main');

		const error = await expectCode(() => renameBranch(repo.ctx, { from: 'main', to: 'other' }), 'invalid-ref');
		assert.match(error.userMessage, /already exists/);
		assert.equal(await repo.branchSha('other'), shas.v01);

		await renameBranch(repo.ctx, { from: 'main', to: 'other', force: true });
		assert.equal(await repo.branchSha('other'), mainSha);
		assert.equal(await repo.hasBranch('main'), false);

		await undoLast(repo);
		assert.equal(await repo.branchSha('main'), mainSha, 'the renamed branch is back');
		assert.equal(await repo.branchSha('other'), shas.v01, 'the overwritten branch is back where it was');
		assert.equal(await repo.api.headBranch(), 'main');
	});

	test('refuses nonsense: same name, unknown branch', async () => {
		const { repo } = await linear();
		await expectCode(() => renameBranch(repo.ctx, { from: 'main', to: 'main' }), 'nothing-to-do');
		await expectCode(() => renameBranch(repo.ctx, { from: 'ghost', to: 'main' }), 'ref-not-found');
		await expectCode(() => renameBranch(repo.ctx, { from: 'main', to: '' }), 'invalid-ref');
	});

	test("remote 'keep': the remote branch is untouched and still tracked", async () => {
		const { repo, remoteDir } = await withRemote();
		const sha = await repo.sha('main');

		const result = await renameBranch(repo.ctx, { from: 'main', to: 'trunk', remote: 'keep' });

		assert.equal(result.upstreamAfter, 'origin/main');
		assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), sha);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'trunk'), undefined, 'nothing was pushed');
		assert.deepEqual(pick(await repo.api.upstream('trunk')), { remote: 'origin', branch: 'main' });

		await undoLast(repo);
		assert.equal(await repo.branchSha('main'), sha);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), sha);
		assert.deepEqual(pick(await repo.api.upstream('main')), { remote: 'origin', branch: 'main' });
	});

	test("remote 'rename': pushes the new name, deletes the old one, undo repairs both", async () => {
		const { repo, shas, remoteDir } = await withRemote();
		const sha = await withPushedTopic(repo, shas);

		const result = await renameBranch(repo.ctx, { from: 'topic', to: 'feature/topic', remote: 'rename' });

		assert.equal(result.pushedRemoteBranch, 'origin/feature/topic');
		assert.equal(result.deletedRemoteBranch, 'origin/topic');
		assert.equal(result.upstreamAfter, 'origin/feature/topic');
		assert.equal(await repo.remoteBranchSha(remoteDir, 'feature/topic'), sha);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'topic'), undefined);
		assert.deepEqual(pick(await repo.api.upstream('feature/topic')), { remote: 'origin', branch: 'feature/topic' });

		await undoLast(repo);
		assert.equal(await repo.branchSha('topic'), sha, 'the local name is back');
		assert.equal(await repo.hasBranch('feature/topic'), false);
		assert.equal(await repo.api.headBranch(), 'topic');
		assert.equal(await repo.remoteBranchSha(remoteDir, 'topic'), sha, 'the deleted remote branch came back');
		assert.equal(await repo.remoteBranchSha(remoteDir, 'feature/topic'), undefined, 'the pushed branch was removed again');
		assert.deepEqual(pick(await repo.api.upstream('topic')), { remote: 'origin', branch: 'topic' }, 'tracking came back with it');
	});

	test("remote 'rename' on the remote's default branch: reports the refusal instead of failing", async () => {
		const { repo, remoteDir } = await withRemote();
		const sha = await repo.sha('main');

		const result = await renameBranch(repo.ctx, { from: 'main', to: 'trunk', remote: 'rename' });

		assert.equal(result.pushedRemoteBranch, 'origin/trunk');
		assert.equal(result.deletedRemoteBranch, undefined, 'a remote will not delete the branch its HEAD points at');
		assert.match(result.notes.join('\n'), /Could not delete origin\/main/);
		assert.equal(await repo.branchSha('trunk'), sha);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), sha, 'the old remote branch is still there');
		assert.equal(await repo.remoteBranchSha(remoteDir, 'trunk'), sha);

		await undoLast(repo);
		assert.equal(await repo.branchSha('main'), sha);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'trunk'), undefined, 'the branch we pushed is removed again');
	});

	test("remote 'push': both names exist on the remote, undo only removes the new one", async () => {
		const { repo, shas, remoteDir } = await withRemote();
		const sha = await withPushedTopic(repo, shas);

		const result = await renameBranch(repo.ctx, { from: 'topic', to: 'feature/topic', remote: 'push' });

		assert.equal(result.pushedRemoteBranch, 'origin/feature/topic');
		assert.equal(result.deletedRemoteBranch, undefined);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'topic'), sha);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'feature/topic'), sha);
		assert.deepEqual(pick(await repo.api.upstream('feature/topic')), { remote: 'origin', branch: 'feature/topic' });

		await undoLast(repo);
		assert.equal(await repo.branchSha('topic'), sha);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'topic'), sha, 'the old remote branch stays');
		assert.equal(await repo.remoteBranchSha(remoteDir, 'feature/topic'), undefined, 'the branch we pushed is gone again');
	});

	test('a rename is journaled as one entry, not one per remote step', async () => {
		const { repo, shas } = await withRemote();
		await withPushedTopic(repo, shas);
		await renameBranch(repo.ctx, { from: 'topic', to: 'feature/topic', remote: 'rename' });

		const journal = await repo.ctx.safety.readJournal();
		assert.equal(journal.length, 1);
		assert.equal(journal[0]!.kind, 'branch');
		assert.equal(journal[0]!.undo.type, 'refs');
		const undo = journal[0]!.undo as { refs: { upstream?: string }[]; checkoutRef?: string; remoteRefs?: { remote: string; branch: string; action?: string }[] };
		assert.equal(undo.remoteRefs?.length, 2, 'restore the old remote branch, remove the new one');
		assert.deepEqual(undo.remoteRefs?.map((r) => `${r.action ?? 'restore'} ${r.remote}/${r.branch}`), [
			'restore origin/topic',
			'delete origin/feature/topic',
		]);
		assert.equal(undo.checkoutRef, 'topic', 'HEAD has to come back before the new name can go');
		assert.equal(undo.refs[0]!.upstream, 'origin/topic', 'the journal stores the short upstream name');
	});

	test('renaming without an upstream can still publish the new name', async () => {
		const { repo, shas, remoteDir } = await withRemote();
		await repo.gitOk(['branch', 'local-only', shas.v02]);

		const result = await renameBranch(repo.ctx, { from: 'local-only', to: 'published', remote: 'push' });

		assert.equal(result.pushedRemoteBranch, 'origin/published');
		assert.equal(await repo.remoteBranchSha(remoteDir, 'published'), shas.v02);
	});
});

describe('branch - deleteBranch', () => {
	test('deletes a merged branch, keeps the remote copy, undo restores both', async () => {
		const { repo, shas, remoteDir } = await withRemote();
		await repo.gitOk(['branch', 'merged', shas.v02]);
		await repo.gitOk(['push', '--quiet', '-u', 'origin', 'merged:merged']);

		const info = await inspectBranchDeletion(repo.ctx, 'merged');
		assert.equal(info.isCurrent, false);
		assert.equal(info.upstream, 'origin/merged');
		assert.equal(info.unmergedCommits, 0, 'everything on it is already on its upstream');

		const result = await deleteBranch(repo.ctx, { name: 'merged' });
		assert.equal(result.forced, false);
		assert.equal(result.deletedRemoteBranch, undefined);
		assert.equal(await repo.hasBranch('merged'), false);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'merged'), shas.v02, 'the remote copy survives a local delete');

		await undoLast(repo);
		assert.equal(await repo.branchSha('merged'), shas.v02);
		assert.deepEqual(pick(await repo.api.upstream('merged')), { remote: 'origin', branch: 'merged' }, 'tracking was restored');
	});

	test('refuses the branch that is checked out', async () => {
		const { repo } = await linear();
		const info = await inspectBranchDeletion(repo.ctx, 'main');
		assert.equal(info.isCurrent, true);

		const error = await expectCode(() => deleteBranch(repo.ctx, { name: 'main' }), 'unsupported');
		assert.match(error.userMessage, /checked out/);
		assert.equal(await repo.hasBranch('main'), true);
	});

	test('refuses unmerged work unless forced, and undo brings it back', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['checkout', '--quiet', '-b', 'wip', shas.v02]);
		const wipSha = await repo.commit('wip only', { 'wip.txt': 'w\n' });
		await repo.checkout('main');

		const info = await inspectBranchDeletion(repo.ctx, 'wip');
		assert.equal(info.unmergedCommits, 1);
		assert.deepEqual(info.unmerged.map((c) => c.subject), ['wip only']);

		const error = await expectCode(() => deleteBranch(repo.ctx, { name: 'wip' }), 'unmerged-branch');
		assert.match(error.userMessage, /1 commit that HEAD does not have/);
		assert.match(error.detail!, /wip only/);
		assert.equal(await repo.hasBranch('wip'), true, 'nothing was deleted');

		const forced = await deleteBranch(repo.ctx, { name: 'wip', force: true });
		assert.equal(forced.forced, true);
		assert.equal(forced.unmergedCommits, 1);
		assert.equal(await repo.hasBranch('wip'), false);

		await undoLast(repo);
		assert.equal(await repo.branchSha('wip'), wipSha, 'the unmerged commit is reachable again');
	});

	test('counts unmerged commits against the upstream when there is one', async () => {
		const { repo, shas } = await withRemote();
		await repo.gitOk(['checkout', '--quiet', '-b', 'topic', shas.v02]);
		await repo.gitOk(['push', '--quiet', '-u', 'origin', 'topic:topic']);
		const ahead = await repo.commit('not pushed yet', { 'ahead.txt': 'a\n' });
		await repo.checkout('main');

		const info = await inspectBranchDeletion(repo.ctx, 'topic');
		assert.equal(info.upstream, 'origin/topic');
		assert.equal(info.unmergedCommits, 1, 'the pushed part is safe, the new commit is not');

		const error = await expectCode(() => deleteBranch(repo.ctx, { name: 'topic' }), 'unmerged-branch');
		assert.match(error.userMessage, /origin\/topic does not have/);
		assert.equal(await repo.branchSha('topic'), ahead);
	});

	test('deletes the remote branch too when asked, and undo pushes it back', async () => {
		const { repo, shas, remoteDir } = await withRemote();
		await repo.gitOk(['branch', 'stale', shas.v02]);
		await repo.gitOk(['push', '--quiet', '-u', 'origin', 'stale:stale']);

		const result = await deleteBranch(repo.ctx, { name: 'stale', deleteRemote: true });
		assert.equal(result.deletedRemoteBranch, 'origin/stale');
		assert.equal(await repo.hasBranch('stale'), false);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'stale'), undefined);

		await undoLast(repo);
		assert.equal(await repo.branchSha('stale'), shas.v02);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'stale'), shas.v02, 'the remote branch came back');
		assert.deepEqual(pick(await repo.api.upstream('stale')), { remote: 'origin', branch: 'stale' });
	});

	test('a delete is journaled as one entry, remote included', async () => {
		const { repo, shas } = await withRemote();
		await repo.gitOk(['branch', 'stale', shas.v02]);
		await repo.gitOk(['push', '--quiet', '-u', 'origin', 'stale:stale']);
		await deleteBranch(repo.ctx, { name: 'stale', deleteRemote: true });

		const journal = await repo.ctx.safety.readJournal();
		assert.equal(journal.length, 1);
		assert.match(journal[0]!.summary, /Deleted branch stale .* and origin\/stale/);
	});

	test('reports an unknown branch', async () => {
		const { repo } = await linear();
		await expectCode(() => deleteBranch(repo.ctx, { name: 'ghost' }), 'ref-not-found');
		await expectCode(() => inspectBranchDeletion(repo.ctx, 'ghost'), 'ref-not-found');
	});
});

describe('branch - checkoutBranch', () => {
	test('switches branches and undo switches back', async () => {
		const { repo, shas } = await linear();
		await repo.gitOk(['branch', 'other', shas.v02]);

		const result = await checkoutBranch(repo.ctx, 'other');
		assert.deepEqual(result, { from: 'main', to: 'other' });
		assert.equal(await repo.api.headBranch(), 'other');
		assert.equal(await repo.sha('HEAD'), shas.v02);

		await undoLast(repo);
		assert.equal(await repo.api.headBranch(), 'main');
		assert.equal(await repo.sha('HEAD'), shas.v04);
	});

	test('says so when the branch is already checked out', async () => {
		const { repo } = await linear();
		await expectCode(() => checkoutBranch(repo.ctx, 'main'), 'nothing-to-do');
	});
});
