/**
 * The Live Server companion of "Open Current Version for Edit".
 *
 * From a read-only Git history / diff editor in the caption, resolve the
 * current working-tree HTML file the same way `openCurrentVersionForEdit` does,
 * then hand that file to the separately installed Live Server extension so it
 * serves the page with live reload in the default browser.
 *
 * The Live Server extension (`ritwickdey.LiveServer`) registers the command
 * `extension.liveServer.goOnline`, whose handler takes the `Uri` of the file to
 * serve (`fileUri.fsPath`) and starts a server rooted at the containing
 * workspace. We pass a real `vscode.Uri` (a bare path string would make it fall
 * back to the active editor). If Live Server is not installed we offer to open
 * its marketplace page instead of failing silently.
 *
 * The .html / .htm gate is enforced here, not in the menu `when` clause:
 * a `git:` revision URI ends in `.html.git`, so a `resourceExtname == .html`
 * guard would never match it - the menu therefore shows on any revision and the
 * handler opens only the first existing HTML target it finds.
 */
import * as vscode from 'vscode';
import { workingTreeFilesForEditor } from '../core/editorFileArgs';
import { isHtmlFile } from '../core/htmlFile';
import { activeEditorArguments } from './editorFileOpen';
import { toVscodeUri } from './fileOpen';
import { reportWithoutWaiting } from '../core/ui';

/** The publisher.extension id of the Live Server extension we integrate with. */
export const LIVE_SERVER_EXTENSION_ID = 'ritwickdey.LiveServer';

/** The command Live Server registers to serve a specific file. */
export const LIVE_SERVER_OPEN_COMMAND = 'extension.liveServer.goOnline';

/** Show a warning without keeping the command (or graph progress) pending. */
function warn(message: string, output: vscode.OutputChannel): void {
	output.appendLine(message);
	reportWithoutWaiting(() => vscode.window.showWarningMessage(`Git Easy Ops: ${message}`));
}

/**
 * Return the Live Server extension if it is installed, otherwise ask the user
 * to install it and return `undefined`. Never throws on a missing extension.
 */
async function ensureLiveServer(output: vscode.OutputChannel): Promise<vscode.Extension<unknown> | undefined> {
	const extension = vscode.extensions.getExtension(LIVE_SERVER_EXTENSION_ID);
	if (extension) {
		return extension;
	}
	output.appendLine(`Live Server (${LIVE_SERVER_EXTENSION_ID}) is not installed`);
	const install: vscode.MessageItem = { title: 'Get Live Server' };
	const chosen = await vscode.window.showWarningMessage(
		'Git Easy Ops: "Open Current Version with Live Server" needs the Live Server extension (ritwickdey.LiveServer).',
		install,
	);
	if (chosen === install) {
		await vscode.env.openExternal(vscode.Uri.parse(`vscode:extension/${LIVE_SERVER_EXTENSION_ID}`));
	}
	return undefined;
}

/**
 * Open the first existing .html / .htm working-tree target with Live Server.
 * Resolves the same URIs `openCurrentVersionForEdit` does (a `git:` revision,
 * a remote Git URI, or the modified side of a diff), keeps only HTML files, and
 * skips targets that no longer exist on disk.
 */
export async function openCurrentVersionWithLiveServer(
	args: readonly unknown[],
	output: vscode.OutputChannel,
): Promise<void> {
	const targets = workingTreeFilesForEditor(args, activeEditorArguments());
	if (!targets.length) {
		warn(
			'right-click the tab of a Git history or diff editor to open its current working-tree version with Live Server.',
			output,
		);
		return;
	}

	for (const target of targets) {
		// Classify the resolved working-tree target directly (it already carries
		// a `fsPath`); this also strips a stray `.git` / `.diff` suffix and accepts
		// the extension-less `index` entry, so `index.html` and `index` both serve.
		if (!isHtmlFile(target)) {
			output.appendLine(`skipping ${target.fsPath} - Live Server serves .html/.htm files only`);
			continue;
		}
		const uri = toVscodeUri(target);
		if (!uri) {
			output.appendLine(`could not turn ${target.fsPath} into an editable uri (scheme ${target.scheme})`);
			continue;
		}
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.type & vscode.FileType.Directory) {
				output.appendLine(`current working-tree target is a directory: ${uri.fsPath}`);
				continue;
			}
		} catch (error) {
			output.appendLine(
				`current working-tree file is unavailable: ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`,
			);
			continue;
		}

		const extension = await ensureLiveServer(output);
		if (!extension) {
			return;
		}
		// Activation registers the `extension.liveServer.goOnline` command.
		await extension.activate();
		await vscode.commands.executeCommand(LIVE_SERVER_OPEN_COMMAND, uri);
		output.appendLine(`started Live Server for ${uri.fsPath}`);
		return;
	}

	const name = targets[0]!.fsPath.split(/[\\/]/).pop() || targets[0]!.fsPath;
	warn(`"Open Current Version with Live Server" serves .html/.htm files only; ${name} is not one.`, output);
}
