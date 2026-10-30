/**
 * Turns whatever the Source Control view handed us into file uris to open.
 *
 * The `scm/resourceState/context` menu (the context menu of a changed-file
 * row) passes the git extension's resource object - the same shape the
 * built-in "Open File" / "Open HEAD File" commands receive:
 *
 *   - one row clicked: the `Resource` (`{resourceUri, type, ...}`);
 *   - several rows selected (Ctrl/Shift-click): an array of them;
 *   - called from the Command Palette: nothing at all.
 *
 * What this module extracts:
 *
 *   - `resourceUri` first (the working-tree file - for a rename that is the
 *     *new* path), then `uri`, then `sourceUri`, then a `file:` string;
 *   - resources whose file is gone from the working tree are skipped:
 *     `DELETED`, `DELETED_BY_US` and `BOTH_DELETED` are the statuses that
 *     mean "the file no longer exists on disk" (the internal git status
 *     enum of the git extension: DELETED = 6, DELETED_BY_US = 14,
 *     BOTH_DELETED = 17). `INDEX_DELETED` is deliberately *not* skipped -
 *     the file is still on disk there, so there is a source to edit.
 *
 * The returned values carry `fsPath` and `scheme`, which is all the VS Code
 * side needs to open them - and a `vscode.Uri` already is one.
 */
import { fileURLToPath } from 'node:url';

/** A filesystem path with its uri scheme - structurally what `vscode.Uri` is. */
export interface FileUriLike {
	/** Absolute filesystem path. */
	readonly fsPath: string;
	/** Uri scheme; `'file'` for workspace files. */
	readonly scheme: string;
}

/** The properties of a Source Control resource row we read. */
export interface ScmResourceLike {
	readonly resourceUri?: FileUriLike | string;
	readonly uri?: FileUriLike | string;
	readonly sourceUri?: FileUriLike | string;
	/** The internal git status (see the status constants below). */
	readonly type?: number;
	readonly resourceState?: { readonly status?: number };
}

/**
 * The internal git status values (the git extension's `Status` enum) that
 * mean the working-tree file is gone - there is no source left to open.
 */
const GONE_FROM_DISK_STATUSES: readonly number[] = [6, 14, 17];

/** Reads one uri-ish property of a resource, as a `FileUriLike | undefined`. */
function readUri(value: unknown): FileUriLike | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.fsPath === 'string' && record.fsPath.trim()) {
		return record as unknown as FileUriLike;
	}
	return undefined;
}

/** The uri to open for one resource row, or `undefined` when there is none. */
function resourceFileUri(resource: ScmResourceLike): FileUriLike | undefined {
	const uri = readUri(resource.resourceUri) ?? readUri(resource.uri) ?? readUri(resource.sourceUri);
	if (uri) {
		return uri;
	}
	// A bare path string is not a uri; only a `file:` scheme makes it one.
	const asString = [resource.resourceUri, resource.uri, resource.sourceUri].find(
		(value): value is string => typeof value === 'string' && value.startsWith('file:'),
	);
	if (asString) {
		try {
			return { scheme: 'file', fsPath: fileURLToPath(asString) };
		} catch {
			// A `file:` string without a path (or with a host we cannot map)
			// is not a file we can open - skip the row like a deleted one.
			return undefined;
		}
	}
	return undefined;
}

/** Whether this resource's file still exists on disk (and can be edited). */
function isGoneFromDisk(resource: ScmResourceLike): boolean {
	const status = resource.type ?? resource.resourceState?.status;
	return status !== undefined && GONE_FROM_DISK_STATUSES.includes(status);
}

/**
 * The file uris the menu's arguments mean, in argument order, deduplicated.
 *
 * Empty when nothing usable was handed in - the caller decides what to say
 * about that (the VS Code side reports it, a test can assert on it).
 */
export function scmResourceFileUris(args: readonly unknown[]): FileUriLike[] {
	const seen = new Set<string>();
	const uris: FileUriLike[] = [];

	for (const arg of args) {
		// A multi-select hands over the selected rows as one array argument.
		const resources = Array.isArray(arg) ? arg : [arg];
		for (const raw of resources) {
			if (!raw || typeof raw !== 'object') {
				continue;
			}
			const resource = raw as ScmResourceLike;
			if (isGoneFromDisk(resource)) {
				continue;
			}
			const uri = resourceFileUri(resource);
			if (uri) {
				const key = `${uri.scheme}:${uri.fsPath}`;
				if (!seen.has(key)) {
					seen.add(key);
					uris.push(uri);
				}
			}
		}
	}

	return uris;
}
