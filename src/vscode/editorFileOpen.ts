/**
 * The editor-caption action: from a read-only Git history/diff document to the
 * current, editable working-tree file.
 *
 * VS Code passes the URI of the editor whose tab (or text area) was
 * right-clicked as the first argument of `editor/title/context` and
 * `editor/context`. A diff or multi-diff tab can occasionally pass only its
 * editor context object, so the active document and active tab input are kept
 * as a fallback. The pure URI resolver lives in `src/core/editorFileArgs.ts`.
 */
import * as vscode from 'vscode';
import { workingTreeFilesForEditor } from '../core/editorFileArgs';
import { reportWithoutWaiting } from '../core/ui';
import { openFilesForEdit, toVscodeUri } from './fileOpen';

/** The active tab input first: its modified side is the current file. */
export function activeEditorArguments(): unknown[] {
	const args: unknown[] = [];
	const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
	if (input) args.push(input);
	const documentUri = vscode.window.activeTextEditor?.document.uri;
	if (documentUri) args.push(documentUri);
	return args;
}

/** Show a warning without keeping the command (or graph progress) pending. */
function warn(message: string, output: vscode.OutputChannel): void {
	output.appendLine(message);
	reportWithoutWaiting(() => vscode.window.showWarningMessage(`Git Easy Ops: ${message}`));
}

/**
 * Open the first working-tree target that still exists on disk. A historical
 * file may have been deleted or renamed since the revision shown, and opening
 * a `file:` URI for a missing path can otherwise create an empty editor.
 */
export async function openCurrentVersionForEdit(
	args: readonly unknown[],
	output: vscode.OutputChannel,
): Promise<void> {
	const targets = workingTreeFilesForEditor(args, activeEditorArguments());
	if (!targets.length) {
		warn('right-click the tab of a Git history or diff editor to open its current working-tree version.', output);
		return;
	}

	for (const target of targets) {
		const uri = toVscodeUri(target);
		if (!uri) {
			output.appendLine(`could not turn ${target.fsPath} into an editable uri (scheme ${target.scheme})`);
			continue;
		}
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.type & vscode.FileType.Directory) {
				output.appendLine(`current working-tree target is a directory: ${target.fsPath}`);
				continue;
			}
		} catch (error) {
			output.appendLine(
				`current working-tree file is unavailable: ${target.fsPath}: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}
		await openFilesForEdit([uri], output);
		output.appendLine(`opened the current working-tree version: ${uri.toString()}`);
		return;
	}

	const name = targets[0]!.fsPath.split(/[\\/]/).pop() || targets[0]!.fsPath;
	warn(`the current working-tree version of ${name} no longer exists.`, output);
}
