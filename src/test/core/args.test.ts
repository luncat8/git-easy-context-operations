/**
 * Menu arguments arrive in whatever shape the caller felt like using, and the
 * resolver has to cope without ever guessing a *wrong* commit - a wrong sha
 * means rewriting the wrong history.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isGecoTreeNode, isShaLike, looksLikeBranch, resolveMenuArgs } from '../../core/args';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

describe('args - isShaLike', () => {
	it('accepts full and abbreviated shas', () => {
		assert.equal(isShaLike(SHA), true);
		assert.equal(isShaLike(SHA.slice(0, 7)), true);
		assert.equal(isShaLike(SHA.slice(0, 40)), true);
		assert.equal(isShaLike(` ${SHA} `), true, 'surrounding whitespace is trimmed');
	});

	it('rejects everything that is not a hex object name', () => {
		for (const value of ['', 'main', 'HEAD', 'HEAD~2', 'v0.2', 'feature/x', 'abc', 'zzzzzzz', SHA + 'x', '0x' + SHA.slice(2), 42, null, undefined, {}, []]) {
			assert.equal(isShaLike(value), false, JSON.stringify(value));
		}
	});
});

describe('args - looksLikeBranch', () => {
	it('accepts ordinary ref names', () => {
		for (const value of ['main', 'old', 'feature/new-button', 'release-1.2', 'HEAD', 'my_branch', 'old-2']) {
			assert.equal(looksLikeBranch(value), true, value);
		}
	});

	it('rejects shas, revisions, flags and junk', () => {
		for (const value of [SHA, 'main~1', 'main^', 'a..b', '', '  ', 'two words', '-flag', 'a:b', 'a?b', 'a*b', 'a[b]', 'a\\b', 7, null, undefined, {}, 'x'.repeat(201)]) {
			assert.equal(looksLikeBranch(value), false, JSON.stringify(value));
		}
	});
});

describe('args - resolveMenuArgs', () => {
	it('finds a sha in every shape an editor can hand over', () => {
		const shapes: unknown[][] = [
			[SHA],
			[{ id: SHA }],
			[{ sha: SHA }],
			[{ hash: SHA }],
			[{ commitId: SHA }],
			[{ revision: SHA }],
			[{ objectId: SHA }],
			[{ historyItem: { id: SHA } }],
			[{ commit: { sha: SHA } }],
			[{ commit: { hash: SHA } }],
			[{ item: { id: SHA } }],
			[[{ id: SHA }]],
			[{ rootUri: { fsPath: '/repo' } }, { id: SHA }],
			[{ gecoKind: 'commit', sha: SHA, repoPath: '/repo' }],
			[undefined, null, { id: SHA }],
			['not-a-sha', { id: SHA }],
		];
		for (const args of shapes) {
			assert.deepEqual(resolveMenuArgs(args).commitRefs, [SHA], JSON.stringify(args));
		}
	});

	it('keeps several commits in argument order without duplicates', () => {
		const other = 'f'.repeat(40);
		assert.deepEqual(resolveMenuArgs([{ id: SHA }, { id: other }, { id: SHA }]).commitRefs, [SHA, other]);
		assert.deepEqual(resolveMenuArgs([[{ id: SHA }, { id: other }]]).commitRefs, [SHA, other]);
	});

	it('never invents a commit out of a label, path or number', () => {
		for (const args of [[], ['main'], [{ label: 'main' }], [{ fsPath: '/repo/a.txt' }], [42], [true], [{ id: 'main' }], [{ name: 'a.txt' }]]) {
			assert.deepEqual(resolveMenuArgs(args).commitRefs, [], JSON.stringify(args));
		}
	});

	it('takes the repository path from uris, fsPath and plain strings', () => {
		assert.equal(resolveMenuArgs([{ rootUri: { fsPath: '/work/repo' } }]).repoPath, '/work/repo');
		assert.equal(resolveMenuArgs([{ repositoryUri: { fsPath: '/work/repo' } }]).repoPath, '/work/repo');
		assert.equal(resolveMenuArgs([{ uri: { scheme: 'file', path: '/work/repo/a.txt' } }]).repoPath, '/work/repo/a.txt');
		assert.equal(resolveMenuArgs([{ repoPath: '/work/repo' }]).repoPath, '/work/repo');
		assert.equal(resolveMenuArgs([{ cwd: '/work/repo' }]).repoPath, '/work/repo');
		assert.equal(resolveMenuArgs([{ fsPath: '/work/repo' }]).repoPath, '/work/repo');
		assert.equal(resolveMenuArgs(['file:///work/repo/a.txt']).repoPath, undefined, 'a bare file uri string is not a repository');
		assert.equal(resolveMenuArgs([{ uri: 'file:///work/repo' }]).repoPath, '/work/repo');
		assert.equal(resolveMenuArgs([{ uri: { scheme: 'untitled', path: '/x' } }]).repoPath, undefined, 'non-file schemes are ignored');
		assert.equal(resolveMenuArgs([{ uri: { fsPath: '/first' } }, { uri: { fsPath: '/second' } }]).repoPath, '/first', 'the first path wins');
	});

	it('decodes percent-escapes in file uris', () => {
		assert.equal(resolveMenuArgs([{ uri: 'file:///work/my%20repo' }]).repoPath, '/work/my repo');
	});

	it('finds a branch name but never mistakes a sha for one', () => {
		assert.equal(resolveMenuArgs([{ name: 'feature/x' }]).branchRef, 'feature/x');
		assert.equal(resolveMenuArgs([{ branch: 'old' }]).branchRef, 'old');
		assert.equal(resolveMenuArgs([{ refName: 'main' }]).branchRef, 'main');
		assert.equal(resolveMenuArgs([{ id: SHA }]).branchRef, undefined);
		assert.equal(resolveMenuArgs([{ name: 'main~1' }]).branchRef, undefined, 'a revision is not a branch name');
		assert.deepEqual(resolveMenuArgs([{ sha: SHA, name: 'topic' }]).commitRefs, [SHA]);
		assert.equal(resolveMenuArgs([{ sha: SHA, name: 'topic' }]).branchRef, 'topic');
	});

	it('ignores a label that only looks like a branch', () => {
		assert.equal(resolveMenuArgs([{ label: 'Git Easy Ops' }]).branchRef, undefined);
		assert.equal(resolveMenuArgs([{ description: 'a commit' }]).branchRef, undefined);
	});

	it('survives cycles, deep nesting and huge argument lists', () => {
		const cyclic: Record<string, unknown> = { id: SHA };
		cyclic.self = cyclic;
		cyclic.children = [cyclic, { parent: cyclic }];
		assert.deepEqual(resolveMenuArgs([cyclic]).commitRefs, [SHA]);

		let deep: Record<string, unknown> = { id: SHA };
		for (let i = 0; i < 40; i++) {
			deep = { node: deep };
		}
		assert.deepEqual(resolveMenuArgs([deep]).commitRefs, [], 'nesting deeper than the limit is not followed');

		const many = Array.from({ length: 500 }, (_, i) => ({ id: `${i}`.padStart(40, '0') }));
		assert.ok(resolveMenuArgs(many).commitRefs.length <= 201, 'the visit counter caps runaway argument lists');
	});

	it('recognises our own tree nodes', () => {
		const node = { gecoKind: 'commit', sha: SHA, repoPath: '/work/repo' };
		assert.equal(isGecoTreeNode(node), true);
		assert.equal(isGecoTreeNode({ gecoKind: 'branch', name: 'main', repoPath: '/work/repo' }), true);
		assert.equal(isGecoTreeNode({ id: SHA }), false);
		assert.equal(isGecoTreeNode(null), false);
		assert.equal(isGecoTreeNode('commit'), false);
		assert.equal(resolveMenuArgs([node]).repoPath, '/work/repo');
	});

	it('handles the Source Control Graph shape: provider plus history items', () => {
		const provider = { id: 'git', rootUri: { scheme: 'file', fsPath: '/work/repo', path: '/work/repo' } };
		const resolved = resolveMenuArgs([provider, { id: SHA, label: 'v0.2' }, { id: 'f'.repeat(40) }]);
		assert.equal(resolved.repoPath, '/work/repo');
		assert.equal(resolved.commitRefs.length, 2);
		assert.equal(resolved.branchRef, undefined);
	});
});
