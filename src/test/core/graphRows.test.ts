/**
 * The rows our own Source Control panel shows: lane art, subject, the ref
 * badges and the tooltip. These are the rows the context menus hang off, so the
 * test also pins down which refs become *child nodes* (the ones the branch
 * operations can act on).
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildGraphRows, describeWhen } from '../../core/graphRows';
import type { CommitInfo, RefInfo } from '../../core/git';

const commit = (sha: string, subject: string, parents: string[] = [], date = '2026-09-19T10:00:00.000Z'): CommitInfo => ({
	sha: `${sha}`.padEnd(40, '0'),
	shortSha: sha,
	parents: parents.map((parent) => `${parent}`.padEnd(40, '0')),
	tree: 't'.repeat(40),
	author: { name: 'Ada', email: 'ada@example.com', date },
	committer: { name: 'Ada', email: 'ada@example.com', date },
	subject,
	body: '',
	message: `${subject}\n`,
});

const ref = (name: string, sha: string, kind: RefInfo['kind'] = 'branch', extra: Partial<RefInfo> = {}): RefInfo => ({
	name,
	sha: `${sha}`.padEnd(40, '0'),
	kind,
	isHead: false,
	...extra,
});

const NOW = new Date('2026-09-19T12:00:00.000Z');

describe('graph rows - content', () => {
	it('carries the lane art, the subject and the sha', () => {
		const rows = buildGraphRows([commit('a1', 'Fix the bug')], [], { now: NOW });

		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.art, '●');
		assert.equal(rows[0]!.subject, 'Fix the bug');
		assert.equal(rows[0]!.shortSha, 'a1');
		assert.match(rows[0]!.tooltip, /Fix the bug/);
		assert.match(rows[0]!.tooltip, /Right-click for the Git Easy Ops operations/);
	});

	it('leaves the art empty when the lanes are turned off', () => {
		const rows = buildGraphRows([commit('a1', 'Fix the bug')], [], { now: NOW, lanes: false });
		assert.equal(rows[0]!.art, '');
	});

	it('lists every ref of a commit as a label and only branches as children', () => {
		const refs = [
			ref('main', 'a1', 'branch', { isHead: true }),
			ref('origin/main', 'a1', 'remote'),
			ref('v1.0', 'a1', 'tag'),
			ref('feature/x', 'a1'),
		];
		const rows = buildGraphRows([commit('a1', 'Fix the bug')], refs, { now: NOW });

		assert.equal(rows[0]!.refsLabel, 'main (HEAD), feature/x, origin/main, v1.0', 'HEAD first, then branches, remotes, tags');
		assert.deepEqual(
			rows[0]!.refs.map((entry) => entry.name),
			['main', 'feature/x'],
			'only local branches get a context menu of their own',
		);
		assert.equal(rows[0]!.isHead, true);
	});

	it('marks HEAD and reports the upstream of a branch badge', () => {
		const rows = buildGraphRows(
			[commit('a1', 'Fix the bug')],
			[ref('main', 'a1', 'branch', { isHead: true, upstream: 'origin/main' })],
			{ now: NOW },
		);

		assert.equal(rows[0]!.refs[0]!.isHead, true);
		assert.equal(rows[0]!.refs[0]!.upstream, 'origin/main');
	});
});

describe('graph rows - relative dates', () => {
	it('describes recent commits in words', () => {
		assert.equal(describeWhen('2026-09-19T11:59:30.000Z', NOW), 'just now');
		assert.equal(describeWhen('2026-09-19T11:30:00.000Z', NOW), '30 minutes ago');
		assert.equal(describeWhen('2026-09-19T10:00:00.000Z', NOW), '2 hours ago');
		assert.equal(describeWhen('2026-09-17T12:00:00.000Z', NOW), '2 days ago');
	});

	it('falls back to the date for anything older than a month', () => {
		assert.equal(describeWhen('2026-01-02T12:00:00.000Z', NOW), '2026-01-02');
	});

	it('does not invent a time for a broken or future date', () => {
		assert.equal(describeWhen('not a date', NOW), 'not a date');
		assert.equal(describeWhen('2026-09-19T18:00:00.000Z', NOW), '2026-09-19T18:00:00.000Z');
	});

	it('puts the relative date into the tooltip', () => {
		const rows = buildGraphRows([commit('a1', 'Fix the bug')], [], { now: NOW });
		assert.match(rows[0]!.tooltip, /2 hours ago/);
		assert.match(rows[0]!.tooltip, /Ada <ada@example\.com>/);
	});
});
