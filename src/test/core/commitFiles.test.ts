import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import * as path from 'node:path';
import { availableCommitFiles, parseCommitFileChanges } from '../../core/commitFiles';
import { resolveMenuArgs } from '../../core/args';
import { TempRepo } from '../helpers/tempRepo';

describe('graph commit changed files', () => {
	it('parses NUL-delimited paths, including rename and copy targets', () => {
		assert.deepEqual(parseCommitFileChanges('M\0a\nfile\0R100\0old name\0new name\0C42\0a\0b\0D\0gone\0'), [
			{ status: 'M', path: 'a\nfile' },
			{ status: 'R100', oldPath: 'old name', path: 'new name' },
			{ status: 'C42', oldPath: 'a', path: 'b' },
			{ status: 'D', path: 'gone' },
		]);
		assert.throws(() => parseCommitFileChanges('R100\0old\0'));
	});

	it('offers existing current paths, including restored deletions, but not missing or unsafe paths', async () => {
		const changes = parseCommitFileChanges('D\0restored\0M\0missing\0R100\0old\0new\0M\0new\0M\0../outside\0');
		const root = path.resolve('repo');
		const result = await availableCommitFiles(root, changes, async (file) => file === path.join(root, 'restored') || file === path.join(root, 'new') || file === path.resolve(root, '..', 'outside'));
		assert.deepEqual(result.map((item) => item.path), ['restored', 'new']);
		assert.equal(result[1]?.oldPath, 'old');
	});

	it('uses the graph provider and selected commit rather than the active editor', () => {
		const sha = 'a'.repeat(40);
		const result = resolveMenuArgs([{ rootUri: { fsPath: '/repo-two', scheme: 'file' } }, { id: sha }]);
		assert.equal(result.repoPath, '/repo-two');
		assert.deepEqual(result.commitRefs, [sha]);
	});

	it('lists root, rename, delete and merge changes against the first parent', async () => {
		const repo = await TempRepo.create();
		try {
			const root = await repo.commit('root', { 'old name': 'content\n', 'deleted': 'old\n' });
			assert.deepEqual((await repo.api.changedFiles(root)).map(c => c.path).sort(), ['deleted', 'old name']);
			await repo.gitOk(['mv', 'old name', 'new name']);
			await repo.gitOk(['rm', 'deleted']);
			const rename = await repo.commit('rename and delete');
			assert.deepEqual(await repo.api.changedFiles(rename), [
				{ status: 'D', path: 'deleted' },
				{ status: 'R100', oldPath: 'old name', path: 'new name' },
			]);
			await repo.gitOk(['checkout', '-b', 'side']);
			await repo.commit('side', { 'side-file': 'side' });
			await repo.gitOk(['checkout', 'main']);
			await repo.commit('main', { 'main-file': 'main' });
			const merge = await repo.mergeNoFastForward('side');
			assert.deepEqual(await repo.api.changedFiles(merge), [{ status: 'A', path: 'side-file' }]);
			await assert.rejects(repo.api.changedFiles('deadbeef'));
		} finally {
			repo.cleanup();
		}
	});
});
