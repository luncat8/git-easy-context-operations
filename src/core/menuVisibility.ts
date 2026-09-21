/**
 * The visibility state machine behind "Customize Context Menus".
 *
 * Pure TypeScript, no VS Code import: the persisted state is the
 * `geco.hiddenMenuItems` string array (the row ids the user hid), and this
 * module turns it into everything else - the context keys VS Code evaluates,
 * the per-surface visible counts the editor tree shows, and the summaries.
 *
 * Safety rails (see `0.3-plan-interactive-menu-editor.md` section 4.4):
 *
 * - Fail-open: `geco.menuFilter` is only `true` after the vscode layer applied
 *   every `geco.menuVisible.*` key; before that nothing can be hidden.
 * - Required rows (`geco.customizeMenus`) cannot be hidden - that entry is the
 *   way back into the editor from every menu we contribute.
 * - A submenu parent auto-hides through `geco.menuHasItems.<submenuId>` when
   * every row inside it is hidden, so no menu opens empty.
 * - Unknown ids in the setting are **kept**, not pruned, so a downgrade never
 *   loses a customization; the editor reports them.
 */
import { EXPANDED_SUBMENUS, MENU_ROWS, rowsForSurface, submenuItemsKey, visibilityKey, type MenuRow, type MenuSurfaceId } from './menuCatalog';

/** The `geco.hiddenMenuItems` setting id. */
export const HIDDEN_MENU_ITEMS_SETTING = 'hiddenMenuItems';
/** Full key including the section, for `affectsConfiguration` and friends. */
export const HIDDEN_MENU_ITEMS_FULL_KEY = 'geco.hiddenMenuItems';

/**
 * Tolerant reader for `geco.hiddenMenuItems`: accepts anything, drops what is
 * not a non-empty string, trims, dedupes, keeps the order. Unknown ids are
 * preserved on purpose (survives downgrade).
 */
export function parseHiddenItems(raw: unknown): string[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const seen = new Set<string>();
	for (const entry of raw) {
		if (typeof entry !== 'string') {
			continue;
		}
		const trimmed = entry.trim();
		if (trimmed) {
			seen.add(trimmed);
		}
	}
	return [...seen];
}

/** Split a hidden list into rows this build knows and ids it does not. */
export function splitUnknownIds(hidden: readonly string[], rows: readonly MenuRow[] = MENU_ROWS): { known: string[]; unknown: string[] } {
	const knownIds = new Set(rows.map((row) => row.id));
	const known: string[] = [];
	const unknown: string[] = [];
	for (const id of hidden) {
		(knownIds.has(id) ? known : unknown).push(id);
	}
	return { known, unknown };
}

/** The ids hidden out of the box (rows flagged `defaultHidden` in the catalogue). */
export function defaultHiddenIds(rows: readonly MenuRow[] = MENU_ROWS): string[] {
	return rows.filter((row) => row.defaultHidden).map((row) => row.id);
}

/**
 * The hidden list a *stored* setting value means:
 *
 * - `undefined` - never stored (fresh install, or the user reset): the
 *   catalogue default applies (the `defaultHidden` rows are hidden);
 * - any array - authoritative, exactly as stored, even `[]`, which means
 *   "show everything, including the default-hidden rows".
 *
 * The vscode layer therefore stores the setting as `undefined` whenever the
 * current choice equals the default, so the manifest needs no `default` at
 * all (a manifest default would silently re-hide a row the user re-enabled).
 */
export function effectiveHiddenList(stored: readonly string[] | undefined, rows: readonly MenuRow[] = MENU_ROWS): string[] {
	return stored === undefined ? defaultHiddenIds(rows) : [...stored];
}

/** Rows the user hid, in catalogue order (skipping required and unknown ids). */
export function hiddenRows(hidden: readonly string[], rows: readonly MenuRow[] = MENU_ROWS): MenuRow[] {
	const hiddenSet = new Set(hidden);
	return rows.filter((row) => !row.required && hiddenSet.has(row.id));
}

/**
 * Whether the row may be switched off. Required rows cannot (the editor
 * renders their switch as on and locked); everything else can - an entirely
 * trimmed menu is allowed, because the required entry always stays and empty
 * submenus collapse their parent via `menuHasItems`.
 */
export function canHide(row: MenuRow): boolean {
	return !row.required;
}

/** Whether a row is currently hidden. Unknown ids are not rows, so `false`. */
export function isHidden(hidden: readonly string[], row: MenuRow): boolean {
	return !row.required && hidden.includes(row.id);
}

/**
 * Every context key the state machine owns, for the given hidden list:
 * `geco.menuVisible.<rowId>` for each row (hidden ⇒ `false`) and
 * `geco.menuHasItems.<submenuId>` per submenu (visible while any row inside
 * is visible). `geco.menuFilter` is deliberately **not** included - the vscode
 * layer applies it last, so a half-applied state never hides anything.
 */
export function contextKeysFor(hidden: readonly string[], rows: readonly MenuRow[] = MENU_ROWS): Record<string, boolean> {
	const keys: Record<string, boolean> = {};
	const hiddenSet = new Set(hidden);
	for (const row of rows) {
		keys[visibilityKey(row.id)] = !hiddenSet.has(row.id) || Boolean(row.required);
	}
	for (const submenuId of EXPANDED_SUBMENUS) {
		const anyVisible = rows.some((row) => row.surfaces.some((surface) => surfaceBelongsToSubmenu(surface, submenuId)) && keys[visibilityKey(row.id)]);
		keys[submenuItemsKey(submenuId)] = anyVisible;
	}
	return keys;
}

function surfaceBelongsToSubmenu(surface: MenuSurfaceId, submenuId: string): boolean {
	// Both submenus are our own "Git Easy Ops" menus; a row lists the submenu
	// surface itself (`submenu.commit` / `submenu.branch`).
	return surface === (submenuId === 'geco.commitSubmenu' ? 'submenu.commit' : 'submenu.branch');
}

/** Visible/total counts for one surface, as the editor tree shows them. */
export function surfaceCounts(hidden: readonly string[], surfaceId: MenuSurfaceId): { visible: number; total: number } {
	const rowsOnSurface = rowsForSurface(surfaceId);
	const visible = rowsOnSurface.filter((row) => !isHidden(hidden, row)).length;
	return { visible, total: rowsOnSurface.length };
}

/** One line about the state, for the editor and the log. */
export function summarizeState(hidden: readonly string[], rows: readonly MenuRow[] = MENU_ROWS): string {
	const { known, unknown } = splitUnknownIds(hidden, rows);
	const hiddenCount = hiddenRows(known, rows).length;
	const parts = [`${hiddenCount} of ${rows.filter((row) => !row.required).length} menu items hidden`];
	if (unknown.length > 0) {
		parts.push(`${unknown.length} saved id${unknown.length === 1 ? '' : 's'} unknown to this version (kept)`);
	}
	return parts.join(' · ');
}
