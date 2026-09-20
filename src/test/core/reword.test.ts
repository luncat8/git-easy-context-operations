import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { rewordCommitMessage, findRewriteBranch } from '../../core/reword';
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

describe('rewordCommitMessage - the tip commit', () => {
	test('v0.4 -> "v0.4 add new button" (README example, on HEAD)', async () => {
		const result = await rewordCommitMessage(repo.ctx, { commit: 'HEAD', message: 'v0.4 add new button' });

		assert.equal(result.noChange, false);
		assert.equal(result.branch, 'main');
		assert.equal(await repo.subject('main'), 'v0.4 add new button');
		assert.equal(await repo.branchSha('main'), result.newTip);
		assert.equal(result.rewritten.length, 1);
		assert.notEqual(result.newTargetSha, shas.v04);
	});

	test('tree, parents, author and dates are preserved - only the message changes', async () => {
		const before = (await repo.log('main', 1))[0];
		const result = await rewordCommitMessage(repo.ctx, { commit: shas.v04, message: 'brand new message' });

		const after = (await repo.log('main', 1))[0];
		assert.equal(after.tree, before.tree);
		assert.deepEqual(after.parents, before.parents);
		assert.equal(after.authorDate, before.authorDate);
		assert.equal(after.committerDate, before.committerDate, 'committer date is preserved by default');
		assert.equal(after.authorName, before.authorName);
		assert.notEqual(after.sha, before.sha);
		assert.equal(after.subject, 'brand new message');
		assert.equal(result.newTip, after.sha);
	});

	test('append mode turns "v0.4" into "v0.4 add new button"', async () => {
		await rewordCommitMessage(repo.ctx, { commit: shas.v04, edit: { mode: 'append', text: 'add new button' } });
		assert.equal(await repo.subject('main'), 'v0.4 add new button');
	});

	test('find/replace mode renames a version tag inside the subject', async () => {
		await rewordCommitMessage(repo.ctx, {
			commit: shas.v04,
			edit: { mode: 'findReplace', find: 'v0.4', text: 'v0.4 add new button' },
		});
		assert.equal(await repo.subject('main'), 'v0.4 add new button');
	});

	test('an identical message is a no-op and does not move the branch', async () => {
		const before = await repo.branchSha('main');
		const result = await rewordCommitMessage(repo.ctx, { commit: shas.v04, message: 'v0.4\n' });
		assert.equal(result.noChange, true);
		assert.equal(await repo.branchSha('main'), before);
		assert.equal(result.rewritten.length, 0);
		assert.equal((await repo.ctx.safety.readJournal()).length, 0, 'a no-op is not journaled');
	});
});

describe('rewordCommitMessage - mid history', () => {
	test('rewording v0.2 replays v0.3 and v0.4 with identical trees and messages', async () => {
		const before = await repo.log('main');
		const result = await rewordCommitMessage(repo.ctx, { commit: shas.v02, message: 'v0.2 add new button' });

		const after = await repo.log('main');
		assert.equal(result.rewritten.length, 3, 'target + two descendants');
		assert.equal(after.length, before.length);
		assert.deepEqual(after.map((c) => c.subject), ['v0.4', 'v0.3', 'v0.2 add new button', 'v0.1']);
		assert.deepEqual(after.map((c) => c.tree), before.map((c) => c.tree), 'every tree is byte-identical');
		assert.deepEqual(after.map((c) => c.authorDate), before.map((c) => c.authorDate));
		assert.deepEqual(after.map((c) => c.committerDate), before.map((c) => c.committerDate));

		// The new chain is parented correctly.
		assert.equal(after[0].parents[0], after[1].sha);
		assert.equal(after[1].parents[0], after[2].sha);
		assert.equal(after[2].parents[0], before[3].sha, 'v0.1 is untouched');
		assert.equal(after[3].sha, shas.v01);
	});

	test('the working tree and index are not touched, even with uncommitted changes', async () => {
		repo.write('uncommitted.txt', 'local work in progress\n');
		repo.write('a.txt', 'modified but not staged\n');

		await rewordCommitMessage(repo.ctx, { commit: shas.v02, message: 'v0.2 add new button' });

		const status = await repo.statusLines();
		assert.deepEqual(status.sort(), [' M a.txt', '?? uncommitted.txt']);
		assert.equal(repo.read('a.txt'), 'modified but not staged\n');
		assert.equal(await repo.subject('main~2'), 'v0.2 add new button');
		assert.deepEqual((await repo.log('main')).map((c) => c.subject), ['v0.4', 'v0.3', 'v0.2 add new button', 'v0.1']);
	});

	test('a commit message with a body keeps the body of every replayed commit', async () => {
		const withBody = await repo.commit('release notes\n\n- first point\n- second point\n', { 'e.txt': 'e\n' });
		await rewordCommitMessage(repo.ctx, { commit: shas.v02, message: 'v0.2 add new button' });

		const replayed = (await repo.log('main')).find((c) => c.subject === 'release notes');
		assert.ok(replayed, 'the commit is still in history');
		assert.equal(replayed.body.trim(), '- first point\n- second point');
		assert.notEqual(replayed.sha, withBody);
	});

	test('the root commit can be reworded', async () => {
		await rewordCommitMessage(repo.ctx, { commit: shas.v01, message: 'v0.1 initial import' });
		const history = await repo.log('main');
		assert.equal(history[history.length - 1].subject, 'v0.1 initial import');
		assert.deepEqual(history[history.length - 1].parents, [], 'still a root commit');
		assert.equal(history.length, 4);
	});
});

describe('rewordCommitMessage - topology', () => {
	test('a merge commit can be reworded and keeps both parents', async () => {
		await repo.checkout('feature', { create: true });
		const featureCommit = await repo.commit('feature work', { 'feature.txt': 'f\n' });
		await repo.checkout('main');
		const merge = await repo.mergeNoFastForward('feature', 'Merge feature into main');

		const result = await rewordCommitMessage(repo.ctx, { commit: merge, message: 'Merge feature into main (reviewed)' });
		const top = (await repo.log('main', 1))[0];

		assert.equal(top.subject, 'Merge feature into main (reviewed)');
		assert.equal(top.parents.length, 2);
		assert.ok(top.parents.includes(featureCommit));
		assert.equal(result.rewritten.length, 1);
	});

	test('rewording a commit on a merged side branch rewrites the merge too', async () => {
		await repo.checkout('feature', { create: true });
		const featureCommit = await repo.commit('feature work', { 'feature.txt': 'f\n' });
		await repo.checkout('main');
		const merge = await repo.mergeNoFastForward('feature');
		const mainBefore = merge;

		const result = await rewordCommitMessage(repo.ctx, { commit: featureCommit, message: 'feature work (fixed typo)' });

		const top = (await repo.log('main', 1))[0];
		assert.equal(top.sha, result.newTip);
		assert.notEqual(top.sha, mainBefore);
		assert.equal(top.parents.length, 2, 'still a merge');
		assert.equal(await repo.subject(top.parents[1]), 'feature work (fixed typo)');
		assert.ok(result.otherRefsOnOldHistory.some((ref) => ref === 'feature'), 'the feature branch still points at the old chain');
	});

	test('a commit that is not on the branch is rejected with the containing branches listed', async () => {
		await repo.checkout('side', { create: true });
		const sideCommit = await repo.commit('side work', { 'side.txt': 's\n' });
		await repo.checkout('main');

		const error = await expectCode(
			() => rewordCommitMessage(repo.ctx, { commit: sideCommit, message: 'nope' }),
			'commit-not-on-branch',
		);
		assert.match(error.userMessage, /side/);
		assert.equal(await repo.branchSha('main'), shas.v04, 'main was not touched');
	});

	test('an explicit branch can be reworded while another branch is checked out', async () => {
		await repo.checkout('feature', { create: true });
		await repo.commit('feature work', { 'feature.txt': 'f\n' });
		const featureTip = await repo.branchSha('feature');

		// HEAD is on feature, but we ask to rewrite main.
		await rewordCommitMessage(repo.ctx, { commit: shas.v02, message: 'v0.2 add new button', branch: 'main' });

		assert.equal(await repo.subject('main~2'), 'v0.2 add new button');
		assert.equal(await repo.subject('main'), 'v0.4', 'the tip keeps its own message');
		assert.equal(await repo.branchSha('feature'), featureTip, 'the checked out branch is untouched');
		assert.equal(await repo.gitOk(['rev-parse', '--abbrev-ref', 'HEAD']), 'feature');
	});

	test('findRewriteBranch reports the candidates', async () => {
		await repo.checkout('side', { create: true });
		const sideCommit = await repo.commit('side work', { 'side.txt': 's\n' });
		await repo.checkout('main');

		const info = await findRewriteBranch(repo.ctx, sideCommit);
		assert.equal(info.currentBranch, 'main');
		assert.deepEqual(info.candidates, ['side']);
		assert.equal(info.branch, 'side', 'a single containing branch is an obvious choice');
	});
});

describe('rewordCommitMessage - detached HEAD', () => {
	test('the checked out commit can be reworded while detached', async () => {
		await repo.checkout(shas.v03);
		const result = await rewordCommitMessage(repo.ctx, { commit: shas.v03, message: 'v0.3 detached edit' });
		assert.equal(result.detachedHead, true);
		assert.equal(result.branch, undefined);
		assert.equal(await repo.gitOk(['rev-parse', 'HEAD']), result.newTargetSha);
		assert.equal(await repo.subject('HEAD'), 'v0.3 detached edit');
		assert.equal(await repo.branchSha('main'), shas.v04, 'main is untouched');
	});

	test('a different commit cannot be reworded while detached', async () => {
		await repo.checkout(shas.v03);
		const error = await expectCode(
			() => rewordCommitMessage(repo.ctx, { commit: shas.v02, message: 'nope' }),
			'detached-head',
		);
		assert.match(error.userMessage, /main/);
	});
});

describe('rewordCommitMessage - safety', () => {
	test('a hidden recovery ref is created and undo puts everything back', async () => {
		const oldTip = await repo.branchSha('main');
		const result = await rewordCommitMessage(repo.ctx, { commit: shas.v02, message: 'v0.2 add new button' });

		assert.ok(result.backupRef);
		assert.ok(result.backupRef!.startsWith('refs/geco/reword/main/'));
		assert.equal(await repo.gitOk(['rev-parse', result.backupRef!]), oldTip);

		const journal = await repo.ctx.safety.readJournal();
		assert.equal(journal.length, 1);
		assert.equal(journal[0].kind, 'reword');
		assert.match(journal[0].summary, /"v0\.2" -> "v0\.2 add new button"/);
		assert.match(journal[0].summary, /3 commits rewritten/);

		const undo = await repo.ctx.safety.undo(journal[0]);
		assert.equal(await repo.branchSha('main'), oldTip);
		assert.equal(await repo.subject('main'), 'v0.4');
		assert.equal(await repo.hasRef(result.backupRef!), false, 'the recovery ref is cleaned up by undo');
		assert.deepEqual(undo.restored.length, 1);
	});

	test('createBackup=false skips the recovery ref', async () => {
		const result = await rewordCommitMessage(repo.ctx, { commit: shas.v02, message: 'x', createBackup: false });
		assert.equal(result.backupRef, undefined);
		const refs = await repo.gitOk(['for-each-ref', '--format=%(refname)', 'refs/geco']);
		assert.equal(refs, '');
	});

	test('nothing is left behind when the branch moves under us (atomic update-ref)', async () => {
		const race = await createTempRepo();
		try {
			const a = await race.commit('one', { 'a.txt': '1\n' });
			await race.commit('two', { 'b.txt': '2\n' });

			// Move the branch after we computed the plan but before update-ref runs.
			const originalUpdateRef = race.ctx.git.updateRef.bind(race.ctx.git);
			let sabotaged = false;
			race.ctx.git.updateRef = async (ref, value, options) => {
				if (!sabotaged && ref === 'refs/heads/main') {
					sabotaged = true;
					await race.gitOk(['update-ref', 'refs/heads/main', a]);
				}
				return originalUpdateRef(ref, value, options);
			};

			await expectCode(() => rewordCommitMessage(race.ctx, { commit: a, message: 'one rewritten' }), 'git-failed');
			assert.equal(await race.branchSha('main'), a, 'the branch was not clobbered');
			const leftovers = await race.gitOk(['for-each-ref', '--format=%(refname)', 'refs/geco']);
			assert.equal(leftovers, '', 'the recovery ref was cleaned up after the failure');
		} finally {
			race.cleanup();
		}
	});

	test('needsForcePush is true once the rewritten commit is on the remote', async () => {
		const remoteDir = await repo.addBareRemote('origin', ['main']);
		assert.ok(remoteDir);

		const notYet = await rewordCommitMessage(repo.ctx, { commit: shas.v04, message: 'v0.4 fresh', createBackup: false });
		// v0.4 was pushed, so rewriting it requires a force push.
		assert.equal(notYet.needsForcePush, true);
		assert.equal(notYet.upstreamRef, 'origin/main');
	});

	test('needsForcePush is false for a purely local commit', async () => {
		const remoteDir = await repo.addBareRemote('origin', ['main']);
		assert.ok(remoteDir);
		const localOnly = await repo.commit('local only', { 'local.txt': 'l\n' });

		const result = await rewordCommitMessage(repo.ctx, { commit: localOnly, message: 'local only (fixed)', createBackup: false });
		assert.equal(result.needsForcePush, false);
	});
});

describe('rewordCommitMessage - committer date policy', () => {
	test('preserveCommitterDate=false refreshes the committer date but keeps the author date', async () => {
		const old = await createTempRepo();
		try {
			const first = await old.commitAt('one', { 'a.txt': '1\n' }, '2020-01-01T00:00:00+00:00');
			await old.commitAt('two', { 'b.txt': '2\n' }, '2020-01-02T00:00:00+00:00');
			const before = (await old.log('main'))[0];

			await rewordCommitMessage(old.ctx, { commit: first, message: 'one edited', preserveCommitterDate: false });

			const after = (await old.log('main'))[0];
			assert.equal(after.subject, 'two');
			assert.notEqual(after.committerDate, before.committerDate, 'the replayed commit gets a fresh committer date');
			assert.equal(after.authorDate, before.authorDate, 'the author date never changes');
		} finally {
			old.cleanup();
		}
	});

	test('the setting is honoured when the option is omitted', async () => {
		const custom = await createTempRepo({ settings: { preserveCommitterDateOnReword: false } });
		try {
			const first = await custom.commitAt('one', { 'a.txt': '1\n' }, '2020-01-01T00:00:00+00:00');
			const before = (await custom.log('main'))[0];
			await rewordCommitMessage(custom.ctx, { commit: first, message: 'one edited' });
			const after = (await custom.log('main'))[0];
			assert.notEqual(after.committerDate, before.committerDate);
			// `%aI` spells UTC as "+00:00" on older git and "Z" on newer git,
			// so compare against the original commit instead of a hard-coded
			// rendering - the instant is what must survive, not the spelling.
			assert.equal(after.authorDate, before.authorDate, 'the author date never changes');
		} finally {
			custom.cleanup();
		}
	});

	test('by default the whole chain keeps its original committer dates', async () => {
		const old = await createTempRepo();
		try {
			const first = await old.commitAt('one', { 'a.txt': '1\n' }, '2020-01-01T00:00:00+00:00');
			await old.commitAt('two', { 'b.txt': '2\n' }, '2020-01-02T00:00:00+00:00');
			const before = (await old.log('main')).map((c) => c.committerDate);
			await rewordCommitMessage(old.ctx, { commit: first, message: 'one edited' });
			const after = (await old.log('main')).map((c) => c.committerDate);
			assert.deepEqual(after, before);
		} finally {
			old.cleanup();
		}
	});
});

describe('rewordCommitMessage - awkward input', () => {
	test('messages with quotes, newlines and shell metacharacters are stored verbatim', async () => {
		const nasty = 'v0.4 add `button` "$(whoami)" ; rm -rf / && echo pwned\n\nbody with "quotes" and \ttabs';
		await rewordCommitMessage(repo.ctx, { commit: shas.v04, message: nasty });
		// git strips the trailing newline; everything else is byte-identical
		assert.equal(await repo.message('main'), nasty);
	});

	test('unicode messages survive the round trip', async () => {
		await rewordCommitMessage(repo.ctx, { commit: shas.v04, message: 'v0.4 添加新按钮 🚀' });
		assert.equal(await repo.subject('main'), 'v0.4 添加新按钮 🚀');
	});

	test('a message that starts with a space keeps it', async () => {
		await rewordCommitMessage(repo.ctx, { commit: shas.v04, message: '  indented subject' });
		assert.equal(await repo.message('main'), '  indented subject');
	});

	test('an unknown revision is reported clearly', async () => {
		const error = await expectCode(() => rewordCommitMessage(repo.ctx, { commit: 'deadbeefdeadbeef', message: 'x' }), 'commit-not-found');
		assert.match(error.message, /deadbeef/);
	});

	test('a missing branch option is reported clearly', async () => {
		await expectCode(() => rewordCommitMessage(repo.ctx, { commit: shas.v02, message: 'x', branch: 'nope' }), 'ref-not-found');
	});

	test('neither message nor edit is rejected', async () => {
		await expectCode(() => rewordCommitMessage(repo.ctx, { commit: shas.v02 }), 'unsupported');
	});

	test('a folder that is not a repository is rejected', async () => {
		const os = await import('node:os');
		const fs = await import('node:fs');
		const path = await import('node:path');
		const { createRepoContext } = await import('../../core/context');
		const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'geco-plain-'));
		try {
			await expectCode(() => rewordCommitMessage(createRepoContext(plain), { commit: 'HEAD', message: 'x' }), 'not-a-repository');
		} finally {
			fs.rmSync(plain, { recursive: true, force: true });
		}
	});

	test('a folder that no longer exists is reported as such, not as "git not found"', async () => {
		const { createRepoContext } = await import('../../core/context');
		const error = await expectCode(() => rewordCommitMessage(createRepoContext('/tmp/geco-does-not-exist-at-all'), { commit: 'HEAD', message: 'x' }), 'not-a-repository');
		assert.match(error.message, /does not exist/);
	});
});

describe('rewordCommitMessage - repeated operations', () => {
	test('rewording twice in a row keeps the history consistent', async () => {
		await rewordCommitMessage(repo.ctx, { commit: shas.v02, message: 'v0.2 first edit' });
		const second = (await repo.log('main')).find((c) => c.subject === 'v0.2 first edit')!;
		await rewordCommitMessage(repo.ctx, { commit: second.sha, message: 'v0.2 second edit' });

		assert.deepEqual((await repo.log('main')).map((c) => c.subject), ['v0.4', 'v0.3', 'v0.2 second edit', 'v0.1']);
		const journal = await repo.ctx.safety.readJournal();
		assert.equal(journal.length, 2);

		// Undoing twice walks back to the original history.
		await repo.ctx.safety.undo(journal[1]);
		assert.equal(await repo.subject('main~2'), 'v0.2 first edit');
		await repo.ctx.safety.undo(journal[0]);
		assert.equal(await repo.subject('main~2'), 'v0.2');
		assert.equal(await repo.branchSha('main'), shas.v04);
	});
});
