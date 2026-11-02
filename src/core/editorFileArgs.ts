/**
 * Resolves the current, editable file behind a read-only Git revision editor.
 *
 * The built-in Git extension encodes a historical version as a `git:` URI
 * whose query carries the original working-tree path and the revision:
 *
 *   git:/repo/app.ts.git?{"path":"/repo/app.ts","ref":"<sha>"}
 *
 * Other history / diff editors use `?path=…&ref=…`, a `file:` URI for the
 * modified (right-hand) side of a diff, or a `vscode-remote:` URI in a remote
 * workspace. This module turns all of those into the URI that a plain editor
 * tab should open. It is deliberately free of `vscode` imports: the shapes
 * below are the structural parts of `vscode.Uri` and of the tab input objects.
 */
import { fileURLToPath } from 'node:url';
import type { FileUriLike } from './scmFileArgs';

/** The parts of `vscode.Uri` that identify a file without importing VS Code. */
export interface EditorUriLike {
	readonly scheme?: string;
	readonly authority?: string;
	readonly path?: string;
	readonly query?: string;
	readonly fragment?: string;
	readonly fsPath?: string;
}

type QueryParams = Record<string, unknown>;

/** Schemes whose very presence means "a historical, read-only revision". */
const REVISION_SCHEMES = new Set([
	'git',
	'git-index',
	'git-commit',
	'gitlens-git',
	'gitlens',
	'vscode-local-history',
]);

/** Non-revision schemes we can nevertheless open as an editable file. */
const FILE_SCHEMES = new Set(['file', 'vscode-remote']);

/** Schemes that can never be turned into a working-tree file. */
const SKIP_SCHEMES = new Set(['untitled', 'output', 'webview-panel', 'command']);

/** Query keys used by the Git extension and other history providers. */
const REVISION_QUERY_KEYS = ['ref', 'commit', 'sha', 'revision', 'commitHash', 'objectId'];
const PATH_QUERY_KEYS = ['path', 'file', 'resourcePath', 'workingPath', 'workingTreePath'];

/** Properties that may carry a URI, most-specific (current version) first. */
const URI_KEYS = [
	'modified',
	'modifiedUri',
	'uri',
	'resourceUri',
	'original',
	'originalUri',
	'input',
	'document',
	'resource',
	'left',
	'right',
];
const CONTAINER_KEYS = ['changes', 'items', 'resources', 'editors'];

const MAX_DEPTH = 6;
const MAX_URIS = 32;

/** Decode once or twice: Git JSON queries can arrive URI-encoded more than once. */
function decodeMaybe(value: string): string {
	let text = value;
	for (let i = 0; i < 2 && /%[0-9a-f]/i.test(text); i++) {
		try {
			const next = decodeURIComponent(text);
			if (next === text) break;
			text = next;
		} catch {
			break;
		}
	}
	return text;
}

/** Both `{"path":…,"ref":…}` and `path=…&ref=…` occur in the wild. */
function parseQuery(query?: string): QueryParams {
	if (!query) return {};
	const decoded = decodeMaybe(query).trim();
	if (decoded.startsWith('{')) {
		try {
			const parsed: unknown = JSON.parse(decoded);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as QueryParams;
			}
		} catch {
			// Fall through to the URLSearchParams form.
		}
	}
	const result: QueryParams = {};
	for (const [key, value] of new URLSearchParams(query)) {
		result[key] = value;
	}
	return result;
}

function hasRevisionMarker(params: QueryParams): boolean {
	return REVISION_QUERY_KEYS.some((key) => typeof params[key] === 'string' && String(params[key]).trim().length > 0);
}

function firstString(params: QueryParams, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = params[key];
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

/** `toGitUri(..., { replaceFileExtension: true })` appends `.git`/`.diff`. */
function stripRevisionSuffix(value: string | undefined): string | undefined {
	return value ? value.replace(/\.(?:git|diff)$/i, '') : undefined;
}

/** Absolute paths on POSIX, Windows and UNC, independent of the host OS. */
function looksAbsolute(value: string): boolean {
	return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value);
}

/** A filesystem path as a URI path (used only for remote authorities). */
function toUriPath(value: string): string {
	const slash = value.replace(/\\/g, '/');
	if (/^[A-Za-z]:\//.test(slash)) {
		return `/${slash}`;
	}
	return slash.startsWith('/') ? slash : `/${slash}`;
}

/** A `path` query value may itself be a `file:` URI instead of a bare path. */
function pathFromQueryValue(value: string | undefined): string | undefined {
	if (!value) return undefined;
	if (value.startsWith('file:')) {
		try {
			return fileURLToPath(value);
		} catch {
			return undefined;
		}
	}
	return value;
}

/** A plain file URI is already the editable working-tree document. */
function editableTarget(uri: EditorUriLike, scheme: string): FileUriLike | undefined {
	if (scheme === 'file') {
		const fsPath = uri.fsPath || uri.path;
		if (!fsPath || !looksAbsolute(fsPath)) return undefined;
		// Uri.file(fsPath) reconstructs the local URI; no remote parts needed.
		return { scheme: 'file', fsPath };
	}
	const path = uri.path || (uri.fsPath ? toUriPath(uri.fsPath) : undefined);
	if (!path) return undefined;
	return {
		scheme: 'vscode-remote',
		authority: uri.authority,
		path,
		fsPath: uri.fsPath || path,
		query: '',
		fragment: '',
	};
}

/** Strip the revision from a `git:`-style URI and keep its remote authority. */
function revisionTarget(uri: EditorUriLike, params: QueryParams, scheme: string): FileUriLike | undefined {
	if (SKIP_SCHEMES.has(scheme)) return undefined;
	const queryPath = stripRevisionSuffix(pathFromQueryValue(firstString(params, PATH_QUERY_KEYS)));
	const uriPath = stripRevisionSuffix(uri.fsPath || uri.path);
	const candidate = [queryPath, uriPath].find((value): value is string => Boolean(value && looksAbsolute(value)));
	if (!candidate) return undefined;

	if (uri.authority || scheme === 'vscode-remote') {
		const path = stripRevisionSuffix(uri.path) || toUriPath(candidate);
		return {
			scheme: 'vscode-remote',
			authority: uri.authority,
			path,
			fsPath: stripRevisionSuffix(uri.fsPath) || path,
			query: '',
			fragment: '',
		};
	}
	return { scheme: 'file', fsPath: candidate };
}

/** The working-tree target of one editor URI, or `undefined` when it has none. */
export function workingTreeFileFromEditorUri(uri: EditorUriLike): FileUriLike | undefined {
	const scheme = (uri.scheme ?? '').toLowerCase();
	if (!scheme || SKIP_SCHEMES.has(scheme)) return undefined;
	const params = parseQuery(uri.query);
	if (REVISION_SCHEMES.has(scheme) || hasRevisionMarker(params)) {
		return revisionTarget(uri, params, scheme);
	}
	return FILE_SCHEMES.has(scheme) ? editableTarget(uri, scheme) : undefined;
}

/** Parse a URI string the same way the extension host would hand it over. */
function uriFromString(value: string): EditorUriLike | undefined {
	const text = value.trim();
	if (!text) return undefined;
	try {
		const url = new URL(text);
		const path = decodeURIComponent(url.pathname);
		if (url.protocol === 'file:') {
			return {
				scheme: 'file',
				path,
				fsPath: fileURLToPath(text),
				query: url.search.slice(1),
				fragment: url.hash.slice(1),
			};
		}
		return {
			scheme: url.protocol.slice(0, -1),
			authority: url.host,
			path,
			fsPath: path,
			query: url.search.slice(1),
			fragment: url.hash.slice(1),
		};
	} catch {
		return undefined;
	}
}

/** Find URI-shaped values in menu arguments, tab inputs and documents. */
function collectUris(value: unknown, depth: number, found: EditorUriLike[]): void {
	if (value === null || value === undefined || depth > MAX_DEPTH || found.length >= MAX_URIS) return;
	if (typeof value === 'string') {
		const uri = uriFromString(value);
		if (uri) found.push(uri);
		return;
	}
	if (typeof value !== 'object') return;
	if (Array.isArray(value)) {
		for (const item of value) collectUris(item, depth + 1, found);
		return;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.scheme === 'string' && (typeof record.fsPath === 'string' || typeof record.path === 'string')) {
		found.push(record as unknown as EditorUriLike);
		return;
	}
	for (const key of URI_KEYS) {
		if (record[key] !== undefined) collectUris(record[key], depth + 1, found);
	}
	for (const key of CONTAINER_KEYS) {
		if (Array.isArray(record[key])) collectUris(record[key], depth + 1, found);
	}
}

function resolveAll(values: readonly unknown[]): FileUriLike[] {
	const found: EditorUriLike[] = [];
	for (const value of values) collectUris(value, 0, found);
	const result: FileUriLike[] = [];
	const seen = new Set<string>();
	for (const uri of found) {
		const target = workingTreeFileFromEditorUri(uri);
		if (!target) continue;
		const key = `${target.scheme}\0${target.authority ?? ''}\0${target.fsPath}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(target);
	}
	return result;
}

/**
 * Working-tree files meant by menu arguments, in preference order. Active
 * editor/tab arguments are only a fallback: a tab context menu passes the URI
 * of the tab that was right-clicked, which may not be the active one.
 */
export function workingTreeFilesForEditor(
	args: readonly unknown[],
	fallback: readonly unknown[] = [],
): FileUriLike[] {
	const fromArgs = resolveAll(args);
	return fromArgs.length ? fromArgs : resolveAll(fallback);
}
