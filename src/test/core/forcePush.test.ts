import { test, describe, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { forcePush } from '../../core/forcePush';
import { rewordCommitMessage } from '../../core/reword';
import { fastForwardBranch } from '../../core/fastForward';
import { GecoError } from '../../core/errors';
import { createLinearRepo, createTempRepo, type TempRepo } from '../helpers/tempRepo';

const open: TempRepo[] = [];
let remoteDir: string;

afterEach(() => {
	while (open.length > 0) {
		open.pop()!.cleanup();
	}
	remoteDir = '';
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

/** Linear repo with `origin` (a real bare repository on disk) and main pushed to it. */
async function withRemote(options?: Parameters<typeof createTempRepo>[0]) {
	const { repo, shas } = await createLinearRepo(options);
	open.push(repo);
	remoteDir = await repo.addBareRemote('origin', ['main']);
	return { repo, shas };
}

describe('forcePush - lease mode (the default)', () => {
	test('pushes rewritten history and the remote ends up identical to local', async () => {
		const { repo } = await withRemote();
		await rewordCommitMessage(repo.ctx, { commit: 'HEAD', message: 'v0.4 add new button', createBackup: false });
		const local = await repo.branchSha('main');

		const result = await forcePush(repo.ctx);

		assert.equal(result.mode, 'lease');
		assert.equal(result.pushed, true);
		assert.equal(result.remote, 'origin');
		assert.equal(result.branch, 'main');
		assert.equal(result.remoteBranch, 'main');
		assert.equal(result.refspec, 'main:refs/heads/main');
		assert.equal(result.ahead, 1);
		assert.equal(result.behind, 1);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), local);
		assert.equal(result.remoteShaAfter, local);
	});

	test('refuses to overwrite a colleague who pushed since our last fetch', async () => {
		const { repo } = await withRemote();
		await rewordCommitMessage(repo.ctx, { commit: 'HEAD', message: 'v0.4 rewritten', createBackup: false });
		const colleague = await repo.pushFromElsewhere(remoteDir, 'colleague commit');
		assert.ok(colleague);
		const remoteBefore = await repo.remoteBranchSha(remoteDir, 'main');

		const error = await expectCode(() => forcePush(repo.ctx), 'rejected');

		assert.match(error.userMessage, /refused/i);
		assert.match(error.userMessage, /stale info|--force-with-lease/i);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), remoteBefore, 'the colleague\'s work survived');
	});

	test('after a fetch the lease is up to date and the push succeeds', async () => {
		const { repo } = await withRemote();
		await repo.pushFromElsewhere(remoteDir, 'colleague commit');
		await repo.fetch();
		await repo.commit('our new work', { 'ours.txt': 'o\n' });

		const result = await forcePush(repo.ctx);

		assert.equal(result.pushed, true);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), await repo.branchSha('main'));
	});

	test('an up to date branch pushes cleanly with nothing to overwrite', async () => {
		const { repo } = await withRemote();
		const result = await forcePush(repo.ctx);
		assert.equal(result.ahead, 0);
		assert.equal(result.behind, 0);
		assert.equal(result.pushed, true);
	});

	test('journal records the previous remote sha so undo can restore it', async () => {
		const { repo } = await withRemote();
		const before = await repo.remoteBranchSha(remoteDir, 'main');
		await rewordCommitMessage(repo.ctx, { commit: 'HEAD', message: 'v0.4 rewritten', createBackup: false });
		await forcePush(repo.ctx);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), await repo.branchSha('main'));

		const journal = await repo.ctx.safety.readJournal();
		const push = journal.filter((e) => e.kind === 'forcePush').pop()!;
		assert.match(push.summary, /Force pushed main to origin\/main \(lease\)/);

		const undo = await repo.ctx.safety.undo(push);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), before, 'the remote branch is back where it was');
		assert.equal(undo.restored.length, 1);
	});
});

describe('forcePush - hard force', () => {
	test('--force overwrites the colleague', async () => {
		const { repo } = await withRemote();
		await rewordCommitMessage(repo.ctx, { commit: 'HEAD', message: 'v0.4 rewritten', createBackup: false });
		await repo.pushFromElsewhere(remoteDir, 'colleague commit');

		const result = await forcePush(repo.ctx, { mode: 'force' });

		assert.equal(result.mode, 'force');
		assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), await repo.branchSha('main'));
	});

	test('the configured default mode is used', async () => {
		const { repo } = await withRemote({ settings: { forcePushMode: 'force' } });
		await repo.pushFromElsewhere(remoteDir, 'colleague commit');

		const result = await forcePush(repo.ctx);
		assert.equal(result.mode, 'force');
		assert.equal(result.pushed, true);
	});

	test('an explicit mode overrides the setting', async () => {
		const { repo } = await withRemote({ settings: { forcePushMode: 'force' } });
		await repo.pushFromElsewhere(remoteDir, 'colleague commit');
		await expectCode(() => forcePush(repo.ctx, { mode: 'lease' }), 'rejected');
	});
});

describe('forcePush - targets', () => {
	test('creates a remote branch that does not exist yet', async () => {
		const { repo, shas } = await withRemote();
		await repo.gitOk(['branch', 'feature', shas.v03]);

		const result = await forcePush(repo.ctx, { branch: 'feature' });

		assert.equal(result.createdRemoteBranch, true);
		assert.equal(result.remoteShaBefore, undefined);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'feature'), shas.v03);
		assert.match((await repo.ctx.safety.readJournal()).pop()!.summary, /created the remote branch/);
	});

	test('undo of a created branch explains how to remove it again', async () => {
		const { repo, shas } = await withRemote();
		await repo.gitOk(['branch', 'feature', shas.v03]);
		await forcePush(repo.ctx, { branch: 'feature' });

		const entry = (await repo.ctx.safety.readJournal()).pop()!;
		assert.equal(entry.undo.type, 'none');
		const undo = await repo.ctx.safety.undo(entry);
		assert.match(undo.messages.join('\n'), /git push origin --delete feature/);
	});

	test('a local branch can be pushed to a differently named remote branch', async () => {
		const { repo, shas } = await withRemote();
		await repo.gitOk(['branch', 'release', shas.v02]);

		const result = await forcePush(repo.ctx, { branch: 'release', remoteBranch: 'stable' });

		assert.equal(result.remoteBranch, 'stable');
		assert.equal(result.refspec, 'release:refs/heads/stable');
		assert.equal(await repo.remoteBranchSha(remoteDir, 'stable'), shas.v02);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), shas.v04, 'main is untouched');
	});

	test('an explicit remote is honoured', async () => {
		const { repo, shas } = await withRemote();
		const secondDir = `${repo.root}/second.git`;
		await repo.gitOk(['clone', '--bare', '--quiet', remoteDir, secondDir]);
		await repo.gitOk(['remote', 'add', 'second', secondDir]);

		const result = await forcePush(repo.ctx, { remote: 'second', branch: 'main' });

		assert.equal(result.remote, 'second');
		assert.equal(await repo.remoteBranchSha(secondDir, 'main'), shas.v04);
	});

	test('an unknown remote is reported with the known ones', async () => {
		const { repo } = await withRemote();
		const error = await expectCode(() => forcePush(repo.ctx, { remote: 'nope' }), 'no-remote');
		assert.match(error.userMessage, /Known remotes: origin/);
	});

	test('setUpstream records the tracking configuration', async () => {
		const { repo, shas } = await withRemote();
		await repo.gitOk(['branch', 'feature', shas.v03]);

		await forcePush(repo.ctx, { branch: 'feature', setUpstream: true });

		assert.equal(await repo.gitOk(['config', 'branch.feature.remote']), 'origin');
		assert.equal(await repo.gitOk(['config', 'branch.feature.merge']), 'refs/heads/feature');
	});

	test('follow-tags pushes annotated tags reachable from the branch', async () => {
		const { repo, shas } = await withRemote();
		await repo.gitOk(['tag', '-a', 'v0.3', '-m', 'release v0.3', shas.v03]);

		await forcePush(repo.ctx, { tags: true });

		const tags = await repo.gitOk(['ls-remote', '--tags', 'origin']);
		assert.match(tags, /v0\.3/);
	});
});

describe('forcePush - dry run', () => {
	test('reports what would happen without changing the remote', async () => {
		const { repo } = await withRemote();
		await rewordCommitMessage(repo.ctx, { commit: 'HEAD', message: 'v0.4 rewritten', createBackup: false });
		const remoteBefore = await repo.remoteBranchSha(remoteDir, 'main');

		const result = await forcePush(repo.ctx, { dryRun: true });

		assert.equal(result.dryRun, true);
		assert.equal(result.pushed, false);
		assert.equal(result.ahead, 1);
		assert.equal(result.behind, 1);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), remoteBefore);
		assert.equal((await repo.ctx.safety.readJournal()).filter((e) => e.kind === 'forcePush').length, 0, 'a dry run is not journaled');
	});
});

describe('forcePush - error paths', () => {
	test('no remote at all', async () => {
		const { repo } = await createLinearRepo();
		open.push(repo);
		const error = await expectCode(() => forcePush(repo.ctx), 'no-remote');
		assert.match(error.userMessage, /no remote/i);
	});

	test('detached HEAD without an explicit branch', async () => {
		const { repo, shas } = await withRemote();
		await repo.checkout(shas.v03);
		await expectCode(() => forcePush(repo.ctx), 'detached-head');
	});

	test('a detached HEAD can still push an explicit branch', async () => {
		const { repo, shas } = await withRemote();
		await repo.checkout(shas.v03);
		await rewordCommitMessage(repo.ctx, { commit: shas.v04, message: 'v0.4 rewritten', branch: 'main', createBackup: false });

		const result = await forcePush(repo.ctx, { branch: 'main' });
		assert.equal(result.branch, 'main');
		assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), await repo.branchSha('main'));
	});

	test('an unknown local branch', async () => {
		const { repo } = await withRemote();
		await expectCode(() => forcePush(repo.ctx, { branch: 'nope' }), 'ref-not-found');
	});

	test('a non-repository folder', async () => {
		const os = await import('node:os');
		const fs = await import('node:fs');
		const path = await import('node:path');
		const { createRepoContext } = await import('../../core/context');
		const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'geco-plain-'));
		try {
			await expectCode(() => forcePush(createRepoContext(plain)), 'not-a-repository');
		} finally {
			fs.rmSync(plain, { recursive: true, force: true });
		}
	});
});

describe('forcePush - end to end with the other operations', () => {
	test('reword + force push leaves the remote with the new message', async () => {
		const { repo } = await withRemote();
		await rewordCommitMessage(repo.ctx, { commit: 'HEAD~2', message: 'v0.2 add new button' });
		const result = await rewordCommitMessage(repo.ctx, { commit: 'HEAD', message: 'v0.4 add new button' });
		assert.equal(result.needsForcePush, true);

		const push = await forcePush(repo.ctx);

		assert.equal(push.pushed, true);
		const remoteLog = await repo.gitOk(['log', '--format=%s', '-3'], { cwd: remoteDir });
		assert.deepEqual(remoteLog.split('\n'), ['v0.4 add new button', 'v0.3', 'v0.2 add new button']);
	});

	test('fast-forward main + push, no force needed', async () => {
		const { repo, shas } = await withRemote();
		await repo.checkout('feature', { create: true });
		const f1 = await repo.commit('feature one', { 'f1.txt': '1\n' });
		await repo.checkout('main');

		const ff = await fastForwardBranch(repo.ctx, { target: f1, branch: 'main' });
		assert.equal(ff.needsForcePush, false);

		const push = await forcePush(repo.ctx, { branch: 'main' });
		assert.equal(push.pushed, true);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), f1);
		assert.ok(shas.v04);
	});
});
