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

export interface ConfirmOptions {
	detail?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	/** Rendered as a destructive (red) action where the UI supports it. */
	destructive?: boolean;
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
	/** Yes/no. `false` on cancel and when the dialog is dismissed. */
	confirm(message: string, options?: ConfirmOptions): Promise<boolean>;
	/** A message with optional action buttons; resolves to the chosen action. */
	ask(message: string, options: AskOptions): Promise<string | undefined>;
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

/** Follow-up action labels used across the flows. */
export const ACTIONS = {
	forcePush: 'Force Push',
	forcePushHard: 'Force Push (--force)',
	undo: 'Undo',
	showBackups: 'Show Backups',
	openWorktree: 'Open Worktree',
	retryWithForce: 'Move Anyway (keep old tip)',
	rewordNow: 'Reword Message',
	copySha: 'Copy SHA',
	applyPatch: 'Apply Patch at Proper Base',
	findBase: 'Show Candidate Bases',
	openLog: 'Show Details',
	checkout: 'Check Out',
	enableGraphMenu: 'How to Enable the Graph Menu',
	copyCommands: 'Copy Commands',
	dropRecoveryPoints: 'Drop Recovery Points',
} as const;

export type ActionLabel = typeof ACTIONS[keyof typeof ACTIONS];
