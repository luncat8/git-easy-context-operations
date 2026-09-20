/**
 * The whole-graph cleanup: scanning for paths that exist only in history,
 * planning the `git filter-repo` rewrite around them and the report the user
 * sees. Scanned against real repositories - the interesting cases are the ones
 * a naive `git log --all --name-only | sort` gets wrong: merges, quoted paths,
 * detached HEADs and this extension's own recovery refs.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import {
	analyzeDeadPaths,
	blockingCleanReasons,
	bundleArgs,
	buildCommands,
	cleanWarnings,
	collectCleanFacts,
	deadPathSizes,
	describeCleanConfirmation,
	diffDeadPaths,
	formatBytes,
	formatCleanReport,
	keptPrefix,
	parsePathList,
	shellCommand,
	unquoteGitPath,
	writeDeadPathsFile,
	type CleanFacts,
	type DeadPathAnalysis,
} from '../../core/cleanHistory';
import { DEFAULT_SETTINGS } from '../../core/config';
import { createTempRepo, TempRepo } from '../helpers/tempRepo';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('cleanHistory - pure helpers', () => {
	it('parses a path list, drops empty lines and undoes git C-quoting', () => {
		assert.deepEqual(parsePathList('a.txt\nb/c.txt\n').paths, ['a.txt', 'b/c.txt']);
		assert.equal(parsePathList('a.txt\n').quoted, false);
		assert.deepEqual(parsePathList('dup.txt\ndup.txt\nother.txt\n').paths, ['dup.txt', 'other.txt']);
		assert.deepEqual(parsePathList('a\0b\0').paths, ['a', 'b'], '-z output is accepted too');
		// A quoted path is unquoted, not reported as a problem.
		const quoted = parsePathList('"caf\\303\\251.txt"\nplain.txt\n');
		assert.deepEqual(quoted.paths, ['caf\u00e9.txt', 'plain.txt']);
		assert.equal(quoted.quoted, false);
		// Only a path that cannot be unquoted (a real newline in the name) counts.
		assert.equal(parsePathList('"with\\nnewline.txt"\n').quoted, true);
	});

	it('unquotes exactly what git quotes, even with core.quotePath=false', () => {
		assert.equal(unquoteGitPath('plain/name.txt'), 'plain/name.txt');
		assert.equal(unquoteGitPath('"caf\\303\\251.txt"'), 'caf\u00e9.txt', 'non-ASCII escapes become UTF-8');
		assert.equal(unquoteGitPath('"quote\\".txt"'), 'quote".txt', 'a quote in the name is quoted by every git');
		assert.equal(unquoteGitPath('"back\\\\slash.txt"'), 'back\\slash.txt');
		assert.equal(unquoteGitPath('"tab\\there.txt"'), 'tab\there.txt');
		assert.equal(unquoteGitPath('"with\\nnewline.txt"'), undefined, 'line-based output cannot carry this');
		assert.equal(unquoteGitPath('"unterminated'), '"unterminated', 'not a quoted form at all');
	});

	it('computes the set difference that defines a dead path', () => {
		assert.deepEqual(diffDeadPaths(['a', 'b', 'c'], ['b']), ['a', 'c']);
		assert.deepEqual(diffDeadPaths(['a'], ['a']), []);
		assert.deepEqual(diffDeadPaths([], ['a']), []);
	});

	it('formats sizes without lying about the unit', () => {
		assert.equal(formatBytes(0), '0 B');
		assert.equal(formatBytes(512), '512 B');
		assert.equal(formatBytes(1023), '1023 B');
		assert.equal(formatBytes(2048), '2 KiB');
		assert.equal(formatBytes(1536), '1.5 KiB');
		assert.equal(formatBytes(5 * 1024 * 1024), '5 MiB');
		assert.equal(formatBytes(3.5 * 1024 * 1024 * 1024), '3.5 GiB');
	});

	it('quotes only what a shell would otherwise split', () => {
		assert.equal(shellCommand(['git', 'filter-repo', '--paths-from-file', '/tmp/dead paths.txt']),
			`git filter-repo --paths-from-file '/tmp/dead paths.txt'`);
		assert.equal(shellCommand(['git', 'gc', '--prune=now']), 'git gc --prune=now');
	});

	it('derives the kept ref prefix from a recovery ref', () => {
		assert.equal(keptPrefix(['refs/geco/reword/main/20260919T120000Z-abcdef1234']), 'refs/geco/reword');
		assert.equal(keptPrefix(['refs/geco/x']), 'refs/geco');
		assert.equal(keptPrefix([]), '');
	});

	it('bundles every ref explicitly, unless there are too many', () => {
		assert.deepEqual(bundleArgs('/tmp/b.bundle', ['refs/heads/main', 'refs/geco/x']), ['bundle', 'create', '/tmp/b.bundle', 'refs/heads/main', 'refs/geco/x']);
		// `--all` does not cover hidden refs, but 5000 refs on one command line do not work either.
		assert.deepEqual(bundleArgs('/tmp/b.bundle', Array.from({ length: 900 }, (_, i) => `refs/heads/b${i}`)), ['bundle', 'create', '/tmp/b.bundle', '--all']);
		assert.deepEqual(bundleArgs('/tmp/b.bundle', []), ['bundle', 'create', '/tmp/b.bundle', '--all']);
	});

	it('keeps the confirmation honest about what cannot be undone', () => {
		const analysis: DeadPathAnalysis = {
			historicalPaths: ['a.txt', 'gone.bin'],
			alivePaths: ['a.txt'],
			deadPaths: ['gone.bin'],
			quotedPaths: false,
			deadBytes: 1024,
		};
		const facts: CleanFacts = {
			dirty: false,
			stashes: 0,
			extraWorktrees: [],
			remotes: [{ name: 'origin', url: 'https://example.com/r.git' }],
			recoveryRefs: ['refs/geco/reword/main/x'],
			detachedHead: false,
		};
		const { message, detail } = describeCleanConfirmation(analysis, facts, { bundleFile: '/tmp/r.bundle', pathsFile: '/tmp/dead.txt' });
		assert.match(message, /Remove 1 dead path from the entire history\?/);
		assert.match(detail, /1 KiB/);
		assert.match(detail, /gone\.bin/);
		assert.match(detail, /EVERY commit/);
		assert.match(detail, /re-clone/);
		assert.match(detail, /refs\/geco\//);
		assert.match(detail, /\/tmp\/r\.bundle/);
		assert.match(detail, /no Undo/i);
	});

	it('separates the blockers from the warnings', () => {
		const clean: CleanFacts = { dirty: false, stashes: 0, extraWorktrees: [], remotes: [], recoveryRefs: [], detachedHead: false };
		assert.deepEqual(blockingCleanReasons(clean), []);
		assert.equal(blockingCleanReasons({ ...clean, dirty: true }).length, 1);
		assert.equal(blockingCleanReasons({ ...clean, extraWorktrees: ['/tmp/wt'] }).length, 1);
		assert.equal(blockingCleanReasons({ ...clean, dirty: true, extraWorktrees: ['/tmp/wt'] }).length, 2);
		// A stash or a recovery point is worth warning about, but not a reason to refuse.
		assert.deepEqual(blockingCleanReasons({ ...clean, stashes: 3, recoveryRefs: ['refs/geco/x'], detachedHead: true }), []);
	});

	it('warns about everything that makes a rewrite unsafe', () => {
		const analysis: DeadPathAnalysis = { historicalPaths: [], alivePaths: [], deadPaths: ['x'], quotedPaths: true };
		const facts: CleanFacts = {
			dirty: true,
			stashes: 2,
			extraWorktrees: ['/tmp/wt'],
			remotes: [],
			recoveryRefs: ['refs/geco/a', 'refs/geco/b'],
			detachedHead: true,
		};
		const warnings = cleanWarnings(analysis, facts);
		assert.equal(warnings.length, 6);
		assert.match(warnings.join('\n'), /unquoted/, 'a path git will not unquote is reported');
		assert.match(warnings.join('\n'), /uncommitted/);
		assert.match(warnings.join('\n'), /stash/);
		assert.match(warnings.join('\n'), /worktree/);
		assert.match(warnings.join('\n'), /recovery point/);
		assert.match(warnings.join('\n'), /detached/i);
		assert.deepEqual(cleanWarnings({ ...analysis, quotedPaths: false, deadPaths: [] }, { ...facts, dirty: false, stashes: 0, extraWorktrees: [], recoveryRefs: [], detachedHead: false }), []);
	});

	it('builds a runnable script: backup, rewrite with the recovery refs excluded, remotes, rescan, gc, push', () => {
		const commands = buildCommands({
			pathsFile: '/tmp/dead.txt',
			bundleFile: '/tmp/backup.bundle',
			refsToKeep: ['refs/geco/reword/main/x'],
			droppedRemotes: [{ name: 'origin', url: 'https://example.com/r.git' }],
			forceFilterRepo: true,
		});
		assert.deepEqual(commands.bundle, ['git', 'bundle', 'create', '/tmp/backup.bundle', '--all']);
		assert.deepEqual(commands.filterRepo, [
			'git', 'filter-repo', '--invert-paths', '--paths-from-file', '/tmp/dead.txt', '--replace-refs', 'delete-no-add',
			'--refs', '--branches', '--remotes', '--tags', '--force',
		]);
		assert.ok(commands.all.indexOf('# 1. Backup - the rewrite cannot be undone by git afterwards.') >= 0, 'the backup comes first');
		assert.ok(commands.script.includes('git remote add origin'), 'the removed remote is re-added');
		assert.ok(commands.script.includes('--force-with-lease'), 'publishing uses the lease, not a blind --force');
		assert.ok(commands.script.includes('reflog expire') && commands.script.includes('gc --prune=now'), 'the space is reclaimed');
		assert.ok(commands.script.includes('comm -23'), 'the script rescans the way the workflow doc does');
		assert.ok(!commands.script.includes('ls-tree -r --name-only --full-tree --branches'), 'the rescan does not pass rev-list flags to ls-tree');

		// Without recovery refs the rewrite covers everything, and --refs would
		// only limit it for no reason.
		const plain = buildCommands({ pathsFile: '/tmp/dead.txt' });
		assert.deepEqual(plain.filterRepo, ['git', 'filter-repo', '--invert-paths', '--paths-from-file', '/tmp/dead.txt', '--replace-refs', 'delete-no-add', '--force']);
		assert.equal(plain.bundle, undefined);
		assert.ok(plain.script.includes('No remote is configured'), 'nothing to push is said, not guessed');
	});

});

describe('cleanHistory - scanning real repositories', () => {
	let repo: TempRepo;

	before(async () => {
		repo = await createTempRepo();
		await repo.commit('v1', { 'keep.txt': 'keep\n', 'gone.bin': 'x'.repeat(2048), 'dir/also-gone.log': 'log\n' });
		await repo.commit('v2', { 'keep.txt': 'keep2\n' });
		await repo.gitOk(['rm', '--quiet', 'gone.bin', 'dir/also-gone.log']);
		await repo.commit('v3 remove the dead files');
	});
	after(() => repo.cleanup());

	it('finds the paths no ref contains anymore, with their sizes', async () => {
		const analysis = await analyzeDeadPaths(repo.ctx);
		assert.deepEqual(analysis.deadPaths.sort(), ['dir/also-gone.log', 'gone.bin']);
		assert.ok(analysis.alivePaths.includes('keep.txt'));
		assert.equal(analysis.quotedPaths, false);
		assert.ok((analysis.deadBytes ?? 0) >= 2048, 'the big blob is measured');
		const biggest = analysis.sizes?.[0];
		assert.equal(biggest?.path, 'gone.bin');
		assert.equal(biggest?.versions, 1);
	});

	it('writes the dead-path list where filter-repo can read it', async () => {
		const analysis = await analyzeDeadPaths(repo.ctx, { sizeAnalysis: false });
		const file = path.join(repo.dir, '.git', 'geco', 'dead-paths.txt');
		await writeDeadPathsFile(file, analysis.deadPaths);
		const written = fs.readFileSync(file, 'utf8');
		assert.equal(written.endsWith('\n'), true, 'a missing trailing newline loses the last path');
		assert.deepEqual(written.trim().split('\n').sort(), ['dir/also-gone.log', 'gone.bin']);
	});

	it('reports the scan the way the output log shows it', async () => {
		const analysis = await analyzeDeadPaths(repo.ctx);
		const facts = await collectCleanFacts(repo.ctx, DEFAULT_SETTINGS.backupRefPrefix);
		const report = formatCleanReport(analysis, facts, { pathsFile: '/tmp/dead.txt' });
		assert.match(report, /Dead paths: 2 \(of 3 paths/);
		assert.match(report, /gone\.bin/);
		assert.match(report, /MiB|KiB/, 'the size is part of the report');
	});

	it('counts a path as alive when a branch, a tag or a remote still has it', async () => {
		const other = await createTempRepo();
		try {
			await other.commit('v1', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
			await other.gitOk(['rm', '--quiet', 'b.txt']);
			await other.commit('v2 drop b');
			// A side branch that still has b.txt keeps it alive.
			await other.gitOk(['branch', 'old-state', 'HEAD~1']);
			let analysis = await analyzeDeadPaths(other.ctx, { sizeAnalysis: false });
			assert.deepEqual(analysis.deadPaths, [], 'a branch still contains b.txt');

			await other.gitOk(['branch', '-D', 'old-state']);
			await other.gitOk(['tag', 'v1-tag', 'HEAD~1']);
			analysis = await analyzeDeadPaths(other.ctx, { sizeAnalysis: false });
			assert.deepEqual(analysis.deadPaths, [], 'a tag still contains b.txt');

			await other.gitOk(['tag', '-d', 'v1-tag']);
			analysis = await analyzeDeadPaths(other.ctx, { sizeAnalysis: false });
			assert.deepEqual(analysis.deadPaths, ['b.txt'], 'now it is dead');

			// A remote-tracking branch counts too (that is where a colleague's
			// copy of the file lives after a push).
			await other.addBareRemote('origin', ['main']);
			await other.gitOk(['update-ref', 'refs/remotes/origin/stale', 'HEAD~1']);
			analysis = await analyzeDeadPaths(other.ctx, { sizeAnalysis: false });
			assert.deepEqual(analysis.deadPaths, [], 'refs/remotes/origin/stale still contains b.txt');
		} finally {
			other.cleanup();
		}
	});

	it('does not declare a detached HEAD dead', async () => {
		const detached = await createTempRepo();
		try {
			await detached.commit('v1', { 'a.txt': 'a\n' });
			const first = await detached.sha('HEAD');
			await detached.commit('v2', { 'a.txt': 'a2\n', 'b.txt': 'b\n' });
			await detached.gitOk(['checkout', '--quiet', '--detach', first]);
			const analysis = await analyzeDeadPaths(detached.ctx, { sizeAnalysis: false });
			assert.deepEqual(analysis.deadPaths, [], 'HEAD itself is scanned as a ref');
			const facts = await collectCleanFacts(detached.ctx, DEFAULT_SETTINGS.backupRefPrefix);
			assert.equal(facts.detachedHead, true);
			assert.match(cleanWarnings(analysis, facts).join('\n'), /detached/i);
		} finally {
			detached.cleanup();
		}
	});

	it('finds a path that arrived through a merge after the side branch is gone', async () => {
		const merged = await createTempRepo();
		try {
			await merged.commit('base', { 'a.txt': 'a\n' });
			await merged.gitOk(['checkout', '--quiet', '-b', 'side']);
			await merged.commit('side adds the junk', { 'build/output.o': 'junk\n' });
			await merged.gitOk(['checkout', '--quiet', 'main']);
			await merged.commit('main moves on', { 'a.txt': 'a2\n' });
			await merged.mergeNoFastForward('side', 'merge side');
			await merged.gitOk(['branch', '-D', 'side']);
			await merged.gitOk(['rm', '-r', '--quiet', 'build']);
			await merged.commit('drop build output');

			// The merge is the only way the junk ever reached `main`, and the
			// branch that carried it is gone. The scan asks for
			// `--diff-merges=separate` so every merge is diffed against each
			// parent explicitly instead of relying on git's combined-diff
			// default - which hides whatever matches one parent, and which
			// `--name-only` only implies since git 2.31.
			const analysis = await analyzeDeadPaths(merged.ctx, { sizeAnalysis: false });
			assert.deepEqual(analysis.deadPaths, ['build/output.o']);
			assert.ok(analysis.alivePaths.includes('a.txt'));
		} finally {
			merged.cleanup();
		}
	});

	it("ignores this extension's recovery refs: they neither keep paths alive nor join the scan", async () => {
		const withRefs = await createTempRepo({ settings: { backupRefPrefix: 'refs/geco/' } });
		try {
			await withRefs.commit('v1', { 'a.txt': 'a\n', 'secret.log': 'junk\n' });
			const v1 = await withRefs.sha('HEAD');
			await withRefs.gitOk(['rm', '--quiet', 'secret.log']);
			await withRefs.commit('v2 drop the log');
			// A recovery point at v1 - exactly what a reword or a squash leaves behind.
			await withRefs.gitOk(['update-ref', 'refs/geco/reword/main/20260919T120000Z-abcdef1234', v1]);

			const analysis = await analyzeDeadPaths(withRefs.ctx, { sizeAnalysis: false });
			assert.deepEqual(analysis.deadPaths, ['secret.log'], 'the recovery ref does not keep the dead path alive');

			const facts = await collectCleanFacts(withRefs.ctx, DEFAULT_SETTINGS.backupRefPrefix);
			assert.deepEqual(facts.recoveryRefs, ['refs/geco/reword/main/20260919T120000Z-abcdef1234']);

			const commands = buildCommands({ pathsFile: '/tmp/dead.txt', refsToKeep: facts.recoveryRefs });
			assert.ok(commands.filterRepo.includes('--refs'), 'the rewrite is limited to the public refs');
			assert.equal(commands.filterRepo[commands.filterRepo.indexOf('--refs') + 1], '--branches');
			assert.match(formatCleanReport(analysis, facts), /recovery point/);
		} finally {
			withRefs.cleanup();
		}
	});

	it('does not choke on paths with spaces, quotes and unicode', async () => {
		const weird = await createTempRepo({ config: { 'core.quotepath': 'false' } });
		try {
			await weird.commit('v1', { 'plain.txt': 'p\n', 'with space.txt': 's\n', 'caf\u00e9.txt': 'c\n', 'quote".txt': 'q\n' });
			await weird.gitOk(['rm', '--quiet', 'with space.txt', 'caf\u00e9.txt', 'quote".txt']);
			await weird.commit('v2 drop them');
			const analysis = await analyzeDeadPaths(weird.ctx, { sizeAnalysis: false });
			assert.deepEqual(analysis.deadPaths.sort(), ['caf\u00e9.txt', 'quote".txt', 'with space.txt']);
			assert.equal(analysis.quotedPaths, false, 'whatever git still quotes is unquoted before the comparison');

			// The list filter-repo receives holds the *real* names, not C-quoted
			// forms it would never match against a tree entry.
			const file = path.join(weird.dir, '.git', 'geco', 'dead-paths.txt');
			await writeDeadPathsFile(file, analysis.deadPaths);
			assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split('\n').sort(), ['caf\u00e9.txt', 'quote".txt', 'with space.txt']);
		} finally {
			weird.cleanup();
		}
	});

	it('quotes the same path identically on both sides even with core.quotePath on', async () => {
		const quoting = await createTempRepo({ config: { 'core.quotepath': 'true' } });
		try {
			await quoting.commit('v1', { 'a.txt': 'a\n', 'caf\u00e9.txt': 'c\n' });
			await quoting.gitOk(['rm', '--quiet', 'caf\u00e9.txt']);
			await quoting.commit('v2 drop it');
			const analysis = await analyzeDeadPaths(quoting.ctx, { sizeAnalysis: false });
			assert.deepEqual(analysis.deadPaths, ['caf\u00e9.txt'], 'the quoted form is unquoted, not compared literally');
			assert.equal(analysis.quotedPaths, false);
		} finally {
			quoting.cleanup();
		}
	});

	it('sizes nothing when there is nothing dead', async () => {
		const empty = await deadPathSizes(repo.ctx, []);
		assert.deepEqual(empty.sizes, []);
		assert.equal(empty.skipped, false);
	});

	it('collects the facts a plan warns about', async () => {
		const facts = await collectCleanFacts(repo.ctx, DEFAULT_SETTINGS.backupRefPrefix);
		assert.equal(facts.dirty, false);
		assert.equal(facts.stashes, 0);
		assert.deepEqual(facts.extraWorktrees, []);
		assert.deepEqual(facts.remotes, []);
		assert.deepEqual(facts.recoveryRefs, []);

		repo.write('uncommitted.txt', 'x\n');
		await repo.gitOk(['add', 'uncommitted.txt']);
		const dirty = await collectCleanFacts(repo.ctx, DEFAULT_SETTINGS.backupRefPrefix);
		assert.equal(dirty.dirty, true, 'a staged change blocks the rewrite');
		await repo.gitOk(['reset', '--quiet']);
		fs.rmSync(path.join(repo.dir, 'uncommitted.txt'), { force: true });

		// A stash and a linked worktree are reported too (filter-repo refuses both).
		repo.write('stashed.txt', 'x\n');
		await repo.gitOk(['stash', '--quiet', '--include-untracked']);
		const worktreeDir = path.join(repo.root, 'linked-worktree');
		await repo.gitOk(['worktree', 'add', '--quiet', worktreeDir, '-b', 'wt-branch']);
		const busy = await collectCleanFacts(repo.ctx, DEFAULT_SETTINGS.backupRefPrefix);
		assert.equal(busy.stashes, 1);
		assert.deepEqual(busy.extraWorktrees, [worktreeDir]);
		assert.match(cleanWarnings({ historicalPaths: [], alivePaths: [], deadPaths: ['x'], quotedPaths: false }, busy).join('\n'), /worktree/);
		await repo.gitOk(['worktree', 'remove', '--force', worktreeDir]);
		await repo.gitOk(['stash', 'clear']);
	});
});
