/**
 * The changed-file menu of the built-in Source Control view hands over the
 * git extension's resource objects - one, several, or nothing at all (the
 * Command Palette). The extraction has to find the file to open in every
 * shape, skip the rows whose file is gone from disk, and never hand the
 * editor a path it cannot use.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { scmResourceFileUris, type FileUriLike } from '../../core/scmFileArgs';

/** The internal git status values of the git extension's `Status` enum. */
const Status = {
	INDEX_MODIFIED: 0,
	INDEX_ADDED: 1,
	INDEX_DELETED: 2,
	INDEX_RENAMED: 3,
	MODIFIED: 5,
	DELETED: 6,
	UNTRACKED: 7,
	DELETED_BY_US: 14,
	BOTH_DELETED: 17,
	BOTH_MODIFIED: 18,
} as const;

const uri = (fsPath: string, scheme = 'file'): FileUriLike => ({ fsPath, scheme });

describe('scmFileArgs - extraction', () => {
	it('reads the resource uri of one clicked row', () => {
		const result = scmResourceFileUris([{ resourceUri: uri('/repo/app.ts'), type: Status.MODIFIED }]);
		assert.deepEqual(result, [uri('/repo/app.ts')]);
	});

	it('falls back to uri and sourceUri', () => {
		assert.deepEqual(scmResourceFileUris([{ uri: uri('/repo/a.ts') }]), [uri('/repo/a.ts')]);
		assert.deepEqual(scmResourceFileUris([{ sourceUri: uri('/repo/b.ts') }]), [uri('/repo/b.ts')]);
	});

	it('accepts a bare file:// string and a filesystem path string', () => {
		assert.deepEqual(
			scmResourceFileUris([{ resourceUri: 'file:///repo/c.ts' }]),
			[{ scheme: 'file', fsPath: '/repo/c.ts' }],
		);
		assert.deepEqual(
			scmResourceFileUris([{ resourceUri: { fsPath: '/repo/d.ts', scheme: 'file' } }]),
			[uri('/repo/d.ts')],
		);
	});

	it('keeps the new path of a renamed resource (its resourceUri)', () => {
		const result = scmResourceFileUris([
			{ resourceUri: uri('/repo/new-name.ts'), originalUri: uri('/repo/old-name.ts'), type: Status.INDEX_RENAMED },
		]);
		assert.deepEqual(result, [uri('/repo/new-name.ts')]);
	});
});

describe('scmFileArgs - multi-select', () => {
	it('opens every selected row, in selection order', () => {
		const result = scmResourceFileUris([
			[
				{ resourceUri: uri('/repo/a.ts'), type: Status.MODIFIED },
				{ resourceUri: uri('/repo/b.ts'), type: Status.UNTRACKED },
			],
		]);
		assert.deepEqual(result, [uri('/repo/a.ts'), uri('/repo/b.ts')]);
	});

	it('deduplicates rows that point at the same file', () => {
		const result = scmResourceFileUris([
			{ resourceUri: uri('/repo/a.ts'), type: Status.MODIFIED },
			{ resourceUri: uri('/repo/a.ts'), type: Status.UNTRACKED },
		]);
		assert.deepEqual(result, [uri('/repo/a.ts')]);
	});
});

describe('scmFileArgs - deleted rows', () => {
	it('skips the statuses whose file is gone from the working tree', () => {
		const gone = [Status.DELETED, Status.DELETED_BY_US, Status.BOTH_DELETED];
		for (const status of gone) {
			const result = scmResourceFileUris([{ resourceUri: uri('/repo/gone.ts'), type: status }]);
			assert.deepEqual(result, [], `status ${status} must be skipped`);
		}
	});

	it('also reads the status off resourceState', () => {
		const result = scmResourceFileUris([{ resourceUri: uri('/repo/gone.ts'), resourceState: { status: Status.DELETED } }]);
		assert.deepEqual(result, []);
	});

	it('keeps index-deleted rows - the file is still on disk', () => {
		const result = scmResourceFileUris([{ resourceUri: uri('/repo/index-deleted.ts'), type: Status.INDEX_DELETED }]);
		assert.deepEqual(result, [uri('/repo/index-deleted.ts')]);
	});

	it('keeps rows with a status it does not know', () => {
		const result = scmResourceFileUris([{ resourceUri: uri('/repo/weird.ts'), type: 4242 }]);
		assert.deepEqual(result, [uri('/repo/weird.ts')]);
	});
});

describe('scmFileArgs - nothing usable', () => {
	it('returns nothing for the Command Palette and for broken arguments', () => {
		assert.deepEqual(scmResourceFileUris([]), []);
		assert.deepEqual(scmResourceFileUris([undefined]), []);
		assert.deepEqual(scmResourceFileUris([null]), []);
		assert.deepEqual(scmResourceFileUris([{ type: Status.MODIFIED }]), [], 'no uri at all');
		assert.deepEqual(scmResourceFileUris([{ resourceUri: uri('/repo/x.ts'), type: Status.DELETED }]), [], 'the only row is deleted');
	});
});
