/** The real {@link UI}, implemented with the VS Code API. */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import type { AskOptions, ChooseOptions, ConfirmOptions, FilePickOptions, InputOptions, MessageKind, MultiPickChoice, PickOptions, QuickPickChoice, UI } from '../core/ui';
import { decodeMultilineInput, encodeMultilineInput, reportWithoutWaiting } from '../core/ui';

export class VsCodeUI implements UI {
	constructor(private readonly output: vscode.OutputChannel) {}

	async input(options: InputOptions): Promise<string | undefined> {
		const result = await vscode.window.showInputBox({
			title: options.title,
			prompt: options.multiline ? `${options.prompt} (\n = newline; \\ = literal backslash)` : options.prompt,
			value: options.multiline ? encodeMultilineInput(options.value ?? '') : options.value ?? '',
			placeHolder: options.placeholder,
			ignoreFocusOut: true,
			validateInput: options.validate
				? (value) => {
					const problem = options.validate!(options.multiline ? decodeMultilineInput(value) : value);
					return problem ?? null;
				}
				: undefined,
		});
		return result === undefined ? undefined : options.multiline ? decodeMultilineInput(result) : result;
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
		const accept: vscode.MessageItem = { title: confirmLabel };
		const cancel: vscode.MessageItem = { title: options?.cancelLabel ?? 'Cancel', isCloseAffordance: true };
		const chosen = await vscode.window.showWarningMessage(message, { modal: true, detail: options?.detail }, accept, cancel);
		return chosen === accept;
	}

	/** Affirmative actions first; the close affordance stays last and Esc cancels. */
	async choose(message: string, options: ChooseOptions): Promise<string | undefined> {
		// Put the declared primary action first so Enter uses it. VS Code owns
		// native platform layout; isCloseAffordance prevents an extra Cancel.
		const actions = options.choices.filter((choice) => choice.value !== 'cancel');
		const ordered = [...actions.filter((choice) => choice.primary), ...actions.filter((choice) => !choice.primary)];
		const buttons = ordered.map((choice) => ({ title: choice.label, value: choice.value }));
		const cancel = { title: options.choices.find((choice) => choice.value === 'cancel')?.label ?? 'Cancel', isCloseAffordance: true };
		const picked = await vscode.window.showWarningMessage<vscode.MessageItem>(
			message,
			{ modal: true, detail: options.detail },
			...buttons, cancel,
		);
		return buttons.find((button) => button === picked)?.value;
	}

	async ask(message: string, options: AskOptions): Promise<string | undefined> {
		if (options.actions.length === 0) {
			// No buttons means no answer to wait for - a report, not a
			// question, so it follows the rule of {@link reportWithoutWaiting}
			// even though the caller awaits it (flows whose follow-up list can
			// end up empty, e.g. a fast-forward with nothing to clean up).
			reportWithoutWaiting(() => vscode.window.showInformationMessage(message, { modal: false, detail: options.detail }));
			return undefined;
		}
		// The answer can only be handed over through this promise
		// (dismissing the notification resolves `undefined`, i.e. "no
		// follow-up action") - so a caller may only *await* it when it
		// genuinely needs the answer before it can go on. An
		// end-of-operation report (work done, buttons are optional
		// follow-ups such as Undo) must instead be handed to
		// `followUpWithoutWaiting`: awaiting it keeps the command pending
		// until the toast goes away, which the Source Control Graph draws
		// as an endless progress bar.
		return vscode.window.showInformationMessage(message, { modal: false, detail: options.detail }, ...options.actions);
	}

	/**
	 * Report a message. Logged first, then shown - and *not* awaited: VS Code
	 * resolves the promise of a non-modal notification when the notification
	 * goes away (10 s for an info message, 12 s for a warning, 15 s for an
	 * error, and never while the mouse hovers it or the window is unfocused).
	 * Awaiting it kept the whole command pending, and the Source Control Graph
	 * draws a progress indicator for exactly as long as a command of its
	 * caption is running - the "endless progress" after *Copy Repository Web
	 * Link*. See {@link reportWithoutWaiting}.
	 */
	async message(kind: MessageKind, message: string, detail?: string): Promise<void> {
		this.log(detail ? `${message}\n${detail}` : message);
		if (kind === 'error') {
			reportWithoutWaiting(() => vscode.window.showErrorMessage(message, { modal: false, detail }));
		} else if (kind === 'warn') {
			reportWithoutWaiting(() => vscode.window.showWarningMessage(message, { modal: false, detail }));
		} else {
			reportWithoutWaiting(() => vscode.window.showInformationMessage(message, { modal: false, detail }));
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
