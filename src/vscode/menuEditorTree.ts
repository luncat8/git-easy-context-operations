/**
 * The "Git Easy Ops Menus" editor - a native checkbox tree, one node per
 * surface, one checkbox per menu row.
 *
 * This is Plan B of `0.3-plan-interactive-menu-editor.md`: rendered entirely
 * by the workbench's own tree widget (no webview, no extra renderer process,
 * nothing loaded until the hidden view is focused). The engine it drives -
 * catalogue, `when` fragments, state machine - lives in `src/core/menu*`, so
 * a future "replica" panel can replace this renderer without touching it.
 *
 * Toggling a checkbox writes `geco.hiddenMenuItems` and re-applies the context
 * keys, which is what makes the real menus change immediately - no reload.
 */
import * as vscode from 'vscode';
import {
	MENU_ROWS,
	MENU_SURFACES,
	menuSurfaceById,
	type MenuRow,
	type MenuSurface,
	type MenuSurfaceId,
} from '../core/menuCatalog';
import { canHide, isHidden, parseHiddenItems, splitUnknownIds, surfaceCounts } from '../core/menuVisibility';

export interface MenuEditorDeps {
	/** Command id → title, resolved from our own package.json at runtime. */
	titles: ReadonlyMap<string, string>;
	/** The current `geco.hiddenMenuItems` value (already normalized). */
	hidden(): readonly string[];
	/** Persists a new hidden list; the extension re-applies the context keys. */
	setHidden(ids: readonly string[]): Promise<void>;
	/** Whether the installed build contributes the graph menus. */
	graphBuildInstalled(): boolean;
	/** Log line sink (the extension's output channel). */
	onLog(message: string): void;
}

export type MenuEditorNode = MenuSurfaceNode | MenuRowNode | MenuNoteNode;

interface MenuSurfaceNode extends vscode.TreeItem {
	nodeKind: 'surface';
	surface: MenuSurface;
}

interface MenuRowNode extends vscode.TreeItem {
	nodeKind: 'row';
	row: MenuRow;
	surface: MenuSurfaceId;
}

interface MenuNoteNode extends vscode.TreeItem {
	nodeKind: 'note';
}

const SURFACE_ICONS: Partial<Record<MenuSurfaceId, string>> = {
	'view.commit': 'git-commit',
	'view.branch': 'git-branch',
	'view.backup': 'shield',
	'view.graphGroup': 'graph',
	'view.title': 'layout-panel',
	'submenu.commit': 'chevron-right',
	'submenu.branch': 'chevron-right',
	'scm.title': 'source-control',
	'scm.sourceControl': 'source-control',
	'scm.repository': 'repo',
	'timeline.commit': 'history',
	'graph.commit': 'graph-line',
	'graph.ref': 'git-branch',
	'graph.title': 'layout-panel',
};

export class MenuEditorProvider implements vscode.TreeDataProvider<MenuEditorNode>, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<MenuEditorNode | undefined | void>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(private readonly deps: MenuEditorDeps) {}

	refresh(): void {
		this.emitter.fire();
	}

	dispose(): void {
		this.emitter.dispose();
	}

	getTreeItem(element: MenuEditorNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: MenuEditorNode): Promise<MenuEditorNode[]> {
		if (!element) {
			return this.rootNodes();
		}
		if (element.nodeKind === 'surface') {
			return this.rowNodes(element.surface);
		}
		return [];
	}

	private rootNodes(): MenuEditorNode[] {
		const nodes: MenuEditorNode[] = [];
		const hidden = this.deps.hidden();
		const { unknown } = splitUnknownIds(hidden);
		if (unknown.length > 0) {
			const note = new vscode.TreeItem(
				`${unknown.length} saved id${unknown.length === 1 ? ' is' : 's are'} unknown to this version - kept`,
				vscode.TreeItemCollapsibleState.None,
			) as MenuNoteNode;
			note.nodeKind = 'note';
			note.iconPath = new vscode.ThemeIcon('info');
			note.description = unknown.join(', ');
			note.tooltip = 'These ids come from another build (or an older release). They are preserved, so downgrading does not lose them.';
			nodes.push(note);
		}
		for (const surface of MENU_SURFACES) {
			const counts = surfaceCounts(hidden, surface.id);
			const node = new vscode.TreeItem(surface.label, vscode.TreeItemCollapsibleState.Expanded) as MenuSurfaceNode;
			node.nodeKind = 'surface';
			node.surface = surface;
			node.id = `surface:${surface.id}`;
			node.description = surface.graphOnly && !this.deps.graphBuildInstalled() ? 'needs the +graph build' : `${counts.visible}/${counts.total} visible`;
			node.iconPath = new vscode.ThemeIcon(SURFACE_ICONS[surface.id] ?? 'menu');
			node.contextValue = `geco.menuSurface${surface.graphOnly ? '.graph' : ''}`;
			node.tooltip = new vscode.MarkdownString(
				`**${surface.label}**\n\nMenu key: \`${surface.menuKey}\``
				+ (surface.expands ? `\n\nOpens the \`${surface.expands}\` submenu` : '')
				+ (surface.graphOnly ? '\n\nOnly exists in the `+graph` build (proposed API).' : ''),
			);
			nodes.push(node);
		}
		return nodes;
	}

	private rowNodes(surface: MenuSurface): MenuEditorNode[] {
		if (surface.graphOnly && !this.deps.graphBuildInstalled()) {
			const note = new vscode.TreeItem(
				'This menu needs the +graph build (proposed API)',
				vscode.TreeItemCollapsibleState.None,
			) as MenuNoteNode;
			note.nodeKind = 'note';
			note.iconPath = new vscode.ThemeIcon('plug');
			note.description = 'npm run package:graph';
			note.tooltip = 'The Source Control Graph menus are a proposed VS Code API. The graph build contributes them; this build does not.';
			return [note];
		}
		const hidden = this.deps.hidden();
		return MENU_ROWS.filter((row) => row.surfaces.includes(surface.id)).map((row) => {
			const label = this.deps.titles.get(row.id) ?? row.label;
			const hiddenHere = isHidden(hidden, row);
			const node = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None) as MenuRowNode;
			node.nodeKind = 'row';
			node.row = row;
			node.surface = surface.id;
			node.id = `row:${surface.id}:${row.id}`;
			node.checkboxState = hiddenHere ? vscode.TreeItemCheckboxState.Unchecked : vscode.TreeItemCheckboxState.Checked;
			if (row.required) {
				node.description = 'always available';
				node.iconPath = new vscode.ThemeIcon('lock');
				node.tooltip = new vscode.MarkdownString(
					`**${label}** is the way back into this editor, so it cannot be hidden.`
					+ `\n\nContext key: \`geco.menuVisible.${row.id}\``,
				);
			} else {
				if (hiddenHere && row.defaultHidden) {
					node.description = 'hidden by default';
				}
				node.tooltip = new vscode.MarkdownString(
					`**${label}**\n\nContext key: \`geco.menuVisible.${row.id}\`\n\n`
					+ `One switch hides this entry in *every* menu that shows it `
					+ `(${row.surfaces.map((s) => menuSurfaceById(s).label).join(', ')}).`
					+ (row.defaultHidden
						? '\n\nHidden by default - tick the box to show it, or "Restore Defaults" to hide it again.'
						: '')
					+ '\n\nThe Command Palette always keeps the command.',
				);
			}
			return node;
		});
	}

	/**
	 * A checkbox changed: compute the new hidden list, persist it (which
	 * re-applies the context keys), and repaint. Required rows snap back with
	 * an explanation instead.
	 */
	async handleCheckboxChange(events: readonly [MenuEditorNode, vscode.TreeItemCheckboxState][]): Promise<void> {
		const hidden = [...this.deps.hidden()];
		let changed = false;
		for (const [node, state] of events) {
			if (node.nodeKind !== 'row') {
				continue;
			}
			const { row } = node;
			if (!canHide(row)) {
				this.deps.onLog(`"${row.label}" cannot be hidden - it is the way back into this editor.`);
				continue;
			}
			const index = hidden.indexOf(row.id);
			if (state === vscode.TreeItemCheckboxState.Unchecked && index < 0) {
				hidden.push(row.id);
				changed = true;
				this.deps.onLog(`Hidden "${row.label}" (${row.surfaces.length} menu${row.surfaces.length === 1 ? '' : 's'}).`);
			} else if (state === vscode.TreeItemCheckboxState.Checked && index >= 0) {
				hidden.splice(index, 1);
				changed = true;
				this.deps.onLog(`Restored "${row.label}".`);
			}
		}
		if (changed) {
			await this.deps.setHidden(hidden);
		}
		this.refresh();
	}
}

/** Resolves the command titles of this build from the extension manifest. */
export function commandTitlesFromManifest(packageJSON: { contributes?: { commands?: { command: string; title: string }[] } }): Map<string, string> {
	const titles = new Map<string, string>();
	for (const command of packageJSON.contributes?.commands ?? []) {
		titles.set(command.command, command.title);
	}
	return titles;
}

/** Tolerant re-export so the extension layer has one import for both. */
export { parseHiddenItems };
