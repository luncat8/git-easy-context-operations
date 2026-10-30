/**
 * The row catalogue - the single source of truth of "Customize Context Menus".
 *
 * Every menu entry this extension contributes belongs to exactly one **row**
 * (one row = one command, because that is what "I don't want this item" means:
 * one switch removes the entry from every menu that shows it). The editor UI is
 * a view of this catalogue; the `when` clauses in `package.json` and in
 * `scripts/apply-graph-menu.mjs` carry one visibility fragment per row, and
 * `src/test/core/menuCatalog.test.ts` fails loudly the moment the manifest and
 * this catalogue drift apart - in either direction.
 *
 * Mechanism (researched in `0.3-plan-interactive-menu-editor.md`): menu
 * contributions are static manifest data, but `when` clauses are evaluated
 * live against context keys. Every fragment reads two keys:
 *
 * - `geco.menuFilter` - the fail-open guard. The state machine sets it to
 *   `true` *last*. While it is `undefined` (extension disabled, crashed, not
 *   yet activated) `!geco.menuFilter` is `true` and **everything shows**.
 * - `geco.menuVisible.<rowId>` - `false` only when the user hid that row.
 *
 * The parent entries that open a submenu additionally carry
 * `geco.menuHasItems.<submenuId>`, which is `false` when every row inside is
 * hidden, so a submenu parent never opens an empty menu.
 */

/** The surfaces (actual menus) a row can appear on. */
export type MenuSurfaceId =
	| 'view.commit'
	| 'view.branch'
	| 'view.backup'
	| 'view.graphGroup'
	| 'view.title'
	| 'submenu.commit'
	| 'submenu.branch'
	| 'scm.title'
	| 'scm.sourceControl'
	| 'scm.repository'
	| 'scm.resource'
	| 'timeline.commit'
	| 'graph.commit'
	| 'graph.ref'
	| 'graph.title';

export interface MenuSurface {
	id: MenuSurfaceId;
	/** What the editor shows ("Sidebar → commit rows"). */
	label: string;
	/** The `contributes.menus` key this surface reads. */
	menuKey: string;
	/** `view/item/context` only: the `viewItem =~ /…/` matcher of this surface. */
	viewItem?: RegExp;
	/** `view/item/context` only: an exact `viewItem == …` matcher. */
	viewItemEquals?: string;
	/** `view/title` only: which view the entry belongs to. */
	view?: string;
	/** Submenu-parent surfaces: the submenu the entry opens. */
	expands?: string;
	/** Only contributed by the `+graph` build (scripts/apply-graph-menu.mjs). */
	graphOnly?: boolean;
}

/**
 * The surfaces of this extension, with the exact context VS Code uses for
 * each. `submenu.branch` is contributed and filled but no menu opens it yet
 * (kept for the graph build's future ref submenu) - the editor lists it with
 * that caveat rather than pretending the rows appear somewhere.
 */
export const MENU_SURFACES: readonly MenuSurface[] = [
	{ id: 'view.commit', label: 'Sidebar → commit row', menuKey: 'view/item/context', viewItem: /^geco\.commit/ },
	{ id: 'view.branch', label: 'Sidebar → branch row', menuKey: 'view/item/context', viewItem: /^geco\.branch/ },
	{ id: 'view.backup', label: 'Sidebar → recovery point / journal row', menuKey: 'view/item/context', viewItem: /^geco\.backup/ },
	{ id: 'view.graphGroup', label: 'Sidebar → Graph group row', menuKey: 'view/item/context', viewItemEquals: 'geco.group.graph' },
	{ id: 'view.title', label: 'Sidebar → view title (⋯ / icons)', menuKey: 'view/title', view: 'geco.history' },
	{ id: 'submenu.commit', label: 'Git Easy Ops → commit submenu', menuKey: 'geco.commitSubmenu' },
	{ id: 'submenu.branch', label: 'Git Easy Ops → branch submenu (not attached yet)', menuKey: 'geco.branchSubmenu' },
	{ id: 'scm.title', label: 'Source Control title (⋯)', menuKey: 'scm/title', expands: 'geco.commitSubmenu' },
	{ id: 'scm.sourceControl', label: 'Source Control panel (⋯)', menuKey: 'scm/sourceControl', expands: 'geco.commitSubmenu' },
	{ id: 'scm.repository', label: 'Source Control repository row', menuKey: 'scm/repository', expands: 'geco.commitSubmenu' },
	// The context menu of a changed-file row in the built-in Source Control
	// view (Changes / Staged Changes lists): `scm/resourceState/context` is
	// the menu key VS Code registers for `MenuId.SCMResourceContext`, and
	// the git extension's own "Open File" / "Open Change" entries live on
	// the same surface.
	{ id: 'scm.resource', label: 'Source Control → changed file row', menuKey: 'scm/resourceState/context' },
	{ id: 'timeline.commit', label: 'Timeline → commit row', menuKey: 'timeline/item/context', expands: 'geco.commitSubmenu' },
	{ id: 'graph.commit', label: 'Source Control Graph → commit row', menuKey: 'scm/historyItem/context', graphOnly: true },
	{ id: 'graph.ref', label: 'Source Control Graph → branch row', menuKey: 'scm/historyItemRef/context', graphOnly: true },
	{ id: 'graph.title', label: 'Source Control Graph → toolbar', menuKey: 'scm/history/title', graphOnly: true },
];

export interface MenuRow {
	/**
	 * Stable id - also the value stored in `geco.hiddenMenuItems`. It is the
	 * command id, because one row is one command. NEVER rename, NEVER reuse.
	 */
	id: string;
	/** Fallback label for tests and tooltips; the UI prefers the manifest title. */
	label: string;
	/** Every surface that shows this row - checked against the manifest by test. */
	surfaces: readonly MenuSurfaceId[];
	/** Cannot be hidden - the way back into the editor. Only `geco.customizeMenus`. */
	required?: boolean;
	/**
	 * Hidden out of the box: a fresh install (no stored `geco.hiddenMenuItems`
	 * at all) starts with the row hidden, and the editor shows it unchecked
	 * with that note. An explicitly stored list (even `[]`) is authoritative -
	 * the user can tick the row back on and it stays on.
	 */
	defaultHidden?: boolean;
}

/** One switch per command, across every menu that shows it. */
export const MENU_ROWS: readonly MenuRow[] = [
	// The primary row-targeted actions also have buttons on the **stable**
	// view header (`view.title`) - fast-forward, Squash, rename commit and
	// rename branch. With no row argument they open the same pickers used by
	// the Command Palette, and without the proposed API that header is their
	// entry point next to our own rows. The built-in graph's header
	// (`graph.title`) deliberately skips all four: in the +graph build they
	// sit in the context menu of the very commit / branch they operate on
	// (`graph.commit`, `graph.ref`), so a picker guessing the target would
	// only duplicate the right-click. The multi-select variant stays on
	// commit rows because a header has no selection to pass through.
	{ id: 'geco.rewordCommit', label: 'Rename Commit Message...', surfaces: ['view.commit', 'submenu.commit', 'graph.commit', 'view.title'] },
	{ id: 'geco.rewordCommitAppend', label: 'Append to Commit Message...', surfaces: ['view.commit', 'submenu.commit', 'graph.commit'] },
	{ id: 'geco.rewordCommitRename', label: 'Search and Replace in Commit Message...', surfaces: ['view.commit', 'submenu.commit', 'graph.commit'], defaultHidden: true },
	{ id: 'geco.squashSelectedCommits', label: 'Squash Selected Commits...', surfaces: ['view.commit'] },
	{ id: 'geco.squashWithPreviousCommits', label: 'Squash with Previous Commits...', surfaces: ['view.commit', 'submenu.commit', 'graph.commit', 'view.title'] },
	{ id: 'geco.createBranch', label: 'Create Branch...', surfaces: ['view.commit', 'view.branch', 'submenu.commit', 'submenu.branch'] },
	// The header's one fast-forward button is the default-branch variant
	// ("move main onto..."); the ask-a-branch variant stays on the rows.
	{ id: 'geco.fastForwardDefaultBranch', label: 'Fast-Forward Default Branch to Commit...', surfaces: ['view.commit', 'submenu.commit', 'graph.commit', 'view.title'] },
	{ id: 'geco.fastForwardBranch', label: 'Fast-Forward Branch to Commit...', surfaces: ['view.commit', 'view.branch', 'submenu.commit', 'submenu.branch', 'graph.commit'] },
	{ id: 'geco.createBackupBranch', label: 'Create Backup Branch...', surfaces: ['view.commit', 'view.branch', 'submenu.commit', 'submenu.branch', 'graph.commit'] },
	{ id: 'geco.forcePush', label: 'Force Push (with lease)...', surfaces: ['view.commit', 'view.branch', 'submenu.commit', 'submenu.branch', 'graph.commit'] },
	{ id: 'geco.forcePushHard', label: 'Force Push (--force)...', surfaces: ['view.commit', 'view.branch', 'submenu.commit', 'submenu.branch', 'graph.commit'] },
	// The patch operations are repository-wide: the patch comes from a file
	// (or, interactively, from a source the user picks *after* clicking), and
	// it lands at a base the search finds - the clicked commit is neither
	// its target nor (usually) its source. They therefore live on the two
	// headers (our view's toolbar and the built-in graph's toolbar), next to
	// the other whole-repository buttons, and on no commit row at all.
	{ id: 'geco.applyPatchAtProperBase', label: 'Apply Patch at Proper Base...', surfaces: ['view.title', 'graph.title'] },
	{ id: 'geco.applyPatchAutomatically', label: 'Apply Patch Automatically', surfaces: ['view.title', 'graph.title'] },
	{ id: 'geco.findProperBase', label: 'Find Proper Base for Patch...', surfaces: ['view.title', 'graph.title'] },
	{ id: 'geco.copyCommitSha', label: 'Copy Commit SHA', surfaces: ['view.commit', 'submenu.commit', 'graph.commit'] },
	{ id: 'geco.enableGraphMenu', label: 'Enable Source Control Graph Menu...', surfaces: ['view.commit', 'view.title', 'submenu.commit', 'graph.commit'] },
	{ id: 'geco.cleanHistory', label: 'Clean History (Remove Dead Paths)...', surfaces: ['view.commit', 'view.graphGroup', 'view.title', 'submenu.commit', 'graph.title'] },
	{ id: 'geco.renameBranch', label: 'Rename Branch...', surfaces: ['view.branch', 'submenu.branch', 'graph.ref', 'view.title'] },
	{ id: 'geco.checkoutBranch', label: 'Check Out Branch...', surfaces: ['view.branch', 'submenu.branch'] },
	{ id: 'geco.deleteBranch', label: 'Delete Branch...', surfaces: ['view.branch', 'submenu.branch'] },
	// The cleanup sits everywhere a commit row shows branch items (it is about
	// the branch names of the whole graph, not about the clicked commit), and on
	// branch rows. On every one of those surfaces it is the **last** entry of
	// the branch group, right after *Create Branch...*. It is deliberately NOT
	// on the graph's per-ref badges (`graph.ref`): VS Code expands every entry
	// there into a "Remove Redundant Branches... > <branch>" sub-item, and a
	// sub-item carrying the selected branch name reads as "this branch gets
	// deleted" - the opposite of a whole-graph sweep whose list of victims only
	// exists after the scan. One flat entry, one click, then the checkbox list.
	{ id: 'geco.removeRedundantBranches', label: 'Remove Redundant Branches...', surfaces: ['view.commit', 'view.branch', 'view.title', 'submenu.commit', 'submenu.branch', 'graph.commit', 'graph.title'] },
	// Repository-wide like Clean History, and deliberately on a toolbar rather
	// than on a row: the trouble it explains (an unfinished merge, a lock, a
	// branch that diverged) is about the repository, not about one commit.
	{ id: 'geco.diagnosePushSync', label: 'Diagnose Push / Sync Trouble...', surfaces: ['view.title', 'graph.title'] },
	{ id: 'geco.undoLastOperation', label: 'Undo Last Operation', surfaces: ['view.backup', 'view.title', 'graph.title'] },
	{ id: 'geco.showBackups', label: 'Show Backups and Recovery Points', surfaces: ['view.title'] },
	// Only on our own view's toolbar: the built-in Source Control Graph
	// caption already carries its own refresh button, and a second one there
	// would be a duplicate (see `scripts/apply-graph-menu.mjs`).
	{ id: 'geco.refresh', label: 'Refresh', surfaces: ['view.title'] },
	// The one row with a condition of its own on top of the editor switch:
	// both header entries also carry `!geco.graphMenuVisible`
	// (`GRAPH_MENU_VISIBLE_CONTEXT_KEY` in `graphMenu.ts`), so the help for
	// a missing graph menu disappears by itself once the proposed menus are
	// really on screen in this session. The switch still governs it
	// everywhere else, and the Command Palette always keeps the command.
	{ id: 'geco.explainMenus', label: "Why Don't I See the Menus?", surfaces: ['view.title', 'graph.title'] },
	// A repository-wide link, so it sits on both headers (never on a commit
	// row) - last of the operation buttons in the shared header order.
	{ id: 'geco.copyRepositoryWebLink', label: 'Copy Repository Web Link', surfaces: ['view.title', 'graph.title'] },
	// "Open Source for Edit" - the changed-file rows of the built-in Source
	// Control view open a (usually read-only) diff by default; this menu
	// entry opens the file itself in an editable editor tab. It is the
	// only row on the `scm.resource` surface (a file row of the built-in
	// Source Control view), sits at the end of the built-in "open"
	// actions (`navigation@4`, after the order-0 Open Changes / Open File /
	// Open HEAD File entries), and is gated to the git provider.

	{ id: 'geco.openSourceForEdit', label: 'Open Source for Edit', surfaces: ['scm.resource'] },
	{ id: 'geco.openCommitSourceForEdit', label: 'Open Changed Files for Edit...', surfaces: ['graph.commit'] },
	{
		id: 'geco.customizeMenus',
		label: 'Customize Context Menus...',
		surfaces: ['view.commit', 'view.branch', 'view.backup', 'view.graphGroup', 'view.title', 'submenu.commit', 'submenu.branch', 'graph.commit'],
		required: true,
	},
];

/** The fail-open guard key: nothing is hidden unless this is `true`. */
export const MENU_FILTER_KEY = 'geco.menuFilter';

/**
 * The `when` fragment every menu entry of the row carries. Evaluated by VS
 * Code live; `(!geco.menuFilter || …)` keeps the menu untouched until the
 * state machine has applied every key (fail-open).
 */
export function visibilityFragment(id: string): string {
	return `(!geco.menuFilter || geco.menuVisible.${id})`;
}

/**
 * The fragment for a submenu parent entry: visible only while the submenu
 * still has at least one visible row (a parent never opens an empty menu).
 */
export function submenuItemsFragment(submenuId: string): string {
	return `(!geco.menuFilter || geco.menuHasItems.${submenuId})`;
}

/** The context key that reports whether the submenu has any visible row. */
export function submenuItemsKey(submenuId: string): string {
	return `geco.menuHasItems.${submenuId}`;
}

/** The context key of one row (`geco.menuVisible.<rowId>`). */
export function visibilityKey(id: string): string {
	return `geco.menuVisible.${id}`;
}

/** The submenu ids whose parent entries carry the `menuHasItems` fragment. */
export const EXPANDED_SUBMENUS = ['geco.commitSubmenu', 'geco.branchSubmenu'] as const;

export function menuSurfaceById(id: MenuSurfaceId): MenuSurface {
	const found = MENU_SURFACES.find((surface) => surface.id === id);
	if (!found) {
		throw new Error(`unknown menu surface: ${id}`);
	}
	return found;
}

export function menuRowById(id: string): MenuRow | undefined {
	return MENU_ROWS.find((row) => row.id === id);
}

/** The rows shown on one surface, in catalogue order. */
export function rowsForSurface(surfaceId: MenuSurfaceId): MenuRow[] {
	return MENU_ROWS.filter((row) => row.surfaces.includes(surfaceId));
}
