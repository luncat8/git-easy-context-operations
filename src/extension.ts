/**
 * Git Easy Ops - activation and wiring.
 *
 * Everything git-related lives in `src/core` (pure, injectable, tested without
 * VS Code). This file only connects that core to the editor: settings, output
 * channel, the tree view, the commands and the repository picker.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import { Controller, type PatchFileMemory, type RewordFlow } from './core/controller';
import { createGitExec, createProcessExec, type GitExec } from './core/gitRunner';
import type { Settings } from './core/config';
import { HIDDEN_MENU_ITEMS_FULL_KEY, HIDDEN_MENU_ITEMS_SETTING, contextKeysFor, defaultHiddenIds, effectiveHiddenList, parseHiddenItems } from './core/menuVisibility';
import { GRAPH_MENU_VISIBLE_CONTEXT_KEY, isGraphMenuVisible } from './core/graphMenu';
import { reportWithoutWaiting } from './core/ui';
import { describeUnavailableViews, isMissingViewError } from './core/viewAvailability';
import { affectsGeco, readSettings, resolveGitPath } from './vscode/settings';
import { VsCodeUI } from './vscode/uiAdapter';
import { GecoHistoryProvider, GecoTreeItem } from './vscode/treeView';
import { MenuEditorProvider, commandTitlesFromManifest, type MenuEditorNode } from './vscode/menuEditorTree';
import { DialogDecisionsProvider, type DecisionRowNode } from './vscode/dialogDecisionsTree';
import { WorkspaceDialogDecisionStore, canonicalRepoKey } from './vscode/dialogDecisionStore';
import { countDecisionRepositories, dialogDecisionById, type DialogDecisionId } from './core/dialogDecisions';
import { applyMenuContext } from './vscode/menuContext';
import { loadGitApi, repositoryPaths, resolveRepoPath, type GitApiLike } from './vscode/repository';
import { describeInstalledBuild, FsFileStore } from './vscode/graphMenu';
import { scmResourceFileUris } from './core/scmFileArgs';
import { openFilesForEdit } from './vscode/fileOpen';

const VIEW_ID = 'geco.history';
const MENU_EDITOR_VIEW_ID = 'geco.menuEditor';
const DIALOG_DECISIONS_VIEW_ID = 'geco.dialogDecisions';
const GRAPH_HINT_KEY = 'geco.graphMenuHintShown';
/** Workspace-state key: repository path -> last patch file auto-applied there. */
const LAST_PATCH_FILES_KEY = 'geco.lastPatchFileByRepo';

/**
 * Files inside the git directory that no refresh may react to: plain
 * `git status` writes the index, staging and every commit dialog write the
 * message drafts, and the git extension does both on its own. None of them
 * can change what a commit graph shows, and reacting to them would bounce a
 * refresh straight back into the extension that wrote them.
 */
const IGNORED_GIT_FILES = new Set(['index', 'index.lock', 'COMMIT_EDITMSG', 'COMMIT_EDITMSG.lock', 'MERGE_MSG', 'SQUASH_MSG']);

interface Runtime {
	settings: Settings;
	exec: GitExec;
	processExec: GitExec;
	controller: Controller;
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Git Easy Ops');
	context.subscriptions.push(output);

	// Are the proposed Source Control Graph menus really on screen in this
	// session? That (and only that) hides "Why Don't I See the Menus?" from
	// both header overflow menus - the question is only offered while it is
	// still open, so a grant configured a minute ago but not yet restarted
	// keeps it. The installed build cannot change within a session, so the
	// verdict is taken once, as early as activation allows; until it is,
	// the unset key leaves the help entry visible (fail-open).
	const installedBuild = describeInstalledBuild(context);
	const graphMenuVisible = isGraphMenuVisible(installedBuild);
	void vscode.commands.executeCommand('setContext', GRAPH_MENU_VISIBLE_CONTEXT_KEY, graphMenuVisible);
	output.appendLine(graphMenuVisible
		? 'The Source Control Graph menus are visible in this session; "Why Don\'t I See the Menus?" stays out of the headers (the Command Palette keeps it).'
		: 'The Source Control Graph menus are not visible in this session; "Why Don\'t I See the Menus?" explains which half is missing.');

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
	 * Asking for that re-sync is not free: `git.refresh` is a write operation
	 * for the git extension (it re-reads status, refs, remotes, submodules and
	 * worktrees), so the Source Control view shows its progress bar and the
	 * repository counts as busy until the scan is done. A burst therefore only
	 * asks for it when something can really have changed the repository - the
	 * `reSync` flag - and never for the commands that only read: copying a SHA
	 * or the web link, showing the backups, the menu editor. Only one re-sync
	 * is ever in flight: a burst that arrives while the git extension is still
	 * busy queues exactly one follow-up run instead of stacking, so the
	 * Source Control progress cannot be kept alive by our own bursts.
	 *
	 * Bursts are coalesced, so a journal write plus the command finishing plus
	 * a watcher tick collapse into one repaint; a later reason that does need
	 * the re-sync upgrades the pending burst instead of being swallowed. Every
	 * burst is logged - open the "Git Easy Ops" output channel to see whether
	 * (and why) a refresh happened.
	 */
	let refreshBurst: ReturnType<typeof setTimeout> | undefined;
	let refreshBurstReSync = false;
	let reSyncInFlight = false;
	let reSyncQueued = false;

	/** Ask the git extension to re-sync the repository our view shows. */
	const reSyncBuiltInGraph = (): void => {
		if (!activeRepo) {
			return;
		}
		const known = (gitApi?.repositories ?? []).some((repo) => repo.rootUri.fsPath === activeRepo);
		if (!known) {
			// The git extension does not know this repository (it is not in a
			// workspace folder it detected): there is no built-in graph for it
			// to refresh, and asking git.refresh would open a picker.
			return;
		}
		if (reSyncInFlight) {
			reSyncQueued = true;
			output.appendLine('the built-in git state is still being re-synced - queued one more');
			return;
		}
		reSyncInFlight = true;
		const startedAt = Date.now();
		output.appendLine(`refreshing the built-in git state of ${activeRepo} (git.refresh)`);
		void Promise.resolve(vscode.commands.executeCommand('git.refresh', activeRepo))
			.then(
				() => {
					// The duration is logged on purpose: "the Source Control
					// progress bar does not go away" is answered by this line
					// either arriving late or not arriving at all.
					output.appendLine(`the built-in git state of ${activeRepo} is current again (${Date.now() - startedAt} ms)`);
				},
				(error: unknown) => {
					output.appendLine(`git.refresh failed after ${Date.now() - startedAt} ms: ${error instanceof Error ? error.message : String(error)}`);
				},
			)
			.then(() => {
				reSyncInFlight = false;
				if (reSyncQueued) {
					reSyncQueued = false;
					reSyncBuiltInGraph();
				}
			});
	};

	/**
	 * Repaint our own view on every change; ask the git extension to re-sync
	 * only when `reSync` says the git state can have changed.
	 */
	const scheduleRefresh = (reason: string, reSync = false) => {
		refreshBurstReSync = refreshBurstReSync || reSync;
		if (refreshBurst) {
			output.appendLine(`refresh already scheduled: ${reason}`);
			return;
		}
		output.appendLine(`refresh scheduled: ${reason}`);
		refreshBurst = setTimeout(() => {
			refreshBurst = undefined;
			const reSyncNow = refreshBurstReSync;
			refreshBurstReSync = false;
			tree?.refresh();
			if (reSyncNow) {
				reSyncBuiltInGraph();
			}
		}, 150);
	};

	// The tree exists further down, but the controller needs to be able to
	// refresh it from the moment it runs its first operation - including the
	// follow-up actions that outlive the command call. Every journaled
	// operation (and every undo) schedules a burst, so the graph a squash
	// just rewrote is current before the result notification is even
	// dismissed, and so is the branch list after a cleanup.
	// "Apply Patch Automatically" remembers, per repository, the patch file
	// it last applied successfully - in workspace state, so the memory is
	// this workspace's, survives reloads, and never leaks into settings
	// (a patch path is machine-local and often outside the repository).
	const lastPatchFile = {
		get: (repoPath: string) => context.workspaceState.get<Record<string, string>>(LAST_PATCH_FILES_KEY, {})[repoPath],
		set: async (repoPath: string, patchFile: string) => {
			const remembered = { ...context.workspaceState.get<Record<string, string>>(LAST_PATCH_FILES_KEY, {}) };
			remembered[repoPath] = patchFile;
			await context.workspaceState.update(LAST_PATCH_FILES_KEY, remembered);
		},
	};

	// Saved dialog decisions: workspace state, scoped per repository, never
	// synced. The store is shared by every rebuilt runtime; its change hook
	// repaints the management view (declared further down).
	let dialogDecisionsView: DialogDecisionsProvider | undefined;
	const dialogDecisionStore = new WorkspaceDialogDecisionStore(context.workspaceState, () => dialogDecisionsView?.refresh());

	let runtime = buildRuntime(readSettings(), ui, () => scheduleRefresh('an operation changed the repository', true), lastPatchFile, dialogDecisionStore);

	const createdTree = new GecoHistoryProvider({
		controller: () => runtime.controller,
		repoPath: () => activeRepo,
		settings: () => runtime.settings,
		onError: (message) => output.appendLine(message),
	});
	tree = createdTree;
	context.subscriptions.push(createdTree);

	// --- Views the window may not know yet ---------------------------------
	// A view id only exists in the workbench after the window loaded the
	// `package.json` that declares it. A window that is still running the
	// previous manifest - "Restart Extensions", an in-place extension update,
	// a development host left open - answers `createTreeView` with
	// "No view is registered with id: geco.dialogDecisions". Left uncaught,
	// that error aborts `activate`: no commands, no git hooks, no tree. An
	// optional view is never worth the whole extension, so a missing view is
	// logged, remembered, and reported once with the action that repairs it
	// (a reload registers the new manifest) while everything else starts.
	const unavailableViews: string[] = [];
	const noteUnavailableView = (label: string, why: string): void => {
		if (!unavailableViews.includes(label)) {
			unavailableViews.push(label);
		}
		output.appendLine(
			`The "${label}" view is not available in this window (${why}). `
			+ 'The window is still using the view list it loaded when it opened; reload it to finish updating.',
		);
	};
	const reportUnavailableViews = (): void => {
		const report = describeUnavailableViews(unavailableViews);
		if (!report) {
			return;
		}
		reportWithoutWaiting(async () => {
			const chosen = await vscode.window.showWarningMessage(report.message, { detail: report.detail }, report.action);
			if (chosen === report.action) {
				await vscode.commands.executeCommand('workbench.action.reloadWindow');
			}
		});
	};
	const openTreeView = <T>(id: string, label: string, options: vscode.TreeViewOptions<T>): vscode.TreeView<T> | undefined => {
		try {
			const view = vscode.window.createTreeView(id, options);
			context.subscriptions.push(view);
			return view;
		} catch (error) {
			if (!isMissingViewError(error)) {
				throw error;
			}
			noteUnavailableView(label, error instanceof Error ? error.message : String(error));
			return undefined;
		}
	};
	/** Reveal a hidden view; a window that predates it is told how to get it. */
	const focusTreeView = async (id: string, label: string): Promise<void> => {
		try {
			await vscode.commands.executeCommand(`${id}.focus`);
		} catch (error) {
			noteUnavailableView(label, error instanceof Error ? error.message : String(error));
			reportUnavailableViews();
		}
	};

	// `canSelectMany` is what makes multi-select (Ctrl/Shift-click) work in the
	// Graph group: VS Code then hands a context-menu command the clicked node
	// plus every selected node, which is how "Squash Selected Commits..." sees
	// the whole selection.
	openTreeView(VIEW_ID, 'Git Easy Ops', { treeDataProvider: createdTree, showCollapseAll: true, canSelectMany: true });

	// --- Customize Context Menus -------------------------------------------
	// The hidden "Git Easy Ops Menu Editor" view plus the context-key state machine.
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
	const menuEditorView = openTreeView(MENU_EDITOR_VIEW_ID, 'Git Easy Ops Menu Editor', {
		treeDataProvider: menuEditor,
		manageCheckboxStateManually: true,
	});
	if (menuEditorView) {
		context.subscriptions.push(menuEditorView.onDidChangeCheckboxState((event) => {
			void menuEditor.handleCheckboxChange(event.items);
		}));
	}
	applyMenus();

	// --- Manage Dialog Decisions -------------------------------------------
	// The hidden "Git Easy Ops Dialog Decisions" view: one row per question,
	// checkbox = saved answer. Enabling a destructive answer asks a fresh
	// modal confirmation here — that confirmation is deliberately not one
	// of the rememberable dialogs, and unchecking/resetting (the safe
	// direction) never asks.
	const enableDialogDecision = async (id: DialogDecisionId): Promise<boolean> => {
		if (!activeRepo) {
			return false;
		}
		const def = dialogDecisionById(id);
		if (!def || def.kind !== 'eligible') {
			return false;
		}
		if (def.destructive) {
			const accept: vscode.MessageItem = { title: def.confirmLabel ?? 'Enable' };
			const cancel: vscode.MessageItem = { title: 'Cancel', isCloseAffordance: true };
			const chosen = await vscode.window.showWarningMessage(
				`Always answer "${def.action}" with "${def.confirmLabel}" for this repository?`,
				{
					modal: true,
					detail: `Future runs skip the question ${def.question} for ${activeRepo} while "Remember dialog decisions" (geco.rememberDialogDecisions) is on. `
						+ 'Only that question is skipped: repository checks, recovery points and journaling still run, and the target of each run is still picked by that run. '
						+ 'Reset it any time in this view (uncheck the row, or "Reset Saved Decision to Default").',
				},
				accept,
				cancel,
			);
			if (chosen !== accept) {
				output.appendLine(`Saved decision not enabled: "${def.action}" (confirmation declined).`);
				return false;
			}
		}
		await dialogDecisionStore.save(activeRepo, id);
		output.appendLine(`Saved decision enabled: "${def.action}" -> always "${def.confirmLabel}" for ${activeRepo}.`);
		return true;
	};
	const dialogDecisionsProvider = new DialogDecisionsProvider({
		masterEnabled: () => readSettings().rememberDialogDecisions,
		repoPath: () => (activeRepo ? canonicalRepoKey(activeRepo) : undefined),
		raw: () => dialogDecisionStore.raw(),
		setEnabled: async (id, enabled) => {
			if (!activeRepo) {
				return false;
			}
			if (!enabled) {
				await dialogDecisionStore.reset(activeRepo, id);
				return true;
			}
			return enableDialogDecision(id);
		},
		onLog: (message) => output.appendLine(message),
	});
	dialogDecisionsView = dialogDecisionsProvider;
	context.subscriptions.push(dialogDecisionsProvider);
	const dialogDecisionsTreeView = openTreeView(DIALOG_DECISIONS_VIEW_ID, 'Git Easy Ops Dialog Decisions', {
		treeDataProvider: dialogDecisionsProvider,
		manageCheckboxStateManually: true,
	});
	if (dialogDecisionsTreeView) {
		context.subscriptions.push(dialogDecisionsTreeView.onDidChangeCheckboxState((event) => {
			void dialogDecisionsProvider.handleCheckboxChange(event.items);
		}));
	}

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
	 *
	 * Only entries that can mean "history changed" are reported (see
	 * {@link IGNORED_GIT_FILES}): reacting to the index would bounce a refresh
	 * straight back into the git extension, whose own scans are what wrote it.
	 */
	let repoWatcher: vscode.FileSystemWatcher | undefined;
	let watchedDir: string | undefined;
	const watchRepository = async (repoPath: string | undefined): Promise<void> => {
		if (!repoPath) {
			if (repoWatcher) {
				repoWatcher.dispose();
				repoWatcher = undefined;
				watchedDir = undefined;
			}
			return;
		}
		try {
			const commonDir = await runtime.controller.contextFor(repoPath).git.commonDir();
			if (commonDir === watchedDir && repoWatcher) {
				// Already watching exactly this directory: keep the watcher and
				// its subscription instead of tearing it down and pushing a new
				// one on every manual refresh.
				return;
			}
			if (repoWatcher) {
				repoWatcher.dispose();
				repoWatcher = undefined;
				watchedDir = undefined;
			}
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(commonDir), '**'));
			const onRepositoryFile = (uri: vscode.Uri) => {
				const name = path.basename(uri.fsPath);
				if (IGNORED_GIT_FILES.has(name)) {
					return;
				}
				scheduleRefresh(`the repository changed on disk (${name})`, true);
			};
			watcher.onDidChange(onRepositoryFile);
			watcher.onDidCreate(onRepositoryFile);
			watcher.onDidDelete(onRepositoryFile);
			context.subscriptions.push(watcher);
			repoWatcher = watcher;
			watchedDir = commonDir;
			output.appendLine(`watching ${commonDir} for changes made elsewhere (another window, the terminal, a push)`);
		} catch (error) {
			output.appendLine(`Could not start the repository watcher: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	/**
	 * Our view follows the repository the user is working in; the git extension
	 * does not need to be told about that. Switching the repository our view
	 * shows changes nothing in git, so this only repaints - asking the git
	 * extension to re-sync here would put the Source Control view's progress
	 * bar on the screen for a plain editor/window focus change (a read-only
	 * command like *Copy Repository Web Link* runs through here when it is the
	 * first thing that touches another repository).
	 */
	const rememberRepo = (repoPath: string | undefined) => {
		if (repoPath && repoPath !== activeRepo) {
			activeRepo = repoPath;
			setRepoContext();
			dialogDecisionsProvider.refresh();
			scheduleRefresh('the active repository changed');
			void watchRepository(repoPath);
		}
	};
	void watchRepository(activeRepo);

	/**
	 * Resolve the repository, run an operation, then repaint our own view.
	 *
	 * The command wrapper deliberately does *not* ask the git extension to
	 * re-sync: a command may have read only (Copy SHA, Copy Repository Web
	 * Link, Show Backups, the menu editor) and re-syncing anyway would show the
	 * Source Control progress bar and scan the repository for nothing. What a
	 * command did change is reported by the controller's change hook (a
	 * journal write, an undo) and by the watcher on the git directory, both of
	 * which ask for the re-sync themselves.
	 */
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
		['geco.applyPatchAutomatically', async (cwd) => runtime.controller.applyPatchAutomatically(cwd)],
		['geco.findProperBase', async (cwd, args) => runtime.controller.showProperBase(cwd, args)],
		['geco.createBackupBranch', async (cwd, args) => runtime.controller.createBackupBranch(cwd, args)],
		['geco.createBranch', async (cwd, args) => runtime.controller.createBranch(cwd, args)],
		['geco.renameBranch', async (cwd, args) => runtime.controller.renameBranch(cwd, args)],
		['geco.deleteBranch', async (cwd, args) => runtime.controller.deleteBranch(cwd, args)],
		['geco.removeRedundantBranches', async (cwd) => runtime.controller.removeRedundantBranches(cwd)],
		['geco.diagnosePushSync', async (cwd) => runtime.controller.diagnosePushSync(cwd)],
		['geco.checkoutBranch', async (cwd, args) => runtime.controller.checkoutBranch(cwd, args)],
		['geco.undoLastOperation', async (cwd) => runtime.controller.undoLastOperation(cwd)],
		['geco.showBackups', async (cwd) => runtime.controller.showBackups(cwd)],
		['geco.cleanHistory', async (cwd) => runtime.controller.cleanHistory(cwd)],
		['geco.copyCommitSha', async (cwd, args) => runtime.controller.copyCommitSha(cwd, args)],
		['geco.copyRepositoryWebLink', async (cwd) => runtime.controller.copyRepositoryWebLink(cwd)],
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
			scheduleRefresh('manual refresh', true);
		}),
		// "Open Source for Edit" - the changed-file rows of the built-in
		// Source Control view open a (usually read-only) diff by default;
		// this opens the file itself in an editable editor tab. It is
		// contributed to `scm/resourceState/context` in the manifest and
		// needs the row the menu handed us, so it stays out of the palette.
		vscode.commands.registerCommand('geco.openSourceForEdit', async (...args: unknown[]) => {
			const uris = scmResourceFileUris(args);
			if (uris.length === 0) {
				output.appendLine('no file to open for edit (the menu arguments carried no usable resource)');
				reportWithoutWaiting(() => vscode.window.showWarningMessage(
					'Git Easy Ops: there is no file to open for edit. Right-click a changed file in the Source Control view.',
				));
				return;
			}
			await openFilesForEdit(uris, output);
		}),
		vscode.commands.registerCommand('geco.explainMenus', async () => {
			await runtime.controller.explainMenus();
			output.show(true);
		}),
		vscode.commands.registerCommand('geco.enableGraphMenu', async () => {
			const build = installedBuild;
			// Two ways to allow the proposed API: the editor's product.json (no
			// command line at all) and the per-user argv.json.
			await runtime.controller.enableGraphMenu(build, new FsFileStore(build.argvPath), new FsFileStore(build.productPath));
			output.show(true);
		}),
		// "Customize Context Menus..." - works with no repository open (the
		// editor is about the menus, not about git), reveals the hidden view.
		vscode.commands.registerCommand('geco.customizeMenus', async () => {
			await focusTreeView(MENU_EDITOR_VIEW_ID, 'Git Easy Ops Menu Editor');
		}),
		// "Manage Dialog Decisions..." - works with no repository open (the
		// view then explains what is missing), reveals the hidden view.
		vscode.commands.registerCommand('geco.manageDialogDecisions', async () => {
			await focusTreeView(DIALOG_DECISIONS_VIEW_ID, 'Git Easy Ops Dialog Decisions');
		}),
		vscode.commands.registerCommand('geco.dialogDecisionToggle', async (node?: DecisionRowNode) => {
			if (!node || node.nodeKind !== 'decision' || node.def.kind !== 'eligible' || !activeRepo) {
				return;
			}
			if (node.saved) {
				await dialogDecisionStore.reset(activeRepo, node.def.id);
				output.appendLine(`Saved decision reset: "${node.def.action}" asks every time again.`);
			} else {
				await enableDialogDecision(node.def.id);
			}
			dialogDecisionsProvider.refresh();
		}),
		vscode.commands.registerCommand('geco.dialogDecisionReset', async (node?: DecisionRowNode) => {
			if (!node || node.nodeKind !== 'decision' || node.def.kind !== 'eligible' || !activeRepo) {
				return;
			}
			await dialogDecisionStore.reset(activeRepo, node.def.id);
			output.appendLine(`Saved decision reset: "${node.def.action}" asks every time again.`);
			dialogDecisionsProvider.refresh();
		}),
		vscode.commands.registerCommand('geco.dialogDecisionsClearAll', async () => {
			// A fresh, never-rememberable confirmation with the full scope in
			// the text: this clears every repository in this workspace, not
			// just the one in the view, and it does not touch the master switch.
			const repositories = countDecisionRepositories(dialogDecisionStore.raw());
			if (repositories === 0) {
				reportWithoutWaiting(() => vscode.window.showInformationMessage('Git Easy Ops: there are no saved dialog decisions in this workspace.'));
				return;
			}
			const accept: vscode.MessageItem = { title: 'Clear All Saved Decisions' };
			const cancel: vscode.MessageItem = { title: 'Cancel', isCloseAffordance: true };
			const chosen = await vscode.window.showWarningMessage(
				`Clear every saved dialog decision in this workspace (${repositories} repositor${repositories === 1 ? 'y' : 'ies'})?`,
				{
					modal: true,
					detail: 'Every question returns to "Default (not enabled)" and will be asked again. The "Remember dialog decisions" setting itself is not changed.',
				},
				accept,
				cancel,
			);
			if (chosen !== accept) {
				return;
			}
			await dialogDecisionStore.clearAll();
			output.appendLine('Saved dialog decisions cleared for every repository in this workspace.');
			dialogDecisionsProvider.refresh();
			reportWithoutWaiting(() => vscode.window.showInformationMessage('Git Easy Ops: all saved dialog decisions were cleared.'));
		}),
		vscode.commands.registerCommand('geco.menuCopyItemName', async (node?: MenuEditorNode) => {
			if (node?.nodeKind !== 'row') return;
			const label = typeof node.label === 'string' ? node.label : node.label?.label;
			if (label) await vscode.env.clipboard.writeText(label);
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
			// Not awaited: a notification only resolves when it goes away, and
			// the command is done the moment the list is written (see
			// `reportWithoutWaiting`). This one is in the menu editor's
			// toolbar, where a pending command is merely pointless - in the
			// Source Control Graph it would be a progress indicator.
			reportWithoutWaiting(() => vscode.window.showInformationMessage('Git Easy Ops: the menu items were restored to their defaults.'));
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
			runtime = buildRuntime(readSettings(), ui, () => scheduleRefresh('an operation changed the repository', true), lastPatchFile, dialogDecisionStore);
			output.appendLine('Settings reloaded.');
			scheduleRefresh('settings changed');
			// Hidden-menu items changed here or in another window: converge.
			applyMenus();
			menuEditor.refresh();
			dialogDecisionsProvider.refresh();
		}),
	);

	maybeShowEntryPointHint(context, runtime.settings, output);
	// Everything else is wired by now, so a window that predates one of the
	// views gets a single actionable report instead of a failed activation.
	reportUnavailableViews();
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

function buildRuntime(
	settings: Settings,
	ui: VsCodeUI,
	onRepositoryChanged: () => void,
	lastPatchFile: PatchFileMemory,
	dialogDecisions?: WorkspaceDialogDecisionStore,
): Runtime {
	const exec = createGitExec({ gitPath: resolveGitPath(settings) });
	// The process runner for everything that is not git itself: the
	// git-filter-repo probe/rewrite of "Clean History" and its installers.
	const processExec = createProcessExec({});
	return { settings, exec, processExec, controller: new Controller({ ui, settings, exec, processExec, onRepositoryChanged, lastPatchFile, dialogDecisions }) };
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
