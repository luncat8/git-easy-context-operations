/**
 * Opens extracted file uris in plain, editable editors.
 *
 * The Source Control view's own "Open File" hands the user a diff view (and
 * that diff is read-only by default); this is the "edit the source itself"
 * half of the same menu: every file lands in a regular text editor tab,
 * ready to type in.
 */
import * as vscode from 'vscode';
import type { FileUriLike } from '../core/scmFileArgs';

/**
 * Open every uri in its own editable editor tab - never a preview tab, so
 * the file stays pinned like one the user opened by hand.
 *
 * A file that cannot be opened (deleted between the menu opening and the
 * click, a directory, an unsupported scheme) is reported through the output
 * channel: the command never fails because of one bad row, and the rest of
 * a multi-select still opens.
 */
export async function openFilesForEdit(uris: readonly FileUriLike[], output: vscode.OutputChannel): Promise<void> {
	for (const uri of uris) {
		try {
			// Extractors can return a plain {scheme, fsPath} for a file: string;
			// openTextDocument needs an actual Uri, not just its structural shape.
			const target: vscode.Uri | undefined = uri.scheme === 'file'
				? vscode.Uri.file(uri.fsPath)
				: typeof (uri as { with?: unknown }).with === 'function' ? uri as vscode.Uri : undefined;
			if (!target) {
				throw new Error(`unsupported URI scheme: ${uri.scheme}`);
			}
			const document = await vscode.workspace.openTextDocument(target);
			await vscode.window.showTextDocument(document, {
				preview: false,
				viewColumn: vscode.ViewColumn.Active,
			});
		} catch (error) {
			output.appendLine(
				`could not open ${uri.fsPath} for edit: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}
