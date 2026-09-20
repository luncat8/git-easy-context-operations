/**
 * Applies the visibility state machine to VS Code's context keys.
 *
 * The ordering is the fail-open rail: every `geco.menuVisible.*` /
 * `geco.menuHasItems.*` key is written **first**, and `geco.menuFilter` - the
 * guard every `when` fragment starts with - is written **last**. A crashed or
 * half-applied run therefore leaves the menus fully visible instead of half
 * hidden. With no keys applied at all (extension disabled, before activation)
 * `!geco.menuFilter` is `true` and everything shows, too.
 */
import { MENU_FILTER_KEY } from '../core/menuCatalog';

export type SetContextValue = boolean | string | number | undefined;

/** The real implementation is `vscode.commands.executeCommand('setContext', …)`. */
export type SetContext = (key: string, value: SetContextValue) => unknown;

/** Writes every key of the state machine, guard last. Idempotent, no event loop. */
export async function applyMenuContext(keys: Readonly<Record<string, boolean>>, setContext: SetContext): Promise<void> {
	for (const [key, value] of Object.entries(keys)) {
		await Promise.resolve(setContext(key, value));
	}
	// Last, deliberately: until this key flips, no fragment hides anything.
	await Promise.resolve(setContext(MENU_FILTER_KEY, true));
}
