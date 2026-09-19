/**
 * Finds *which* repository an operation should run in.
 *
 * VS Code's own git extension is a hard dependency of this one, so its API is
 * already active when we are. It tells us about open repositories; the active
 * editor and the workspace folders decide which one the user means. With more
 * than one repository open and no way to tell them apart, the user is asked.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';

export interface GitRepositoryLike {
	rootUri: vscode.Uri;
}

export interface GitApiLike {
	readonly repositories: readonly GitRepositoryLike[];
	onDidOpenRepository?: vscode.Event<GitRepositoryLike>;
	onDidCloseRepository?: vscode.Event<GitRepositoryLike>;
}

/** Loads the `vscode.git` API (version 1) without importing its typings. */
export function loadGitApi(): GitApiLike | undefined {
	const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApiLike }>('vscode.git');
	if (!extension) {
		return undefined;
	}
	try {
		return extension.exports?.getAPI(1);
	} catch {
		return undefined;
	}
}

export function repositoryPaths(api: GitApiLike | undefined): string[] {
	return (api?.repositories ?? []).map((repo) => repo.rootUri.fsPath).filter((p, index, all) => p && all.indexOf(p) === index);
}

/**
 * The repository a command should act on:
 *   1. a path the menu argument carried (our tree node, a graph provider, ...);
 *   2. the repository that contains the active editor's file;
 *   3. the repository of the first workspace folder;
 *   4. the only open repository;
 *   5. a QuickPick when several are open;
 *   6. `undefined` - no repository at all.
 */
export async function resolveRepoPath(api: GitApiLike | undefined, args: readonly unknown[] = [], hint?: string): Promise<string | undefined> {
	const known = repositoryPaths(api);
	const fromArgs = repoPathFromArgs(args) ?? hint;

	if (fromArgs) {
		const normalized = path.resolve(fromArgs);
		if (known.length === 0 || known.some((repo) => isInside(repo, normalized))) {
			return normalized;
		}
		// The menu said one repository, VS Code knows others: trust the menu.
		return normalized;
	}

	const activeFile = vscode.window.activeTextEditor?.document.uri;
	if (activeFile && activeFile.scheme === 'file') {
		const file = activeFile.fsPath;
		const containing = known.find((repo) => isInside(repo, file));
		if (containing) {
			return containing;
		}
	}

	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		if (folder.uri.scheme !== 'file') {
			continue;
		}
		const containing = known.find((repo) => isInside(folder.uri.fsPath, repo) || isInside(repo, folder.uri.fsPath));
		if (containing) {
			return containing;
		}
	}

	if (known.length === 1) {
		return known[0];
	}
	if (known.length === 0) {
		// No repository is registered yet (or the git extension is still working):
		// fall back to the workspace folder and let git itself complain.
		const folder = vscode.workspace.workspaceFolders?.[0];
		return folder && folder.uri.scheme === 'file' ? folder.uri.fsPath : undefined;
	}

	const picked = await vscode.window.showQuickPick(
		known.map((repo) => ({ label: path.basename(repo), description: repo, value: repo })),
		{ title: 'Git Easy Ops', placeHolder: 'Which repository should this run in?', ignoreFocusOut: true },
	);
	return picked?.value;
}

function repoPathFromArgs(args: readonly unknown[]): string | undefined {
	const seen = new Set<object>();
	const visit = (value: unknown, depth: number): string | undefined => {
		if (!value || typeof value !== 'object' || depth > 5 || seen.has(value as object)) {
			return undefined;
		}
		seen.add(value as object);
		if (Array.isArray(value)) {
			for (const item of value) {
				const found = visit(item, depth + 1);
				if (found) {
					return found;
				}
			}
			return undefined;
		}
		const record = value as Record<string, unknown>;
		for (const key of ['repoPath', 'repositoryRoot', 'rootPath', 'fsPath', 'path']) {
			const candidate = record[key];
			if (typeof candidate === 'string' && candidate.trim() && (path.isAbsolute(candidate) || key === 'fsPath' || key === 'path')) {
				if (key === 'path' && typeof candidate === 'string' && !path.isAbsolute(candidate)) {
					continue;
				}
				return candidate;
			}
		}
		for (const key of ['rootUri', 'repositoryUri', 'repoUri', 'uri', 'resourceUri', 'node']) {
			const candidate = record[key];
			if (candidate && typeof candidate === 'object') {
				const fsPath = (candidate as { fsPath?: unknown }).fsPath;
				if (typeof fsPath === 'string' && fsPath.trim()) {
					return fsPath;
				}
				const nested = visit(candidate, depth + 1);
				if (nested) {
					return nested;
				}
			}
		}
		return undefined;
	};

	for (const arg of args) {
		const found = visit(arg, 0);
		if (found) {
			return found;
		}
	}
	return undefined;
}

function isInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
