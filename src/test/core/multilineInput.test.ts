import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { decodeMultilineInput, encodeMultilineInput } from '../../core/ui';

describe('multiline input encoding', () => {
	it('round-trips paragraphs, indentation, CRLF, trailing newlines and literal escapes', () => {
		for (const message of ['', 'subject', 'subject\n\nbody\n  - item\n', 'subject\r\n\r\nbody', String.raw`literal \n, \r, \\ and C:\repo\file`]) {
			const encoded = encodeMultilineInput(message);
			assert.doesNotMatch(encoded, /[\r\n]/);
			assert.equal(decodeMultilineInput(encoded), message);
		}
	});

	it('decodes edited newline escapes without interpreting other backslash sequences', () => {
		assert.equal(decodeMultilineInput(String.raw`subject\n\nnew body`), 'subject\n\nnew body');
		assert.equal(decodeMultilineInput(String.raw`literal \\n and \t`), String.raw`literal \n and \t`);
	});
});
