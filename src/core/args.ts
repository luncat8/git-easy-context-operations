/**
 * Turns whatever a menu handed us into a commit reference and a repository path.
 *
 * The same commands are reachable from several places and each one passes a
 * different shape:
 *
 *   - VS Code Source Control Graph (`scm/historyItem/context`):
 *     `(provider: {rootUri}, ...historyItems: [{id}])` where `id` is the full sha;
 *   - the Timeline view: a `TimelineItem` (`{id, uri, ...}`);
 *   - this extension's own tree view: `{gecoKind: 'commit', sha, repoPath}`;
 *   - GitLens / other extensions: `{sha}`, `{commit: {sha}}`, `{hash}` ...;
 *   - the command palette: nothing at all.
 *
 * So instead of depending on one API, we walk the arguments, pick up anything
 * that looks like a commit reference and anything that looks like a path. When
 * nothing is found the caller falls back to a picker.
 */

export interface ResolvedMenuArgs {
	/** Commit references in argument order (usually exactly one). */
	commitRefs: string[];
	/** Repository path, when the caller told us which repository it meant. */
	repoPath?: string;
	/** A branch name, for menus that are scoped to a ref rather than a commit. */
	branchRef?: string;
}

const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
const COMMIT_KEYS = ['id', 'sha', 'hash', 'commitId', 'commit', 'revision', 'objectId', 'commitHash'] as const;
const PATH_KEYS = ['repoPath', 'repositoryRoot', 'rootPath', 'cwd', 'fsPath', 'path'] as const;
const URI_KEYS = ['rootUri', 'repositoryUri', 'repoUri', 'uri', 'resourceUri'] as const;
const BRANCH_KEYS = ['branch', 'branchName', 'ref', 'refName', 'name'] as const;
const MAX_DEPTH = 6;
const MAX_VISITS = 200;

export function isShaLike(value: unknown): value is string {
	return typeof value === 'string' && SHA_PATTERN.test(value.trim());
}

export function looksLikeBranch(value: unknown): value is string {
	if (typeof value !== 'string') {
		return false;
	}
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 200 || /\s/.test(trimmed)) {
		return false;
	}
	if (SHA_PATTERN.test(trimmed)) {
		return false;
	}
	// Reject anything that is clearly not a ref name.
	return !/[~^:?*\[\]\\]/.test(trimmed) && !trimmed.startsWith('-') && !trimmed.includes('..');
}

export function resolveMenuArgs(args: readonly unknown[]): ResolvedMenuArgs {
	const commitRefs: string[] = [];
	const branchCandidates: string[] = [];
	let repoPath: string | undefined;
	const seen = new Set<object>();
	let visits = 0;

	const addCommit = (value: string) => {
		const trimmed = value.trim();
		if (!commitRefs.includes(trimmed)) {
			commitRefs.push(trimmed);
		}
	};

	const visit = (value: unknown, depth: number): void => {
		if (value === null || value === undefined || depth > MAX_DEPTH || visits++ > MAX_VISITS) {
			return;
		}
		if (typeof value === 'string') {
			const text = value.trim();
			if (isShaLike(value)) {
				addCommit(value);
			} else if (text.startsWith('refs/heads/')) {
				// A bare full branch ref is unambiguous - a bare short name is not
				// (it could be a commit-ish, a path, a label), so it is ignored.
				const branch = branchFromValue(text);
				if (branch && !branchCandidates.includes(branch)) {
					branchCandidates.push(branch);
				}
			}
			return;
		}
		if (typeof value !== 'object') {
			return;
		}
		if (seen.has(value as object)) {
			return;
		}
		seen.add(value as object);

		if (Array.isArray(value)) {
			for (const item of value) {
				visit(item, depth + 1);
			}
			return;
		}

		const record = value as Record<string, unknown>;

		for (const key of COMMIT_KEYS) {
			const candidate = record[key];
			if (typeof candidate === 'string' && isShaLike(candidate)) {
				addCommit(candidate);
			} else if (candidate && typeof candidate === 'object') {
				visit(candidate, depth + 1);
			}
		}

		if (!repoPath) {
			for (const key of PATH_KEYS) {
				const candidate = record[key];
				if (typeof candidate === 'string' && candidate.trim()) {
					repoPath = candidate;
					break;
				}
			}
		}
		if (!repoPath) {
			for (const key of URI_KEYS) {
				const candidate = record[key];
				if (candidate && typeof candidate === 'object') {
					const fsPath = (candidate as { fsPath?: unknown }).fsPath;
					if (typeof fsPath === 'string' && fsPath.trim()) {
						repoPath = fsPath;
						break;
					}
					const scheme = (candidate as { scheme?: unknown }).scheme;
					if (scheme === 'file') {
						const pathValue = (candidate as { path?: unknown }).path;
						if (typeof pathValue === 'string' && pathValue.trim()) {
							repoPath = pathValue;
							break;
						}
					}
				} else if (typeof candidate === 'string' && candidate.startsWith('file://')) {
					repoPath = decodeURIComponent(candidate.slice('file://'.length));
					break;
				}
			}
		}

		if (!branchCandidates.length) {
			for (const key of BRANCH_KEYS) {
				const candidate = branchFromValue(record[key]);
				if (candidate) {
					branchCandidates.push(candidate);
					break;
				}
			}
		}
		if (!branchCandidates.length) {
			// `id` is ambiguous: a provider id ('git'), a commit sha, or - in the
			// Source Control Graph - the ref name of a branch row.
			const fromId = branchFromId(record);
			if (fromId) {
				branchCandidates.push(fromId);
			}
		}

		// Nested objects worth a look (historyItem, commit, repository, ...).
		for (const key of ['historyItem', 'historyItemRef', 'commit', 'item', 'repository', 'provider', 'sourceControl', 'node']) {
			if (record[key] && typeof record[key] === 'object') {
				visit(record[key], depth + 1);
			}
		}
	};

	for (const arg of args) {
		visit(arg, 0);
	}

	return { commitRefs, repoPath, branchRef: branchCandidates[0] };
}

/**
 * A branch name from a menu argument. The Source Control Graph hands a ref row
 * over as `{id: 'refs/heads/main'}`, other callers use plain names - and a
 * commit row uses `id` for a sha, which must not be mistaken for a branch.
 */
export function branchFromValue(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	let name = value.trim();
	if (!name || name.includes('://')) {
		return undefined;
	}
	if (name.startsWith('refs/heads/')) {
		name = name.slice('refs/heads/'.length);
	} else if (name.startsWith('refs/')) {
		// Remote-tracking refs, tags and recovery refs are not local branches.
		return undefined;
	}
	if (isShaLike(name) || !looksLikeBranch(name)) {
		return undefined;
	}
	return name;
}

function branchFromId(record: Record<string, unknown>): string | undefined {
	const raw = record.id;
	if (typeof raw !== 'string') {
		return undefined;
	}
	const value = raw.trim();
	if (value.startsWith('refs/heads/')) {
		return branchFromValue(value);
	}
	// A plain name is only trusted when the object says it is a branch row.
	if (record.kind === 'branch' || record.type === 'branch' || record.refType === 'branch') {
		return branchFromValue(value);
	}
	return undefined;
}

/** Shape of this extension's own tree nodes (see `src/vscode/treeView.ts`). */
export interface GecoTreeNode {
	gecoKind: 'commit' | 'branch' | 'backup' | 'group';
	sha?: string;
	name?: string;
	repoPath: string;
}

export function isGecoTreeNode(value: unknown): value is GecoTreeNode {
	return !!value && typeof value === 'object' && 'gecoKind' in (value as Record<string, unknown>);
}
