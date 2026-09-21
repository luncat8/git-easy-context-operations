/**
 * The safety net: the journal that makes "Undo last operation" possible, the
 * backup branches and the hidden recovery refs. Everything here is what stands
 * between a user and a lost commit, so it gets tested directly.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_SETTINGS } from '../../core/config';
import { clearJournal } from '../../core/safety';
import { createLinearRepo, createTempRepo, TempRepo } from '../helpers/tempRepo';

describe('safety - journal', () => {
	it('lives in the common git dir, is written atomically and reads back', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const safety = repo.ctx.safety;
			const file = await safety.journalPath();
			assert.match(file, /[\\/]\.git[\\/]geco[\\/]journal\.json$/);
			assert.equal(fs.existsSync(file), false, 'nothing is written before the first operation');
			assert.deepEqual(await safety.readJournal(), []);
			assert.equal(await safety.lastEntry(), undefined);

			const entry = await safety.record({
				kind: 'reword',
				summary: 'Renamed the message of abc1234 on main',
				undo: { type: 'refs', refs: [{ ref: 'refs/heads/main', restoreTo: shas.v04, expected: shas.v04 }] },
			});
			assert.ok(fs.existsSync(file));
			assert.equal(fs.existsSync(`${file}.${process.pid}.tmp`), false, 'the temporary file is renamed away');

			const journal = await safety.readJournal();
			assert.equal(journal.length, 1);
			assert.deepEqual(journal[0], entry);
			assert.equal(entry.repo, repo.dir);
			assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/);
			assert.equal((await safety.lastEntry())!.id, entry.id);
		} finally {
			repo.cleanup();
		}
	});

	it('keeps at most journalMaxEntries, newest ones', async () => {
		const repo = await createTempRepo({ settings: { ...DEFAULT_SETTINGS, journalMaxEntries: 3 } });
		try {
			await repo.commit('v0.1', { 'a.txt': 'a\n' });
			for (let i = 1; i <= 5; i++) {
				await repo.ctx.safety.record({ kind: 'backup', summary: `entry ${i}`, undo: { type: 'none', hint: 'nothing to do' } });
			}
			const journal = await repo.ctx.safety.readJournal();
			assert.deepEqual(journal.map((e) => e.summary), ['entry 3', 'entry 4', 'entry 5']);
		} finally {
			repo.cleanup();
		}
	});

	it('survives a corrupt or hand-edited journal file', async () => {
		const { repo } = await createLinearRepo();
		try {
			const file = await repo.ctx.safety.journalPath();
			fs.mkdirSync(path.dirname(file), { recursive: true });

			fs.writeFileSync(file, 'this is not json', 'utf8');
			assert.deepEqual(await repo.ctx.safety.readJournal(), []);

			fs.writeFileSync(file, '{"not":"an array"}', 'utf8');
			assert.deepEqual(await repo.ctx.safety.readJournal(), []);

			fs.writeFileSync(
				file,
				JSON.stringify([1, null, { kind: 'nope' }, { id: 'x', kind: 'backup', at: 'now', repo: repo.dir, summary: 'kept', undo: { type: 'none', hint: 'h' } }]),
				'utf8',
			);
			const journal = await repo.ctx.safety.readJournal();
			assert.equal(journal.length, 1, 'only well-formed entries survive');
			assert.equal(journal[0]!.summary, 'kept');
		} finally {
			repo.cleanup();
		}
	});

	it('removes an entry once it has been undone, and can be cleared', async () => {
		const { repo } = await createLinearRepo();
		try {
			const safety = repo.ctx.safety;
			const first = await safety.record({ kind: 'backup', summary: 'first', undo: { type: 'none', hint: 'nothing' } });
			await safety.record({ kind: 'backup', summary: 'second', undo: { type: 'none', hint: 'nothing' } });
			assert.equal((await safety.readJournal()).length, 2);

			const result = await safety.undo(first);
			assert.deepEqual(result.restored, []);
			assert.deepEqual(result.messages, ['nothing']);
			const remaining = await safety.readJournal();
			assert.deepEqual(remaining.map((e) => e.summary), ['second']);

			await clearJournal(repo.api, repo.ctx.settings);
			assert.deepEqual(await safety.readJournal(), []);
		} finally {
			repo.cleanup();
		}
	});
});

describe('safety - undo specs', () => {
	it('puts a branch back and resynchronises the working tree (resetHard)', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			// Simulate an operation that moved main back by one commit.
			await repo.gitOk(['update-ref', 'refs/heads/main', shas.v03]);
			assert.equal(repo.exists('d.txt'), true, 'the working tree still shows the newer commit');

			const entry = await repo.ctx.safety.record({
				kind: 'reword',
				summary: 'moved main back',
				undo: { type: 'refs', refs: [{ ref: 'refs/heads/main', restoreTo: shas.v04, expected: shas.v03, resetHard: true }] },
			});
			const result = await repo.ctx.safety.undo(entry);

			assert.equal(await repo.sha('main'), shas.v04);
			assert.deepEqual(result.restored, [`refs/heads/main -> ${shas.v04.slice(0, 10)}`]);
			assert.equal(repo.exists('d.txt'), true);
			assert.deepEqual(await repo.statusLines(), [], 'the working tree matches the restored commit');
		} finally {
			repo.cleanup();
		}
	});

	it('refuses to restore a ref that moved again in the meantime', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const entry = await repo.ctx.safety.record({
				kind: 'reword',
				summary: 'stale expectation',
				undo: { type: 'refs', refs: [{ ref: 'refs/heads/main', restoreTo: shas.v03, expected: shas.v01 }] },
			});
			await assert.rejects(() => repo.ctx.safety.undo(entry), /update-ref failed|cannot lock ref/);
			assert.equal(await repo.sha('main'), shas.v04, 'main was not touched');
		} finally {
			repo.cleanup();
		}
	});

	it('deletes the branches and refs an operation created', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			await repo.gitOk(['branch', 'geco/temporary', shas.v02]);
			await repo.gitOk(['update-ref', 'refs/geco/scratch', shas.v02]);
			assert.equal(await repo.hasBranch('geco/temporary'), true);

			const entry = await repo.ctx.safety.record({
				kind: 'applyPatch',
				summary: 'created a branch and a ref',
				undo: { type: 'refs', refs: [], deleteBranches: ['geco/temporary'], deleteRefs: ['refs/geco/scratch'] },
			});
			const result = await repo.ctx.safety.undo(entry);

			assert.equal(await repo.hasBranch('geco/temporary'), false);
			assert.equal(await repo.hasRef('refs/geco/scratch'), false);
			assert.ok(result.messages.some((m) => /Deleted backup branch geco\/temporary/.test(m)), result.messages.join('\n'));
		} finally {
			repo.cleanup();
		}
	});

	it('removes a worktree and its branch', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const worktreePath = `${repo.root}/wt-undo`;
			await repo.gitOk(['worktree', 'add', '--quiet', '-b', 'geco/wt', worktreePath, shas.v02]);
			assert.equal((await repo.worktrees()).length, 2);

			const entry = await repo.ctx.safety.record({
				kind: 'applyPatch',
				summary: 'created a worktree',
				undo: { type: 'refs', refs: [], worktrees: [{ path: worktreePath, branch: 'geco/wt' }] },
			});
			const result = await repo.ctx.safety.undo(entry);

			assert.deepEqual(await repo.worktrees(), [repo.dir]);
			assert.equal(await repo.hasBranch('geco/wt'), false);
			assert.equal(fs.existsSync(worktreePath), false);
			assert.ok(result.messages.some((m) => m.startsWith('Removed worktree ')), result.messages.join('\n'));
		} finally {
			repo.cleanup();
		}
	});

	it('checks the previous branch out again', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			await repo.gitOk(['branch', 'feature', shas.v02]);
			await repo.checkout('feature');
			const entry = await repo.ctx.safety.record({
				kind: 'applyPatch',
				summary: 'switched branches',
				undo: { type: 'refs', refs: [], checkoutRef: 'main' },
			});
			const result = await repo.ctx.safety.undo(entry);

			assert.equal(await repo.gitOk(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
			assert.ok(result.messages.some((m) => m === 'Checked out main again'), result.messages.join('\n'));
		} finally {
			repo.cleanup();
		}
	});

	it('reports (instead of guessing) when a checkout cannot be restored', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			repo.write('a.txt', 'dirty\n');
			const entry = await repo.ctx.safety.record({
				kind: 'applyPatch',
				summary: 'switched branches',
				undo: { type: 'refs', refs: [{ ref: 'refs/heads/main', restoreTo: shas.v03, expected: shas.v04 }], checkoutRef: 'no-such-branch' },
			});
			const result = await repo.ctx.safety.undo(entry);

			assert.ok(result.messages.some((m) => /Could not check out no-such-branch/.test(m)), result.messages.join('\n'));
			assert.equal(await repo.sha('main'), shas.v03, 'the ref restore still happened');
		} finally {
			repo.cleanup();
		}
	});

	it('pushes the previous sha back to the remote for a remoteRef spec', async () => {
		const { repo } = await createLinearRepo();
		try {
			const remoteDir = await repo.addBareRemote('origin');
			const pushed = await repo.sha('main');
			await repo.gitOk(['commit', '--quiet', '--amend', '-m', 'v0.4 rewritten']);
			await repo.gitOk(['push', '--quiet', '--force', 'origin', 'main:main']);
			assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), await repo.sha('main'));

			const entry = await repo.ctx.safety.record({
				kind: 'forcePush',
				summary: 'force pushed',
				undo: { type: 'remoteRef', remote: 'origin', branch: 'main', restoreTo: pushed },
			});
			const result = await repo.ctx.safety.undo(entry);

			assert.equal(await repo.remoteBranchSha(remoteDir, 'main'), pushed);
			assert.deepEqual(result.restored, [`origin/main -> ${pushed.slice(0, 10)}`]);
			assert.equal(await repo.sha('main'), await repo.sha('main'), 'the local branch is not part of a remote undo');
		} finally {
			repo.cleanup();
		}
	});

	it('reports a rejected remote undo instead of leaving a half-restored remote', async () => {
		const { repo } = await createLinearRepo();
		try {
			await repo.addBareRemote('origin');
			const entry = await repo.ctx.safety.record({
				kind: 'forcePush',
				summary: 'force pushed',
				// A sha that does not exist in this repository cannot be pushed.
				undo: { type: 'remoteRef', remote: 'origin', branch: 'main', restoreTo: '0123456789012345678901234567890123456789' },
			});
			await assert.rejects(() => repo.ctx.safety.undo(entry), /Could not restore origin\/main/);
		} finally {
			repo.cleanup();
		}
	});
});

describe('safety - backup branches and recovery points', () => {
	it('creates a backup branch, reuses one that already matches, and suffixes otherwise', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const safety = repo.ctx.safety;

			const created = await safety.backupBranch('old', shas.v04);
			assert.deepEqual(created, { name: 'old', sha: shas.v04, reused: false, renamed: false });
			assert.equal(await repo.sha('old'), shas.v04);

			const reused = await safety.backupBranch('old', shas.v04);
			assert.equal(reused.reused, true);
			assert.equal(reused.name, 'old');

			const suffixed = await safety.backupBranch('old', shas.v02);
			assert.deepEqual(suffixed, { name: 'old-2', sha: shas.v02, reused: false, renamed: true });
			assert.equal(await repo.sha('old'), shas.v04, 'the first backup is untouched');

			const third = await safety.backupBranch('old', shas.v01);
			assert.equal(third.name, 'old-3');

			const blank = await safety.backupBranch('   ', shas.v03);
			assert.notEqual(blank.name, '', 'an empty name falls back to the configured default');
		} finally {
			repo.cleanup();
		}
	});

	it('knows which branch names are unusable', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const safety = repo.ctx.safety;
			await repo.gitOk(['tag', 'v9', shas.v02]);

			assert.equal(await safety.isBranchNameFree('fresh'), true);
			assert.equal(await safety.isBranchNameFree('main'), false, 'an existing branch is taken');
			assert.equal(await safety.isBranchNameFree('v9'), false, 'a tag with the same name would be ambiguous');
			assert.equal(await safety.isBranchNameFree('-flag'), false);
			assert.equal(await safety.isBranchNameFree('a..b'), false);
			assert.equal(await safety.isBranchNameFree(''), false);
			assert.equal(await safety.isBranchNameFree('main~1'), false, 'git rejects it');
		} finally {
			repo.cleanup();
		}
	});

	it('hidden recovery refs are invisible as branches but listed as recovery points', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const ref = await repo.ctx.safety.hiddenBackupRef('reword/main', shas.v04);
			assert.match(ref, /^refs\/geco\/reword\/main\/\d{8}T\d{6}Z-[0-9a-f]{10}$/);
			assert.equal(await repo.hasRef(ref), true);
			assert.equal(await repo.hasBranch(ref), false);
			assert.equal(await repo.gitOk(['rev-parse', ref]), shas.v04);
			assert.equal((await repo.branches()).includes(ref), false, 'it never shows up in branch listings');

			const points = await repo.ctx.safety.listRecoveryPoints();
			assert.equal(points.length, 1);
			assert.deepEqual(
				{ ...points[0]!, createdAt: undefined },
				{ kind: 'ref', name: ref, sha: shas.v04, description: `reword/main/${ref.split('/').pop()}`, createdAt: undefined },
			);
			assert.match(points[0]!.createdAt!, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'the timestamp is recovered from the ref name');
		} finally {
			repo.cleanup();
		}
	});

	it('lists backup branches recorded by a fast-forward and deletes points on request', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const safety = repo.ctx.safety;
			const backup = await safety.backupBranch('old', shas.v04);
			await safety.record({
				kind: 'fastForward',
				summary: 'Moved main',
				undo: { type: 'refs', refs: [{ ref: 'refs/heads/main', restoreTo: shas.v04 }], deleteBranches: [backup.name] },
			});
			const hidden = await safety.hiddenBackupRef('reword/main', shas.v03);

			const points = await safety.listRecoveryPoints();
			assert.equal(points.length, 2);
			assert.deepEqual(points.map((p) => p.kind).sort(), ['branch', 'ref']);
			const branchPoint = points.find((p) => p.kind === 'branch')!;
			assert.equal(branchPoint.name, 'old');
			assert.equal(branchPoint.sha, shas.v04);
			assert.equal(branchPoint.description, 'Moved main');

			await safety.deleteRecoveryPoint(branchPoint);
			assert.equal(await repo.hasBranch('old'), false);
			await safety.deleteRecoveryPoint(points.find((p) => p.kind === 'ref')!);
			assert.equal(await repo.hasRef(hidden), false);
			assert.deepEqual(await safety.listRecoveryPoints(), []);
		} finally {
			repo.cleanup();
		}
	});

	it('ignores backup branches whose journal entry disappeared', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			await repo.gitOk(['branch', 'old', shas.v02]);
			assert.deepEqual(await repo.ctx.safety.listRecoveryPoints(), [], 'a branch alone is not claimed as a recovery point');
		} finally {
			repo.cleanup();
		}
	});

	it('sorts recovery points newest first', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const safety = repo.ctx.safety;
			await safety.record({ kind: 'fastForward', summary: 'older', at: '2020-01-01T00:00:00.000Z', undo: { type: 'refs', refs: [], deleteBranches: ['older-backup'] } });
			await repo.gitOk(['branch', 'older-backup', shas.v01]);
			await safety.hiddenBackupRef('newer', shas.v02);

			const points = await safety.listRecoveryPoints();
			assert.equal(points.length, 2);
			assert.equal(points[0]!.kind, 'ref', 'the hidden ref has a real timestamp and sorts first');
		} finally {
			repo.cleanup();
		}
	});

	it('honours a custom backup ref prefix', async () => {
		const repo = await createTempRepo({ settings: { ...DEFAULT_SETTINGS, backupRefPrefix: 'geco-test' } });
		try {
			const sha = await repo.commit('v0.1', { 'a.txt': 'a\n' });
			assert.equal(repo.ctx.settings.backupRefPrefix, 'refs/geco-test/', 'the prefix is normalised');
			const ref = await repo.ctx.safety.hiddenBackupRef('label', sha);
			assert.match(ref, /^refs\/geco-test\/label\//);
			assert.equal((await repo.ctx.safety.listRecoveryPoints()).length, 1);
		} finally {
			repo.cleanup();
		}
	});

	it('keeps working in a linked worktree (common dir is shared)', async () => {
		const { repo, shas } = await createLinearRepo();
		try {
			const worktreePath = `${repo.root}/wt-journal`;
			await repo.gitOk(['worktree', 'add', '--quiet', worktreePath, shas.v02]);
			await repo.ctx.safety.record({ kind: 'backup', summary: 'from the main checkout', undo: { type: 'none', hint: 'h' } });

			const linked = new LinkedRepo(worktreePath, repo);
			assert.equal(await linked.journalEntries(), 1, 'the linked worktree sees the same journal');
		} finally {
			repo.cleanup();
		}
	});
});

/** Reads the journal from a linked worktree through a second RepoContext. */
class LinkedRepo {
	constructor(private readonly dir: string, private readonly owner: TempRepo) {}

	async journalEntries(): Promise<number> {
		const result = await this.owner.exec(['rev-parse', '--git-common-dir'], { cwd: this.dir });
		assert.equal(result.exitCode, 0);
		const { createRepoContext } = await import('../../core/context');
		const ctx = createRepoContext(this.dir, DEFAULT_SETTINGS, this.owner.exec);
		return (await ctx.safety.readJournal()).length;
	}
}
