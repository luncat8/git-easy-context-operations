/**
 * The UI contract the controller programs against.
 *
 * `src/vscode/uiAdapter.ts` implements it with the real VS Code API, the tests
 * implement it with a scriptable fake - which is what makes the interactive
 * flows (pickers, confirmations, follow-up actions) testable without VS Code.
 */

export interface QuickPickChoice<T> {
	label: string;
	description?: string;
	detail?: string;
	value: T;
}

export interface InputOptions {
	title?: string;
	prompt: string;
	value?: string;
	placeholder?: string;
	validate?(value: string): string | undefined | null;
}

export interface PickOptions {
	title?: string;
	placeholder?: string;
}

/** A choice in a multi-select picker; `picked` is its initial checkbox state. */
export interface MultiPickChoice<T> extends QuickPickChoice<T> {
	picked?: boolean;
}

export interface ConfirmOptions {
	detail?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	/** Rendered as a destructive (red) action where the UI supports it. */
	destructive?: boolean;
}

/** One button of a {@link UI.choose} dialog. */
export interface Choice {
	/** The button label. */
	label: string;
	/** What picking the button resolves to. */
	value: string;
	/** The answer a UI uses when the choice is unscripted: the safe default action. */
	primary?: boolean;
}

export interface ChooseOptions {
	/** Optional second line, shown under the message. */
	detail?: string;
	/** The dialog buttons, left to right. */
	choices: readonly Choice[];
}

export interface AskOptions {
	detail?: string;
	actions: readonly string[];
}

export type MessageKind = 'info' | 'warn' | 'error';

export interface FilePickOptions {
	title?: string;
	filters?: Record<string, string[]>;
}

export interface UI {
	/** Free text; `undefined` means the user cancelled. */
	input(options: InputOptions): Promise<string | undefined>;
	/** One of the given choices; `undefined` means the user cancelled. */
	pick<T>(items: readonly QuickPickChoice<T>[], options?: PickOptions): Promise<T | undefined>;
	/**
	 * Optional: several of the given choices (checkboxes). `undefined` means the
	 * user cancelled, `[]` that everything was unticked. A UI without it makes
	 * the caller fall back to "all of them".
	 */
	pickMany?<T>(items: readonly MultiPickChoice<T>[], options?: PickOptions): Promise<T[] | undefined>;
	/** Yes/no. `false` on cancel and when the dialog is dismissed. */
	confirm(message: string, options?: ConfirmOptions): Promise<boolean>;
	/**
	 * Optional: a modal dialog with several buttons. Resolves to the picked
	 * choice's `value`, or `undefined` when the dialog is dismissed. A UI
	 * without it makes the caller fall back to a plain confirm.
	 */
	choose?(message: string, options: ChooseOptions): Promise<string | undefined>;
	/**
	 * A message with optional action buttons; resolves to the chosen action.
	 * Without any action it is a plain report: it must not wait for the
	 * notification to be dismissed either.
	 */
	ask(message: string, options: AskOptions): Promise<string | undefined>;
	/**
	 * Show a message. The promise must resolve as soon as the message has been
	 * handed to the UI - *not* when the user dismisses it (see
	 * {@link reportWithoutWaiting}, which is what the VS Code adapter uses).
	 */
	message(kind: MessageKind, message: string, detail?: string): Promise<void>;
	log(message: string): void;
	withProgress<R>(title: string, task: (report: (message: string) => void) => Promise<R>): Promise<R>;
	copy(text: string): Promise<void>;
	/** Optional: open a file dialog and return the chosen path. */
	pickFile?(options: FilePickOptions): Promise<string | undefined>;
	/** Optional: reveal a path (e.g. a worktree) in the editor/explorer. */
	openPath?(path: string): Promise<void>;
	/** Optional: reveal the extension's output channel. */
	showOutput?(): Promise<void>;
}

/**
 * Hand a message to the UI and return at once.
 *
 * This is the one rule the adapter has to follow for {@link UI.message}:
 * *never await a notification*.
 *
 * `showInformationMessage` / `showWarningMessage` / `showErrorMessage` resolve
 * **when the notification goes away**, not when it is shown. VS Code keeps a
 * non-modal toast on screen for 10 s (info), 12 s (warning) or 15 s (error),
 * and never hides it while the mouse hovers it or while the window is
 * unfocused - so the promise can stay pending for minutes. Everything that
 * waits for it stays pending too:
 *
 *  - the *command* only finishes then (it is listed as running the whole time);
 *  - an action started from the built-in **Source Control Graph** runs under a
 *    progress indicator that lasts exactly as long as the command's promise -
 *    VS Code wraps every action of that view in `withProgress` - which is how
 *    pressing **Copy Repository Web Link** in the graph caption left a spinner
 *    running in the graph long after the link was on the clipboard.
 *
 * A message is a report, not a question (`ask` is the question, and it is meant
 * to wait for an answer): show it and move on. Nothing is lost either way - the
 * same text goes to the output channel.
 *
 * A UI that cannot show the message (or throws while doing it) must never fail
 * the operation that already succeeded, so both paths are swallowed.
 */
export function reportWithoutWaiting(show: () => PromiseLike<unknown> | undefined | void): void {
	try {
		const shown = show();
		if (shown && typeof shown.then === 'function') {
			void Promise.resolve(shown).then(undefined, () => undefined);
		}
	} catch {
		// A message that cannot be shown is not worth failing a finished command.
	}
}

/** Follow-up action labels used across the flows. */
export const ACTIONS = {
	forcePush: 'Force Push',
	forcePushHard: 'Force Push (--force)',
	undo: 'Undo',
	showBackups: 'Show Backups',
	openWorktree: 'Open Worktree',
	retryWithForce: 'Move Anyway (keep old tip)',
	rewordNow: 'Rename Message',
	copySha: 'Copy SHA',
	applyPatch: 'Apply Patch at Proper Base',
	findBase: 'Show Candidate Bases',
	openLog: 'Show Details',
	checkout: 'Check Out',
	enableGraphMenu: 'How to Enable the Graph Menu',
	copyCommands: 'Copy Commands',
	dropRecoveryPoints: 'Drop Recovery Points',
	removeWorktrees: 'Remove Linked Worktrees',
} as const;

export type ActionLabel = typeof ACTIONS[keyof typeof ACTIONS];
