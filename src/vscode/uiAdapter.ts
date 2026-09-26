/** The real {@link UI}, implemented with the VS Code API. */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import type { AskOptions, ChooseOptions, ConfirmOptions, FilePickOptions, InputOptions, MessageKind, MultiPickChoice, PickOptions, QuickPickChoice, UI } from '../core/ui';

export class VsCodeUI implements UI {
	constructor(private readonly output: vscode.OutputChannel) {}

	async input(options: InputOptions): Promise<string | undefined> {
		return vscode.window.showInputBox({
			title: options.title,
			prompt: options.prompt,
			value: options.value ?? '',
			placeHolder: options.placeholder,
			ignoreFocusOut: true,
			validateInput: options.validate
				? (value) => {
					const problem = options.validate!(value);
					return problem ?? null;
				}
				: undefined,
		});
	}

	async pick<T>(items: readonly QuickPickChoice<T>[], options?: PickOptions): Promise<T | undefined> {
		const picked = await vscode.window.showQuickPick(
			items.map((item) => ({
				label: item.label,
				description: item.description,
				detail: item.detail,
				value: item.value,
			})),
			{
				title: options?.title,
				placeHolder: options?.placeholder,
				ignoreFocusOut: true,
				matchOnDescription: true,
				matchOnDetail: true,
			},
		);
		return picked?.value;
	}

	async pickMany<T>(items: readonly MultiPickChoice<T>[], options?: PickOptions): Promise<T[] | undefined> {
		const picked = await vscode.window.showQuickPick(
			items.map((item) => ({
				label: item.label,
				description: item.description,
				detail: item.detail,
				picked: item.picked === true,
				value: item.value,
			})),
			{
				title: options?.title,
				placeHolder: options?.placeholder,
				ignoreFocusOut: true,
				canPickMany: true,
				matchOnDescription: true,
				matchOnDetail: true,
			},
		);
		// Dismissing the picker yields `undefined`; unticking everything yields [].
		return picked?.map((item) => item.value);
	}

	async confirm(message: string, options?: ConfirmOptions): Promise<boolean> {
		const confirmLabel = options?.confirmLabel ?? 'OK';
		// A modal warning dialog is the only place VS Code lets an extension
		// stop the user before something irreversible happens.
		const chosen = await vscode.window.showWarningMessage(message, { modal: true, detail: options?.detail }, confirmLabel);
		return chosen === confirmLabel;
	}

	/**
	 * A modal dialog with several buttons - the shape the fast-forward flow
	 * wants: cancel, clean up redundant refs, move only, or remove the old backup.
	 * Dismissing the dialog (Esc) resolves to `undefined`.
	 */
	async choose(message: string, options: ChooseOptions): Promise<string | undefined> {
		const picked = await vscode.window.showWarningMessage(
			message,
			{ modal: true, detail: options.detail },
			...options.choices.map((choice) => choice.label),
		);
		return options.choices.find((choice) => choice.label === picked)?.value;
	}

	async ask(message: string, options: AskOptions): Promise<string | undefined> {
		if (options.actions.length === 0) {
			await vscode.window.showInformationMessage(message, { modal: false, detail: options.detail });
			return undefined;
		}
		return vscode.window.showInformationMessage(message, { modal: false, detail: options.detail }, ...options.actions);
	}

	async message(kind: MessageKind, message: string, detail?: string): Promise<void> {
		this.log(detail ? `${message}\n${detail}` : message);
		if (kind === 'error') {
			await vscode.window.showErrorMessage(message, { modal: false, detail });
		} else if (kind === 'warn') {
			await vscode.window.showWarningMessage(message, { modal: false, detail });
		} else {
			await vscode.window.showInformationMessage(message, { modal: false, detail });
		}
	}

	log(message: string): void {
		const stamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
		for (const line of message.split('\n')) {
			this.output.appendLine(`[${stamp}] ${line}`);
		}
	}

	async withProgress<R>(title: string, task: (report: (message: string) => void) => Promise<R>): Promise<R> {
		return vscode.window.withProgress<R>(
			{ location: vscode.ProgressLocation.Notification, title: `Git Easy Ops: ${title}`, cancellable: false },
			(progress) => task((message) => progress.report({ message })),
		);
	}

	async copy(text: string): Promise<void> {
		await vscode.env.clipboard.writeText(text);
	}

	async pickFile(options: FilePickOptions): Promise<string | undefined> {
		const picked = await vscode.window.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			title: options.title,
			filters: options.filters,
			openLabel: 'Use Patch',
		});
		return picked?.[0]?.fsPath;
	}

	async openPath(target: string): Promise<void> {
		if (!target) {
			return;
		}
		const uri = vscode.Uri.file(target);
		let isDirectory = false;
		try {
			isDirectory = fs.statSync(target).isDirectory();
		} catch {
			isDirectory = false;
		}
		if (isDirectory) {
			// A worktree deserves its own window: it is a separate checkout.
			await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
		} else {
			await vscode.commands.executeCommand('vscode.open', uri);
		}
	}

	async showOutput(): Promise<void> {
		this.output.show(true);
	}
}
