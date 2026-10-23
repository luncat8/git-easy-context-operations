/**
 * What to do when a view the manifest contributes is not registered in the
 * running window.
 *
 * A view id only exists in the workbench after the window has loaded the
 * `package.json` that declares it. Install a build that adds a view, and a
 * window that is still running the previous manifest - "Restart Extensions",
 * an extension updated in place, a development host left open - answers
 * `window.createTreeView(id, ...)` with:
 *
 *     No view is registered with id: geco.dialogDecisions
 *
 * That is a normal consequence of updating, not a bug in the extension, and
 * VS Code fixes it on the next window reload (microsoft/vscode#265001). What
 * must **not** happen is that the error escapes: `activate` throwing means no
 * commands, no git hooks, no tree - the extension dies over an optional view.
 * So a missing view is recorded, logged, and reported once with the one
 * action that repairs it, and activation carries on.
 *
 * Everything here is pure so the decision - is this the known
 * "window is older than the manifest" case, and what exactly do we tell the
 * user - is testable without an editor.
 */

/** The label of the button that fixes a missing view. */
export const RELOAD_WINDOW_ACTION = 'Reload Window';

/** The workbench's wording when a view id is unknown to the window. */
const MISSING_VIEW_ERROR = /No view is registered with id:\s*(\S+)/i;

/**
 * The id the workbench named in a "No view is registered with id" error, or
 * `undefined` for anything else (a different failure must not be mistaken for
 * the stale-window case and silently swallowed).
 */
export function missingViewId(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
	return MISSING_VIEW_ERROR.exec(message)?.[1];
}

/** Whether `error` is the workbench refusing to create a not-yet-known view. */
export function isMissingViewError(error: unknown): boolean {
	return missingViewId(error) !== undefined;
}

/** `"A"`, `"A" and "B"`, `"A", "B" and "C"`. */
export function quotedLabelList(labels: readonly string[]): string {
	const quoted = labels.map((label) => `"${label}"`);
	if (quoted.length <= 1) {
		return quoted[0] ?? '';
	}
	return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/** A message body plus the action that resolves it. */
export interface UnavailableViewsReport {
	message: string;
	detail: string;
	action: string;
}

/**
 * The one report shown for the views a window does not know yet.
 *
 * `undefined` for an empty list, so callers can ask unconditionally: nothing
 * is shown, and no reload is suggested, when every view exists.
 * Duplicates and blank labels are dropped, because the same view is recorded
 * from both the failed creation and a refused "focus" command.
 */
export function describeUnavailableViews(labels: readonly string[]): UnavailableViewsReport | undefined {
	const unique = [...new Set(labels.map((label) => label.trim()).filter((label) => label.length > 0))];
	if (unique.length === 0) {
		return undefined;
	}
	const subject = unique.length === 1 ? `the ${quotedLabelList(unique)} view` : `the ${quotedLabelList(unique)} views`;
	return {
		message: `Git Easy Ops: ${subject} ${unique.length === 1 ? 'is' : 'are'} not available in this window yet.`,
		detail:
			'VS Code fixes the list of contributed views when a window opens, so a view added by an update only exists '
			+ 'after that window is reloaded. Everything else works: the extension is active, its commands run, and your '
			+ 'settings, saved dialog decisions and menu choices are untouched. '
			+ `"${RELOAD_WINDOW_ACTION}" finishes the update.`,
		action: RELOAD_WINDOW_ACTION,
	};
}
