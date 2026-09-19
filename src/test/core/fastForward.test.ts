import { test, describe, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { fastForwardBranch, resolveBranch } from '../../core/fastForward';
import { GecoError } from '../../core/errors';
import { createLinearRepo, createTempRepo, type TempRepo } from '../helpers/tempRepo';

const open: TempRepo[] = [];

async function linear() {
	const created = await createLinearRepo();
	open.push(created.repo);
	return created;
}

async function temp(options?: Parameters<typeof createTempRepo>[0]) {
	const created = await createTempRepo(options);
	open.push(created);
	return created;
}

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

/** main: v0.1..v0.4, feature: v0.1..v0.4 + f1 + f2 */
async function withFeatureBranch() {
	const { repo, shas } = await linear();
	await repo.checkout('feature', { create: true });
	const f1 = await repo.commit('feature one', { 'f1.txt': '1\n' });
	const f2 = await repo.commit('feature two', { 'f2.txt': '2\n' });
	await repo.checkout('main');
	return { repo, shas, f1, f2 };
}

describe('fastForwardBranch - real fast-forward', () => {
	test('moves main to the feature tip and parks the old tip on "old"', async () => {
		const { repo, shas, f2 } = await withFeatureBranch();
		const mainBefore = shas.v04;

		const result = await fastForwardBranch(repo.ctx, { target: f2, branch: 'main' });

		assert.equal(result.wasFastForward, true);
		assert.equal(result.alreadyAtTarget, false);
		assert.equal(await repo.branchSha('main'), f2);
		assert.equal(result.from, mainBefore);
		assert.equal(result.to, f2);
		assert.equal(result.ahead, 2);
		assert.equal(result.behind, 0);
		assert.deepEqual(result.discardedCommits, []);
		assert.equal(result.backup?.name, 'old');
		assert.equal(await repo.branchSha('old'), mainBefore);
		assert.equal(result.checkedOut, true, 'main is the checked out branch in this scenario');
		assert.equal(result.worktreeUpdated, true);
		assert.equal(repo.read('f1.txt'), '1\n');
		assert.deepEqual(await repo.statusLines(), []);
		assert.equal(await repo.gitOk(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
	});

	test('the working tree is untouched when the branch is not checked out', async () => {
		const { repo, shas, f2 } = await withFeatureBranch();
		await repo.checkout('feature');
		repo.write('scratch.txt', 'local scratch\n');

		const result = await fastForwardBranch(repo.ctx, { target: f2, branch: 'main' });

		assert.equal(result.checkedOut, false);
		assert.equal(await repo.gitOk(['rev-parse', '--abbrev-ref', 'HEAD']), 'feature');
		assert.equal(repo.read('scratch.txt'), 'local scratch\n');
		assert.deepEqual(await repo.statusLines(), ['?? scratch.txt']);
		assert.equal(await repo.branchSha('main'), f2);
		assert.ok(shas.v04);
	});

	test('updates the working tree when main is checked out', async () => {
		const { repo, f2 } = await withFeatureBranch();
		await repo.checkout('main');
		assert.equal(repo.exists('f1.txt'), false);

		const result = await fastForwardBranch(repo.ctx, { target: f2, branch: 'main' });

		assert.equal(result.checkedOut, true);
		assert.equal(result.worktreeUpdated, true);
		assert.equal(repo.exists('f1.txt'), true, 'the feature files are checked out');
		assert.equal(repo.read('f2.txt'), '2\n');
		assert.deepEqual(await repo.statusLines(), [], 'the worktree is clean after the fast-forward');
		assert.equal(await repo.branchSha('main'), f2);
	});

	test('an explicit backup name is used', async () => {
		const { repo, f2 } = await withFeatureBranch();
		const result = await fastForwardBranch(repo.ctx, { target: f2, branch: 'main', backupName: 'main-before-release' });
		assert.equal(result.backup?.name, 'main-before-release');
		assert.equal(await repo.hasBranch('main-before-release'), true);
	});

	test('no backup branch when createBackup=false', async () => {
		const { repo, f2 } = await withFeatureBranch();
		const result = await fastForwardBranch(repo.ctx, { target: f2, branch: 'main', createBackup: false });
		assert.equal(result.backup, undefined);
		assert.equal(await repo.hasBranch('old'), false);
	});

	test('moving to the commit main already points at is a no-op', async () => {
		const { repo, shas } = await linear();
		const result = await fastForwardBranch(repo.ctx, { target: shas.v04, branch: 'main' });
		assert.equal(result.alreadyAtTarget, true);
		assert.equal(result.backup, undefined);
		assert.equal(result.notes.length, 1);
		assert.match(result.notes[0], /nothing to do/);
		assert.equal((await repo.ctx.safety.readJournal()).length, 0);
	});

	test('a short sha or a relative revision works as the target', async () => {
		const { repo, f2 } = await withFeatureBranch();
		const short = f2.slice(0, 8);
		const result = await fastForwardBranch(repo.ctx, { target: short, branch: 'main' });
		assert.equal(result.to, f2);
		assert.equal(await repo.branchSha('main'), f2);
	});
});

describe('fastForwardBranch - diverged histories', () => {
	/** main gets its own commit after the feature branch forked off. */
	async function diverged() {
		const { repo, shas } = await linear();
		await repo.checkout('feature', { create: true });
		const f1 = await repo.commit('feature one', { 'f1.txt': '1\n' });
		await repo.checkout('main');
		const mainOnly = await repo.commit('main only', { 'm.txt': 'm\n' });
		return { repo, shas, f1, mainOnly };
	}

	test('refuses without force and leaves everything alone', async () => {
		const { repo, shas, f1, mainOnly } = await diverged();
		const error = await expectCode(() => fastForwardBranch(repo.ctx, { target: f1, branch: 'main' }), 'not-fast-forward');

		assert.match(error.userMessage, /1 commit on "main" would be left behind/);
		assert.match(error.userMessage, /main only/);
		assert.equal(await repo.branchSha('main'), mainOnly, 'main did not move');
		assert.equal(await repo.hasBranch('old'), false, 'no backup branch was left behind');
		assert.equal((await repo.ctx.safety.readJournal()).length, 0);
		assert.ok(shas.v04);
	});

	test('with force it moves main and the discarded commit stays reachable from the backup', async () => {
		const { repo, f1, mainOnly } = await diverged();

		const result = await fastForwardBranch(repo.ctx, { target: f1, branch: 'main', force: true });

		assert.equal(result.wasFastForward, false);
		assert.equal(result.behind, 1);
		assert.equal(result.ahead, 1);
		assert.equal(await repo.branchSha('main'), f1);
		assert.equal(result.discardedCommits.length, 1);
		assert.equal(result.discardedCommits[0].subject, 'main only');
		assert.equal(result.discardedCommits[0].sha, mainOnly);

		const backup = result.backup!;
		assert.equal(await repo.branchSha(backup.name), mainOnly);
		const stillReachable = await repo.git(['merge-base', '--is-ancestor', mainOnly, backup.name]);
		assert.equal(stillReachable.exitCode, 0, 'the discarded commit is safe on the backup branch');
	});

	test('moving main backwards needs force too', async () => {
		const { repo, shas } = await linear();
		await expectCode(() => fastForwardBranch(repo.ctx, { target: shas.v02, branch: 'main' }), 'not-fast-forward');

		const result = await fastForwardBranch(repo.ctx, { target: shas.v02, branch: 'main', force: true });
		assert.equal(await repo.branchSha('main'), shas.v02);
		assert.equal(result.discardedCommits.length, 2);
		assert.deepEqual(result.discardedCommits.map((c) => c.subject).sort(), ['v0.3', 'v0.4']);
		assert.equal(await repo.branchSha('old'), shas.v04);
	});

	test('a dirty worktree blocks reset --hard, allowDirty overrides it', async () => {
		const { repo, f1 } = await diverged();
		repo.write('m.txt', 'uncommitted local edit\n');

		const error = await expectCode(
			() => fastForwardBranch(repo.ctx, { target: f1, branch: 'main', force: true }),
			'dirty-worktree',
		);
		assert.match(error.userMessage, /uncommitted changes/);

		const result = await fastForwardBranch(repo.ctx, { target: f1, branch: 'main', force: true, allowDirty: true });
		assert.equal(result.worktreeUpdated, true);
		assert.equal(await repo.branchSha('main'), f1);
	});

	test('checkoutStrategy "refuse" never touches a checked out branch', async () => {
		const { repo, f1 } = await diverged();
		const error = await expectCode(
			() => fastForwardBranch(repo.ctx, { target: f1, branch: 'main', force: true, checkoutStrategy: 'refuse' }),
			'rejected',
		);
		assert.match(error.userMessage, /checked out/);
	});

	test('checkoutStrategy "ff-only" refuses a diverged move even with force', async () => {
		const { repo, f1 } = await diverged();
		await expectCode(
			() => fastForwardBranch(repo.ctx, { target: f1, branch: 'main', force: true, checkoutStrategy: 'ff-only' }),
			'not-fast-forward',
		);
	});

	test('a failed move does not leave a stray backup branch', async () => {
		const { repo, f1 } = await diverged();
		repo.write('m.txt', 'dirty\n');
		await expectCode(() => fastForwardBranch(repo.ctx, { target: f1, branch: 'main', force: true }), 'dirty-worktree');
		assert.equal(await repo.hasBranch('old'), false);
		assert.equal(await repo.branches().then((b) => b.length), 2, 'only main and feature remain');
	});
});

describe('fastForwardBranch - backup naming', () => {
	test('an occupied name gets a numeric suffix', async () => {
		const { repo, shas, f2 } = await withFeatureBranch();
		await repo.gitOk(['branch', 'old', shas.v01]);

		const result = await fastForwardBranch(repo.ctx, { target: f2, branch: 'main' });

		assert.equal(result.backup?.name, 'old-2');
		assert.equal(result.backup?.renamed, true);
		assert.equal(await repo.branchSha('old'), shas.v01, 'the pre-existing branch is untouched');
		assert.equal(await repo.branchSha('old-2'), shas.v04);
		assert.match(result.notes.join('\n'), /old-2/);
	});

	test('a chain of collisions keeps counting up', async () => {
		const { repo, shas, f1, f2 } = await withFeatureBranch();
		await repo.gitOk(['branch', 'old', shas.v01]);
		await repo.gitOk(['branch', 'old-2', shas.v02]);

		const result = await fastForwardBranch(repo.ctx, { target: f2, branch: 'main' });
		assert.equal(result.backup?.name, 'old-3');
		assert.ok(f1);
	});

	test('a tag with the same name is avoided too', async () => {
		const { repo, f2 } = await withFeatureBranch();
		await repo.gitOk(['tag', 'old']);
		const result = await fastForwardBranch(repo.ctx, { target: f2, branch: 'main' });
		assert.equal(result.backup?.name, 'old-2');
	});

	test('the configured default name is used', async () => {
		const custom = await temp({ settings: { defaultBackupBranchName: 'previous-main' } });
		await custom.commit('one', { 'a.txt': '1\n' });
		await custom.checkout('feature', { create: true });
		const two = await custom.commit('two', { 'b.txt': '2\n' });
		await custom.checkout('main');

		const result = await fastForwardBranch(custom.ctx, { target: two });

		assert.equal(result.branch, 'main', 'main is auto-detected');
		assert.equal(result.backup?.name, 'previous-main');
		assert.equal(await custom.branchSha('previous-main'), result.from);
	});

	test('an existing backup that already points at the old tip is reused', async () => {
		const { repo, shas, f2 } = await withFeatureBranch();
		await repo.gitOk(['branch', 'old', shas.v04]);

		const result = await fastForwardBranch(repo.ctx, { target: f2, branch: 'main' });

		assert.equal(result.backup?.name, 'old');
		assert.equal(result.backup?.reused, true);
		assert.equal(result.backup?.renamed, false);
		assert.equal(await repo.branchSha('main'), f2);
	});
});

describe('fastForwardBranch - branch resolution', () => {
	test('origin/HEAD wins when it is set', async () => {
		const { repo, f2 } = await withFeatureBranch();
		const remoteDir = await repo.addBareRemote('origin', ['main']);
		assert.ok(remoteDir);

		const resolved = await resolveBranch(repo.ctx);
		assert.equal(resolved.branch, 'main');
		assert.equal(resolved.how, 'originHead');

		const result = await fastForwardBranch(repo.ctx, { target: f2 });
		assert.equal(result.branch, 'main');
		assert.equal(result.branchHow, 'originHead');
		assert.equal(await repo.branchSha('main'), f2);
	});

	test('falls back to "main", then "master", then the current branch', async () => {
		const noOrigin = await temp();
		await noOrigin.commit('one', { 'a.txt': '1\n' });
		await noOrigin.gitOk(['branch', '-m', 'main', 'trunk']);
		assert.equal((await resolveBranch(noOrigin.ctx)).branch, 'trunk');
		assert.equal((await resolveBranch(noOrigin.ctx)).how, 'current');

		await noOrigin.gitOk(['branch', 'master']);
		assert.equal((await resolveBranch(noOrigin.ctx)).branch, 'master');

		await noOrigin.gitOk(['branch', 'main']);
		const resolved = await resolveBranch(noOrigin.ctx);
		assert.equal(resolved.branch, 'main');
		assert.equal(resolved.how, 'main');
	});

	test('an explicit branch is always honoured', async () => {
		const { repo, shas, f2 } = await withFeatureBranch();
		await repo.gitOk(['branch', 'release', 'main']);
		const result = await fastForwardBranch(repo.ctx, { target: f2, branch: 'release' });
		assert.equal(result.branch, 'release');
		assert.equal(result.branchHow, 'explicit');
		assert.equal(await repo.branchSha('release'), f2);
		assert.equal(await repo.branchSha('main'), shas.v04, 'other branches are left alone');
	});

	test('an unknown branch is reported', async () => {
		const { repo, f2 } = await withFeatureBranch();
		const error = await expectCode(() => fastForwardBranch(repo.ctx, { target: f2, branch: 'nope' }), 'ref-not-found');
		assert.match(error.userMessage, /feature, main/);
	});

	test('an unknown target commit is reported', async () => {
		const { repo } = await withFeatureBranch();
		await expectCode(() => fastForwardBranch(repo.ctx, { target: 'deadbeefdeadbeef', branch: 'main' }), 'commit-not-found');
	});
});

describe('fastForwardBranch - undo', () => {
	test('undo puts main back and deletes the backup branch', async () => {
		const { repo, shas, f2 } = await withFeatureBranch();
		await fastForwardBranch(repo.ctx, { target: f2, branch: 'main' });
		assert.equal(await repo.branchSha('main'), f2);

		const journal = await repo.ctx.safety.readJournal();
		assert.equal(journal.length, 1);
		assert.equal(journal[0].kind, 'fastForward');
		assert.match(journal[0].summary, /Moved main .* -> .* \(fast-forward, 2 ahead \/ 0 behind\), old tip kept on old/);

		const undo = await repo.ctx.safety.undo(journal[0]);
		assert.equal(await repo.branchSha('main'), shas.v04);
		assert.equal(await repo.hasBranch('old'), false);
		assert.deepEqual(undo.restored, [`refs/heads/main -> ${shas.v04.slice(0, 10)}`]);
	});

	test('undo also resynchronises the working tree when main was checked out', async () => {
		const { repo, shas, f2 } = await withFeatureBranch();
		await repo.checkout('main');
		await fastForwardBranch(repo.ctx, { target: f2, branch: 'main' });
		assert.equal(repo.exists('f1.txt'), true);

		const journal = await repo.ctx.safety.readJournal();
		await repo.ctx.safety.undo(journal[0]);

		assert.equal(await repo.branchSha('main'), shas.v04);
		assert.equal(repo.exists('f1.txt'), false, 'the feature files are gone again');
		assert.deepEqual(await repo.statusLines(), [], 'and the worktree is clean, not "everything deleted"');
	});

	test('undo of a forced move brings the discarded commits back', async () => {
		const { repo, shas } = await linear();
		await repo.checkout('feature', { create: true });
		const f1 = await repo.commit('feature one', { 'f1.txt': '1\n' });
		await repo.checkout('main');
		const mainOnly = await repo.commit('main only', { 'm.txt': 'm\n' });

		await fastForwardBranch(repo.ctx, { target: f1, branch: 'main', force: true });
		assert.equal(await repo.branchSha('main'), f1);

		const journal = await repo.ctx.safety.readJournal();
		await repo.ctx.safety.undo(journal[0]);
		assert.equal(await repo.branchSha('main'), mainOnly);
		assert.equal(await repo.subject('main'), 'main only');
		assert.ok(shas.v04);
	});
});

describe('fastForwardBranch - remote awareness', () => {
	test('needsForcePush is true when the remote main has commits the target lacks', async () => {
		const { repo, f1 } = await withFeatureBranch();
		const remoteDir = await repo.addBareRemote('origin', ['main']);
		await repo.pushFromElsewhere(remoteDir, 'colleague commit');
		await repo.fetch(); // learn about the colleague's commit, like VS Code's auto fetch does

		const result = await fastForwardBranch(repo.ctx, { target: f1, branch: 'main', force: true });
		assert.equal(result.needsForcePush, true);
		assert.equal(result.upstreamRef, 'origin/main');
	});

	test('needsForcePush reflects what the local remote-tracking ref knows', async () => {
		const { repo, f1 } = await withFeatureBranch();
		const remoteDir = await repo.addBareRemote('origin', ['main']);
		await repo.pushFromElsewhere(remoteDir, 'colleague commit');
		// No fetch: origin/main still looks like an ancestor of the target.
		const result = await fastForwardBranch(repo.ctx, { target: f1, branch: 'main', force: true });
		assert.equal(result.needsForcePush, false);
		assert.match(result.notes.join('\n') + result.upstreamRef, /origin\/main/);
	});

	test('needsForcePush is false for a plain fast-forward that includes the remote', async () => {
		const { repo, f2 } = await withFeatureBranch();
		await repo.addBareRemote('origin', ['main']);
		const result = await fastForwardBranch(repo.ctx, { target: f2, branch: 'main' });
		assert.equal(result.needsForcePush, false);
	});
});

describe('fastForwardBranch - detached HEAD', () => {
	test('moving a branch while HEAD is detached at its tip notes it', async () => {
		const { repo, shas, f2 } = await withFeatureBranch();
		await repo.checkout(shas.v04);

		const result = await fastForwardBranch(repo.ctx, { target: f2, branch: 'main' });

		assert.equal(result.checkedOut, false);
		assert.equal(await repo.gitOk(['rev-parse', 'HEAD']), shas.v04, 'HEAD stays where it was');
		assert.match(result.notes.join('\n'), /detached/);
		assert.equal(await repo.branchSha('main'), f2);
	});
});
