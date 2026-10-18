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

/** Lossless representation of multiline text in VS Code's single-line input. */
export function encodeMultilineInput(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

export function decodeMultilineInput(value: string): string {
	return value.replace(/\\([\\rn])/g, (_, escaped: string) => escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : '\\');
}

export interface InputOptions {
	title?: string;
	prompt: string;
	value?: string;
	placeholder?: string;
	/** Preserve line breaks using editable \n escapes in single-line UIs. */
	multiline?: boolean;
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
	 * notification to be dismissed either. With actions, only a caller
	 * that needs the answer to continue may await it - an end-of-operation
	 * report whose buttons are optional follow-ups must go through
	 * {@link followUpWithoutWaiting} instead, or the command (and the
	 * Source Control Graph's progress indicator tied to it) stays pending
	 * until the notification goes away.
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

/**
 * Hand an end-of-operation report to the user *without waiting for its
 * answer*, and run `handle` if and when an action is picked.
 *
 * This is the follow-up sibling of {@link reportWithoutWaiting}, for the
 * reports that carry buttons ("Undo", "Open Worktree", ...). The rule is
 * the same, and it is stated here because it has regressed several times:
 * a report is not a step of the operation. The work is already done, the
 * journal entry is already written, and the branch that refreshes the
 * graphs has already been scheduled - nothing is gained by keeping the
 * *command* pending until the toast is dismissed, and much is lost: VS
 * Code resolves the notification promise only when it goes away (never
 * under Do Not Disturb, while hovered, or while the window is unfocused),
 * and an action started from the built-in Source Control Graph runs under
 * a progress indicator that lasts exactly as long as the command's
 * promise. Awaiting the report is therefore precisely the "endless
 * progress bar" - most recently reintroduced by Apply Patch Automatically,
 * whose result report waited for its *Undo* button.
 *
 * So: show it, attach the follow-up, and let the command finish. When the
 * user does click, `handle` runs then (the controller's change hook and
 * the repository watcher repaint the graphs for it, exactly as they do
 * for an Undo started from the Command Palette). A report that cannot be
 * shown, or a follow-up that fails, is logged through `onError` and never
 * turns into an unhandled rejection.
 */
export function followUpWithoutWaiting(
	shown: PromiseLike<string | undefined> | string | undefined,
	handle: (chosen: string | undefined) => Promise<void> | void,
	onError?: (error: unknown) => void,
): void {
	try {
		void Promise.resolve(shown as PromiseLike<string | undefined>)
			.then((chosen) => handle(chosen))
			.then(undefined, (error: unknown) => {
				try {
					onError?.(error);
				} catch {
					// Even reporting the failure must not escape.
				}
			});
	} catch (error) {
		try {
			onError?.(error);
		} catch {
			// See above.
		}
	}
}

/**
 * The warning every flow that rewrote history repeats, because the habit it
 * warns about is the natural one: after a reword, a squash, a forced move or a
 * cleaned history, the remote still holds the *old* commits, so a plain push is
 * rejected. VS Code's **Sync** button looks like the way out - but it runs
 * `git pull` first, and that pull merges (or rebases) the old remote history
 * back into the branch: the rewrite is undone, or the merge stops with a
 * conflict and leaves the repository half-finished. The way out is the force
 * push this extension offers right next to the report.
 */
export const SYNC_BUTTON_WARNING = 'Do not use VS Code\'s Sync button for this: it runs "git pull" first and merges the old remote history - including the commits this operation replaced - back into the branch, or stops half-way with a conflict. Use Force Push (with lease) instead.';

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
	diagnose: 'Diagnose Push / Sync Trouble',
	dropRecoveryPoints: 'Drop Recovery Points',
	removeWorktrees: 'Remove Linked Worktrees',
} as const;

export type ActionLabel = typeof ACTIONS[keyof typeof ACTIONS];
