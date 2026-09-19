import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { applyMessageEdit, messageSubject, normalizeMessage, splitMessage } from '../../core/reword';
import { GecoError } from '../../core/errors';

describe('normalizeMessage', () => {
	test('trims trailing whitespace on every line', () => {
		assert.equal(normalizeMessage('v0.2   \n\nbody  \n'), 'v0.2\n\nbody');
	});

	test('drops surrounding blank lines', () => {
		assert.equal(normalizeMessage('\n\n\nhello\n\n\n'), 'hello');
	});

	test('normalises CRLF', () => {
		assert.equal(normalizeMessage('a\r\nb\r\n'), 'a\nb');
	});

	test('keeps inner blank lines (subject/body separator)', () => {
		assert.equal(normalizeMessage('subject\n\nbody line 1\nbody line 2\n'), 'subject\n\nbody line 1\nbody line 2');
	});

	test('empty input', () => {
		assert.equal(normalizeMessage(''), '');
	});
});

describe('splitMessage', () => {
	test('subject only', () => {
		assert.deepEqual(splitMessage('v0.2'), { subject: 'v0.2', body: '' });
	});

	test('subject and body', () => {
		assert.deepEqual(splitMessage('v0.2\n\nmore detail\n'), { subject: 'v0.2', body: 'more detail' });
	});

	test('body keeps its own blank lines', () => {
		assert.deepEqual(splitMessage('s\n\npara1\n\npara2'), { subject: 's', body: 'para1\n\npara2' });
	});

	test('messageSubject is the first line', () => {
		assert.equal(messageSubject('first\n\nsecond'), 'first');
	});
});

describe('applyMessageEdit - replace', () => {
	test('the headline case from the README: v0.2 -> v0.2 add new button', () => {
		assert.equal(
			applyMessageEdit('v0.2', { mode: 'replace', text: 'v0.2 add new button' }),
			'v0.2 add new button',
		);
	});

	test('keeps a multi-line replacement message', () => {
		assert.equal(
			applyMessageEdit('old', { mode: 'replace', text: 'subject\n\nbody\n' }),
			'subject\n\nbody',
		);
	});

	test('rejects an empty message', () => {
		assert.throws(
			() => applyMessageEdit('old', { mode: 'replace', text: '   \n  ' }),
			(err: unknown) => err instanceof GecoError && err.code === 'nothing-to-do',
		);
	});
});

describe('applyMessageEdit - append', () => {
	test('appends to the subject by default', () => {
		assert.equal(applyMessageEdit('v0.2', { mode: 'append', text: 'add new button' }), 'v0.2 add new button');
	});

	test('does not collapse an existing body', () => {
		assert.equal(
			applyMessageEdit('v0.2\n\nfixed the widget', { mode: 'append', text: 'add new button' }),
			'v0.2 add new button\n\nfixed the widget',
		);
	});

	test('collapses newlines in the appended text when editing the subject', () => {
		assert.equal(applyMessageEdit('v0.2', { mode: 'append', text: 'add\nnew button' }), 'v0.2 add new button');
		// inner spacing typed by the user is kept as-is
		assert.equal(applyMessageEdit('v0.2', { mode: 'append', text: 'a  b' }), 'v0.2 a  b');
	});

	test('subjectOnly=false appends a new paragraph instead', () => {
		assert.equal(
			applyMessageEdit('v0.2\n\nbody', { mode: 'append', text: 'extra note', subjectOnly: false }),
			'v0.2\n\nbody\n\nextra note',
		);
	});

	test('rejects empty text', () => {
		assert.throws(
			() => applyMessageEdit('v0.2', { mode: 'append', text: '  ' }),
			(err: unknown) => err instanceof GecoError && err.code === 'nothing-to-do',
		);
	});
});

describe('applyMessageEdit - prepend', () => {
	test('prepends to the subject', () => {
		assert.equal(applyMessageEdit('add new button', { mode: 'prepend', text: 'v0.2' }), 'v0.2 add new button');
	});

	test('subjectOnly=false prepends a paragraph', () => {
		assert.equal(
			applyMessageEdit('body only', { mode: 'prepend', text: 'RELEASE', subjectOnly: false }),
			'RELEASE\n\nbody only',
		);
	});
});

describe('applyMessageEdit - findReplace', () => {
	test('replaces every occurrence in the subject', () => {
		assert.equal(
			applyMessageEdit('v0.2 and v0.2 again', { mode: 'findReplace', find: 'v0.2', text: 'v0.2 add new button' }),
			'v0.2 add new button and v0.2 add new button again',
		);
	});

	test('leaves the body alone in subject mode', () => {
		assert.equal(
			applyMessageEdit('v0.2\n\nmentions v0.2 in the body', { mode: 'findReplace', find: 'v0.2', text: 'v0.3' }),
			'v0.3\n\nmentions v0.2 in the body',
		);
	});

	test('whole message mode replaces in the body too', () => {
		assert.equal(
			applyMessageEdit('v0.2\n\nmentions v0.2 in the body', { mode: 'findReplace', find: 'v0.2', text: 'v0.3', subjectOnly: false }),
			'v0.3\n\nmentions v0.3 in the body',
		);
	});

	test('errors when the search text is missing', () => {
		assert.throws(
			() => applyMessageEdit('v0.2', { mode: 'findReplace', find: 'v9.9', text: 'x' }),
			(err: unknown) => err instanceof GecoError && err.code === 'nothing-to-do',
		);
	});

	test('errors when no search text is given', () => {
		assert.throws(
			() => applyMessageEdit('v0.2', { mode: 'findReplace', text: 'x' }),
			(err: unknown) => err instanceof GecoError && err.code === 'unsupported',
		);
	});

	test('can delete text', () => {
		assert.equal(
			applyMessageEdit('v0.2 WIP add new button', { mode: 'findReplace', find: 'WIP ', text: '' }),
			'v0.2 add new button',
		);
	});
});

describe('applyMessageEdit - awkward input', () => {
	test('unicode, quotes and shell metacharacters survive untouched', () => {
		const nasty = 'v0.2 🚀 "quoted" `backtick` $(cmd) ; rm -rf / && echo pwned';
		assert.equal(applyMessageEdit('v0.2', { mode: 'replace', text: nasty }), nasty);
	});

	test('a message that is only whitespace cannot be appended to', () => {
		assert.throws(
			() => applyMessageEdit('   ', { mode: 'append', text: '' }),
			(err: unknown) => err instanceof GecoError,
		);
	});

	test('unknown mode is rejected', () => {
		assert.throws(
			() => applyMessageEdit('v0.2', { mode: 'nonsense' as never, text: 'x' }),
			(err: unknown) => err instanceof GecoError && err.code === 'unsupported',
		);
	});
});
