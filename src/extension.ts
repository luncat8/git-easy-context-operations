/**
 * Git Easy Ops - activation and wiring.
 *
 * Everything git-related lives in `src/core` (pure, injectable, tested without
 * VS Code). This file only connects that core to the editor: settings, output
 * channel, the tree view, the commands and the repository picker.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import { Controller, type RewordFlow } from './core/controller';
import { createGitExec, type GitExec } from './core/gitRunner';
import type { Settings } from './core/config';
import { affectsGeco, readSettings, resolveGitPath } from './vscode/settings';
import { VsCodeUI } from './vscode/uiAdapter';
import { GecoHistoryProvider, GecoTreeItem } from './vscode/treeView';
import { loadGitApi, repositoryPaths, resolveRepoPath, type GitApiLike } from './vscode/repository';
import { describeInstalledBuild, FsFileStore } from './vscode/graphMenu';

const VIEW_ID = 'geco.history';
const GRAPH_HINT_KEY = 'geco.graphMenuHintShown';

interface Runtime {
	settings: Settings;
	exec: GitExec;
	controller: Controller;
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Git Easy Ops');
	context.subscriptions.push(output);

	const ui = new VsCodeUI(output);
	let runtime = buildRuntime(readSettings(), ui);
	const gitApi: GitApiLike | undefined = loadGitApi();
	if (!gitApi) {
		output.appendLine('The vscode.git API is unavailable; falling back to workspace folders.');
	}

	let activeRepo: string | undefined = repositoryPaths(gitApi)[0];

	const tree = new GecoHistoryProvider({
		controller: () => runtime.controller,
		repoPath: () => activeRepo,
		settings: () => runtime.settings,
		onError: (message) => output.appendLine(message),
	});
	context.subscriptions.push(tree);
	// `canSelectMany` is what makes multi-select (Ctrl/Shift-click) work in the
	// Graph group: VS Code then hands a context-menu command the clicked node
	// plus every selected node, which is how "Squash Selected Commits..." sees
	// the whole selection.
	const treeView = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: tree, showCollapseAll: true, canSelectMany: true });
	context.subscriptions.push(treeView);

	const setRepoContext = () => {
		void vscode.commands.executeCommand('setContext', 'geco.repositoryOpen', Boolean(activeRepo));
	};
	setRepoContext();

	const rememberRepo = (repoPath: string | undefined) => {
		if (repoPath && repoPath !== activeRepo) {
			activeRepo = repoPath;
			setRepoContext();
			tree.refresh();
		}
	};

	/** Resolve the repository, run an operation, then refresh the view. */
	const run = async (operation: (cwd: string, args: unknown[]) => Promise<void>, ...args: unknown[]) => {
		const flat = (args.flat() as unknown[]).filter((arg) => arg !== undefined);
		// A tree node knows its own repository; anything else comes from the editor.
		const fromNode = flat.find((arg): arg is GecoTreeItem => arg instanceof GecoTreeItem);
		const cwd = await resolveRepoPath(gitApi, flat, fromNode?.repoPath);
		if (!cwd) {
			void vscode.window.showErrorMessage('Git Easy Ops: no Git repository is open. Open a folder that contains one.');
			return;
		}
		rememberRepo(cwd);
		output.appendLine(`--- ${cwd}`);
		try {
			await operation(cwd, flat);
		} finally {
			tree.refresh();
		}
	};

	const reword = (flow: RewordFlow) => async (cwd: string, args: unknown[]) => runtime.controller.rewordCommit(cwd, args, flow);

	const commands: [string, (cwd: string, args: unknown[]) => Promise<void>][] = [
		['geco.rewordCommit', reword('replace')],
		['geco.rewordCommitAppend', reword('append')],
		['geco.rewordCommitRename', reword('findReplace')],
		['geco.squashSelectedCommits', async (cwd, args) => runtime.controller.squashSelectedCommits(cwd, args)],
		['geco.squashWithPreviousCommits', async (cwd, args) => runtime.controller.squashWithPreviousCommits(cwd, args)],
		['geco.fastForwardDefaultBranch', async (cwd, args) => runtime.controller.fastForward(cwd, args, { askBranch: false })],
		['geco.fastForwardBranch', async (cwd, args) => runtime.controller.fastForward(cwd, args, { askBranch: true })],
		['geco.forcePush', async (cwd, args) => runtime.controller.forcePush(cwd, args)],
		['geco.forcePushHard', async (cwd, args) => runtime.controller.forcePush(cwd, args, 'force')],
		['geco.applyPatchAtProperBase', async (cwd, args) => runtime.controller.applyPatchAtProperBase(cwd, args)],
		['geco.findProperBase', async (cwd, args) => runtime.controller.showProperBase(cwd, args)],
		['geco.createBackupBranch', async (cwd, args) => runtime.controller.createBackupBranch(cwd, args)],
		['geco.createBranch', async (cwd, args) => runtime.controller.createBranch(cwd, args)],
		['geco.renameBranch', async (cwd, args) => runtime.controller.renameBranch(cwd, args)],
		['geco.deleteBranch', async (cwd, args) => runtime.controller.deleteBranch(cwd, args)],
		['geco.checkoutBranch', async (cwd, args) => runtime.controller.checkoutBranch(cwd, args)],
		['geco.undoLastOperation', async (cwd) => runtime.controller.undoLastOperation(cwd)],
		['geco.showBackups', async (cwd) => runtime.controller.showBackups(cwd)],
		['geco.copyCommitSha', async (cwd, args) => runtime.controller.copyCommitSha(cwd, args)],
	];

	for (const [id, operation] of commands) {
		context.subscriptions.push(vscode.commands.registerCommand(id, (...args: unknown[]) => run(operation, ...args)));
	}

	// Commands that do not need a repository.
	context.subscriptions.push(
		vscode.commands.registerCommand('geco.refresh', () => {
			activeRepo = repositoryPaths(gitApi)[0] ?? activeRepo;
			setRepoContext();
			tree.refresh();
		}),
		vscode.commands.registerCommand('geco.explainMenus', async () => {
			await runtime.controller.explainMenus();
			output.show(true);
		}),
		vscode.commands.registerCommand('geco.enableGraphMenu', async () => {
			const build = describeInstalledBuild(context);
			// Two ways to allow the proposed API: the editor's product.json (no
			// command line at all) and the per-user argv.json.
			await runtime.controller.enableGraphMenu(build, new FsFileStore(build.argvPath), new FsFileStore(build.productPath));
			output.show(true);
		}),
	);

	// Keep the view alive as repositories and settings change.
	if (gitApi?.onDidOpenRepository) {
		context.subscriptions.push(
			gitApi.onDidOpenRepository((repo) => {
				activeRepo = repo.rootUri.fsPath;
				setRepoContext();
				tree.refresh();
			}),
		);
	}
	if (gitApi?.onDidCloseRepository) {
		context.subscriptions.push(
			gitApi.onDidCloseRepository(() => {
				activeRepo = repositoryPaths(gitApi)[0];
				setRepoContext();
				tree.refresh();
			}),
		);
	}
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => {
			const file = vscode.window.activeTextEditor?.document.uri;
			if (!file || file.scheme !== 'file') {
				return;
			}
			const containing = repositoryPaths(gitApi).find((repo) => contains(repo, file.fsPath));
			if (containing) {
				rememberRepo(containing);
			}
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (!affectsGeco(event)) {
				return;
			}
			runtime = buildRuntime(readSettings(), ui);
			output.appendLine('Settings reloaded.');
			tree.refresh();
		}),
	);

	maybeShowEntryPointHint(context, runtime.settings, output);
	output.appendLine(`Git Easy Ops ready (git: ${resolveGitPath(runtime.settings) ?? 'git from PATH'}).`);
}

function buildRuntime(settings: Settings, ui: VsCodeUI): Runtime {
	const exec = createGitExec({ gitPath: resolveGitPath(settings) });
	return { settings, exec, controller: new Controller({ ui, settings, exec }) };
}

function contains(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function deactivate(): void {
	// Nothing to tear down: VS Code disposes the subscriptions.
}

/**
 * The Source Control *Graph* commit menu needs a proposed VS Code API, so it is
 * opt-in (see `npm run graph-menu:on`). Tell the user once where the menus that
 * always work are, instead of leaving them guessing.
 */
function maybeShowEntryPointHint(context: vscode.ExtensionContext, settings: Settings, output: vscode.OutputChannel): void {
	if (!settings.showGraphMenuHint || context.globalState.get<boolean>(GRAPH_HINT_KEY)) {
		return;
	}
	void context.globalState.update(GRAPH_HINT_KEY, true);
	void vscode.window
		.showInformationMessage(
			'Git Easy Ops: right-click a commit in the "Git Easy Ops" view - its Graph group is the commit graph - or in the Timeline, or use the Command Palette.',
			'Where are the menus?',
		)
		.then((choice) => {
			if (choice === 'Where are the menus?') {
				void vscode.commands.executeCommand('geco.explainMenus');
			} else {
				output.appendLine('Run "Git Easy Ops: Why Don\'t I See the Menus?" any time for every entry point.');
			}
		});
}
