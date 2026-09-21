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
import { createGitExec, createProcessExec, type GitExec } from './core/gitRunner';
import type { Settings } from './core/config';
import { HIDDEN_MENU_ITEMS_FULL_KEY, HIDDEN_MENU_ITEMS_SETTING, contextKeysFor, defaultHiddenIds, effectiveHiddenList, parseHiddenItems } from './core/menuVisibility';
import { affectsGeco, readSettings, resolveGitPath } from './vscode/settings';
import { VsCodeUI } from './vscode/uiAdapter';
import { GecoHistoryProvider, GecoTreeItem } from './vscode/treeView';
import { MenuEditorProvider, commandTitlesFromManifest } from './vscode/menuEditorTree';
import { applyMenuContext } from './vscode/menuContext';
import { loadGitApi, repositoryPaths, resolveRepoPath, type GitApiLike } from './vscode/repository';
import { describeInstalledBuild, FsFileStore } from './vscode/graphMenu';

const VIEW_ID = 'geco.history';
const MENU_EDITOR_VIEW_ID = 'geco.menuEditor';
const GRAPH_HINT_KEY = 'geco.graphMenuHintShown';

interface Runtime {
	settings: Settings;
	exec: GitExec;
	processExec: GitExec;
	controller: Controller;
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Git Easy Ops');
	context.subscriptions.push(output);

	const ui = new VsCodeUI(output);
	const gitApi: GitApiLike | undefined = loadGitApi();
	if (!gitApi) {
		output.appendLine('The vscode.git API is unavailable; falling back to workspace folders.');
	}

	let activeRepo: string | undefined = repositoryPaths(gitApi)[0];
	let tree: GecoHistoryProvider | undefined;

	/**
	 * One coalesced repaint burst per change, aimed at BOTH graphs:
	 *
	 *  - our own view (the sidebar "Graph" group) repaints from `tree.refresh`;
	 *  - the *built-in* Source Control Graph belongs to the vscode.git
	 *    extension and only redraws when that extension re-syncs its state.
	 *    `git.refresh`, given the repository root as a hint, asks exactly that
	 *    (and never pops a repository picker, which a bare `git.refresh`
	 *    would do with several repositories open). Without this half, a
	 *    fast-forward or a deleted branch can leave the built-in graph stale
	 *    even though our own view is current.
	 *
	 * Bursts are debounced, so a journal write plus the command finishing
	 * plus a watcher tick collapse into one repaint, and every burst is
	 * logged - open the "Git Easy Ops" output channel to see whether (and
	 * why) a refresh happened.
	 */
	let refreshBurst: ReturnType<typeof setTimeout> | undefined;
	const scheduleRefresh = (reason: string) => {
		if (refreshBurst) {
			return;
		}
		output.appendLine(`refresh scheduled: ${reason}`);
		refreshBurst = setTimeout(() => {
			refreshBurst = undefined;
			tree?.refresh();
			if (!activeRepo) {
				return;
			}
			const known = (gitApi?.repositories ?? []).some((repo) => repo.rootUri.fsPath === activeRepo);
			if (!known) {
				// The git extension does not know this repository (it is not in
				// a workspace folder it detected): there is no built-in graph
				// for it to refresh, and asking git.refresh would open a picker.
				return;
			}
			output.appendLine(`refreshing the built-in git state of ${activeRepo} (git.refresh)`);
			void Promise.resolve(vscode.commands.executeCommand('git.refresh', activeRepo)).catch((error: unknown) => {
				output.appendLine(`git.refresh failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}, 150);
	};

	// The tree exists further down, but the controller needs to be able to
	// refresh it from the moment it runs its first operation - including the
	// follow-up actions that outlive the command call. Every journaled
	// operation (and every undo) schedules a burst, so the graph a squash
	// just rewrote is current before the result notification is even
	// dismissed, and so is the branch list after a cleanup.
	let runtime = buildRuntime(readSettings(), ui, () => scheduleRefresh('an operation changed the repository'));

	const createdTree = new GecoHistoryProvider({
		controller: () => runtime.controller,
		repoPath: () => activeRepo,
		settings: () => runtime.settings,
		onError: (message) => output.appendLine(message),
	});
	tree = createdTree;
	context.subscriptions.push(createdTree);
	// `canSelectMany` is what makes multi-select (Ctrl/Shift-click) work in the
	// Graph group: VS Code then hands a context-menu command the clicked node
	// plus every selected node, which is how "Squash Selected Commits..." sees
	// the whole selection.
	const treeView = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: createdTree, showCollapseAll: true, canSelectMany: true });
	context.subscriptions.push(treeView);

	// --- Customize Context Menus -------------------------------------------
	// The hidden "Git Easy Ops Menus" view plus the context-key state machine.
	// Applied right on activation and re-applied whenever the setting changes
	// (also from another window or Settings Sync) - every window converges.
	const applyMenus = () => {
		const hidden = readHiddenMenuItems();
		void applyMenuContext(contextKeysFor(hidden), (key, value) => vscode.commands.executeCommand('setContext', key, value));
		return hidden;
	};
	// The stored value, with its `undefined` meaning: an explicit list (even
	// `[]`) is authoritative, a missing value means "the catalogue defaults
	// apply" - which is where the default-hidden rows live.
	const readStoredHiddenItems = (): string[] | undefined => {
		const raw = vscode.workspace.getConfiguration('geco').get<string[] | undefined>(HIDDEN_MENU_ITEMS_SETTING);
		return raw === undefined ? undefined : parseHiddenItems(raw);
	};
	const readHiddenMenuItems = () => effectiveHiddenList(readStoredHiddenItems());

	const menuEditor = new MenuEditorProvider({
		titles: commandTitlesFromManifest(context.extension.packageJSON),
		hidden: () => readHiddenMenuItems(),
		setHidden: (ids) => writeHiddenMenuItems(ids, output),
		graphBuildInstalled: () => Boolean(context.extension.packageJSON?.contributes?.menus?.['scm/historyItem/context']),
		onLog: (message) => output.appendLine(message),
	});
	context.subscriptions.push(menuEditor);
	const menuEditorView = vscode.window.createTreeView(MENU_EDITOR_VIEW_ID, {
		treeDataProvider: menuEditor,
		manageCheckboxStateManually: true,
	});
	context.subscriptions.push(
		menuEditorView,
		menuEditorView.onDidChangeCheckboxState((event) => {
			void menuEditor.handleCheckboxChange(event.items);
		}),
	);
	applyMenus();

	const setRepoContext = () => {
		void vscode.commands.executeCommand('setContext', 'geco.repositoryOpen', Boolean(activeRepo));
	};
	setRepoContext();

	/**
	 * Changes made elsewhere - another window, the terminal, a colleague's
	 * push - never pass through this window's hooks, so they need a watcher.
	 * The built-in git extension keeps its own views current the same way
	 * (it watches the repository's git directory); this mirrors that for our
	 * view. The journal file lives in the common git directory, so the same
	 * watcher also catches operations journaled by *other windows*.
	 */
	let repoWatcher: vscode.FileSystemWatcher | undefined;
	let watchedDir: string | undefined;
	const watchRepository = async (repoPath: string | undefined): Promise<void> => {
		if (repoWatcher) {
			repoWatcher.dispose();
			repoWatcher = undefined;
			watchedDir = undefined;
		}
		if (!repoPath) {
			return;
		}
		try {
			const commonDir = await runtime.controller.contextFor(repoPath).git.commonDir();
			if (commonDir === watchedDir) {
				return;
			}
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(commonDir), '**'));
			watcher.onDidChange(() => scheduleRefresh('the repository changed on disk'));
			watcher.onDidCreate(() => scheduleRefresh('the repository changed on disk'));
			watcher.onDidDelete(() => scheduleRefresh('the repository changed on disk'));
			context.subscriptions.push(watcher);
			repoWatcher = watcher;
			watchedDir = commonDir;
			output.appendLine(`watching ${commonDir} for changes made elsewhere (another window, the terminal, a push)`);
		} catch (error) {
			output.appendLine(`Could not start the repository watcher: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const rememberRepo = (repoPath: string | undefined) => {
		if (repoPath && repoPath !== activeRepo) {
			activeRepo = repoPath;
			setRepoContext();
			scheduleRefresh('the active repository changed');
			void watchRepository(repoPath);
		}
	};
	void watchRepository(activeRepo);

	/** Resolve the repository, run an operation, then refresh both graphs. */
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
			scheduleRefresh('a command finished');
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
		['geco.removeRedundantBranches', async (cwd) => runtime.controller.removeRedundantBranches(cwd)],
		['geco.checkoutBranch', async (cwd, args) => runtime.controller.checkoutBranch(cwd, args)],
		['geco.undoLastOperation', async (cwd) => runtime.controller.undoLastOperation(cwd)],
		['geco.showBackups', async (cwd) => runtime.controller.showBackups(cwd)],
		['geco.cleanHistory', async (cwd) => runtime.controller.cleanHistory(cwd)],
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
			void watchRepository(activeRepo);
			scheduleRefresh('manual refresh');
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
		// "Customize Context Menus..." - works with no repository open (the
		// editor is about the menus, not about git), reveals the hidden view.
		vscode.commands.registerCommand('geco.customizeMenus', async () => {
			await vscode.commands.executeCommand(`${MENU_EDITOR_VIEW_ID}.focus`);
		}),
		vscode.commands.registerCommand('geco.menuResetAll', async () => {
			// "Default" is the *absence* of a stored value, and a workspace
			// value would keep overriding the user scope - clear it in every
			// scope where one exists (default-hidden rows become hidden again).
			const config = vscode.workspace.getConfiguration('geco');
			const inspect = config.inspect<string[]>(HIDDEN_MENU_ITEMS_SETTING);
			if (inspect?.workspaceValue !== undefined) {
				await config.update(HIDDEN_MENU_ITEMS_SETTING, undefined, vscode.ConfigurationTarget.Workspace);
			}
			if (inspect?.globalValue !== undefined) {
				await config.update(HIDDEN_MENU_ITEMS_SETTING, undefined, vscode.ConfigurationTarget.Global);
			}
			output.appendLine(`${HIDDEN_MENU_ITEMS_FULL_KEY} -> default (no stored list)`);
			applyMenus();
			menuEditor.refresh();
			await vscode.window.showInformationMessage('Git Easy Ops: the menu items were restored to their defaults.');
		}),
	);

	// Keep the view alive as repositories and settings change.
	if (gitApi?.onDidOpenRepository) {
		context.subscriptions.push(
			gitApi.onDidOpenRepository((repo) => {
				activeRepo = repo.rootUri.fsPath;
				setRepoContext();
				scheduleRefresh('a repository was opened');
				void watchRepository(repo.rootUri.fsPath);
			}),
		);
	}
	if (gitApi?.onDidCloseRepository) {
		context.subscriptions.push(
			gitApi.onDidCloseRepository(() => {
				activeRepo = repositoryPaths(gitApi)[0];
				setRepoContext();
				scheduleRefresh('a repository was closed');
				void watchRepository(activeRepo);
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
			runtime = buildRuntime(readSettings(), ui, () => scheduleRefresh('an operation changed the repository'));
			output.appendLine('Settings reloaded.');
			scheduleRefresh('settings changed');
			// Hidden-menu items changed here or in another window: converge.
			applyMenus();
			menuEditor.refresh();
		}),
	);

	maybeShowEntryPointHint(context, runtime.settings, output);
	output.appendLine(`Git Easy Ops ready (git: ${resolveGitPath(runtime.settings) ?? 'git from PATH'}).`);
}

/**
 * Persists `geco.hiddenMenuItems`. User scope by default; when a workspace
 * value exists it stays a workspace override (so trimming menus in a work
 * repository never changes the home repository).
 *
 * Writing `undefined` means "the catalogue defaults apply" (the manifest
 * deliberately carries no default - a stored `undefined` must never fall back
 * to a default that would re-hide a row the user just re-enabled). It is only
 * written when the choice equals the default AND the choice lives in the user
 * scope; in the workspace scope `undefined` would fall through to the (possibly
 * different) user value, so the workspace always stores a concrete array.
 */
async function writeHiddenMenuItems(ids: readonly string[], output: vscode.OutputChannel): Promise<void> {
	const config = vscode.workspace.getConfiguration('geco');
	const inspect = config.inspect<string[]>(HIDDEN_MENU_ITEMS_SETTING);
	const target = inspect?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
	const defaultIds = defaultHiddenIds();
	const equalsDefault = ids.length === defaultIds.length && defaultIds.every((id) => ids.includes(id));
	const value = equalsDefault && target === vscode.ConfigurationTarget.Global ? undefined : [...ids];
	await config.update(HIDDEN_MENU_ITEMS_SETTING, value, target);
	output.appendLine(
		`${HIDDEN_MENU_ITEMS_FULL_KEY} -> ${target === vscode.ConfigurationTarget.Workspace ? 'workspace' : 'user'}: ${value === undefined ? '(default)' : `[${ids.join(', ')}]`}`,
	);
}

function buildRuntime(settings: Settings, ui: VsCodeUI, onRepositoryChanged: () => void): Runtime {
	const exec = createGitExec({ gitPath: resolveGitPath(settings) });
	// The process runner for everything that is not git itself: the
	// git-filter-repo probe/rewrite of "Clean History" and its installers.
	const processExec = createProcessExec({});
	return { settings, exec, processExec, controller: new Controller({ ui, settings, exec, processExec, onRepositoryChanged }) };
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
