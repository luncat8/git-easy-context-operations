/**
 * The four states that make "push" and "Sync" stop working - and the repairs.
 *
 * The centrepiece is the state the issue reported: *the same work committed
 * twice*. A commit is made locally, the same change arrives on the remote from
 * another clone (or a web edit), the trees are byte-identical, the hashes are
 * not, and `git push` rejects it as non-fast-forward. Pressing *Sync* then runs
 * `git pull` first, which merges the remote copy back in - and when the file
 * was also edited on the other side, the merge stops on a conflict and the
 * repository is left unfinished: from then on **both** buttons fail
 * ("You have not concluded your merge (MERGE_HEAD exists)").
 *
 * Everything here is asserted against real repositories; the controller flow is
 * driven through the same fake UI the other flows use.
 */
import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_SETTINGS } from '../../core/config';
import { Controller } from '../../core/controller';
import { GecoError } from '../../core/errors';
import {
	abortUnfinished,
	assertStartable,
	fetchRemote,
	formatPushSyncReport,
	inspectPushSync,
	moveBranchOntoUpstream,
	publishBranch,
	rebaseOntoUpstream,
	removeLockFiles,
} from '../../core/pushSync';
import { createTempRepo, type TempRepo } from '../helpers/tempRepo';
import { FakeUI } from '../helpers/fakeUi';

const open: TempRepo[] = [];

afterEach(() => {
	while (open.length > 0) {
		open.pop()!.cleanup();
	}
});

async function temp(): Promise<TempRepo> {
	const repo = await createTempRepo();
	open.push(repo);
	return repo;
}

function controllerFor(ui: FakeUI, repo: TempRepo): Controller {
	return new Controller({ ui, settings: DEFAULT_SETTINGS, exec: repo.exec });
}

/** A repository with `origin` and one pushed commit. */
async function withRemote(): Promise<{ repo: TempRepo; remoteDir: string }> {
	const repo = await temp();
	await repo.commit('base', { 'plan.md': 'base\n' });
	const remoteDir = await repo.addBareRemote();
	return { repo, remoteDir };
}

/** A second clone of the same remote - "another session / another machine". */
async function cloneElsewhere(repo: TempRepo, remoteDir: string): Promise<string> {
	const dir = path.join(repo.root, `clone-${Math.random().toString(36).slice(2, 8)}`);
	await repo.gitOk(['clone', '--quiet', remoteDir, dir]);
	await repo.gitOk(['config', 'user.name', 'Other Person'], { cwd: dir });
	await repo.gitOk(['config', 'user.email', 'other@example.com'], { cwd: dir });
	return dir;
}

/**
 * The reported accident, exactly: both sides commit the same file content, the
 * clone pushes first, and a follow-up edit lands on top - on GitHub, through
 * the web UI, from a third place. The local commit then has the identical tree
 * under a different hash, and the remote has a commit the local side lacks.
 */
async function duplicateCommitAccident(repo: TempRepo, remoteDir: string) {
	const clone = await cloneElsewhere(repo, remoteDir);
	// Locally: the plan file.
	const local = await repo.commit('Add 0.8.x draft slice integration plan', { '0.8.x-draft.md': 'draft v1\n' });
	// In the other clone: byte-identical content, a different commit hash
	// (different author/committer date on purpose - otherwise git could produce
	// the very same hash and the test would reproduce nothing).
	fs.writeFileSync(path.join(clone, '0.8.x-draft.md'), 'draft v1\n', 'utf8');
	await repo.gitOk(['add', '-A'], { cwd: clone });
	await repo.gitOk(['commit', '--quiet', '-m', 'Add 0.8.x draft slice integration plan'], {
		cwd: clone,
		env: { GIT_AUTHOR_DATE: '2026-10-13T19:19:00+02:00', GIT_COMMITTER_DATE: '2026-10-13T19:19:00+02:00' },
	});
	await repo.gitOk(['push', '--quiet', 'origin', 'main'], { cwd: clone });
	const remote = await repo.gitOk(['rev-parse', 'HEAD'], { cwd: clone });
	// The web edit on top of it.
	fs.writeFileSync(path.join(clone, '0.8.x-draft.md'), 'draft v1\nweb edit\n', 'utf8');
	await repo.gitOk(['add', '-A'], { cwd: clone });
	await repo.gitOk(['commit', '--quiet', '-m', 'Edit plan from the web UI'], {
		cwd: clone,
		env: { GIT_AUTHOR_DATE: '2026-10-13T19:40:00+02:00', GIT_COMMITTER_DATE: '2026-10-13T19:40:00+02:00' },
	});
	await repo.gitOk(['push', '--quiet', 'origin', 'main'], { cwd: clone });
	const webEdit = await repo.gitOk(['rev-parse', 'HEAD'], { cwd: clone });
	await repo.fetch();
	return { local, remote, webEdit, clone };
}

/** Leave the repository in the state a conflicted `git pull` produces. */
async function leaveHalfFinishedMerge(repo: TempRepo): Promise<void> {
	const pull = await repo.gitQuiet(['pull', '--no-rebase', 'origin', 'main']);
	assert.notEqual(pull.exitCode, 0, 'the pull is expected to stop on the conflict');
	assert.equal(await repo.sha('HEAD'), await repo.sha('main'));
	assert.ok(fs.existsSync(path.join(repo.dir, '.git', 'MERGE_HEAD')), 'MERGE_HEAD exists');
}

describe('inspectPushSync - what would push / sync do', () => {
	it('is clean when the branch is in step with its remote', async () => {
		const { repo } = await withRemote();

		const report = await inspectPushSync(repo.ctx);

		assert.equal(report.clean, true);
		assert.equal(report.branch, 'main');
		assert.equal(report.sync?.ahead, 0);
		assert.equal(report.sync?.behind, 0);
		assert.ok(report.findings.some((finding) => finding.id === 'in-sync'));
		assert.match(report.verdict, /No push\/sync blockers found/);
		assert.deepEqual(report.repairs, [], 'a repository in step with its remote needs no repair');
	});

	it('recognizes the same work committed twice, byte-identical trees and all', async () => {
		const { repo, remoteDir } = await withRemote();
		const { local, remote } = await duplicateCommitAccident(repo, remoteDir);

		const report = await inspectPushSync(repo.ctx);

		assert.equal(report.clean, false);
		assert.equal(report.sync?.ahead, 1);
		assert.equal(report.sync?.behind, 2);
		const [duplicate] = report.sync!.duplicates;
		assert.equal(duplicate!.sha, local);
		assert.equal(duplicate!.alreadyThere, true);
		assert.equal(duplicate!.equivalentTo, remote, 'the counterpart on the remote is named');
		assert.equal(duplicate!.identicalContent, true, 'the trees are byte-identical');
		assert.equal(report.sync!.unique.length, 0, 'nothing local is unique');

		const finding = report.findings.find((entry) => entry.id === 'diverged-duplicates');
		assert.ok(finding, `expected the duplicate finding: ${report.findings.map((f) => f.id).join(', ')}`);
		assert.match(finding!.headline, /duplicate commits/);
		assert.match(finding!.lines.join('\n'), /already applied|merges? .*back in/, 'explains why Sync makes it worse');
		assert.match(report.verdict, /non-fast-forward/);

		// The safe repairs, and only those: force push would drop the web edit.
		assert.ok(report.repairs.includes('rebase-onto-upstream'));
		assert.ok(report.repairs.includes('move-onto-upstream'));
		assert.ok(!report.repairs.includes('force-push'), 'nothing unique, so a force push is not offered');
	});

	it('sees a rewritten branch as diverged work when commits are unique', async () => {
		const { repo, remoteDir } = await withRemote();
		const clone = await cloneElsewhere(repo, remoteDir);
		// The local side rewrites its tip (reword/squash/forced move) while the
		// remote keeps the old commit - and the other clone adds one of its own.
		await repo.commit('mine', { 'mine.txt': 'mine\n' });
		await repo.gitOk(['commit', '--amend', '-q', '-m', 'mine (rewritten)']);
		fs.writeFileSync(path.join(clone, 'theirs.txt'), 'theirs\n', 'utf8');
		await repo.gitOk(['add', '-A'], { cwd: clone });
		await repo.gitOk(['commit', '--quiet', '-m', 'their work'], { cwd: clone });
		await repo.gitOk(['push', '--quiet', 'origin', 'main'], { cwd: clone });
		await repo.fetch();

		const report = await inspectPushSync(repo.ctx);

		const finding = report.findings.find((entry) => entry.id === 'diverged-unique');
		assert.ok(finding, `expected diverged-unique: ${report.findings.map((f) => f.id).join(', ')}`);
		assert.equal(finding!.severity, 'blocker');
		assert.equal(report.sync!.unique.length, 1, 'the rewritten commit is local-only work');
		assert.equal(report.sync!.duplicates.length, 0);
		assert.ok(report.repairs.includes('force-push'), 'publishing a rewrite needs a force push');
		assert.ok(!report.repairs.includes('move-onto-upstream'), 'a unique commit must not be thrown away');
	});

	it('calls being behind what it is: the case Sync handles well', async () => {
		const { repo, remoteDir } = await withRemote();
		const clone = await cloneElsewhere(repo, remoteDir);
		fs.writeFileSync(path.join(clone, 'from-elsewhere.txt'), 'x\n', 'utf8');
		await repo.gitOk(['add', '-A'], { cwd: clone });
		await repo.gitOk(['commit', '--quiet', '-m', 'colleague work'], { cwd: clone });
		await repo.gitOk(['push', '--quiet', 'origin', 'main'], { cwd: clone });
		await repo.fetch();

		const report = await inspectPushSync(repo.ctx);

		assert.equal(report.clean, true);
		assert.ok(report.findings.some((finding) => finding.id === 'behind'));
		assert.match(report.verdict, /behind/);
	});

	it('sees a branch that was never published', async () => {
		const { repo } = await withRemote();
		await repo.gitOk(['checkout', '-q', '-b', 'feature']);
		await repo.commit('feature work', { 'f.txt': 'f\n' });

		const report = await inspectPushSync(repo.ctx);

		assert.ok(report.findings.some((finding) => finding.id === 'no-upstream'));
		assert.ok(report.repairs.includes('publish'));
		assert.equal(report.clean, false);
	});

	it('sees a tracking branch that is gone from the server', async () => {
		const { repo, remoteDir } = await withRemote();
		await repo.gitOk(['checkout', '-q', '-b', 'feature']);
		await repo.commit('feature work', { 'f.txt': 'f\n' });
		await repo.gitOk(['push', '--quiet', '-u', 'origin', 'feature']);
		await repo.gitOk(['push', '--quiet', 'origin', '--delete', 'feature']);
		assert.equal(await repo.remoteBranchSha(remoteDir, 'feature'), undefined);
		// `--prune` is what makes the deleted branch disappear from tracking refs.
		await repo.gitOk(['fetch', '--quiet', '--prune', 'origin']);

		const report = await inspectPushSync(repo.ctx);

		assert.ok(report.findings.some((finding) => finding.id === 'upstream-missing'), `findings: ${report.findings.map((f) => f.id).join(', ')}`);
		assert.ok(report.repairs.includes('publish'));
		assert.equal(report.clean, false);
	});

	it('names the unfinished merge and the conflict markers', async () => {
		const { repo, remoteDir } = await withRemote();
		await duplicateCommitAccident(repo, remoteDir);
		await leaveHalfFinishedMerge(repo);

		const report = await inspectPushSync(repo.ctx);

		assert.equal(report.clean, false);
		assert.equal(report.unfinished.length, 1);
		assert.equal(report.unfinished[0]!.kind, 'merge');
		assert.deepEqual(report.conflicts, ['0.8.x-draft.md']);
		assert.ok(report.repairs.includes('abort-operation'));
		assert.match(report.verdict, /blocked/);
		assert.match(report.verdict, /unfinished merge/);
	});

	it('names a lock file left behind by a killed git process', async () => {
		const { repo } = await withRemote();
		fs.writeFileSync(path.join(repo.dir, '.git', 'index.lock'), '', 'utf8');

		const report = await inspectPushSync(repo.ctx);

		assert.equal(report.clean, false);
		assert.deepEqual(report.locks.map((lock) => lock.name), ['index.lock']);
		assert.ok(report.repairs.includes('remove-lock'));
		assert.match(report.verdict, /blocked/);
	});

	it('says so when there is no remote at all', async () => {
		const repo = await temp();
		await repo.commit('only local', { 'a.txt': 'a\n' });

		const report = await inspectPushSync(repo.ctx);

		assert.equal(report.clean, true);
		assert.ok(report.findings.some((finding) => finding.id === 'no-remote'));
	});

	it('reports a detached HEAD instead of inventing a branch', async () => {
		const { repo } = await withRemote();
		const sha = await repo.sha('HEAD');
		await repo.gitOk(['checkout', '-q', '--detach', sha]);

		const report = await inspectPushSync(repo.ctx);

		assert.equal(report.detached, true);
		assert.equal(report.branch, undefined);
		assert.ok(report.findings.some((finding) => finding.id === 'detached-head'));
	});

	it('prints a readable report', async () => {
		const { repo, remoteDir } = await withRemote();
		await duplicateCommitAccident(repo, remoteDir);

		const text = formatPushSyncReport(await inspectPushSync(repo.ctx));

		assert.match(text, /Push \/ sync diagnosis for /);
		assert.match(text, /upstream: origin\/main/);
		assert.match(text, /\[PROBLEM\]/);
		assert.match(text, /Verdict: /);
	});
});

describe('pushSync - repairs', () => {
	it('aborts the half-finished merge the Sync button left behind', async () => {
		const { repo, remoteDir } = await withRemote();
		await duplicateCommitAccident(repo, remoteDir);
		await leaveHalfFinishedMerge(repo);
		const headBefore = await repo.sha('HEAD');
		const branchBefore = await repo.branchSha('main');

		const result = await abortUnfinished(repo.ctx, (await inspectPushSync(repo.ctx)).unfinished[0]!);

		assert.match(result.message, /Aborted the unfinished merge/);
		assert.equal(await repo.branchSha('main'), branchBefore, 'the commits that were made stay');
		assert.equal(await repo.sha('HEAD'), headBefore);
		assert.ok(!fs.existsSync(path.join(repo.dir, '.git', 'MERGE_HEAD')), 'the marker is gone');
		assert.deepEqual(await repo.statusLines(), [], 'the conflict markers are gone from the worktree');
		assert.equal((await inspectPushSync(repo.ctx)).unfinished.length, 0);
		const journal = await repo.ctx.safety.readJournal();
		assert.equal(journal.at(-1)!.summary.startsWith('Aborted the unfinished merge'), true);
	});

	it('rebase drops the duplicate and keeps the branch undoable', async () => {
		const { repo, remoteDir } = await withRemote();
		const { local } = await duplicateCommitAccident(repo, remoteDir);
		const headBefore = await repo.sha('HEAD');

		const result = await rebaseOntoUpstream(repo.ctx, {
			branch: 'main',
			upstreamSha: await repo.sha('origin/main'),
			upstreamRef: 'origin/main',
			duplicates: 1,
		});

		assert.equal(result.from, headBefore);
		assert.equal(result.to, await repo.sha('origin/main'));
		assert.equal(result.dropped, 1);
		assert.ok(result.recoveryRef?.startsWith('refs/geco/'), `recovery point: ${result.recoveryRef}`);
		assert.ok(await repo.hasRef(result.recoveryRef!));
		const report = await inspectPushSync(repo.ctx);
		assert.equal(report.clean, true);
		assert.equal(report.sync?.ahead, 0);
		assert.equal(report.sync?.behind, 0);
		assert.equal(report.sync?.localOnly.length, 0, `the duplicate is gone: ${local}`);
	});

	it('aborts a rebase that would stop on a conflict, so nothing is left behind', async () => {
		const { repo, remoteDir } = await withRemote();
		const clone = await cloneElsewhere(repo, remoteDir);
		// Both sides change the same line differently.
		await repo.commit('mine', { 'plan.md': 'mine\n' });
		fs.writeFileSync(path.join(clone, 'plan.md'), 'theirs\n', 'utf8');
		await repo.gitOk(['add', '-A'], { cwd: clone });
		await repo.gitOk(['commit', '--quiet', '-m', 'theirs'], { cwd: clone });
		await repo.gitOk(['push', '--quiet', 'origin', 'main'], { cwd: clone });
		await repo.fetch();
		const before = await repo.sha('HEAD');
		const upstreamSha = await repo.sha('origin/main');

		await assert.rejects(
			() => rebaseOntoUpstream(repo.ctx, { branch: 'main', upstreamSha, upstreamRef: 'origin/main' }),
			(error: unknown) => {
				assert.ok(error instanceof GecoError);
				assert.equal(error.code, 'git-failed');
				assert.match(error.userMessage, /aborted again, so the repository is exactly as it was/);
				return true;
			},
		);

		assert.equal(await repo.sha('HEAD'), before, 'the branch is back where it was');
		assert.equal((await inspectPushSync(repo.ctx)).unfinished.length, 0, 'no rebase left in progress');
		assert.deepEqual(await repo.statusLines(), [], 'no stray recovery point either');
	});

	it('refuses to rebase a branch that is not checked out', async () => {
		const { repo } = await withRemote();
		await repo.gitOk(['checkout', '-q', '-b', 'feature']);
		const otherSha = await repo.sha('HEAD');

		await assert.rejects(
			() => rebaseOntoUpstream(repo.ctx, { branch: 'main', upstreamSha: otherSha, upstreamRef: 'origin/main' }),
			(error: unknown) => {
				assert.ok(error instanceof GecoError);
				assert.equal(error.code, 'rejected');
				return true;
			},
		);
	});

	it('moves the branch onto the remote copy with a backup branch and a way back', async () => {
		const { repo, remoteDir } = await withRemote();
		const { local } = await duplicateCommitAccident(repo, remoteDir);
		const remoteSha = await repo.sha('origin/main');

		const result = await moveBranchOntoUpstream(repo.ctx, { branch: 'main', upstreamSha: remoteSha, upstreamRef: 'origin/main' });

		assert.equal(await repo.branchSha('main'), remoteSha);
		assert.equal(result.backup, 'old');
		assert.equal(await repo.branchSha('old'), local, 'the old tip is parked on the backup branch');
		assert.equal(result.fastForward.wasFastForward, false);
		assert.equal(result.fastForward.needsForcePush, false, 'the branch now matches the remote');

		// Undo brings the local commit back.
		const journal = await repo.ctx.safety.readJournal();
		await repo.ctx.safety.undo(journal.at(-1)!);
		assert.equal(await repo.branchSha('main'), local, 'undo restored the moved branch');
	});

	it('refuses to move a branch when a local commit is not already on the remote', async () => {
		const { repo } = await withRemote();
		await repo.commit('unique work', { 'unique.txt': 'u\n' });
		await repo.fetch();
		const remoteSha = await repo.sha('origin/main');

		await assert.rejects(
			() => moveBranchOntoUpstream(repo.ctx, { branch: 'main', upstreamSha: remoteSha, upstreamRef: 'origin/main' }),
			(error: unknown) => {
				assert.ok(error instanceof GecoError);
				assert.equal(error.code, 'not-fast-forward');
				return true;
			},
		);
		assert.equal(await repo.branchSha('main'), await repo.sha('HEAD'), 'nothing was moved');
	});

	it('removes a stale lock file', async () => {
		const { repo } = await withRemote();
		const lockPath = path.join(repo.dir, '.git', 'index.lock');
		fs.writeFileSync(lockPath, '', 'utf8');
		const [lock] = (await inspectPushSync(repo.ctx)).locks;

		const removed = await removeLockFiles(repo.ctx, [lock!]);

		assert.deepEqual(removed, [lockPath]);
		assert.ok(!fs.existsSync(lockPath));
		assert.equal((await inspectPushSync(repo.ctx)).clean, true);
	});

	it('publishes a branch and journals the way back', async () => {
		const { repo } = await withRemote();
		await repo.gitOk(['checkout', '-q', '-b', 'feature']);
		const sha = await repo.commit('feature work', { 'f.txt': 'f\n' });

		const result = await publishBranch(repo.ctx, { branch: 'feature', remote: 'origin' });

		assert.equal(result.sha, sha);
		assert.equal(await repo.gitOk(['rev-parse', '--abbrev-ref', 'feature@{upstream}']), 'origin/feature');
		const journal = await repo.ctx.safety.readJournal();
		const undo = journal.at(-1)!.undo;
		assert.equal(undo.type, 'refs');
		if (undo.type === 'refs') {
			assert.deepEqual(undo.remoteRefs, [{ remote: 'origin', branch: 'feature', action: 'delete', expectedSha: sha }]);
		}
	});

	it('reports a fetch against an unreachable remote instead of hanging', async () => {
		const { repo } = await withRemote();
		await repo.gitOk(['remote', 'add', 'broken', '/nonexistent/repository.git']);

		const outcome = await fetchRemote(repo.ctx, 'broken', { timeoutMs: 20_000 });

		assert.equal(outcome.ok, false);
		assert.equal(outcome.remote, 'broken');
		assert.ok(outcome.output.length > 0);
	});
});

describe('assertStartable - the guard in front of every operation', () => {
	it('lets a clean repository through', async () => {
		const { repo } = await withRemote();
		await assertStartable(repo.ctx);
	});

	it('refuses to start on top of an unfinished merge', async () => {
		const { repo, remoteDir } = await withRemote();
		await duplicateCommitAccident(repo, remoteDir);
		await leaveHalfFinishedMerge(repo);

		await assert.rejects(
			() => assertStartable(repo.ctx),
			(error: unknown) => {
				assert.ok(error instanceof GecoError);
				assert.equal(error.code, 'repo-busy');
				assert.match(error.message, /unfinished merge/);
				assert.match(error.userMessage, /Diagnose Push \/ Sync Trouble/);
				assert.match(error.userMessage, /Nothing was changed by this command/);
				return true;
			},
		);
	});

	it('refuses to start when a lock file is in the way', async () => {
		const { repo } = await withRemote();
		fs.writeFileSync(path.join(repo.dir, '.git', 'index.lock'), '', 'utf8');

		await assert.rejects(() => assertStartable(repo.ctx), (error: unknown) => {
			assert.ok(error instanceof GecoError);
			assert.equal(error.code, 'repo-busy');
			assert.match(error.message, /index\.lock/);
			return true;
		});
	});

	it('lets the patch flow continue its own interrupted git am', async () => {
		const { repo } = await withRemote();
		fs.mkdirSync(path.join(repo.dir, '.git', 'rebase-apply'), { recursive: true });
		fs.writeFileSync(path.join(repo.dir, '.git', 'rebase-apply', 'applying'), '', 'utf8');

		// A conflicted `git am` is the patch flow's own state: it may continue or
		// abort it, so the guard lets that flow through.
		repo.write('conflicted.txt', '<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n');
		await repo.gitOk(['add', 'conflicted.txt']);
		await repo.gitOk(['update-index', '--index-info'], { input: '0 0000000000000000000000000000000000000000\tconflicted.txt\n' }).catch(() => undefined);

		const forThePatchFlow = await assertStartable(repo.ctx, { allowAm: true }).then(() => undefined, (error: unknown) => error);

		assert.equal(forThePatchFlow, undefined, 'the patch flow may continue an am it started itself');
		await assert.rejects(() => assertStartable(repo.ctx), (error: unknown) => {
			assert.ok(error instanceof GecoError);
			assert.match(error.message, /patch application/);
			return true;
		});
	});
});

describe('controller - diagnose push / sync flow', () => {
	it('explains the duplicate-commit state and moves the branch onto the remote', async () => {
		const { repo, remoteDir } = await withRemote();
		const { local } = await duplicateCommitAccident(repo, remoteDir);
		const remoteSha = await repo.sha('origin/main');
		const ui = new FakeUI({ picks: ['Point main at origin/main'], confirms: true });

		await controllerFor(ui, repo).diagnosePushSync(repo.dir);

		const picker = ui.pickCalls[0]!;
		const labels = picker.items.map((item) => item.label);
		assert.ok(labels.some((label) => label.startsWith('Rebase my')), `labels: ${labels.join(' | ')}`);
		assert.ok(labels.some((label) => label.startsWith('Point main at origin/main')), `labels: ${labels.join(' | ')}`);
		assert.ok(labels.some((label) => label.startsWith('Fetch origin')), `labels: ${labels.join(' | ')}`);
		assert.ok(!labels.some((label) => label.startsWith('Force Push')), 'duplicates are not force-pushed away');
		assert.match(ui.pickCalls[0]!.options?.placeholder ?? '', /non-fast-forward/);

		assert.equal(ui.confirmCalls.length, 1);
		assert.match(ui.confirmCalls[0]!.message, /Point "main" at origin\/main\?/);
		assert.equal(await repo.branchSha('main'), remoteSha);
		assert.equal(await repo.branchSha('old'), local);
		const moved = ui.messages.find((message) => /now points at/.test(message.message));
		assert.ok(moved, `expected the move report: ${ui.transcript}`);
		assert.match(moved!.detail ?? '', /Nothing was lost/);
		assert.match(ui.messages.at(-1)!.message, /No push\/sync blockers found/, 'the run ends with the state it reached');
	});

	it('aborts the unfinished merge first and then re-reads the repository', async () => {
		const { repo, remoteDir } = await withRemote();
		await duplicateCommitAccident(repo, remoteDir);
		await leaveHalfFinishedMerge(repo);
		const ui = new FakeUI({ picks: ['Abort the unfinished merge', 'Rebase my'], confirms: true });

		await controllerFor(ui, repo).diagnosePushSync(repo.dir);

		assert.equal(ui.pickCalls.length, 2, 'two repairs, one after the other');
		assert.equal(ui.confirmCalls.length, 2);
		assert.ok(!fs.existsSync(path.join(repo.dir, '.git', 'MERGE_HEAD')));
		assert.deepEqual(await repo.statusLines(), []);
		assert.equal(await repo.branchSha('main'), await repo.sha('origin/main'), 'the second repair rebased it');
		// The report of every step goes to the output channel.
		assert.ok(ui.logs.some((line) => line.includes('Push / sync diagnosis for')), 'the state is logged');
		assert.ok(ui.logs.some((line) => line.includes('Aborted the unfinished merge')), 'the abort is logged');
	});

	it('reports a clean repository without asking anything', async () => {
		const { repo } = await withRemote();
		const ui = new FakeUI();

		await controllerFor(ui, repo).diagnosePushSync(repo.dir);

		assert.equal(ui.pickCalls.length, 0);
		assert.equal(ui.confirmCalls.length, 0);
		assert.match(ui.messages.at(-1)!.message, /No push\/sync blockers found/);
	});

	it('stops cleanly when the user dismisses the picker', async () => {
		const { repo, remoteDir } = await withRemote();
		await duplicateCommitAccident(repo, remoteDir);
		const before = await repo.sha('main');
		const ui = new FakeUI({ picks: [-1] });

		await controllerFor(ui, repo).diagnosePushSync(repo.dir);

		assert.equal(await repo.sha('main'), before, 'nothing was changed');
		assert.ok(ui.logs.some((line) => line.includes('nothing was changed')));
	});

	it('offers to remove a lock file, and only after a confirmation', async () => {
		const { repo } = await withRemote();
		fs.writeFileSync(path.join(repo.dir, '.git', 'index.lock'), '', 'utf8');
		const ui = new FakeUI({ picks: ['Remove the lock file'], confirms: false });

		await controllerFor(ui, repo).diagnosePushSync(repo.dir);

		assert.equal(ui.confirmCalls.length, 1);
		assert.ok(fs.existsSync(path.join(repo.dir, '.git', 'index.lock')), 'the lock stays after a cancelled confirmation');

		const yes = new FakeUI({ picks: ['Remove the lock file'], confirms: true });
		await controllerFor(yes, repo).diagnosePushSync(repo.dir);
		assert.ok(!fs.existsSync(path.join(repo.dir, '.git', 'index.lock')));
		assert.match(yes.messages[0]!.message, /Removed index\.lock/);
	});

	it('stops the flows that rewrite refs when the repository is half-finished', async () => {
		const { repo, remoteDir } = await withRemote();
		await duplicateCommitAccident(repo, remoteDir);
		await leaveHalfFinishedMerge(repo);
		const before = await repo.sha('main');
		const ui = new FakeUI();

		await controllerFor(ui, repo).fastForward(repo.dir, [], { askBranch: false });

		const error = ui.messages.find((message) => message.kind === 'error');
		assert.ok(error, `expected an error message: ${ui.transcript}`);
		assert.match(error!.message, /unfinished merge/);
		assert.equal(await repo.sha('main'), before, 'the branch was not moved');
		assert.ok(fs.existsSync(path.join(repo.dir, '.git', 'MERGE_HEAD')), 'the merge is still there to be finished');
	});
});
