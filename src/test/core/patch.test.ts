import { test, describe, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyPatch, findProperBase, materializePatch, parsePatch } from '../../core/patch';
import { GecoError } from '../../core/errors';
import { createTempRepo, type TempRepo } from '../helpers/tempRepo';

const open: TempRepo[] = [];

afterEach(() => {
	while (open.length > 0) {
		open.pop()!.cleanup();
	}
});

async function temp(options?: Parameters<typeof createTempRepo>[0]) {
	const created = await createTempRepo(options);
	open.push(created);
	return created;
}

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

/**
 *   main:    c1 -> c2 (f.txt changes) -> c3 (g.txt changes)
 *   feature: c1 -> p1 (f.txt changes again, differently)
 *
 * The patch from p1 belongs on c1: it does not apply on c2 or c3.
 */
async function scenario() {
	const repo = await temp();
	const c1 = await repo.commit('c1 initial', { 'f.txt': 'one\n', 'g.txt': 'g-one\n' });
	const c2 = await repo.commit('c2 changes f', { 'f.txt': 'two\n' });
	const c3 = await repo.commit('c3 changes g', { 'g.txt': 'g-two\n' });
	await repo.checkout('feature', { create: true });
	await repo.gitOk(['reset', '--hard', c1]);
	const p1 = await repo.commit('p1 feature change', { 'f.txt': 'feature\n' });
	await repo.checkout('main');
	return { repo, c1, c2, c3, p1 };
}

describe('parsePatch - real git output', () => {
	test('a format-patch mailbox keeps author, date and subject', async () => {
		const { repo, p1 } = await scenario();
		const raw = await repo.gitOk(['format-patch', '-1', '--stdout', p1]);
		const parsed = parsePatch(raw);

		assert.equal(parsed.kind, 'mailbox');
		assert.equal(parsed.commitCount, 1);
		assert.equal(parsed.commitSha, p1);
		assert.equal(parsed.subject, 'p1 feature change');
		assert.equal(parsed.authorName, 'Test User');
		assert.equal(parsed.authorEmail, 'test@example.com');
		assert.ok(parsed.authorDate);
		assert.equal(parsed.files.length, 1);
		assert.equal(parsed.files[0].path, 'f.txt');
		assert.equal(parsed.files[0].oldPath, 'f.txt');
		assert.ok(parsed.files[0].preImageBlob);
		assert.equal(parsed.files[0].hunkCount, 1);
		assert.equal(parsed.hasCombinedDiff, false);
	});

	test('[PATCH 1/2] prefixes are stripped from the subject', async () => {
		const parsed = parsePatch([
			'From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001',
			'From: Someone <someone@example.com>',
			'Date: Mon, 17 Sep 2026 10:00:00 +0000',
			'Subject: [PATCH 1/2] add the button',
			'',
			'---',
			'',
		].join('\n'));
		assert.equal(parsed.subject, 'add the button');
		assert.equal(parsed.authorName, 'Someone');
		assert.equal(parsed.authorEmail, 'someone@example.com');
	});

	test('a series counts every patch', async () => {
		const { repo, c1, c3 } = await scenario();
		const raw = await repo.gitOk(['format-patch', '--stdout', `${c1}..${c3}`]);
		const parsed = parsePatch(raw);
		assert.equal(parsed.kind, 'mailbox');
		assert.equal(parsed.commitCount, 2);
		assert.equal(parsed.files.length, 2);
	});

	test('new, deleted, renamed and binary files', async () => {
		const repo = await temp();
		await repo.commit('base', { 'keep.txt': 'k\n', 'gone.txt': 'g\n', 'old-name.txt': 'n\n', 'blob.bin': '\u0000\u0001\u0002binary\n' });
		repo.write('new.txt', 'added\n');
		fs.rmSync(path.join(repo.dir, 'gone.txt'));
		await repo.gitOk(['mv', 'old-name.txt', 'renamed.txt']);
		fs.writeFileSync(path.join(repo.dir, 'blob.bin'), '\u0000\u0009\u0008changed binary\n');
		await repo.gitOk(['add', '-A']);
		const raw = await repo.gitOk(['diff', '--cached', '--binary']);
		const parsed = parsePatch(raw);

		const byPath = new Map(parsed.files.map((f) => [f.path || f.oldPath, f]));
		assert.equal(byPath.get('new.txt')?.isNewFile, true);
		assert.equal(byPath.get('new.txt')?.preImageBlob, undefined);
		assert.equal(byPath.get('gone.txt')?.isDelete, true);
		assert.equal(byPath.get('renamed.txt')?.isRename, true);
		assert.equal(byPath.get('renamed.txt')?.oldPath, 'old-name.txt');
		assert.equal(byPath.get('blob.bin')?.isBinary, true);
	});

	test('paths in subdirectories keep their full path', async () => {
		const repo = await temp();
		await repo.commit('base', { 'src/deep/nested/file.ts': 'a\n' });
		await repo.commit('change', { 'src/deep/nested/file.ts': 'b\n' });
		const parsed = parsePatch(await repo.gitOk(['diff', 'HEAD~1', 'HEAD']));
		assert.deepEqual(parsed.files.map((f) => f.path), ['src/deep/nested/file.ts']);
	});

	test('paths with spaces survive', () => {
		const raw = [
			'diff --git "a/my file.txt" "b/my file.txt"',
			'index 1111111..2222222 100644',
			'--- "a/my file.txt"',
			'+++ "b/my file.txt"',
			'@@ -1 +1 @@',
			'-old',
			'+new',
			'',
		].join('\n');
		const parsed = parsePatch(raw);
		assert.equal(parsed.files.length, 1);
		assert.equal(parsed.files[0].path, 'my file.txt');
		assert.equal(parsed.files[0].oldPath, 'my file.txt');
	});

	test('paths with spaces, unquoted form', () => {
		const raw = [
			'diff --git a/my file.txt b/my file.txt',
			'index 1111111..2222222 100644',
			'--- a/my file.txt',
			'+++ b/my file.txt',
			'@@ -1 +1 @@',
			'-old',
			'+new',
			'',
		].join('\n');
		const parsed = parsePatch(raw);
		assert.equal(parsed.files[0].path, 'my file.txt');
	});

	test('a combined (merge) diff is flagged as unappliable', () => {
		const raw = [
			'diff --cc conflicted.txt',
			'index 1111111,2222222..3333333',
			'--- a/conflicted.txt',
			'+++ b/conflicted.txt',
			'@@@ -1,1 -1,1 +1,1 @@@',
			'-ours',
			' -theirs',
			'++both',
			'',
		].join('\n');
		const parsed = parsePatch(raw);
		assert.equal(parsed.hasCombinedDiff, true);
		assert.equal(parsed.files[0].isCombined, true);
	});

	test('mode-only change', async () => {
		const repo = await temp();
		await repo.commit('base', { 'script.sh': '#!/bin/sh\n' });
		await repo.gitOk(['update-index', '--chmod=+x', 'script.sh']);
		const parsed = parsePatch(await repo.gitOk(['diff', '--cached']));
		assert.equal(parsed.files.length, 1);
		assert.equal(parsed.files[0].path, 'script.sh');
		assert.equal(parsed.files[0].hunkCount, 0);
	});

	test('garbage in, no files out', () => {
		assert.deepEqual(parsePatch('this is not a patch').files, []);
		assert.deepEqual(parsePatch('').files, []);
		assert.equal(parsePatch('').kind, 'diff');
	});

	test('CRLF patches are normalised', () => {
		const parsed = parsePatch('diff --git a/x b/x\r\nindex 1111111..2222222 100644\r\n--- a/x\r\n+++ b/x\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n');
		assert.equal(parsed.files[0].path, 'x');
	});
});

describe('materializePatch', () => {
	test('from a commit (mailbox by default)', async () => {
		const { repo, p1 } = await scenario();
		const materialized = await materializePatch(repo.ctx, { kind: 'commit', commit: p1 });
		assert.equal(parsePatch(materialized.patch).kind, 'mailbox');
		assert.equal(materialized.sourceCommit, p1);
		assert.match(materialized.label, /p1 feature change/);
	});

	test('from a commit as a plain diff', async () => {
		const { repo, p1 } = await scenario();
		const materialized = await materializePatch(repo.ctx, { kind: 'commit', commit: p1, mailbox: false });
		assert.equal(parsePatch(materialized.patch).kind, 'diff');
	});

	test('from a range', async () => {
		const { repo, c1, c3 } = await scenario();
		const materialized = await materializePatch(repo.ctx, { kind: 'range', from: c1, to: c3 });
		assert.equal(parsePatch(materialized.patch).files.length, 2);
	});

	test('from the index and from the working tree', async () => {
		const repo = await temp();
		await repo.commit('base', { 'f.txt': 'one\n' });
		repo.write('f.txt', 'staged\n');
		await repo.gitOk(['add', 'f.txt']);
		repo.write('g.txt', 'untracked but added\n');
		await repo.gitOk(['add', 'g.txt']);

		const staged = await materializePatch(repo.ctx, { kind: 'staged' });
		assert.equal(parsePatch(staged.patch).files.length, 2);

		repo.write('h.txt', 'only in the worktree\n');
		await repo.gitOk(['add', '-N', 'h.txt']);
		const worktree = await materializePatch(repo.ctx, { kind: 'worktree' });
		assert.equal(parsePatch(worktree.patch).files.length, 3);
	});

	test('empty sources are rejected', async () => {
		const repo = await temp();
		await repo.commit('base', { 'f.txt': 'one\n' });
		await expectCode(() => materializePatch(repo.ctx, { kind: 'staged' }), 'nothing-to-do');
		await expectCode(() => materializePatch(repo.ctx, { kind: 'worktree' }), 'nothing-to-do');
	});

	test('from a file on disk (relative and absolute)', async () => {
		const { repo, p1 } = await scenario();
		const patchFile = path.join(repo.dir, 'saved.patch');
		fs.writeFileSync(patchFile, await repo.gitOk(['format-patch', '-1', '--stdout', p1]), 'utf8');

		const relative = await materializePatch(repo.ctx, { kind: 'file', path: 'saved.patch' });
		assert.equal(parsePatch(relative.patch).commitSha, p1);

		const absolute = await materializePatch(repo.ctx, { kind: 'file', path: patchFile });
		assert.equal(parsePatch(absolute.patch).commitSha, p1);

		await expectCode(() => materializePatch(repo.ctx, { kind: 'file', path: 'missing.patch' }), 'unsupported');
	});

	test('a merge commit falls back to a diff against its first parent', async () => {
		const { repo, p1 } = await scenario();
		const merge = await repo.git(['merge', '--no-ff', '--no-edit', p1]);
		if (merge.exitCode !== 0) {
			// f.txt changed on both sides: take the feature version and finish the merge.
			await repo.gitOk(['checkout', '--theirs', '--', '.']);
			await repo.gitOk(['add', '-A']);
			await repo.gitOk(['commit', '--quiet', '--no-edit']);
		}
		const mergeSha = await repo.gitOk(['rev-parse', 'HEAD']);
		const info = await repo.api.commitInfo(mergeSha);
		assert.equal(info.parents.length, 2);

		const materialized = await materializePatch(repo.ctx, { kind: 'commit', commit: mergeSha });
		const parsed = parsePatch(materialized.patch);
		assert.equal(parsed.hasCombinedDiff, false, 'a diff against the first parent is appliable');
		assert.match(materialized.label, /merge commit/);
	});
});

describe('findProperBase', () => {
	test('the parent of the commit the patch came from is the proper base', async () => {
		const { repo, c1, c2, c3, p1 } = await scenario();
		const { patch } = await materializePatch(repo.ctx, { kind: 'commit', commit: p1 });

		const found = await findProperBase(repo.ctx, { patch, sourceCommit: p1, targetBranch: 'main' });

		assert.ok(found.best);
		assert.equal(found.best!.sha, c1);
		assert.equal(found.best!.exact, true);
		assert.equal(found.best!.appliesCleanly, true);
		assert.equal(found.best!.score, 100);
		assert.match(found.best!.label, /parent of/);
		assert.equal(found.evaluated.length, 1, 'stops at the first exact match');
		assert.ok(c2 && c3);
	});

	test('the branch tip is rejected when the file moved on there', async () => {
		const { repo, c1, c3, p1 } = await scenario();
		const { patch } = await materializePatch(repo.ctx, { kind: 'commit', commit: p1 });

		const found = await findProperBase(repo.ctx, { patch, sourceCommit: p1, targetBranch: 'main', stopAtFirstMatch: false });

		const tip = found.evaluated.find((e) => e.sha === c3)!;
		assert.equal(tip.appliesCleanly, false);
		assert.deepEqual(tip.mismatchedPaths, ['f.txt']);
		assert.equal(found.best!.sha, c1);
	});

	test('without a source commit the first-parent history is walked to find a base', async () => {
		const { repo, c2, c3 } = await scenario();
		// A patch that only fits the g.txt content of c1/c2 (main tip has g-two).
		const patch = [
			'diff --git a/g.txt b/g.txt',
			'index 1111111..2222222 100644',
			'--- a/g.txt',
			'+++ b/g.txt',
			'@@ -1 +1 @@',
			'-g-one',
			'+g-three',
			'',
		].join('\n');

		const found = await findProperBase(repo.ctx, { patch, targetBranch: 'main', stopAtFirstMatch: false });

		assert.equal(found.best!.sha, c2, 'newest commit where the patch still applies');
		assert.equal(found.best!.appliesCleanly, true);
		const tip = found.evaluated.find((e) => e.sha === c3)!;
		assert.equal(tip.appliesCleanly, false);
		assert.equal(found.evaluated.length >= 2, true);
	});

	test('a patch that fits nowhere reports every candidate it probed', async () => {
		const { repo } = await scenario();
		const patch = [
			'diff --git a/never.txt b/never.txt',
			'index 1111111..2222222 100644',
			'--- a/never.txt',
			'+++ b/never.txt',
			'@@ -1 +1 @@',
			'-nothing',
			'+something',
			'',
		].join('\n');

		const found = await findProperBase(repo.ctx, { patch, targetBranch: 'main', stopAtFirstMatch: false });
		assert.equal(found.best!.score, 0);
		assert.equal(found.evaluated.every((e) => !e.appliesCleanly), true);

		await expectCode(() => applyPatch(repo.ctx, { patch, targetBranch: 'main' }), 'conflict');
	});

	test('a base that only works through a 3-way merge is recognised and scored below a clean one', async () => {
		const { repo, c1, c3, p1 } = await scenario();
		const { patch } = await materializePatch(repo.ctx, { kind: 'commit', commit: p1, mailbox: false });

		const found = await findProperBase(repo.ctx, { patch, sourceCommit: p1, targetBranch: 'main', stopAtFirstMatch: false });

		const tip = found.evaluated.find((e) => e.sha === c3)!;
		assert.equal(tip.exact, false);
		assert.equal(tip.appliesCleanly, false);
		assert.equal(tip.threeWay, true, 'the pre-image blob exists, so a 3-way merge is possible');
		assert.equal(tip.threeWayConflicts, true, 'f.txt was changed on both sides');
		assert.equal(tip.score, 20);
		assert.match(tip.reason, /3-way merge/);
		assert.equal(found.best!.sha, c1, 'the exact base still wins');
	});

	test('the 3-way probe can be switched off', async () => {
		const threeWayOff = await temp({ settings: { threeWayApply: false } });
		await threeWayOff.commit('base', { 'f.txt': 'one\n' });
		const head = await threeWayOff.commit('changed', { 'f.txt': 'two\n' });
		const patch = 'diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-one\n+three\n';

		const found = await findProperBase(threeWayOff.ctx, { patch, targetBranch: 'main', stopAtFirstMatch: false });
		const tip = found.evaluated.find((e) => e.sha === head)!;
		assert.equal(tip.threeWay, false);
		assert.equal(tip.reason, 'does not apply here');
	});

	test('verify=false only uses the cheap blob comparison', async () => {
		const { repo, c1, p1 } = await scenario();
		const { patch } = await materializePatch(repo.ctx, { kind: 'commit', commit: p1 });
		const found = await findProperBase(repo.ctx, { patch, sourceCommit: p1, targetBranch: 'main', verify: false, stopAtFirstMatch: false });
		assert.equal(found.best!.sha, c1);
		assert.equal(found.best!.exact, true);
		assert.equal(found.evaluated.find((e) => !e.exact)!.reason, 'not verified');
	});

	test('extra candidates from the caller are considered', async () => {
		const { repo, c2, p1 } = await scenario();
		const { patch } = await materializePatch(repo.ctx, { kind: 'commit', commit: p1 });
		const found = await findProperBase(repo.ctx, { patch, sourceCommit: p1, extraCandidates: [c2], stopAtFirstMatch: false });
		assert.ok(found.evaluated.some((e) => e.sha === c2));
	});

	test('something that is not a patch is rejected', async () => {
		const { repo } = await scenario();
		await expectCode(() => findProperBase(repo.ctx, { patch: 'hello world' }), 'unsupported');
	});

	test('a combined diff is rejected with a hint', async () => {
		const { repo } = await scenario();
		const raw = 'diff --cc x.txt\nindex 1111111,2222222..3333333\n--- a/x.txt\n+++ b/x.txt\n@@@ -1 -1 +1 @@@\n-a\n+b\n';
		const error = await expectCode(() => findProperBase(repo.ctx, { patch: raw }), 'unsupported');
		assert.match(error.userMessage, /--cc/);
	});

	test('the probe never touches the user index or working tree', async () => {
		const { repo, p1 } = await scenario();
		repo.write('scratch.txt', 'local scratch\n');
		const statusBefore = await repo.statusLines();
		const indexBefore = await repo.gitOk(['write-tree']);

		const { patch } = await materializePatch(repo.ctx, { kind: 'commit', commit: p1 });
		await findProperBase(repo.ctx, { patch, sourceCommit: p1, targetBranch: 'main', stopAtFirstMatch: false });

		assert.deepEqual(await repo.statusLines(), statusBefore);
		assert.equal(await repo.gitOk(['write-tree']), indexBefore);
		assert.equal(await repo.gitOk(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
	});
});

describe('applyPatch - new branch at the proper base', () => {
	test('a mailbox patch is replayed with git am, keeping author and message', async () => {
		const { repo, c1, p1 } = await scenario();
		const { patch } = await materializePatch(repo.ctx, { kind: 'commit', commit: p1 });
		const headBefore = await repo.branchSha('main');

		const result = await applyPatch(repo.ctx, { patch, sourceCommit: p1, targetBranch: 'main', destination: 'newBranch' });

		assert.equal(result.base.sha, c1);
		assert.equal(result.method, 'am-3');
		assert.equal(result.committed, true);
		assert.ok(result.branch);
		assert.equal(await repo.subject(result.branch!), 'p1 feature change');
		assert.equal(await repo.gitOk(['log', '-1', '--format=%an <%ae>', result.branch!]), 'Test User <test@example.com>');
		assert.equal(repo.read('f.txt'), 'feature\n', 'the branch is checked out with the patch applied');
		assert.notEqual(await repo.branchSha('main'), undefined);
		assert.equal(await repo.branchSha('main'), headBefore, 'main itself was not moved');
	});

	test('a plain diff patch is applied and committed on request', async () => {
		const { repo, c1, p1 } = await scenario();
		const { patch } = await materializePatch(repo.ctx, { kind: 'commit', commit: p1, mailbox: false });

		const result = await applyPatch(repo.ctx, {
			patch,
			sourceCommit: p1,
			targetBranch: 'main',
			destination: 'newBranch',
			branchName: 'apply/button',
			commit: true,
			commitMessage: 'add new button (applied from patch)',
		});

		assert.equal(result.base.sha, c1);
		assert.equal(result.branch, 'apply/button');
		assert.equal(result.method, 'apply-3way');
		assert.equal(result.committed, true);
		assert.equal(result.staged, true);
		assert.equal(await repo.subject('apply/button'), 'add new button (applied from patch)');
		assert.deepEqual(result.appliedPaths, ['f.txt']);
	});

	test('without commit the changes stay in the working tree', async () => {
		const { repo, p1 } = await scenario();
		const { patch } = await materializePatch(repo.ctx, { kind: 'commit', commit: p1, mailbox: false });

		const result = await applyPatch(repo.ctx, { patch, sourceCommit: p1, targetBranch: 'main', destination: 'newBranch', branchName: 'wip' });

		assert.equal(result.committed, false);
		assert.equal(result.staged, true, '--3way implies --index');
		assert.equal(await repo.subject('wip'), 'c1 initial', 'the branch tip is still the base commit');
		assert.equal(repo.read('f.txt'), 'feature\n');
	});

	test('an existing branch name is refused', async () => {
		const { repo, p1 } = await scenario();
		const { patch } = await materializePatch(repo.ctx, { kind: 'commit', commit: p1 });
		const error = await expectCode(
			() => applyPatch(repo.ctx, { patch, sourceCommit: p1, destination: 'newBranch', branchName: 'main' }),
			'ref-exists',
		);
		assert.match(error.userMessage, /already exists/);
	});

	test('a failed apply leaves no branch behind', async () => {
		const { repo } = await scenario();
		const patch = 'diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-nothing here\n+something\n';
		await expectCode(() => applyPatch(repo.ctx, { patch, destination: 'newBranch', branchName: 'temp' }), 'conflict');
		assert.equal(await repo.hasBranch('temp'), false);
		assert.equal(await repo.gitOk(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
	});
});

describe('applyPatch - separate worktree', () => {
	test('the current checkout is never touched', async () => {
		const { repo, c1, p1 } = await scenario();
		repo.write('scratch.txt', 'precious local work\n');
		const headBefore = await repo.gitOk(['rev-parse', 'HEAD']);
		const { patch } = await materializePatch(repo.ctx, { kind: 'commit', commit: p1, mailbox: false });

		const result = await applyPatch(repo.ctx, {
			patch,
			sourceCommit: p1,
			targetBranch: 'main',
			destination: 'worktree',
			branchName: 'patch/f',
			commit: true,
		});

		assert.equal(result.base.sha, c1);
		assert.ok(result.worktreePath);
		assert.equal(result.checkedOut, false);
		assert.equal(await repo.gitOk(['rev-parse', 'HEAD']), headBefore, 'HEAD did not move');
		assert.equal(await repo.gitOk(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
		assert.equal(repo.read('scratch.txt'), 'precious local work\n');
		assert.deepEqual(await repo.statusLines(), ['?? scratch.txt']);
		assert.equal(fs.readFileSync(path.join(result.worktreePath!, 'f.txt'), 'utf8'), 'feature\n');
		assert.equal(await repo.subject('patch/f'), 'Apply patch (1 file)');
	});

	test('a dirty working tree makes newBranch fall back to a worktree', async () => {
		const { repo, p1 } = await scenario();
		repo.write('f.txt', 'uncommitted local edit\n');
		const { patch } = await materializePatch(repo.ctx, { kind: 'commit', commit: p1, mailbox: false });

		const result = await applyPatch(repo.ctx, { patch, sourceCommit: p1, targetBranch: 'main', destination: 'newBranch' });

		assert.equal(result.destination, 'worktree');
		assert.match(result.warnings.join('\n'), /separate worktree/);
		assert.equal(repo.read('f.txt'), 'uncommitted local edit\n', 'the local edit is still there');
	});

	test('undo removes the worktree and its branch', async () => {
		const { repo, p1 } = await scenario();
		const { patch } = await materializePatch(repo.ctx, { kind: 'commit', commit: p1, mailbox: false });

		const result = await applyPatch(repo.ctx, { patch, sourceCommit: p1, destination: 'worktree', branchName: 'patch/undo-me' });
		const worktreePath = result.worktreePath!;
		assert.ok(fs.existsSync(worktreePath));
		assert.equal(await repo.hasBranch('patch/undo-me'), true);

		const entry = (await repo.ctx.safety.readJournal()).pop()!;
		const undo = await repo.ctx.safety.undo(entry);

		assert.equal(fs.existsSync(worktreePath), false);
		assert.equal(await repo.hasBranch('patch/undo-me'), false);
		assert.equal((await repo.worktrees()).length, 1);
		assert.match(undo.messages.join('\n'), /Removed worktree/);
	});

	test('the worktree folder comes from the settings', async () => {
		const custom = await temp({ settings: { worktreeFolder: 'build/geco-trees' } });
		await custom.commit('base', { 'f.txt': 'one\n' });
		const patch = 'diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-one\n+two\n';

		const result = await applyPatch(custom.ctx, { patch, destination: 'worktree', branchName: 'wt' });
		assert.match(result.worktreePath!, /build[/\\]geco-trees/);
	});
});

describe('applyPatch - current branch', () => {
	test('applies to the working tree when the proper base is HEAD', async () => {
		const { repo, c3 } = await scenario();
		const patch = 'diff --git a/g.txt b/g.txt\nindex 1111111..2222222 100644\n--- a/g.txt\n+++ b/g.txt\n@@ -1 +1 @@\n-g-two\n+g-three\n';

		const result = await applyPatch(repo.ctx, { patch, targetBranch: 'main', destination: 'current', commit: true, commitMessage: 'bump g' });

		assert.equal(result.base.sha, c3);
		assert.equal(result.destination, 'current');
		assert.equal(result.committed, true);
		assert.equal(repo.read('g.txt'), 'g-three\n');
		assert.equal(await repo.subject('main'), 'bump g');
	});

	test('refuses when HEAD is not the proper base', async () => {
		const { repo, p1 } = await scenario();
		const { patch } = await materializePatch(repo.ctx, { kind: 'commit', commit: p1, mailbox: false });

		const error = await expectCode(
			() => applyPatch(repo.ctx, { patch, sourceCommit: p1, targetBranch: 'main', destination: 'current' }),
			'unsupported',
		);
		assert.match(error.userMessage, /proper base/i);
	});

	test('undo of a committed apply restores the branch and the files', async () => {
		const { repo } = await scenario();
		const before = await repo.branchSha('main');
		const patch = 'diff --git a/g.txt b/g.txt\nindex 1111111..2222222 100644\n--- a/g.txt\n+++ b/g.txt\n@@ -1 +1 @@\n-g-two\n+g-three\n';

		await applyPatch(repo.ctx, { patch, targetBranch: 'main', destination: 'current', commit: true });
		assert.notEqual(await repo.branchSha('main'), before);

		const entry = (await repo.ctx.safety.readJournal()).pop()!;
		await repo.ctx.safety.undo(entry);

		assert.equal(await repo.branchSha('main'), before);
		assert.equal(repo.read('g.txt'), 'g-two\n');
		assert.deepEqual(await repo.statusLines(), []);
	});

	test('dry run reports the base without changing anything', async () => {
		const { repo, c1, p1 } = await scenario();
		const { patch } = await materializePatch(repo.ctx, { kind: 'commit', commit: p1 });
		const headBefore = await repo.branchSha('main');

		const result = await applyPatch(repo.ctx, { patch, sourceCommit: p1, targetBranch: 'main', dryRun: true });

		assert.equal(result.dryRun, true);
		assert.equal(result.base.sha, c1);
		assert.equal(result.method, 'none');
		assert.equal(await repo.branchSha('main'), headBefore);
		assert.equal((await repo.branches()).join(','), 'feature,main');
	});
});

describe('applyPatch - conflicts', () => {
	test('a conflicting mailbox patch reports the conflicted files and how to continue', async () => {
		const { repo, c3 } = await scenario();
		// Apply the c2 change again on top of c3 where f.txt already changed.
		const conflicting = 'From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001\n'
			+ 'From: Test User <test@example.com>\n'
			+ 'Date: Mon, 17 Sep 2026 10:00:00 +0000\n'
			+ 'Subject: [PATCH] conflicting change\n\n---\n\n'
			+ 'diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-one\n+conflicting\n';

		const error = await expectCode(
			() => applyPatch(repo.ctx, { patch: conflicting, base: c3, destination: 'worktree', branchName: 'conflict-test' }),
			'conflict',
		);
		assert.match(error.userMessage, /f\.txt/);
		assert.match(error.userMessage, /git am --abort|git am --continue/);
		assert.equal(await repo.hasBranch('conflict-test'), false, 'the worktree and branch were cleaned up');
		assert.equal((await repo.worktrees()).length, 1);
	});
});

describe('applyPatch - patch files from disk', () => {
	test('round trip: save a patch to a file, apply it in a fresh clone at the proper base', async () => {
		const { repo, c1, p1 } = await scenario();
		const patchText = await repo.gitOk(['format-patch', '-1', '--stdout', p1]);
		const patchFile = path.join(repo.root, 'saved.patch');
		fs.writeFileSync(patchFile, patchText, 'utf8');

		const cloneDir = path.join(repo.root, 'clone');
		await repo.gitOk(['clone', '--quiet', repo.dir, cloneDir]);
		const { createRepoContext } = await import('../../core/context');
		const ctx = createRepoContext(cloneDir, undefined, repo.exec);

		const materialized = await materializePatch(ctx, { kind: 'file', path: patchFile });
		const result = await applyPatch(ctx, { patch: materialized.patch, sourceCommit: p1, destination: 'newBranch', branchName: 'from-file' });

		assert.equal(result.base.sha, c1, 'the clone finds the same proper base');
		assert.equal(result.committed, true);
		assert.equal(await repo.subject(p1), 'p1 feature change');
		const cloneLog = await repo.gitOk(['log', '--format=%s', '-2'], { cwd: cloneDir });
		assert.deepEqual(cloneLog.split('\n'), ['p1 feature change', 'c1 initial']);
	});
});
