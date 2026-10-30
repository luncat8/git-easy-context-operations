/** A commit-row fallback: the graph's file-row menu is not extension-contributable. */
import * as vscode from 'vscode';
import { resolveMenuArgs } from '../core/args';
import { availableCommitFiles } from '../core/commitFiles';
import type { Git } from '../core/git';
import { reportWithoutWaiting } from '../core/ui';
import { openFilesForEdit } from './fileOpen';

/** Graph context commands receive the source-control provider and history item. */
export function graphCommitTarget(args: readonly unknown[]): { sha?: string; repoPath?: string } {
	const resolved = resolveMenuArgs(args);
	return { sha: resolved.commitRefs[0], repoPath: resolved.repoPath };
}

/** Pick files touched by the commit and open their current working-tree versions. */
export async function openCommitFilesForEdit(git: Git, sha: string, output: vscode.OutputChannel): Promise<void> {
	const changes = await git.changedFiles(sha);
	const root = await git.repoRoot();
	const files = await availableCommitFiles(root, changes, async (file) => {
		try {
			return Boolean((await vscode.workspace.fs.stat(vscode.Uri.file(file))).type & vscode.FileType.File);
		} catch {
			return false;
		}
	});
	const items = files.map((file) => ({
		label: file.path,
		description: file.oldPath ? `renamed from ${file.oldPath}` : undefined,
		uri: vscode.Uri.file(file.absolutePath),
	}));
	if (!items.length) {
		reportWithoutWaiting(() => vscode.window.showInformationMessage('Git Easy Ops: no changed files from this commit exist in the working tree.'));
		return;
	}
	const selected = await vscode.window.showQuickPick(items, {
		canPickMany: true,
		title: 'Open Changed Files for Edit',
		placeHolder: 'Select working-tree files to open (historical versions are not edited)',
	});
	if (selected?.length) {
		await openFilesForEdit(selected.map((item) => item.uri), output);
	}
}
