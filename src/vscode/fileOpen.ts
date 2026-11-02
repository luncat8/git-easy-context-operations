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
 * Rebuild a real `vscode.Uri` from the structural values the pure argument
 * resolvers return. A `file:` target is always local; a remote target keeps
 * its authority and URI path, so a Remote-SSH path is never mistaken for a
 * path on the machine running the extension host UI.
 */
export function toVscodeUri(uri: FileUriLike): vscode.Uri | undefined {
	// Extractors can pass through an actual Uri (it has a `with` method).
	if (typeof (uri as { with?: unknown }).with === 'function') {
		return uri as vscode.Uri;
	}
	if (uri.scheme === 'file') {
		return uri.fsPath ? vscode.Uri.file(uri.fsPath) : undefined;
	}
	if (!uri.path) {
		return undefined;
	}
	return vscode.Uri.from({
		scheme: uri.scheme,
		authority: uri.authority,
		path: uri.path,
		query: uri.query,
		fragment: uri.fragment,
	});
}

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
			const target = toVscodeUri(uri);
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
