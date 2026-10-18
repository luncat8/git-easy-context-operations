/**
 * A commit message has to be read exactly as it is stored.
 *
 * Git's `%s` (subject) folds the first paragraph of a message into a single
 * line and `%b` (body) is empty for a message without a blank line - so a
 * message rebuilt from those two turns "123\n456" into "123 456" and only
 * survives a paragraph break ("123\n\n456"). The raw message (`%B`) is the
 * only source that can hold every line break the user wrote.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseCommits, splitCommitMessage } from '../../core/git';
import { createTempRepo, type TempRepo } from '../helpers/tempRepo';

let repo: TempRepo;

beforeEach(async () => {
	repo = await createTempRepo();
});

afterEach(() => {
	repo.cleanup();
});

/** A commit whose message is stored byte for byte (git's own cleanup would strip empty lines). */
async function commitVerbatim(message: string): Promise<string> {
	repo.write('a.txt', 'a\n');
	await repo.gitOk(['add', '-A']);
	await repo.gitOk(['commit', '--quiet', '--allow-empty', '--cleanup=verbatim', '-F', '-'], { input: message });
	return repo.gitOk(['rev-parse', 'HEAD']);
}

describe('commit messages are read byte for byte', () => {
	test('a single line break between subject and body survives', async () => {
		const sha = await repo.commit('123\n456', { 'a.txt': 'a\n' });

		const info = await repo.api.commitInfo(sha);
		assert.equal(info.message, '123\n456', 'the line break is a line break, not a space');
		assert.equal(info.subject, '123 456', 'git still folds the subject for display');
		assert.equal(info.body, '', 'and there is no body without a blank line');
	});

	test('a paragraph break survives as well', async () => {
		const sha = await repo.commit('123\n\n456', { 'a.txt': 'a\n' });

		const info = await repo.api.commitInfo(sha);
		assert.equal(info.message, '123\n\n456');
		assert.equal(info.subject, '123');
		assert.equal(info.body, '456');
	});

	test('indentation, blank lines and trailing text survive', async () => {
		const message = 'Subject\n\nFirst paragraph.\n  - indented item\n\nLast paragraph.';
		const sha = await repo.commit(message, { 'a.txt': 'a\n' });

		const info = await repo.api.commitInfo(sha);
		assert.equal(info.message, message);
	});

	test('a message that is only a body (no subject line) survives', async () => {
		const sha = await commitVerbatim('\njust a body\n');

		const info = await repo.api.commitInfo(sha);
		assert.equal(info.message, '\njust a body');
	});

	test('every commit of a list is read the same way', async () => {
		await repo.commit('first\nbody', { 'a.txt': 'a\n' });
		await repo.commit('second\n\nbody', { 'b.txt': 'b\n' });

		const commits = await repo.api.commits({ ref: 'HEAD' });
		assert.deepEqual(commits.map((commit) => commit.message), ['second\n\nbody', 'first\nbody']);
	});

	test('a separator character inside the message does not break the parsing', async () => {
		const sha = await repo.commit('odd\x1fmessage', { 'a.txt': 'a\n' });

		const info = await repo.api.commitInfo(sha);
		assert.equal(info.message, 'odd\x1fmessage');
	});

	test('parseCommits reads the raw message out of a log record', () => {
		const record = [
			'a'.repeat(40), 'a'.repeat(7), '', 'b'.repeat(40),
			'Test User', 'test@example.com', '2026-01-01T00:00:00+00:00',
			'Test User', 'test@example.com', '2026-01-01T00:00:00+00:00',
			'123\n456',
		].join('\x1f');

		const commits = parseCommits(`${record}\x1e\n`);
		assert.equal(commits.length, 1);
		assert.equal(commits[0]!.message, '123\n456');
		assert.equal(commits[0]!.subject, '123 456');
		assert.equal(commits[0]!.body, '');
	});
});

describe('the subject and the body follow git\'s own rules', () => {
	test('the subject is the first paragraph, folded into one line', () => {
		assert.deepEqual(splitCommitMessage('123\n456'), { subject: '123 456', body: '' });
		assert.deepEqual(splitCommitMessage('123\n\n456'), { subject: '123', body: '456' });
		assert.deepEqual(splitCommitMessage('a\nb\nc\n\nd'), { subject: 'a b c', body: 'd' });
		assert.deepEqual(splitCommitMessage('only'), { subject: 'only', body: '' });
		assert.deepEqual(splitCommitMessage(''), { subject: '', body: '' });
	});

	test('the body is everything after the first empty line', () => {
		assert.deepEqual(splitCommitMessage('subject\n\nbody\n\nmore'), { subject: 'subject', body: 'body\n\nmore' });
		assert.deepEqual(splitCommitMessage('\nbody only'), { subject: '', body: 'body only' });
	});
});
