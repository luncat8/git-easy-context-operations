/**
 * The "Git Easy Ops Dialog Decisions" view — one native tree row per
 * question the extension can ask, in registry order.
 *
 * Rendered entirely by the workbench's tree widget (like the Menu Editor):
 * no webview, keyboard navigable, screen-reader friendly through each row's
 * label, description and tooltip. Eligible rows carry a checkbox —
 * checked means a saved answer exists ("Enabled"), unchecked means
 * "Default (not enabled)". Ineligible and not-applicable rows carry no
 * checkbox at all, so nothing about them can be switched by accident; they
 * explain why instead. Changing a checkbox goes through the extension,
 * which asks a fresh (never rememberable) confirmation before enabling a
 * destructive answer and simply resets in the safe direction.
 */
import * as vscode from 'vscode';
import {
	dialogDecisionRows,
	type DialogDecisionDef,
	type DialogDecisionId,
} from '../core/dialogDecisions';

export interface DialogDecisionsDeps {
	/** The `geco.rememberDialogDecisions` master setting. */
	masterEnabled(): boolean;
	/** The repository whose decisions are being edited, if any. */
	repoPath(): string | undefined;
	/** The raw stored decisions (validated by the core helpers). */
	raw(): unknown;
	/**
	 * Enables (saves the affirmative answer) or resets one decision.
	 * Resolves false when the enable was declined at its fresh confirmation
	 * — the tree then repaints and the checkbox reverts.
	 */
	setEnabled(id: DialogDecisionId, enabled: boolean): Promise<boolean>;
	onLog(message: string): void;
}

export type DialogDecisionNode = DecisionInfoNode | DecisionRowNode;

interface DecisionInfoNode extends vscode.TreeItem {
	nodeKind: 'info';
}

export interface DecisionRowNode extends vscode.TreeItem {
	nodeKind: 'decision';
	def: DialogDecisionDef;
	saved: boolean;
}

export class DialogDecisionsProvider implements vscode.TreeDataProvider<DialogDecisionNode>, vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<DialogDecisionNode | undefined | void>();
	readonly onDidChangeTreeData = this.emitter.event;

	constructor(private readonly deps: DialogDecisionsDeps) {}

	refresh(): void {
		this.emitter.fire();
	}

	dispose(): void {
		this.emitter.dispose();
	}

	getTreeItem(element: DialogDecisionNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: DialogDecisionNode): Promise<DialogDecisionNode[]> {
		if (element) {
			return [];
		}
		const repo = this.deps.repoPath();
		const master = this.deps.masterEnabled();
		const nodes: DialogDecisionNode[] = [];

		const scope = new vscode.TreeItem(
			repo ? `Repository: ${repo}` : 'No Git repository is open',
			vscode.TreeItemCollapsibleState.None,
		) as DecisionInfoNode;
		scope.nodeKind = 'info';
		scope.id = 'scope';
		scope.iconPath = new vscode.ThemeIcon(repo ? 'repo' : 'warning');
		scope.description = master ? 'saved decisions are ON' : 'saved decisions are OFF (geco.rememberDialogDecisions)';
		scope.tooltip = new vscode.MarkdownString(
			repo
				? `Decisions are saved per repository — this list edits **${repo}** only. `
					+ 'They are stored in this workspace’s extension state and are never synced to other machines or repositories.'
					+ (master
						? '\n\nThe master setting is on: an “Enabled” answer below skips only its own question. Repository checks, recovery points and journaling still run.'
						: '\n\nThe master setting is off: saved answers below are kept but inactive — no dialog offers “(always)” and no saved answer is used until the mode is turned on.')
				: 'Open a folder that contains a Git repository to see and edit its saved decisions.',
		);
		scope.accessibilityInformation = { label: scope.tooltip.value };
		nodes.push(scope);

		if (!repo) {
			return nodes;
		}

		for (const row of dialogDecisionRows(this.deps.raw(), repo, master)) {
			const { def } = row;
			const node = new vscode.TreeItem(def.action, vscode.TreeItemCollapsibleState.None) as DecisionRowNode;
			node.nodeKind = 'decision';
			node.def = def;
			node.saved = row.saved;
			node.id = `decision:${def.id}`;
			node.description = row.stateLabel;
			node.contextValue = def.kind === 'eligible'
				? (row.saved ? 'geco.dialogDecision.enabled' : 'geco.dialogDecision.default')
				: 'geco.dialogDecision.locked';
			if (def.kind === 'eligible') {
				node.checkboxState = row.saved ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
				node.iconPath = new vscode.ThemeIcon(row.saved ? 'pass-filled' : 'circle-large-outline');
				node.tooltip = new vscode.MarkdownString(
					`**${def.action}**\n\nControls the question ${def.question}.\n\n`
					+ (row.saved
						? `Saved answer: always “${def.confirmLabel}”${master ? '.' : ' — inactive while the master setting is off.'} `
							+ 'Only this question is skipped; the operation’s repository checks, recovery points and journal entries still happen. '
							+ 'The branch, commit and remote of a future run still come from that run.\n\nUntick the box (or “Reset to Default”) to ask again every time.'
						: 'No saved answer: this question is asked every time. '
							+ 'Tick the box to always answer it with its affirmative button'
							+ (def.destructive ? ' — enabling this skips a destructive confirmation, so the editor asks once more before it takes effect.' : '.')),
				);
				node.command = {
					command: 'geco.dialogDecisionToggle',
					title: row.saved ? 'Reset to Default' : 'Enable Saved Answer',
					arguments: [node],
				};
			} else {
				node.iconPath = new vscode.ThemeIcon(def.kind === 'ineligible' ? 'lock' : 'info');
				node.tooltip = new vscode.MarkdownString(
					`**${def.action}**\n\n${def.question}.\n\n${def.ineligibleReason ?? ''}`,
				);
			}
			node.accessibilityInformation = {
				label: `${def.action}: ${row.stateLabel}. ${def.question}`,
			};
			nodes.push(node);
		}
		return nodes;
	}

	/** A checkbox changed: persist through the extension, then repaint. */
	async handleCheckboxChange(events: readonly [DialogDecisionNode, vscode.TreeItemCheckboxState][]): Promise<void> {
		let changed = false;
		for (const [node, state] of events) {
			if (node.nodeKind !== 'decision' || node.def.kind !== 'eligible') {
				continue;
			}
			const enabled = state === vscode.TreeItemCheckboxState.Checked;
			if (enabled === node.saved) {
				continue;
			}
			const applied = await this.deps.setEnabled(node.def.id, enabled);
			if (applied) {
				changed = true;
				this.deps.onLog(enabled
					? `Saved decision enabled: "${node.def.action}" now always answers "${node.def.confirmLabel}" for this repository.`
					: `Saved decision reset: "${node.def.action}" asks every time again.`);
			}
		}
		if (changed || events.length > 0) {
			this.refresh();
		}
	}
}
