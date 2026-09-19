/**
 * The "Git Easy Ops" view in the Source Control sidebar.
 *
 * It is the stable, always-available entry point: recent commits, branches and
 * the recovery points/journal this extension created. Its context menu carries
 * the same commands as the palette, and clicking a node hands the command a
 * {@link GecoTreeItem} whose fields `resolveMenuArgs` understands.
 */
import * as vscode from 'vscode';
import type { Controller } from '../core/controller';
import type { Settings } from '../core/config';
import { shorten } from '../core/safety';

export type GecoNodeKind = 'group' | 'commit' | 'branch' | 'backup' | 'journal';

export class GecoTreeItem extends vscode.TreeItem {
	/** Fields `resolveMenuArgs()` reads when a command is invoked from this node. */
	readonly gecoKind: GecoNodeKind;
	readonly sha?: string;
	readonly name?: string;
	readonly repoPath: string;

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
			collapsible?: boolean;
			contextValue?: string;
		} = {},
	) {
		super(label, options.collapsible ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		this.gecoKind = kind;
		this.sha = options.sha;
		this.name = options.name;
		this.repoPath = repoPath;
		this.description = options.description;
		this.tooltip = options.tooltip;
		this.contextValue = options.contextValue;
		this.id = `${kind}:${options.sha ?? options.name ?? label}`;
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
			// Only the three root groups are collapsible; anything else is a leaf.
			const label = typeof element.label === 'string' ? element.label : element.label?.label;
			switch (label) {
				case GROUP_COMMITS:
					return this.commitNodes(repoPath);
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
			new GecoTreeItem(repoPath, 'group', GROUP_COMMITS, { icon: 'git-commit', collapsible: true, contextValue: 'geco.group', tooltip: 'Recent commits - right-click for the operations' }),
			new GecoTreeItem(repoPath, 'group', GROUP_BRANCHES, { icon: 'git-branch', collapsible: true, contextValue: 'geco.group', tooltip: 'Local branches' }),
			new GecoTreeItem(repoPath, 'group', GROUP_SAFETY, { icon: 'history', collapsible: true, contextValue: 'geco.group', tooltip: 'Recovery points and journaled operations' }),
		];
	}

	private async commitNodes(repoPath: string): Promise<GecoTreeItem[]> {
		const commits = await this.deps.controller().listCommits(repoPath, this.deps.settings().commitPickerLimit);
		if (commits.length === 0) {
			return [new GecoTreeItem(repoPath, 'commit', 'No commits yet', { icon: 'circle-slash', contextValue: 'geco.empty' })];
		}
		return commits.map((commit) =>
			new GecoTreeItem(repoPath, 'commit', `${commit.label}  ${commit.description}`, {
				description: commit.detail,
				tooltip: `${commit.label}\n${commit.description}${commit.detail ? `\n${commit.detail}` : ''}`,
				icon: 'git-commit',
				sha: commit.sha,
				contextValue: 'geco.commit',
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

export const GROUP_COMMITS = 'Commits';
export const GROUP_BRANCHES = 'Branches';
export const GROUP_SAFETY = 'Backups & Undo';
