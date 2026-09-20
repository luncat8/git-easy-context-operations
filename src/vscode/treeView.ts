/**
 * The "Git Easy Ops" view in the Source Control sidebar.
 *
 * It is the stable, always-available entry point: the commit graph itself
 * (lane art plus the ref badges that point at each commit), the branches and the
 * recovery points/journal this extension created. Its context menu carries the
 * same commands as the palette, and clicking a node hands the command a
 * {@link GecoTreeItem} whose fields `resolveMenuArgs` understands.
 *
 * The built-in Source Control Graph paints its lanes with a canvas and opens
 * proposed-API menus, neither of which an extension may do - so this view does
 * the next best thing: one text row per commit in `●│╮…` form, with a child node
 * per branch so "Rename Branch..." / "Delete Branch..." are one right-click
 * away, exactly like in the graph.
 */
import * as vscode from 'vscode';
import type { Controller } from '../core/controller';
import type { Settings } from '../core/config';
import type { GraphCommitRow, GraphRefRow } from '../core/graphRows';
import { shorten } from '../core/safety';

export type GecoNodeKind = 'group' | 'commit' | 'branch' | 'backup' | 'journal';

export class GecoTreeItem extends vscode.TreeItem {
	/** Fields `resolveMenuArgs()` reads when a command is invoked from this node. */
	readonly gecoKind: GecoNodeKind;
	readonly sha?: string;
	readonly name?: string;
	readonly repoPath: string;
	/** Refs that point at this commit - rendered as child nodes (graph badges). */
	readonly graphRefs?: readonly GraphRefRow[];

	constructor(
		repoPath: string,
		kind: GecoNodeKind,
		label: string,
		options: {
			description?: string;
			tooltip?: string;
			icon?: string;
			sha?: string;
			name?: string;
			collapsible?: boolean | 'expanded';
			contextValue?: string;
			/** Overrides the default `<kind>:<sha|name|label>` tree id. */
			id?: string;
			graphRefs?: readonly GraphRefRow[];
		} = {},
	) {
		const state = options.collapsible === 'expanded'
			? vscode.TreeItemCollapsibleState.Expanded
			: options.collapsible
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None;
		super(label, state);
		this.gecoKind = kind;
		this.sha = options.sha;
		this.name = options.name;
		this.repoPath = repoPath;
		this.graphRefs = options.graphRefs;
		this.description = options.description;
		this.tooltip = options.tooltip;
		this.contextValue = options.contextValue;
		this.id = options.id ?? `${kind}:${options.sha ?? options.name ?? label}`;
		if (options.icon) {
			this.iconPath = new vscode.ThemeIcon(options.icon);
		}
	}
}

export interface HistoryProviderDeps {
	controller(): Controller;
	repoPath(): string | undefined;
	settings(): Settings;
	onError(message: string): void;
}

export class GecoHistoryProvider implements vscode.TreeDataProvider<GecoTreeItem> {
	private readonly emitter = new vscode.EventEmitter<GecoTreeItem | undefined | void>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(private readonly deps: HistoryProviderDeps) {}

	refresh(): void {
		this.emitter.fire();
	}

	dispose(): void {
		this.emitter.dispose();
	}

	getTreeItem(element: GecoTreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: GecoTreeItem): Promise<GecoTreeItem[]> {
		const repoPath = this.deps.repoPath();
		if (!repoPath) {
			// Returning nothing makes VS Code show the contributed welcome view.
			return [];
		}
		try {
			if (!element) {
				return this.rootNodes(repoPath);
			}
			// A commit row expands into the refs that point at it.
			if (element.gecoKind === 'commit') {
				return this.refNodes(repoPath, element);
			}
			// Only the root groups are collapsible otherwise.
			const label = typeof element.label === 'string' ? element.label : element.label?.label;
			switch (label) {
				case GROUP_GRAPH:
					return this.graphNodes(repoPath);
				case GROUP_BRANCHES:
					return this.branchNodes(repoPath);
				case GROUP_SAFETY:
					return this.safetyNodes(repoPath);
				default:
					return [];
			}
		} catch (error) {
			this.deps.onError(`Could not load the Git Easy Ops view: ${error instanceof Error ? error.message : String(error)}`);
			return [];
		}
	}

	private rootNodes(repoPath: string): GecoTreeItem[] {
		return [
			new GecoTreeItem(repoPath, 'group', GROUP_GRAPH, {
				icon: 'git-commit',
				collapsible: 'expanded',
				// Its own context value: the whole-graph operation ("Clean
				// History") is the inline button of *this* row, not of every group.
				contextValue: 'geco.group.graph',
				tooltip:
					'The commit graph - right-click a commit for the operations, or expand it to right-click one of its branches.\n'
					+ 'The trash button (and the last context-menu item) cleans the WHOLE graph: it removes every path that exists in old commits but in no branch, tag or remote anymore.',
			}),
			new GecoTreeItem(repoPath, 'group', GROUP_BRANCHES, { icon: 'git-branch', collapsible: true, contextValue: 'geco.group', tooltip: 'Local branches' }),
			new GecoTreeItem(repoPath, 'group', GROUP_SAFETY, { icon: 'history', collapsible: true, contextValue: 'geco.group', tooltip: 'Recovery points and journaled operations' }),
		];
	}

	/**
	 * The graph rows: `● fix typo` with the lane art in front and the ref badges
	 * (branch names) after the subject, exactly like the built-in graph - only
	 * as text, because a tree row cannot be painted.
	 */
	private async graphNodes(repoPath: string): Promise<GecoTreeItem[]> {
		const rows = await this.deps.controller().graphRows(repoPath);
		if (rows.length === 0) {
			return [new GecoTreeItem(repoPath, 'commit', 'No commits yet', { icon: 'circle-slash', contextValue: 'geco.empty' })];
		}
		return rows.map((row) => this.commitNode(repoPath, row));
	}

	private commitNode(repoPath: string, row: GraphCommitRow): GecoTreeItem {
		const label = row.art ? `${row.art} ${row.subject}` : row.subject;
		const description = [row.refsLabel, row.shortSha].filter(Boolean).join('  ');
		const item = new GecoTreeItem(repoPath, 'commit', label, {
			description,
			tooltip: row.tooltip,
			sha: row.sha,
			contextValue: 'geco.commit',
			id: `commit:${row.sha}`,
			collapsible: row.refs.length > 0,
			graphRefs: row.refs,
		});
		return item;
	}

	/** The ref badges of a commit row - the branch menu lives here. */
	private refNodes(repoPath: string, commit: GecoTreeItem): GecoTreeItem[] {
		const refs = commit.graphRefs ?? [];
		return refs.map((ref) =>
			new GecoTreeItem(repoPath, 'branch', ref.name, {
				description: ref.isHead ? 'checked out' : ref.upstream,
				tooltip: [
					`${ref.name} -> ${shorten(ref.sha)}`,
					ref.isHead ? 'HEAD points here.' : '',
					ref.upstream ? `tracks ${ref.upstream}` : '',
					'Right-click to create, rename, check out or delete this branch.',
				]
					.filter(Boolean)
					.join('\n'),
				icon: ref.isHead ? 'pass-filled' : 'git-branch',
				name: ref.name,
				contextValue: 'geco.branch',
				// The same branch also appears under "Branches"; tree ids have to
				// stay unique, so the badge is qualified by its commit.
				id: `ref:${shorten(ref.sha)}:${ref.name}`,
			}),
		);
	}

	private async branchNodes(repoPath: string): Promise<GecoTreeItem[]> {
		const branches = await this.deps.controller().listBranches(repoPath);
		return branches.map((branch) =>
			new GecoTreeItem(repoPath, 'branch', branch.name, {
				description: shorten(branch.sha),
				tooltip: `${branch.name} -> ${branch.sha}${branch.upstream ? `\ntracks ${branch.upstream}` : ''}`,
				icon: branch.isHead ? 'pass-filled' : 'git-branch',
				name: branch.name,
				contextValue: 'geco.branch',
			}),
		);
	}

	private async safetyNodes(repoPath: string): Promise<GecoTreeItem[]> {
		const controller = this.deps.controller();
		const [points, journal] = await Promise.all([controller.listRecoveryPoints(repoPath), controller.listJournal(repoPath)]);
		const items: GecoTreeItem[] = [];

		for (const point of points) {
			// refs/geco/reword/main/20260919T... is too long for a tree row.
			const label = point.kind === 'ref' ? point.name.replace(/^refs\/[^/]+\//, '') : point.name;
			items.push(
				new GecoTreeItem(repoPath, 'backup', label, {
					description: shorten(point.sha),
					tooltip: `${point.name} -> ${point.sha}${point.description ? `\n${point.description}` : ''}${point.createdAt ? `\ncreated ${point.createdAt}` : ''}`,
					icon: point.kind === 'branch' ? 'git-branch' : 'lock',
					name: point.name,
					sha: point.sha,
					contextValue: 'geco.backup',
				}),
			);
		}
		for (const entry of journal.slice().reverse().slice(0, 20)) {
			items.push(
				new GecoTreeItem(repoPath, 'journal', `${entry.kind}: ${entry.summary}`, {
					description: new Date(entry.at).toLocaleString(),
					tooltip: `${entry.summary}\n${entry.at}\nChoose "Undo Last Operation" to roll operations back, newest first.`,
					icon: 'history',
					contextValue: 'geco.backup',
				}),
			);
		}
		if (items.length === 0) {
			items.push(
				new GecoTreeItem(repoPath, 'backup', 'No recovery points yet', {
					icon: 'circle-slash',
					contextValue: 'geco.empty',
					tooltip: 'Recovery points and backups appear here as soon as an operation creates one.',
				}),
			);
		}
		return items;
	}
}

export const GROUP_GRAPH = 'Graph';
export const GROUP_BRANCHES = 'Branches';
export const GROUP_SAFETY = 'Backups & Undo';
