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
	GLOBAL_DECISION_KEY,
	dialogDecisionRows,
	type DialogDecisionDef,
	type DialogDecisionId,
	type StorageScope,
} from '../core/dialogDecisions';

export interface DialogDecisionsDeps {
	/** The `geco.rememberDialogDecisions` master setting. */
	masterEnabled(): boolean;
	forceEnabled(): boolean;
	/** The active storage scope for saved decisions (`global` | `perRepository`). */
	scope(): StorageScope;
	/** The repository whose decisions are being edited, if any (canonical key). */
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
		const scopeValue = this.deps.scope();
		const isGlobal = scopeValue === 'global';
		const repo = this.deps.repoPath();
		// With a global scope the one shared bucket is edited here regardless of
		// which (or whether any) repository is open; per-repository scope still
		// needs an open repository to know which bucket to show.
		const effectiveKey = isGlobal ? GLOBAL_DECISION_KEY : repo;
		const master = this.deps.masterEnabled();
		const forceEnabled = this.deps.forceEnabled();
		const nodes: DialogDecisionNode[] = [];

		const scopeLabel = isGlobal
			? 'Scope: Global — shared across repositories in this workspace'
			: (repo ? `Repository: ${repo}` : 'No Git repository is open');
		const scope = new vscode.TreeItem(
			scopeLabel,
			vscode.TreeItemCollapsibleState.None,
		) as DecisionInfoNode;
		scope.nodeKind = 'info';
		scope.id = 'scope';
		scope.iconPath = new vscode.ThemeIcon(isGlobal ? 'globe' : (repo ? 'repo' : 'warning'));
		scope.description = master ? 'saved decisions are ON' : 'saved decisions are OFF (geco.rememberDialogDecisions)';
		scope.tooltip = new vscode.MarkdownString(
			(isGlobal
				? 'Decisions are shared across repositories **in this workspace** (scope `global`). '
				: repo ? `Decisions are saved for **${repo}** only (scope \`perRepository\`). `
					: 'Open a Git repository to edit per-repository decisions. ')
			+ 'Saved answers are stored in workspace state and are not synced. '
			+ (master ? 'The master setting is on.' : 'The master setting is off; saved answers are inactive.')
			+ (forceEnabled ? '' : ' Force-related saved answers are inactive while `geco.rememberForceDialogDecisions` is off.')
			+ ' Only the named question is skipped; repository checks, recovery points and journaling still run.',
		);
		scope.accessibilityInformation = { label: scope.tooltip.value };
		nodes.push(scope);

		if (!effectiveKey) {
			return nodes;
		}

		for (const row of dialogDecisionRows(this.deps.raw(), effectiveKey, master, forceEnabled)) {
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
						? `Saved answer: always “${def.confirmLabel}”${row.state === 'enabled' ? '.' : ' — inactive while its setting is off.'} `
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
					? `Saved decision enabled: "${node.def.action}" now always answers "${node.def.confirmLabel}" for ${this.deps.scope() === 'global' ? 'all repositories in this workspace' : 'this repository'}.`
					: `Saved decision reset: "${node.def.action}" asks every time again.`);
			}
		}
		if (changed || events.length > 0) {
			this.refresh();
		}
	}
}
