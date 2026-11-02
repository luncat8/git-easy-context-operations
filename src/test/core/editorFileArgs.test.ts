/**
 * A read-only Git revision editor has to resolve back to the *current* file,
 * not to the commit shown in it. These are the URI shapes the built-in Git
 * extension, diff editors, remote workspaces and editor menus hand over.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
	workingTreeFileFromEditorUri,
	workingTreeFilesForEditor,
	type EditorUriLike,
} from '../../core/editorFileArgs';

const REPO = '/repo/app.ts';

function gitUri(options: {
	path?: string;
	fsPath?: string;
	query: string;
	authority?: string;
	scheme?: string;
}): EditorUriLike {
	return {
		scheme: options.scheme ?? 'git',
		...(options.authority ? { authority: options.authority } : {}),
		path: options.path ?? `${REPO}.git`,
		fsPath: options.fsPath ?? `${REPO}.git`,
		query: options.query,
	};
}

const gitJson = (ref: string, path = REPO) => JSON.stringify({ path, ref });
const fileUri = (fsPath = REPO): EditorUriLike => ({
	scheme: 'file',
	path: fsPath,
	fsPath,
	query: '',
	fragment: '',
});

const fileTarget = (fsPath: string) => ({ scheme: 'file', fsPath });

describe('editorFileArgs - a historical git: uri', () => {
	it('reads the working-tree path out of the Git extension JSON query', () => {
		assert.deepEqual(
			workingTreeFileFromEditorUri(gitUri({ query: gitJson('abc123') })),
			fileTarget(REPO),
		);
	});

	it('accepts an encoded JSON query and a URLSearchParams query', () => {
		const encoded = encodeURIComponent(gitJson('abc123'));
		assert.deepEqual(workingTreeFileFromEditorUri(gitUri({ query: encoded })), fileTarget(REPO));
		assert.deepEqual(
			workingTreeFileFromEditorUri(gitUri({ query: `path=${encodeURIComponent(REPO)}&ref=abc123` })),
			fileTarget(REPO),
		);
	});

	it('uses the URI path when there is only a ref query', () => {
		const uri: EditorUriLike = { scheme: 'git', path: REPO, fsPath: REPO, query: 'ref=HEAD~2' };
		assert.deepEqual(workingTreeFileFromEditorUri(uri), fileTarget(REPO));
	});

	it('strips the .git suffix when the query is missing', () => {
		const uri: EditorUriLike = { scheme: 'git', path: `${REPO}.git`, fsPath: `${REPO}.git`, query: '' };
		assert.deepEqual(workingTreeFileFromEditorUri(uri), fileTarget(REPO));
	});

	it('keeps Windows paths absolute and does not turn them into POSIX paths', () => {
		const windows = 'C:\\work\\repo\\app.ts';
		assert.deepEqual(
			workingTreeFileFromEditorUri(gitUri({
				path: '/C:/work/repo/app.ts.git',
				fsPath: '/C:/work/repo/app.ts.git',
				query: gitJson('abc123', windows),
			})),
			fileTarget(windows),
		);
	});
});

describe('editorFileArgs - diff and remote editors', () => {
	it('opens the editable file side of a diff as-is', () => {
		const target = workingTreeFileFromEditorUri(fileUri());
		assert.equal(target?.scheme, 'file');
		assert.equal(target?.fsPath, REPO);
	});

	it('keeps a remote authority and drops the revision query', () => {
		const target = workingTreeFileFromEditorUri(gitUri({
			scheme: 'vscode-remote',
			authority: 'ssh-remote+host',
			path: `${REPO}.git`,
			fsPath: `${REPO}.git`,
			query: gitJson('abc123'),
		}));
		assert.deepEqual(target, {
			scheme: 'vscode-remote',
			authority: 'ssh-remote+host',
			path: REPO,
			fsPath: REPO,
			query: '',
			fragment: '',
		});
	});

	it('maps a remote git: uri back to vscode-remote, not a local file', () => {
		const target = workingTreeFileFromEditorUri(gitUri({
			authority: 'ssh-remote+host',
			query: gitJson('abc123'),
		}));
		assert.equal(target?.scheme, 'vscode-remote');
		assert.equal(target?.authority, 'ssh-remote+host');
		assert.equal(target?.path, REPO);
	});
});

describe('editorFileArgs - menu arguments and fallbacks', () => {
	it('prefers the right-clicked tab uri over the active editor', () => {
		const clicked = gitUri({ query: gitJson('old') });
		const active = fileUri('/repo/other.ts');
		const result = workingTreeFilesForEditor(
			[clicked, { groupId: 1, editorIndex: 2 }],
			[active],
		);
		assert.deepEqual(result, [fileTarget(REPO)]);
	});

	it('uses the active tab input when only the editor context was passed', () => {
		const input = {
			modified: fileUri(),
			original: gitUri({ query: gitJson('old') }),
		};
		const result = workingTreeFilesForEditor([{ groupId: 1, editorIndex: 0 }], [input]);
		assert.deepEqual(result, [fileTarget(REPO)]);
	});

	it('puts the modified (current) path of a rename first', () => {
		const input = {
			modified: fileUri('/repo/new-name.ts'),
			original: gitUri({ query: gitJson('old', '/repo/old-name.ts') }),
		};
		const result = workingTreeFilesForEditor([], [input]);
		assert.deepEqual(result, [fileTarget('/repo/new-name.ts'), fileTarget('/repo/old-name.ts')]);
	});

	it('deduplicates two revisions of the same file', () => {
		const result = workingTreeFilesForEditor([
			[gitUri({ query: gitJson('one') }), gitUri({ query: gitJson('two') })],
		]);
		assert.deepEqual(result, [fileTarget(REPO)]);
	});

	it('reads a URI string and nested document objects', () => {
		const result = workingTreeFilesForEditor([{
			document: { uri: `git:${REPO}.git?${encodeURIComponent(gitJson('abc123'))}` },
		}]);
		assert.deepEqual(result, [fileTarget(REPO)]);
	});
});

describe('editorFileArgs - no working-tree file', () => {
	it('skips untitled, output and unrelated virtual editors', () => {
		for (const scheme of ['untitled', 'output', 'webview-panel']) {
			assert.equal(
				workingTreeFileFromEditorUri({ scheme, path: REPO, fsPath: REPO, query: '' }),
				undefined,
				`${scheme} must not produce a file target`,
			);
		}
	});

	it('returns nothing for a relative revision path or an editor context object', () => {
		assert.equal(
			workingTreeFileFromEditorUri({ scheme: 'git', path: 'app.ts', fsPath: 'app.ts', query: 'ref=abc' }),
			undefined,
		);
		assert.deepEqual(workingTreeFilesForEditor([{ groupId: 1, editorIndex: 0 }]), []);
	});
});
