/**
 * The interactive layer: turns a menu click into questions, a confirmation with
 * a concrete plan, a git operation and a report - plus the follow-up actions
 * that usually come next (force push after a rewrite, undo after a mistake).
 *
 * It only talks to {@link UI} and {@link RepoContext}, so every flow below is
 * covered by tests that drive it with a fake UI against real repositories.
 */
import { createRepoContext, type RepoContext } from './context';
import type { GitExec } from './gitRunner';
import type { Settings } from './config';
import { ACTIONS, type ActionLabel, type QuickPickChoice, type UI } from './ui';
import { resolveMenuArgs } from './args';
import {
	applyMessageEdit,
	findRewriteBranch,
	messageSubject,
	normalizeMessage,
	previewSubject,
	rewordCommitMessage,
	type MessageEdit,
	type RewordResult,
} from './reword';
import { fastForwardBranch, resolveBranch, type FastForwardResult } from './fastForward';
import {
	collectPreviousCommits,
	composeSquashMessage,
	orderSquashSelection,
	parseSquashCount,
	squashCommits,
	type SquashResult,
} from './squash';
import {
	createBranch as createBranchCore,
	checkoutBranch as checkoutBranchCore,
	deleteBranch as deleteBranchCore,
	inspectBranchDeletion,
	renameBranch as renameBranchCore,
	suggestBranchName,
	type RenameBranchOptions,
} from './branch';
import { deleteRedundantBranches, findRedundantBranches } from './redundantBranches';
import { forcePush, planForcePush, type ForcePushResult } from './forcePush';
import {
	applyPatch,
	findProperBase,
	materializePatch,
	type ApplyPatchResult,
	type BaseEvaluation,
	type PatchSource,
} from './patch';
import { GecoError, isGecoError, toErrorMessage } from './errors';
import { assessGraphMenu, graphMenuFixOptions, GRAPH_MENU_PROPOSALS, type ArgvStore, type GraphMenuBuild, type GraphMenuFix } from './graphMenu';
import { addProposedApi } from './argvJson';
import { addProductProposals } from './productJson';
import { buildGraphRows, refRowsAt, type GraphCommitRow, type GraphRefRow } from './graphRows';
import { shorten, timestamp, type JournalEntry, type RecoveryPoint } from './safety';
import {
	analyzeDeadPaths,
	blockingCleanReasons,
	buildCommands,
	cleanWarnings,
	collectCleanFacts,
	createBackupBundle,
	deadPathsFileFor,
	defaultBundleFile,
	FILTER_REPO_TIMEOUT_MS,
	describeCleanConfirmation,
	formatBytes,
	formatCleanReport,
	reclaimSpace,
	writeDeadPathsFile,
	type CleanPlan,
	type CleanFacts,
	type DeadPathAnalysis,
	type FilterRepoRunner,
} from './cleanHistory';
import {
	externallyManagedHint,
	filterRepoInstallers,
	firstErrorLine,
	INSTALL_TIMEOUT_MS,
	INSTALLER_PROBE_TIMEOUT_MS,
	needsSudo,
	SUDO_PROBE,
	type FilterRepoInstaller,
	type InstallerRunner,
} from './installFilterRepo';
import type { CommitInfo, RefInfo } from './git';
import type { ForcePushMode, PatchDestination } from './config';

export type RewordFlow = 'replace' | 'append' | 'findReplace';

export interface ControllerOptions {
	ui: UI;
	settings: Settings;
	exec?: GitExec;
	/**
	 * Runs the external rewrite tool (`git filter-repo`) for "Clean History".
	 * Injectable so tests can stand in for a tool that is not installed.
	 */
	filterRepoRunner?: FilterRepoRunner;
	/**
	 * Runs arbitrary processes (installer probes, installations, and the
	 * `git-filter-repo` binary form) - unlike `exec`, which always spawns the
	 * git binary. Wired to `createProcessExec()` in production.
	 */
	processExec?: GitExec;
	/**
	 * Runs the installer probes and the installation itself when
	 * `git-filter-repo` is missing ("Install with pip3" / brew / sudo apt-get).
	 * Injectable so tests are independent of the tools on the host. When
	 * neither this nor `exec` exists, the flow falls back to informing only.
	 */
	filterRepoInstaller?: InstallerRunner;
	/**
	 * Called whenever an operation changed the repository. The VS Code layer
	 * refreshes the tree view with it, so the graph reflects a squash, a
	 * fast-forward or an undo the moment it is done - including the follow-up
	 * actions ("Undo", "Force Push") that only run after the command itself
	 * has already returned.
	 */
	onRepositoryChanged?(): void;
}

export interface CommitPick {
	label: string;
	description: string;
	detail?: string;
	sha: string;
}

export class Controller {
	constructor(private readonly options: ControllerOptions) {}

	private get ui(): UI {
		return this.options.ui;
	}

	private get settings(): Settings {
		return this.options.settings;
	}

	contextFor(cwd: string): RepoContext {
		return createRepoContext(cwd, this.settings, {
			exec: this.options.exec,
			onChanged: () => this.options.onRepositoryChanged?.(),
		});
	}

	// ------------------------------------------------------------- feature 1

	async rewordCommit(cwd: string, args: readonly unknown[], flow: RewordFlow): Promise<void> {
		await this.guard('Rename commit', async () => {
			const ctx = this.contextFor(cwd);
			const target = await this.resolveCommit(ctx, args, 'Rename which commit?');
			if (!target) {
				return;
			}
			const info = await ctx.git.commitInfo(target);
			const oldMessage = await ctx.git.rawMessage(target);

			const branch = await this.pickRewriteBranch(ctx, target, info);
			if (!branch) {
				return;
			}

			const edit = await this.askForMessage(info, flow);
			if (!edit) {
				return;
			}
			const newMessage = edit.message !== undefined ? (normalizeMessage(edit.message) || ' ') : applyMessageEdit(oldMessage, edit.edit!);
			if (normalizeMessage(oldMessage) === normalizeMessage(newMessage)) {
				await this.ui.message('info', `The message of ${info.shortSha} is unchanged - nothing was rewritten.`);
				return;
			}

			const descendants = await ctx.git.countCommits(`${target}..refs/heads/${branch}`);
			const total = 1 + descendants;
			const upstream = await ctx.git.upstream(branch);

			if (this.settings.confirmDestructiveOperations) {
				const confirmed = await this.ui.confirm(`Rename the message of ${info.shortSha} on ${branch}?`, {
					confirmLabel: 'Rename',
					destructive: true,
					detail: [
						`"${previewSubject(oldMessage)}"`,
						`   -> "${previewSubject(newMessage)}"`,
						'',
						`${total} commit${total === 1 ? '' : 's'} get a new SHA${descendants > 0 ? ` (${info.shortSha} plus ${descendants} after it)` : ''}. Trees, parents and author dates are kept.`,
						`Recovery point: ${this.settings.backupRefPrefix}... , restore it with "Git Easy Ops: Undo Last Operation".`,
						upstream?.sha ? `${branch} tracks ${upstream.remote}/${upstream.branch}: a force push is needed afterwards.` : '',
					].filter(Boolean).join('\n'),
				});
				if (!confirmed) {
					this.ui.log(`Rename of ${info.shortSha} cancelled by the user.`);
					return;
				}
			}

			const result = await this.ui.withProgress(`Renaming the message of ${info.shortSha}`, async (report) => {
				report(`rewriting ${total} commit${total === 1 ? '' : 's'} on ${branch}`);
				return rewordCommitMessage(ctx, { commit: target, message: edit.message, edit: edit.edit, branch });
			});

			await this.reportReword(ctx, result, cwd);
		});
	}

	private async askForMessage(info: CommitInfo, flow: RewordFlow): Promise<{ message?: string; edit?: MessageEdit } | undefined> {
		if (flow === 'replace') {
			const value = await this.ui.input({
				title: `Rename ${info.shortSha}`,
				// Only a clipped preview goes into the prompt - the full message
				// stays in the (editable) input value - so a long commit message
				// cannot stretch the input box past the screen.
				prompt: `New commit message (currently "${previewSubject(info.message)}")`,
				value: info.message,
			});
			if (value === undefined) {
				return undefined;
			}
			// An empty or whitespace-only replacement is accepted and stored as
			// a single space - handy for temporary commits that should stay quiet.
			return { message: value };
		}

		if (flow === 'append') {
			const value = await this.ui.input({
				title: `Append to ${info.shortSha}`,
				prompt: `Append to "${previewSubject(info.message)}"`,
				value: '',
				placeholder: 'add new button',
			});
			if (value === undefined) {
				return undefined;
			}
			if (!value.trim()) {
				await this.ui.message('warn', 'Nothing to append.');
				return undefined;
			}
			return { edit: { mode: 'append', text: value } };
		}

		const find = await this.ui.input({
			title: `Search and replace in ${info.shortSha}`,
			prompt: 'Find in the commit message',
			value: info.subject,
		});
		if (find === undefined) {
			return undefined;
		}
		if (!find) {
			await this.ui.message('warn', 'Nothing to search for.');
			return undefined;
		}
		const replaceWith = await this.ui.input({
			title: `Search and replace in ${info.shortSha}`,
			prompt: `Replace "${previewSubject(find)}" with`,
			value: find,
		});
		if (replaceWith === undefined) {
			return undefined;
		}
		return { edit: { mode: 'findReplace', find, text: replaceWith } };
	}

	private async pickRewriteBranch(ctx: RepoContext, target: string, info: CommitInfo, verb = 'Rename'): Promise<string | undefined> {
		const rewrite = await findRewriteBranch(ctx, target);
		if (rewrite.branch) {
			return rewrite.branch;
		}
		if (rewrite.candidates.length === 0) {
			await this.ui.message('error', `${info.shortSha} is not reachable from any local branch, so its history cannot be rewritten.`, rewrite.currentBranch ? `HEAD is ${rewrite.currentBranch}.` : 'HEAD is detached.');
			return undefined;
		}
		return this.ui.pick(
			rewrite.candidates.map((name) => ({
				label: name,
				description: name === rewrite.currentBranch ? 'current branch' : undefined,
				value: name,
			})),
			{ title: `${verb} ${info.shortSha} on which branch?`, placeholder: 'The commit is on more than one branch' },
		);
	}

	private async reportReword(ctx: RepoContext, result: RewordResult, cwd: string): Promise<void> {
		const where = result.branch ?? 'detached HEAD';
		this.ui.log(
			[
				`Renamed the message of ${shorten(result.targetSha)} -> ${shorten(result.newTargetSha)} on ${where}`,
				`  before: ${JSON.stringify(messageSubject(result.oldMessage))}`,
				`  after:  ${JSON.stringify(messageSubject(result.newMessage))}`,
				`  rewritten commits: ${result.rewritten.length}`,
				result.backupRef ? `  recovery point: ${result.backupRef}` : '',
				result.needsForcePush ? `  a force push to ${result.upstreamRef ?? 'the remote'} is needed` : '',
				result.otherRefsOnOldHistory.length > 0 ? `  still on the old history: ${result.otherRefsOnOldHistory.join(', ')}` : '',
				result.signatureDropped ? '  the commit was signed; the signature does not survive a rewrite' : '',
			].filter(Boolean).join('\n'),
		);

		if (result.noChange) {
			await this.ui.message('info', 'The message is unchanged, nothing was rewritten.');
			return;
		}

		const actions: string[] = [];
		if (result.needsForcePush) {
			actions.push(ACTIONS.forcePush);
			if (this.settings.forcePushMode !== 'force') {
				actions.push(ACTIONS.forcePushHard);
			}
		}
		actions.push(ACTIONS.undo);

		const message = `Renamed the message of ${shorten(result.newTargetSha)} on ${where}: "${previewSubject(result.newMessage)}"`
			+ (result.rewritten.length > 1 ? ` (${result.rewritten.length} commits rewritten)` : '')
			+ (result.needsForcePush ? ` - ${result.upstreamRef ?? 'the remote'} now needs a force push.` : '.');

		const chosen = await this.ui.ask(message, { actions });
		if (chosen === ACTIONS.forcePush) {
			await this.forcePush(cwd, [], 'lease');
		} else if (chosen === ACTIONS.forcePushHard) {
			await this.forcePush(cwd, [], 'force');
		} else if (chosen === ACTIONS.undo) {
			await this.undoLast(ctx, true);
		}
	}

	// ------------------------------------------------------------- squash

	/**
	 * "Squash Selected Commits..." - combines every commit row that is selected
	 * in our own Graph group into one commit.
	 *
	 * VS Code only enables multi-selection in a tree view whose extension asked
	 * for it (`canSelectMany`), and it then hands the command the clicked item
	 * plus the whole selection as separate arguments - so the selection arrives
	 * here like any other menu argument.
	 */
	async squashSelectedCommits(cwd: string, args: readonly unknown[]): Promise<void> {
		await this.guard('Squash', async () => {
			const ctx = this.contextFor(cwd);
			const selection: string[] = [];
			for (const ref of resolveMenuArgs(args).commitRefs) {
				const sha = await ctx.git.tryRun(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
				if (sha) {
					if (!selection.includes(sha)) {
						selection.push(sha);
					}
				} else {
					this.ui.log(`Ignoring "${ref}" from the menu arguments: not a commit in this repository.`);
				}
			}

			if (selection.length === 0) {
				await this.ui.message(
					'info',
					'Squash Selected Commits needs a selection in the Graph group.',
					'Open the Source Control sidebar, Ctrl/Shift-click two or more commit rows of "Git Easy Ops" > "Graph", then right-click inside the selection. To combine one commit with its ancestors, use "Squash with Previous Commits...".',
				);
				return;
			}
			if (selection.length < 2) {
				await this.ui.message(
					'warn',
					'Only one commit is selected - a squash needs at least two.',
					'Ctrl/Shift-click the rows of the commits that should become one commit, then right-click inside the selection. "Squash with Previous Commits..." combines a single commit with its ancestors.',
				);
				return;
			}

			await this.runSquash(ctx, cwd, await orderSquashSelection(ctx.git, selection));
		});
	}

	/**
	 * "Squash with Previous Commits..." - asks for N and combines the commit the
	 * menu was opened on with the N commits before it. This is the variant that
	 * works from *any* entry point (built-in Source Control Graph, Timeline,
	 * palette), because it only needs that one commit.
	 */
	async squashWithPreviousCommits(cwd: string, args: readonly unknown[]): Promise<void> {
		await this.guard('Squash', async () => {
			const ctx = this.contextFor(cwd);
			const target = await this.resolveCommit(ctx, args, 'Squash which commit?');
			if (!target) {
				return;
			}
			const info = await ctx.git.commitInfo(target);
			const depth = Math.max(0, (await ctx.git.countCommits(target)) - 1);
			if (depth === 0) {
				await this.ui.message('info', `${info.shortSha} is the first commit of this repository - there is nothing before it to squash.`);
				return;
			}

			const typed = await this.ui.input({
				title: `Squash into ${info.shortSha}`,
				prompt: `How many commits before "${previewSubject(info.message)}" should be squashed into it?`,
				value: String(Math.min(3, depth)),
				placeholder: `1 - ${Math.min(50, depth)}`,
				validate: (value) => (parseSquashCount(value) === undefined ? 'Enter a whole number between 1 and 50.' : undefined),
			});
			if (typed === undefined) {
				return;
			}
			const count = parseSquashCount(typed);
			if (count === undefined) {
				await this.ui.message('warn', 'Enter a whole number between 1 and 50.');
				return;
			}

			const selection = await collectPreviousCommits(ctx.git, target, count);
			if (selection.length < count + 1) {
				await this.ui.message('warn', `${info.shortSha} has only ${selection.length - 1} commit(s) before it - not enough for ${count}.`, 'Nothing was rewritten.');
				return;
			}
			await this.runSquash(ctx, cwd, selection);
		});
	}

	/** The shared half of both squash entry points: message, plan, confirmation, report. */
	private async runSquash(ctx: RepoContext, cwd: string, selection: readonly string[]): Promise<void> {
		const infos = await Promise.all(selection.map((sha) => ctx.git.commitInfo(sha)));
		const oldest = infos[0]!;
		const newest = infos[infos.length - 1]!;

		const branch = await this.pickRewriteBranch(ctx, newest.sha, newest, 'Squash');
		if (!branch) {
			return;
		}

		const typed = await this.ui.input({
			title: `Squash ${infos.length} commits into one`,
			prompt: `Message of the combined commit (default: the message of ${newest.shortSha})`,
			value: composeSquashMessage(infos.map((info) => info.message)),
		});
		if (typed === undefined) {
			return;
		}
		// A blank combined message is accepted and stored as one space, the
		// same way Rename Commit Message stores one - squashing temporary
		// commits should be able to stay quiet too.
		const message = normalizeMessage(typed) || ' ';

		const descendants = await ctx.git.countCommits(`${newest.sha}..refs/heads/${branch}`);
		const upstream = await ctx.git.upstream(branch);
		if (this.settings.confirmDestructiveOperations) {
			// Keep the dialog on one screen: clip every subject and list at
			// most ten commits by name.
			const listed = infos.slice(0, 10);
			const confirmed = await this.ui.confirm(`Squash ${infos.length} commits into one on ${branch}?`, {
				confirmLabel: 'Squash',
				destructive: true,
				detail: [
					...listed.map((info) => `${info.shortSha}  ${previewSubject(info.message)}`),
					infos.length > listed.length ? `... and ${infos.length - listed.length} more` : '',
					`   -> one commit: "${previewSubject(message)}"`,
					'',
					`${infos.length} commits become 1${descendants > 0 ? `; the ${descendants} commit${descendants === 1 ? '' : 's'} after them are replayed with new SHAs` : ''}. The combined commit keeps the tree of ${newest.shortSha}, so the working tree does not change.`,
					oldest.parents.length > 1 ? `${oldest.shortSha} is a merge commit: only its first parent is kept.` : '',
					`Recovery point: ${this.settings.backupRefPrefix}... , restore it with "Git Easy Ops: Undo Last Operation".`,
					upstream?.sha ? `${branch} tracks ${upstream.remote}/${upstream.branch}: a force push is needed afterwards.` : '',
				].filter(Boolean).join('\n'),
			});
			if (!confirmed) {
				this.ui.log(`Squash of ${infos.length} commits cancelled by the user.`);
				return;
			}
		}

		const result = await this.ui.withProgress(`Squashing ${infos.length} commits`, async (report) => {
			report(`combining ${infos.length} commits into one on ${branch}`);
			return squashCommits(ctx, { commits: infos.map((info) => info.sha), branch, message });
		});

		await this.reportSquash(ctx, result, cwd);
	}

	private async reportSquash(ctx: RepoContext, result: SquashResult, cwd: string): Promise<void> {
		this.ui.log(
			[
				`Squashed ${result.squashed.length} commits into ${shorten(result.newSha)} on ${result.branch}`,
				`  squashed: ${result.squashed.map((commit) => `${commit.shortSha} ${commit.subject}`).join(' | ')}`,
				`  message:  ${JSON.stringify(messageSubject(result.message))}`,
				`  tip:      ${shorten(result.oldTip)} -> ${shorten(result.newTip)}`,
				`  replayed commits after the squash: ${result.rewritten.length - 1}`,
				result.base ? `  parent of the combined commit: ${shorten(result.base)}` : '  the combined commit is a root commit',
				result.backupRef ? `  recovery point: ${result.backupRef}` : '',
				result.needsForcePush ? `  a force push to ${result.upstreamRef ?? 'the remote'} is needed` : '',
				result.otherRefsOnOldHistory.length > 0 ? `  still on the old history: ${result.otherRefsOnOldHistory.join(', ')}` : '',
				result.signatureDropped ? '  one of the squashed commits was signed; the signature does not survive a rewrite' : '',
			].filter(Boolean).join('\n'),
		);

		const actions: string[] = [];
		if (result.needsForcePush) {
			actions.push(ACTIONS.forcePush);
			if (this.settings.forcePushMode !== 'force') {
				actions.push(ACTIONS.forcePushHard);
			}
		}
		actions.push(ACTIONS.undo);

		const message = `Squashed ${result.squashed.length} commits into ${shorten(result.newSha)} on ${result.branch}: "${previewSubject(result.message)}"`
			+ (result.needsForcePush ? ` - ${result.upstreamRef ?? 'the remote'} now needs a force push.` : '.');

		const chosen = await this.ui.ask(message, { actions });
		if (chosen === ACTIONS.forcePush) {
			await this.forcePush(cwd, [], 'lease');
		} else if (chosen === ACTIONS.forcePushHard) {
			await this.forcePush(cwd, [], 'force');
		} else if (chosen === ACTIONS.undo) {
			await this.undoLast(ctx, true);
		}
	}

	// ------------------------------------------------------------- feature 2

	async fastForward(cwd: string, args: readonly unknown[], options: { askBranch: boolean }): Promise<void> {
		await this.guard('Fast-forward', async () => {
			const ctx = this.contextFor(cwd);
			const target = await this.resolveCommit(ctx, args, 'Fast-forward to which commit?');
			if (!target) {
				return;
			}
			const targetInfo = await ctx.git.commitInfo(target);

			const detected = await resolveBranch(ctx);
			let branch: string | undefined;
			let backupName = this.settings.defaultBackupBranchName;

			if (options.askBranch) {
				branch = await this.ui.pick(
					detected.candidates.map((name) => ({
						label: name,
						description: name === detected.branch ? `default (${detected.how})` : undefined,
						value: name,
					})),
					{ title: 'Fast-forward which branch?', placeholder: detected.branch ? `Default: ${detected.branch}` : 'Pick a branch' },
				);
				if (!branch) {
					return;
				}
				const typed = await this.ui.input({
					title: `Fast-forward ${branch}`,
					prompt: `Keep the old ${branch} tip on a branch named`,
					value: backupName,
					placeholder: 'old',
				});
				if (typed === undefined) {
					return;
				}
				backupName = typed.trim() || backupName;
			} else {
				branch = detected.branch;
				if (!branch) {
					await this.ui.message('error', 'Could not work out which branch to move.', detected.candidates.length > 0 ? `Local branches: ${detected.candidates.join(', ')}.` : 'This repository has no branches yet.');
					return;
				}
			}

			const from = await ctx.git.revParse(`refs/heads/${branch}`);
			if (!from) {
				await this.ui.message('error', `Branch "${branch}" does not exist.`);
				return;
			}
			if (from === target) {
				await this.ui.message('info', `"${branch}" already points at ${targetInfo.shortSha}.`);
				return;
			}
			const counts = await ctx.git.counts(from, target);
			const isFastForward = counts.left === 0;

			// Which name the backup branch will really get - the dialog has to
			// promise the exact name it will leave behind (or remove). If a
			// branch by the desired name already exists *at a different
			// commit*, the mover would append a suffix, and that existing
			// branch is NOT redundant (it still carries its own commits) - so
			// removing the backup must not be offered.
			const backupTakenAtFrom = (await ctx.git.revParse(`refs/heads/${backupName}`)) === from;
			const actualBackupName = backupTakenAtFrom ? backupName : await ctx.safety.resolveFreeBranchName(backupName);
			const canRemoveBackup = isFastForward && !backupTakenAtFrom;

			let removeBackup = false;
			let cleanRedundantAfterMove = false;
			if (this.settings.confirmDestructiveOperations) {
				if (canRemoveBackup && this.ui.choose) {
					// The clean-up the user usually wants in one step: move
					// the branch AND drop the now-redundant backup it parks at
					// the old tip. Only offered for a true fast-forward, where
					// the old tip has no commit of its own on it.
					const choice = await this.ui.choose(`Move ${branch} to ${targetInfo.shortSha}?`, {
						detail: [
							`${branch}: ${shorten(from)} -> ${shorten(target)}`,
							`"${previewSubject(targetInfo.message)}"`,
							'',
							`Fast-forward: ${counts.right === 1 ? '1 commit is' : `${counts.right} commits are`} added, nothing is lost.`,
							`The old tip is kept on branch "${actualBackupName}".`,
							`"${actualBackupName}" is redundant: every commit of it is already on ${branch}, so removing it loses nothing.`,
							'',
							`The cleanup option checks out ${branch} if the worktree is clean, then lets you review redundant branch names. Remote deletion and a normal push are separately confirmed.`,
						].join('\n'),
						choices: [
							{ label: 'Cancel', value: 'cancel' },
							{ label: 'Move and clean up redundant branches…', value: 'move-clean', primary: true },
							{ label: 'Move', value: 'move' },
							{ label: `Move and remove "${actualBackupName}"`, value: 'move-remove' },
						],
					});
					if (choice === undefined || choice === 'cancel') {
						this.ui.log(`Fast-forward of ${branch} cancelled by the user.`);
						return;
					}
					removeBackup = choice === 'move-remove' || choice === 'move-clean';
					cleanRedundantAfterMove = choice === 'move-clean';
				} else {
					const confirmed = await this.ui.confirm(`Move ${branch} to ${targetInfo.shortSha}?`, {
						confirmLabel: isFastForward ? 'Move' : 'Move anyway',
						destructive: !isFastForward,
						detail: [
							`${branch}: ${shorten(from)} -> ${shorten(target)}`,
							`"${previewSubject(targetInfo.message)}"`,
							'',
							isFastForward
								? `Fast-forward: ${counts.right === 1 ? '1 commit is' : `${counts.right} commits are`} added, nothing is lost.`
								: `NOT a fast-forward: ${counts.left} commit${counts.left === 1 ? '' : 's'} on ${branch} would be left behind.`,
							`The old tip is kept on branch "${actualBackupName}".`,
						].join('\n'),
					});
					if (!confirmed) {
						this.ui.log(`Fast-forward of ${branch} cancelled by the user.`);
						return;
					}
				}
			}

			let result: FastForwardResult;
			try {
				result = await this.ui.withProgress(`Moving ${branch}`, (report) => {
					report(`moving ${branch} to ${targetInfo.shortSha}`);
					return fastForwardBranch(ctx, { target, branch, backupName });
				});
			} catch (error) {
				if (!isGecoError(error) || error.code !== 'not-fast-forward') {
					throw error;
				}
				const forced = await this.askForForce(error, branch, targetInfo.shortSha);
				if (!forced) {
					return;
				}
				result = await this.ui.withProgress(`Moving ${branch}`, (report) => {
					report(`moving ${branch} to ${targetInfo.shortSha} (forced)`);
					return fastForwardBranch(ctx, { target, branch, backupName, force: true });
				});
			}

			const backup = result.backup;
			let removedBackup: string | undefined;
			if (removeBackup && !result.alreadyAtTarget && backup && !backup.reused) {
				// The move already parked the old tip there, and the move is a
				// true fast-forward: the backup is redundant by construction.
				// deleteRedundantBranches still re-verifies everything
				// (existence, tip, reachability, protected) right before it
				// deletes, and it journals the removal as its own entry, so
				// one Undo brings the backup back without touching the move.
				const removal = await this.ui.withProgress(`Removing ${backup.name}`, (report) => {
					report('checking the backup branch is still redundant');
					return deleteRedundantBranches(
						ctx,
						[{ name: backup.name, sha: result.from, subject: result.fromSubject, keptAliveBy: [result.branch] }],
						{ deleteRemote: false },
					);
				});
				if (removal.deleted.length > 0) {
					removedBackup = removal.deleted[0]!.name;
					this.ui.log(`Removed the redundant backup branch ${removedBackup} (${shorten(result.from)}) - every commit of it is on ${result.branch}.`);
				} else {
					this.ui.log(`Kept ${backup.name}: ${removal.skipped.map((entry) => entry.reason).join('; ')}`);
				}
			}

			if (cleanRedundantAfterMove && !result.alreadyAtTarget) {
				// Leave the user on the branch that now owns the new history before
				// scanning for duplicate names. This makes the former feature branch
				// eligible for cleanup, while dirty worktrees are never disturbed.
				const current = await ctx.git.headBranch();
				if (current !== result.branch) {
					if (await ctx.git.isDirty({ includeUntracked: true })) {
						this.ui.log(`Kept the current checkout (${current ?? 'detached HEAD'}): the worktree has uncommitted changes.`);
					} else {
						await ctx.git.checkout(result.branch);
						await ctx.safety.record({
							kind: 'branch',
							summary: `Checked out ${result.branch} after fast-forward cleanup`,
							undo: { type: 'refs', refs: [], checkoutRef: current },
						});
						this.ui.log(`Checked out ${result.branch} after moving it to the selected commit.`);
					}
				}
				await this.cleanupRedundantAfterFastForward(ctx, result);
			}

			await this.reportFastForward(ctx, result, cwd, removedBackup);
		});
	}

	/** Review and remove branches made redundant by the just-completed move. */
	private async cleanupRedundantAfterFastForward(ctx: RepoContext, result: FastForwardResult): Promise<void> {
		const scan = await findRedundantBranches(ctx);
		if (scan.redundant.length === 0) {
			this.ui.log(`No redundant branches to clean up after moving ${result.branch}.`);
			return;
		}

		const picked = this.ui.pickMany
			? await this.ui.pickMany(scan.redundant.map((branch) => ({
				label: branch.name,
				description: `already in ${branch.keptAliveBy.join(', ')}${branch.remote ? ` · remote ${branch.remote.remote}` : ''}`,
				detail: `${shorten(branch.sha)} ${branch.subject}`,
				value: branch,
				picked: true,
			})), {
				title: 'Remove branches made redundant by the fast-forward?',
				placeholder: 'Only selected branch names are removed; commits are kept',
			})
			: scan.redundant;
		if (!picked || picked.length === 0) {
			this.ui.log('Fast-forward cleanup skipped; no redundant branches were selected.');
			return;
		}

		const remoteChosen = picked.filter((branch) => branch.remote);
		let deleteRemote = false;
		if (remoteChosen.length > 0) {
			const upstream = await ctx.git.upstream(result.branch);
			const canPublishAndDelete = Boolean(upstream && remoteChosen.every((branch) => branch.remote!.remote === upstream.remote));
			const options: { label: string; description?: string; value: boolean }[] = [
				{ label: 'Remove locally only', description: 'leave the branches on the server', value: false },
			];
			if (upstream && canPublishAndDelete) {
				options.push({
					label: `Push ${result.branch} to ${upstream.remote}/${upstream.branch}, then remove remotely`,
					description: 'ordinary fast-forward push; remote branch deletions use a lease',
					value: true,
				});
			} else if (upstream) {
				this.ui.log(`Selected remote branches are not all on ${upstream.remote}; leaving server refs alone to avoid deleting commits before publishing them there.`);
			}
			const scope = await this.ui.pick<boolean>(options, {
				title: 'How should redundant remote branches be removed?',
				placeholder: remoteChosen.map((branch) => branch.name).join(', '),
			});
			if (scope === undefined) {
				this.ui.log('Fast-forward cleanup cancelled; branches were kept.');
				return;
			}
			deleteRemote = scope;
			if (deleteRemote && upstream) {
				const pushed = await ctx.git.push([upstream.remote, `${result.branch}:refs/heads/${upstream.branch}`]);
				if (pushed.exitCode !== 0) {
					this.ui.log(`Could not push ${result.branch} to ${upstream.remote}/${upstream.branch}; no branches were cleaned up. ${pushed.stderr.trim()}`);
					return;
				}
				this.ui.log(`Pushed ${result.branch} to ${upstream.remote}/${upstream.branch} before remote cleanup.`);
			}
		}

		const removal = await this.ui.withProgress('Cleaning up redundant branches', () =>
			deleteRedundantBranches(ctx, picked, { deleteRemote }),
		);
		this.ui.log([
			`Fast-forward cleanup removed ${removal.deleted.length} redundant branch(es): ${removal.deleted.map((branch) => branch.name).join(', ') || '(none)'}`,
			...removal.skipped.map((entry) => `  kept ${entry.name}: ${entry.reason}`),
			...removal.notes.map((note) => `  ${note}`),
		].join('\n'));
	}

	private async askForForce(error: GecoError, branch: string, target: string): Promise<boolean> {
		this.ui.log(`"${branch}" diverged from ${target}: ${error.message}`);
		return this.ui.confirm(`"${branch}" has commits that ${target} does not. Move it anyway?`, {
			confirmLabel: 'Move anyway',
			destructive: true,
			detail: `${error.detail ?? ''}\n\nThe old tip is still moved onto the backup branch first, so nothing is lost.`,
		});
	}

	private async reportFastForward(ctx: RepoContext, result: FastForwardResult, cwd: string, removedBackup?: string): Promise<void> {
		this.ui.log(
			[
				`Moved ${result.branch}: ${shorten(result.from)} -> ${shorten(result.to)} (${result.wasFastForward ? 'fast-forward' : 'forced'})`,
				`  "${result.toSubject}"`,
				`  ahead ${result.ahead}, behind ${result.behind}`,
				removedBackup
					? `  old tip removed - the backup branch "${removedBackup}" was redundant`
					: result.backup
						? `  old tip kept on ${result.backup.name}${result.backup.reused ? ' (reused)' : ''}`
						: '  no backup branch created',
				result.discardedCommits.length > 0 ? `  left behind: ${result.discardedCommits.map((c) => `${shorten(c.sha)} ${c.subject}`).join(', ')}` : '',
				result.needsForcePush ? `  ${result.upstreamRef ?? 'the remote'} now needs a force push` : '',
				...result.notes.map((note) => `  note: ${note}`),
			].filter(Boolean).join('\n'),
		);

		if (result.alreadyAtTarget) {
			await this.ui.message('info', result.notes[0] ?? `"${result.branch}" already points at ${shorten(result.to)}.`);
			return;
		}

		const actions: string[] = [];
		if (result.needsForcePush) {
			actions.push(ACTIONS.forcePush);
		}
		actions.push(ACTIONS.undo);
		if (result.backup) {
			actions.push(ACTIONS.showBackups);
		}

		const chosen = await this.ui.ask(
			removedBackup
				? `${result.branch} now points at ${shorten(result.to)} ("${result.toSubject}"); the redundant backup "${removedBackup}" was removed - nothing was lost.`
				: `${result.branch} now points at ${shorten(result.to)} ("${result.toSubject}")${result.backup ? `, old tip kept on ${result.backup.name}` : ''}.`,
			{ actions },
		);
		if (chosen === ACTIONS.forcePush) {
			await this.forcePush(cwd, [], undefined, result.branch);
		} else if (chosen === ACTIONS.undo) {
			await this.undoLast(ctx, true);
		} else if (chosen === ACTIONS.showBackups) {
			await this.showBackups(cwd);
		}
	}

	// ------------------------------------------------------------- feature 3

	async forcePush(cwd: string, args: readonly unknown[], mode?: ForcePushMode, branch?: string): Promise<void> {
		await this.guard('Force push', async () => {
			const ctx = this.contextFor(cwd);
			let target = branch;
			if (!target) {
				const resolved = resolveMenuArgs(args);
				const fromArgs = resolved.branchRef;
				if (fromArgs && (await ctx.git.branchExists(fromArgs))) {
					target = fromArgs;
				}
			}
			const plan = await planForcePush(ctx, { branch: target, mode });
			const effectiveMode: ForcePushMode = mode ?? this.settings.forcePushMode;

			if (this.settings.confirmDestructiveOperations) {
				const confirmed = await this.ui.confirm(`Force push ${plan.branch} to ${plan.remote}/${plan.remoteBranch}?`, {
					confirmLabel: effectiveMode === 'lease' ? 'Force Push (with lease)' : 'Force Push',
					destructive: true,
					detail: [
						plan.createdRemoteBranch
							? `Creates ${plan.remote}/${plan.remoteBranch} (it does not exist yet).`
							: `Overwrites ${plan.remote}/${plan.remoteBranch}: ${shorten(plan.remoteShaBefore!)} -> ${shorten(plan.localSha)} (${plan.ahead} ahead, ${plan.behind} behind).`,
						effectiveMode === 'lease'
							? 'With --force-with-lease the push is refused if somebody else pushed since your last fetch.'
							: '--force overwrites whatever is on the remote, including work you have not fetched.',
					].join('\n'),
				});
				if (!confirmed) {
					this.ui.log('Force push cancelled by the user.');
					return;
				}
			}

			const result: ForcePushResult = await this.ui.withProgress(`Pushing ${plan.branch}`, (report) => {
				report(`pushing to ${plan.remote}/${plan.remoteBranch}`);
				return forcePush(ctx, { branch: plan.branch, remote: plan.remote, remoteBranch: plan.remoteBranch, mode: effectiveMode });
			});

			this.ui.log(
				[
					`Force pushed ${result.branch} -> ${result.remote}/${result.remoteBranch} (${result.mode})`,
					`  ${result.remoteShaBefore ? `${shorten(result.remoteShaBefore)} -> ` : '(new branch) '}${shorten(result.localSha)}`,
					`  ahead ${result.ahead}, behind ${result.behind}`,
					result.output ? result.output.split('\n').map((line) => `  | ${line}`).join('\n') : '',
				].filter(Boolean).join('\n'),
			);

			const chosen = await this.ui.ask(
				result.createdRemoteBranch
					? `Created ${result.remote}/${result.remoteBranch}.`
					: `${result.remote}/${result.remoteBranch} now points at ${shorten(result.localSha)} (${result.ahead} ahead, ${result.behind} behind were overwritten).`,
				{ actions: [ACTIONS.undo] },
			);
			if (chosen === ACTIONS.undo) {
				await this.undoLast(ctx, true);
			}
		});
	}

	// ------------------------------------------------------------- feature 4

	async applyPatchAtProperBase(cwd: string, args: readonly unknown[]): Promise<void> {
		await this.guard('Apply patch', async () => {
			const ctx = this.contextFor(cwd);
			const source = await this.pickPatchSource(ctx, args);
			if (!source) {
				return;
			}
			const materialized = await this.ui.withProgress('Building patch', () => materializePatch(ctx, source));
			const found = await this.ui.withProgress('Looking for the proper base', (report) => {
				report('probing candidate commits');
				return findProperBase(ctx, {
					patch: materialized.patch,
					sourceCommit: materialized.sourceCommit,
					targetBranch: undefined,
				});
			});
			const base = found.best;
			if (!base) {
				await this.ui.message('error', 'No candidate base was found for this patch.');
				return;
			}

			const destination = await this.pickDestination();
			if (!destination) {
				return;
			}
			let branchName: string | undefined;
			if (destination !== 'current') {
				const suggested = `geco/${materialized.sourceCommit ? `patch-${shorten(materialized.sourceCommit)}` : 'patch'}`;
				const typed = await this.ui.input({
					title: 'Apply patch',
					prompt: destination === 'worktree' ? 'Branch for the new worktree' : 'New branch at the proper base',
					value: suggested,
				});
				if (typed === undefined) {
					return;
				}
				branchName = typed.trim() || suggested;
			}

			if (this.settings.confirmDestructiveOperations && destination === 'current') {
				const confirmed = await this.ui.confirm('Apply this patch to the current branch?', {
					confirmLabel: 'Apply',
					detail: this.describeBase(base, materialized.label, destination, branchName),
				});
				if (!confirmed) {
					return;
				}
			}

			const result = await this.ui.withProgress('Applying patch', (report) => {
				report(`applying at ${shorten(base.sha)}`);
				return applyPatch(ctx, {
					patch: materialized.patch,
					sourceCommit: materialized.sourceCommit,
					base: base.sha,
					destination,
					branchName,
					commit: destination === 'current' ? false : undefined,
				});
			});

			await this.reportApplyPatch(ctx, result, materialized.label, cwd);
		});
	}

	async showProperBase(cwd: string, args: readonly unknown[]): Promise<void> {
		await this.guard('Find proper base', async () => {
			const ctx = this.contextFor(cwd);
			const source = await this.pickPatchSource(ctx, args);
			if (!source) {
				return;
			}
			const materialized = await materializePatch(ctx, source);
			const limit = Math.min(Math.max(5, this.settings.patchBaseCandidateLimit), 25);
			const found = await this.ui.withProgress('Looking for the proper base', () =>
				findProperBase(ctx, {
					patch: materialized.patch,
					sourceCommit: materialized.sourceCommit,
					maxCandidates: limit,
					stopAtFirstMatch: false,
				}),
			);

			const lines = [
				`Patch: ${materialized.label} (${found.parsed.files.length} file${found.parsed.files.length === 1 ? '' : 's'}${found.parsed.kind === 'mailbox' ? ', with commit message' : ''})`,
				'',
				'Candidate bases (best first):',
				...found.evaluated.map((e) => `  ${shorten(e.sha)}  ${this.scoreLabel(e)}  ${e.label}${e.mismatchedPaths.length > 0 ? `  [differs: ${e.mismatchedPaths.slice(0, 3).join(', ')}${e.mismatchedPaths.length > 3 ? ', ...' : ''}]` : ''}`),
				'',
				found.best ? `Proper base: ${shorten(found.best.sha)} - ${found.best.reason}` : 'No candidate accepts this patch.',
			];
			this.ui.log(lines.join('\n'));

			const chosen = await this.ui.ask(
				found.best
					? `Proper base for "${materialized.label}": ${shorten(found.best.sha)} (${found.best.label}). ${found.evaluated.length} candidates were probed - see the output log.`
					: `None of the ${found.evaluated.length} probed commits accepts "${materialized.label}". See the output log.`,
				{ actions: found.best ? [ACTIONS.applyPatch, ACTIONS.openLog] : [ACTIONS.openLog] },
			);
			if (chosen === ACTIONS.applyPatch) {
				await this.applyPatchAtProperBase(cwd, args);
			} else if (chosen === ACTIONS.openLog) {
				await this.ui.showOutput?.();
			}
		});
	}

	private scoreLabel(evaluation: BaseEvaluation): string {
		if (evaluation.exact) {
			return 'exact   ';
		}
		if (evaluation.appliesCleanly) {
			return 'clean   ';
		}
		if (evaluation.threeWay) {
			return evaluation.threeWayConflicts ? '3way(!) ' : '3way    ';
		}
		return 'no      ';
	}

	private describeBase(base: BaseEvaluation, patchLabel: string, destination: PatchDestination, branchName?: string): string {
		return [
			`Patch: ${patchLabel}`,
			`Base: ${shorten(base.sha)} (${base.label}) - ${base.reason}`,
			`Destination: ${destination}${branchName ? ` as branch "${branchName}"` : ''}`,
			base.threeWayConflicts ? 'A 3-way merge is needed and may leave conflict markers.' : '',
		].filter(Boolean).join('\n');
	}

	private async reportApplyPatch(ctx: RepoContext, result: ApplyPatchResult, patchLabel: string, cwd: string): Promise<void> {
		this.ui.log(
			[
				`Applied "${patchLabel}" at ${shorten(result.base.sha)} (${result.base.label})`,
				`  method: ${result.method}`,
				`  destination: ${result.destination}${result.branch ? ` (${result.branch})` : ''}`,
				result.worktreePath ? `  worktree: ${result.worktreePath}` : '',
				`  files: ${result.appliedPaths.join(', ') || '(none)'}`,
				result.committed && result.commitSha ? `  commit: ${shorten(result.commitSha)}` : '',
				result.conflicts.length > 0 ? `  conflicts: ${result.conflicts.join(', ')}` : '',
				...result.warnings.map((warning) => `  warning: ${warning}`),
			].filter(Boolean).join('\n'),
		);

		const actions: string[] = [];
		if (result.worktreePath) {
			actions.push(ACTIONS.openWorktree);
		}
		actions.push(ACTIONS.undo);

		const headline = result.conflicts.length > 0
			? `Patch applied at ${shorten(result.base.sha)} with conflicts in ${result.conflicts.join(', ')}.`
			: `Patch applied at ${shorten(result.base.sha)} (${result.base.label})${result.branch ? ` on ${result.branch}` : ''}${result.worktreePath ? ` in ${result.worktreePath}` : ''}.`;

		const chosen = await this.ui.ask(headline, { detail: result.warnings.join('\n') || undefined, actions });
		if (chosen === ACTIONS.openWorktree && result.worktreePath) {
			await this.ui.openPath?.(result.worktreePath);
		} else if (chosen === ACTIONS.undo) {
			await this.undoLast(ctx, true);
		}
		void cwd;
	}

	private async pickPatchSource(ctx: RepoContext, args: readonly unknown[]): Promise<PatchSource | undefined> {
		const resolved = resolveMenuArgs(args);
		const preselected = resolved.commitRefs[0];

		const items: QuickPickChoice<SourceChoice>[] = [];
		if (preselected) {
			let description = shorten(preselected);
			try {
				const info = await ctx.git.commitInfo(preselected);
				description = `${info.shortSha} ${info.subject}`;
			} catch {
				// Keep the raw value: git will say why it cannot resolve it.
			}
			items.push({ label: 'Selected commit (patch + message)', description, value: { kind: 'source', source: { kind: 'commit', commit: preselected } } });
			items.push({ label: 'Selected commit (changes only)', description, value: { kind: 'source', source: { kind: 'commit', commit: preselected, mailbox: false } } });
		}
		items.push(
			{ label: 'Another commit...', description: 'pick from the history', value: { kind: 'commit' } },
			{ label: 'A range of commits...', description: 'from..to', value: { kind: 'range' } },
			{ label: 'Staged changes', description: 'what is in the index', value: { kind: 'source', source: { kind: 'staged' } } },
			{ label: 'Working tree changes', description: 'everything against HEAD', value: { kind: 'source', source: { kind: 'worktree' } } },
		);
		if (this.ui.pickFile) {
			items.push({ label: 'Patch file...', description: '.patch / .diff on disk', value: { kind: 'file' } });
		}

		const chosen = await this.ui.pick(items, { title: 'Which patch?', placeholder: 'Pick the patch to apply' });
		if (chosen === undefined) {
			return undefined;
		}
		if (chosen.kind === 'source') {
			return chosen.source;
		}
		if (chosen.kind === 'commit') {
			const sha = await this.pickCommit(ctx, 'Patch from which commit?');
			return sha ? { kind: 'commit', commit: sha } : undefined;
		}
		if (chosen.kind === 'range') {
			const from = await this.pickCommit(ctx, 'Range start (exclusive)');
			if (!from) {
				return undefined;
			}
			const to = await this.pickCommit(ctx, 'Range end (inclusive)');
			return to ? { kind: 'range', from, to } : undefined;
		}
		const file = await this.ui.pickFile?.({ title: 'Choose a patch file', filters: { Patch: ['patch', 'diff'], 'All files': ['*'] } });
		return file ? { kind: 'file', path: file } : undefined;
	}

	private async pickDestination(): Promise<PatchDestination | undefined> {
		const order: PatchDestination[] = ['newBranch', 'worktree', 'current'];
		const labels: Record<PatchDestination, { label: string; description: string }> = {
			current: { label: 'Current branch', description: 'only possible when HEAD is the proper base' },
			newBranch: { label: 'New branch', description: 'create a branch at the proper base and check it out' },
			worktree: { label: 'Separate worktree', description: 'your checkout is never touched' },
		};
		const items = order
			.slice()
			.sort((a, b) => (a === this.settings.applyPatchDestination ? -1 : 0) - (b === this.settings.applyPatchDestination ? -1 : 0))
			.map((value) => ({
				label: labels[value].label,
				description: value === this.settings.applyPatchDestination ? `${labels[value].description} (default)` : labels[value].description,
				value,
			}));
		return this.ui.pick(items, { title: 'Where should the patch be applied?', placeholder: 'Choose a destination' });
	}

	// ------------------------------------------------------- safety features

	async createBackupBranch(cwd: string, args: readonly unknown[]): Promise<void> {
		await this.guard('Create backup', async () => {
			const ctx = this.contextFor(cwd);
			const resolved = resolveMenuArgs(args);
			let target = resolved.commitRefs[0];
			let label = 'commit';
			if (!target && resolved.branchRef && (await ctx.git.branchExists(resolved.branchRef))) {
				target = resolved.branchRef;
				label = resolved.branchRef;
			}
			if (!target) {
				const branch = await ctx.git.headBranch();
				target = branch ?? 'HEAD';
				label = branch ?? 'HEAD';
			}
			const sha = await ctx.git.resolveCommit(target);
			const suggested = `${(await ctx.git.headBranch()) ?? 'head'}-backup-${timestamp().slice(0, 8)}`;
			const name = await this.ui.input({
				title: 'Create backup branch',
				prompt: `Backup branch for ${label} (${shorten(sha)})`,
				value: suggested,
			});
			if (name === undefined) {
				return;
			}
			const trimmed = name.trim();
			if (!trimmed) {
				await this.ui.message('warn', 'A branch name is required.');
				return;
			}
			const backup = await ctx.safety.backupBranch(trimmed, sha);
			await ctx.safety.record({
				kind: 'backup',
				summary: `Created backup branch ${backup.name} at ${shorten(sha)}`,
				undo: { type: 'refs', refs: [], deleteBranches: backup.reused ? [] : [backup.name] },
			});
			this.ui.log(`Backup branch ${backup.name} -> ${backup.sha}${backup.reused ? ' (already existed)' : ''}`);
			await this.ui.message('info', `Backup branch "${backup.name}" points at ${shorten(sha)}.`);
		});
	}

	// ---------------------------------------------------------- clean history

	/**
	 * "Clean History (Remove Dead Paths)..." - the repository-wide operation the
	 * archive/clean-git-workflow.txt notes describe: find every path that exists
	 * in old commits but in no current ref, then rewrite the whole history with
	 * `git filter-repo` so those files (and the objects behind them) are gone.
	 *
	 * There is no ref-level Undo for a full-history rewrite, so the flow insists
	 * on a `git bundle` backup first, journals where that bundle is, excludes the
	 * extension's own recovery refs from the rewrite (Undo of *earlier*
	 * operations keeps working), verifies with a rescan, and offers the force
	 * push that publishes the result. When `git-filter-repo` is not installed it
	 * degrades to the exact script, ready to copy into a terminal.
	 */
	async cleanHistory(cwd: string): Promise<void> {
		await this.guard('Clean history', async () => {
			const ctx = this.contextFor(cwd);
			if ((await ctx.git.commits({ limit: 1 })).length === 0) {
				throw new GecoError('nothing-to-do', 'This repository has no commits yet - there is no history to clean.');
			}

			const analysis = await this.ui.withProgress('Scanning history for dead paths', async (report) => {
				report('listing every path any commit ever touched');
				return analyzeDeadPaths(ctx);
			});
			let facts = await collectCleanFacts(ctx, this.settings.backupRefPrefix);
			if (analysis.deadPaths.length === 0) {
				this.ui.log(
					[
						`Clean history: ${cwd}`,
						`  ${analysis.historicalPaths.length} paths ever existed, ${analysis.alivePaths.length} of them are in a current ref.`,
						'  No dead paths - nothing to remove from the history.',
					].join('\n'),
				);
				await this.ui.message('info', 'No dead paths: every path that ever existed is still in a branch, tag or remote-tracking branch.');
				return;
			}

			const root = await ctx.git.repoRoot();
			const pathsFile = await deadPathsFileFor(ctx);
			let plan = await this.buildCleanPlan(ctx, { root, pathsFile, analysis, facts });
			this.ui.log([`Clean history plan for ${root}`, '', plan.report, '', 'Commands:', plan.commands.script].join('\n'));

			if (!plan.filterRepoAvailable) {
				// Ask first, then install - and only inform (the old behavior)
				// when nothing installable is left to try.
				const ready = await this.ensureFilterRepo(ctx, plan);
				if (!ready) {
					return;
				}
				plan = ready;
			}

			// filter-repo refuses a dirty tree and linked worktrees anyway - say
			// so *before* a multi-gigabyte bundle is written for nothing.
			let blockers = blockingCleanReasons(facts);
			if (blockers.length > 0) {
				const actions: ActionLabel[] = [];
				if (facts.extraWorktrees.length > 0) {
					actions.push(ACTIONS.removeWorktrees);
				}
				actions.push(ACTIONS.openLog);

				const chosen = await this.ui.ask(`Cannot rewrite this history yet - ${blockers.length} thing(s) have to go first.`, {
					detail: blockers.join('\n'),
					actions,
				});

				if (chosen === ACTIONS.removeWorktrees) {
					for (const wt of facts.extraWorktrees) {
						try {
							await ctx.git.worktreeRemove(wt, { force: true });
							this.ui.log(`Removed linked worktree: ${wt}`);
						} catch (err) {
							this.ui.log(`Failed to remove worktree "${wt}": ${err instanceof Error ? err.message : String(err)}`);
						}
					}
					try {
						await ctx.git.worktreePrune();
					} catch (err) {
						this.ui.log(`Failed to prune worktrees: ${err instanceof Error ? err.message : String(err)}`);
					}

					facts = await collectCleanFacts(ctx, this.settings.backupRefPrefix);
					plan = await this.buildCleanPlan(ctx, { root, pathsFile, analysis, facts });
					blockers = blockingCleanReasons(facts);
					if (blockers.length > 0) {
						this.ui.log(`Clean history refused:\n${blockers.map((reason) => `  ! ${reason}`).join('\n')}`);
						const remaining = await this.ui.ask(`Cannot rewrite this history yet - ${blockers.length} thing(s) have to go first.`, {
							detail: blockers.join('\n'),
							actions: [ACTIONS.openLog],
						});
						if (remaining === ACTIONS.openLog) {
							await this.ui.showOutput?.();
						}
						return;
					}
				} else {
					this.ui.log(`Clean history refused:\n${blockers.map((reason) => `  ! ${reason}`).join('\n')}`);
					if (chosen === ACTIONS.openLog) {
						await this.ui.showOutput?.();
					}
					return;
				}
			}

			const confirmation = describeCleanConfirmation(analysis, facts, { bundleFile: plan.bundleFile, pathsFile });
			if (facts.recoveryRefs.length > 0 && !plan.commands.recoveryRefsProtected) {
				confirmation.detail +=
					`\n\nToo many refs to list them all: the ${facts.recoveryRefs.length} recovery point(s) under ${this.settings.backupRefPrefix}\n`
					+ 'are rewritten too, so Undo of earlier operations stops working. The bundle is the way back.';
			}
			if (this.settings.confirmDestructiveOperations) {
				const confirmed = await this.ui.confirm(confirmation.message, {
					confirmLabel: 'Clean History',
					destructive: true,
					detail: confirmation.detail,
				});
				if (!confirmed) {
					this.ui.log('Clean history cancelled by the user - nothing was rewritten.');
					return;
				}
			}

			await this.runHistoryClean(ctx, plan);
		});
	}

	/** Scans for the external tool, writes the dead-path list and builds the plan. */
	private async buildCleanPlan(
		ctx: RepoContext,
		input: { root: string; pathsFile: string; analysis: DeadPathAnalysis; facts: CleanFacts },
	): Promise<CleanPlan> {
		const { root, pathsFile, analysis, facts } = input;
		await writeDeadPathsFile(pathsFile, analysis.deadPaths);

		const probe = await this.probeFilterRepo(ctx);
		const filterRepoAvailable = probe.available;
		if (!filterRepoAvailable) {
			this.ui.log(`git filter-repo is not available (${probe.detail}).`);
		}

		// The bundle is written next to the repository, never inside it: a file
		// in the worktree would show up as untracked (and could be committed).
		// It has to list *full* ref names (`listRefs()` reports the short ones,
		// and a bundle of "main" cannot be restored as refs/heads/main), and it
		// has to include the hidden recovery refs - `--all` skips them, and they
		// are the Undo of every earlier operation.
		const bundleFile = defaultBundleFile(root);
		const publicRefs = [
			...new Set([
				...(await ctx.git.refsUnder('refs/heads')).map((ref) => ref.name),
				...(await ctx.git.refsUnder('refs/remotes')).map((ref) => ref.name),
				...(await ctx.git.refsUnder('refs/tags')).map((ref) => ref.name),
			]),
		];
		const bundleRefs = [...new Set([...publicRefs, ...facts.recoveryRefs])];
		const commands = buildCommands({
			pathsFile,
			bundleFile,
			bundleRefs,
			refsToKeep: facts.recoveryRefs,
			// The rewrite is limited by *name*: `git-filter-repo --refs` takes
			// ref names, not the `--branches --remotes --tags` flags the scan
			// uses (see CommandsOptions.rewriteRefs).
			rewriteRefs: publicRefs,
			droppedRemotes: facts.remotes,
			forceFilterRepo: true,
			// pip --user installs put `git-filter-repo` on PATH without git
			// finding it as a subcommand - the probe remembers which form works.
			filterRepoCommand: probe.command,
		});
		if (facts.recoveryRefs.length > 0 && !commands.recoveryRefsProtected) {
			this.ui.log(
				`The rewrite cannot be limited to the ${publicRefs.length} public refs (too many to list) - `
				+ `the ${facts.recoveryRefs.length} recovery point(s) under ${this.settings.backupRefPrefix} are rewritten too, `
				+ 'so "Undo Last Operation" stops working for earlier operations. The backup bundle still holds them.',
			);
		}

		return {
			analysis,
			facts,
			commands,
			report: formatCleanReport(analysis, facts, { pathsFile }),
			warnings: cleanWarnings(analysis, facts),
			filterRepoAvailable,
			bundleFile,
			pathsFile,
			repoRoot: root,
			bundleRefs,
		};
	}

	/**
	 * Which invocation of the rewrite tool works: the `git filter-repo`
	 * subcommand (the normal case), or the `git-filter-repo` binary directly
	 * (what a pip `--user` install produces when its bin directory is on PATH
	 * but git's exec path has not picked the subcommand shim up).
	 */
	private async probeFilterRepo(ctx: RepoContext): Promise<{ available: boolean; command: readonly string[]; detail: string }> {
		const asSubcommand = await this.runFilterRepo(ctx, ['git', 'filter-repo', '--version']);
		if (asSubcommand.exitCode === 0) {
			return { available: true, command: ['git', 'filter-repo'], detail: asSubcommand.stdout.trim() };
		}
		const asBinary = await this.runFilterRepo(ctx, ['git-filter-repo', '--version']);
		if (asBinary.exitCode === 0) {
			return { available: true, command: ['git-filter-repo'], detail: asBinary.stdout.trim() };
		}
		return {
			available: false,
			command: ['git', 'filter-repo'],
			detail: asSubcommand.stderr.trim().split('\n')[0] ?? asBinary.stderr.trim().split('\n')[0] ?? 'not found',
		};
	}

	/**
	 * `git-filter-repo` is missing: ask to install it (the first installer
	 * that exists on this machine), fall through to the next candidate when an
	 * install fails, and hand over the copy-paste script only when nothing
	 * works or the user declines. Returns the re-probed plan when the tool
	 * became available, so the caller continues the cleanup it already began.
	 */
	private async ensureFilterRepo(ctx: RepoContext, plan: CleanPlan): Promise<CleanPlan | undefined> {
		let remaining = filterRepoInstallers(process.platform);
		for (;;) {
			// Probe in priority order; the first tool that answers is offered.
			let installer: FilterRepoInstaller | undefined;
			while (remaining.length > 0) {
				const candidate = remaining[0]!;
				if (needsSudo(candidate)) {
					const sudo = await this.runInstaller(SUDO_PROBE, ctx.git.cwd, INSTALLER_PROBE_TIMEOUT_MS);
					if (sudo.exitCode !== 0) {
						this.ui.log(`Skipping the ${candidate.label} installer: sudo needs a password, which cannot be answered here.`);
						remaining = remaining.slice(1);
						continue;
					}
				}
				const probe = await this.runInstaller(candidate.probe, ctx.git.cwd, INSTALLER_PROBE_TIMEOUT_MS);
				if (probe.exitCode === 0) {
					installer = candidate;
					break;
				}
				this.ui.log(`The ${candidate.label} installer is not available (${firstErrorLine(probe)}).`);
				remaining = remaining.slice(1);
			}
			if (!installer) {
				await this.reportMissingFilterRepo(plan);
				return undefined;
			}

			const installAction = `Install with ${installer.label}`;
			const chosen = await this.ui.ask(
				`${plan.analysis.deadPaths.length} dead path(s) found, but git-filter-repo is not installed - install it now?`,
				{
					detail: [
						'The cleanup continues automatically once the tool is in place.',
						`Will run: ${installer.command.join(' ')}`,
						installer.note ? `(${installer.note})` : '',
						plan.commands.script,
					].filter((line) => line !== '').join('\n'),
					actions: [installAction, ACTIONS.copyCommands, ACTIONS.openLog],
				},
			);
			if (chosen !== installAction) {
				if (chosen === ACTIONS.copyCommands) {
					await this.ui.copy(plan.commands.script);
					await this.ui.message('info', `Copied ${plan.commands.all.filter((line) => !line.startsWith('#')).length} commands - the dead-path list is at ${plan.pathsFile}.`);
				} else if (chosen === ACTIONS.openLog) {
					await this.ui.showOutput?.();
				}
				this.ui.log(`Clean history stopped: git-filter-repo was not installed (${chosen === undefined ? 'dialog dismissed' : `chose "${chosen}"`}).`);
				return undefined;
			}

			const result = await this.ui.withProgress(`Installing git-filter-repo (${installer.label})`, (report) => {
				report(installer.command.join(' '));
				return this.runInstaller(installer!.command, ctx.git.cwd, INSTALL_TIMEOUT_MS);
			});
			if (result.exitCode !== 0) {
				const hint = externallyManagedHint(result.stderr);
				this.ui.log(
					[
						`Installing with ${installer.label} failed: ${firstErrorLine(result)}`,
						...(hint ? [`  ${hint}`] : []),
					].join('\n'),
				);
				remaining = remaining.slice(1);
				continue;
			}

			const reprobe = await this.probeFilterRepo(ctx);
			if (!reprobe.available) {
				// Installed, but reachable neither as `git filter-repo` nor as
				// `git-filter-repo` (e.g. a pip --user bin dir outside PATH).
				this.ui.log(`git-filter-repo was installed with ${installer.label}, but git cannot run it (${reprobe.detail}). Restart the editor if the install location was just added to PATH.`);
				remaining = remaining.slice(1);
				continue;
			}
			this.ui.log(`git-filter-repo installed with ${installer.label} (${reprobe.detail.split('\n')[0]}).`);
			const rebuilt = await this.buildCleanPlan(ctx, {
				root: plan.repoRoot,
				pathsFile: plan.pathsFile,
				analysis: plan.analysis,
				facts: plan.facts,
			});
			await this.ui.message('info', `git-filter-repo ${reprobe.detail.trim()} installed - continuing with the cleanup of ${plan.analysis.deadPaths.length} dead path(s).`);
			return rebuilt;
		}
	}

	/** Runs an installer probe or install; injectable through {@link ControllerOptions}. */
	private async runInstaller(command: readonly string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const runner: InstallerRunner | undefined = this.options.filterRepoInstaller;
		if (runner) {
			return runner(command, cwd);
		}
		return this.runExternal(command, cwd, timeoutMs);
	}

	/** `git-filter-repo` is missing: hand over the exact script instead of failing. */
	private async reportMissingFilterRepo(plan: CleanPlan): Promise<void> {
		this.ui.log(
			[
				'git-filter-repo is not installed - the cleanup was NOT run.',
				'  pip install git-filter-repo      (or: brew install git-filter-repo)',
				`  the dead-path list is already written to ${plan.pathsFile}`,
				'  then run the commands above, or install the tool and use this command again.',
			].join('\n'),
		);
		const chosen = await this.ui.ask(
			`${plan.analysis.deadPaths.length} dead path(s) found, but git-filter-repo is not installed - nothing was rewritten.`,
			{ detail: plan.commands.script, actions: [ACTIONS.copyCommands, ACTIONS.openLog] },
		);
		if (chosen === ACTIONS.copyCommands) {
			await this.ui.copy(plan.commands.script);
			await this.ui.message('info', `Copied ${plan.commands.all.filter((line) => !line.startsWith('#')).length} commands - the dead-path list is at ${plan.pathsFile}.`);
		} else if (chosen === ACTIONS.openLog) {
			await this.ui.showOutput?.();
		}
	}

	/** Backup bundle -> filter-repo -> remotes -> rescan -> journal -> offer the push. */
	private async runHistoryClean(ctx: RepoContext, plan: CleanPlan): Promise<void> {
		const { analysis, facts, commands } = plan;

		let bundleNote = 'no backup bundle was created';
		if (commands.bundle && plan.bundleFile) {
			const bundle = await this.ui.withProgress('Creating the backup bundle', (report) => {
				report(`bundling ${plan.bundleRefs.length} refs into ${plan.bundleFile}`);
				return createBackupBundle(ctx, plan.bundleFile!, plan.bundleRefs);
			});
			if (!bundle.ok) {
				this.ui.log(`Backup bundle failed: ${bundle.detail}`);
				const proceed = await this.ui.confirm('The backup bundle could not be created. Rewrite the history anyway?', {
					confirmLabel: 'Rewrite Anyway',
					destructive: true,
					detail: `${bundle.detail}\n\nWithout the bundle there is no way back to the current history.`,
				});
				if (!proceed) {
					this.ui.log('Clean history aborted: no backup bundle.');
					return;
				}
				bundleNote = `the bundle FAILED (${bundle.detail}) - restore is not possible`;
			} else {
				bundleNote = plan.bundleFile;
				this.ui.log(`Backup bundle written to ${plan.bundleFile} (${bundle.detail}).`);
			}
		}

		const result = await this.ui.withProgress(`Removing ${analysis.deadPaths.length} dead paths`, (report) => {
			report('git filter-repo is rewriting every commit - this can take a while');
			return this.runFilterRepo(ctx, commands.filterRepo);
		});
		if (result.exitCode !== 0) {
			throw new GecoError(
				'git-failed',
				'git filter-repo failed - the history was not rewritten.',
				`${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}\nBackup bundle: ${bundleNote}`,
			);
		}
		this.ui.log(`git filter-repo finished:\n${(result.stdout + result.stderr).trim().split('\n').map((line) => `  | ${line}`).join('\n')}`);

		// filter-repo removes every remote on purpose (so a half-cleaned history
		// cannot be pushed by accident) - put them back before offering the push.
		const restoredRemotes: string[] = [];
		for (const remote of facts.remotes) {
			const existing = await ctx.git.tryRun(['remote', 'get-url', remote.name]);
			if (existing) {
				continue;
			}
			const add = await ctx.git.run(['remote', 'add', remote.name, remote.url]);
			if (add.exitCode === 0) {
				restoredRemotes.push(remote.name);
			} else {
				this.ui.log(`Could not re-add the remote ${remote.name}: ${add.stderr.trim()}`);
			}
		}
		if (restoredRemotes.length > 0) {
			this.ui.log(`Re-added remote(s): ${restoredRemotes.join(', ')} (filter-repo removes them).`);
		}

		// Verify the way the workflow doc does: rescan and diff.
		const verification = await this.ui.withProgress('Verifying', (report) => {
			report('rescanning every ref');
			return analyzeDeadPaths(ctx, { sizeAnalysis: false });
		});
		const keptAlive = verification.deadPaths;
		const keptByRecovery = facts.recoveryRefs.length > 0 && keptAlive.length > 0
			? `still held by the ${facts.recoveryRefs.length} recovery point(s) under ${this.settings.backupRefPrefix} (they were excluded from the rewrite)`
			: undefined;
		this.ui.log(
			[
				keptAlive.length === 0
					? 'Verification: no dead paths remain in any branch, remote-tracking branch or tag.'
					: `Verification: ${keptAlive.length} dead path(s) remain${keptByRecovery ? ` - ${keptByRecovery}` : ''}:`,
				...keptAlive.slice(0, 20).map((p) => `  ${p}`),
				...analysis.sizes?.slice(0, 10).map((entry) => `  removed ${formatBytes(entry.bytes).padStart(9)}  ${entry.path}`) ?? [],
			].join('\n'),
		);

		await ctx.safety.record({
			kind: 'cleanHistory',
			summary: `Removed ${analysis.deadPaths.length} dead path(s) from the history${analysis.deadBytes ? ` (${formatBytes(analysis.deadBytes)})` : ''}`,
			undo: {
				type: 'none',
				hint:
					`A full-history rewrite cannot be undone ref by ref. Every commit has a new SHA; `
					+ `the way back is the backup bundle: ${bundleNote}. `
					+ `Restore with: git clone --mirror ${plan.bundleFile ?? '<bundle>'} && push the refs back, or re-clone from a colleague.`,
			},
		});

		// The recovery points still reference the removed objects: offer to drop
		// them so `git gc` can actually reclaim the space (that is the moment
		// Undo of *earlier* operations stops working - the user decides).
		let recoveryNote = '';
		if (facts.recoveryRefs.length > 0) {
			const drop = await this.ui.confirm(
				`Drop the ${facts.recoveryRefs.length} Git Easy Ops recovery point(s) and reclaim the space?`,
				{
					confirmLabel: 'Drop & GC',
					destructive: true,
					detail:
						`They were excluded from the rewrite, so they still hold every removed file:\n`
						+ facts.recoveryRefs.slice(0, 10).map((ref) => `  ${ref}`).join('\n')
						+ (facts.recoveryRefs.length > 10 ? `\n  ... ${facts.recoveryRefs.length - 10} more` : '')
						+ '\n\nDropping them makes "Undo Last Operation" unable to restore earlier operations\n'
						+ 'and runs git reflog expire + git gc --prune=now (the bundle stays as the way back).',
				},
			);
			if (drop) {
				for (const ref of facts.recoveryRefs) {
					await ctx.git.run(['update-ref', '-d', ref]);
				}
				recoveryNote = await reclaimSpace(ctx);
				this.ui.log(`Dropped ${facts.recoveryRefs.length} recovery point(s); ${recoveryNote}.`);
			} else {
				recoveryNote = `recovery points kept - the removed files stay reachable under ${this.settings.backupRefPrefix} until they are dropped`;
				this.ui.log(recoveryNote);
			}
		}

		const headline = keptAlive.length === 0
			? `Cleaned the history: ${analysis.deadPaths.length} dead path(s) removed${analysis.deadBytes ? ` (${formatBytes(analysis.deadBytes)})` : ''}.`
			: `Cleaned the history: ${analysis.deadPaths.length - keptAlive.length} of ${analysis.deadPaths.length} dead path(s) removed - ${keptAlive.length} remain${keptByRecovery ? ` (${keptByRecovery})` : ''}.`;
		const actions = facts.remotes.length > 0 ? [ACTIONS.forcePush, ACTIONS.openLog] : [ACTIONS.openLog];
		const chosen = await this.ui.ask(headline, {
			detail: [
				plan.bundleFile ? `Backup bundle: ${plan.bundleFile}` : '',
				facts.remotes.length > 0
					? 'The remotes still have the OLD history (and with it the dead files) until every branch and tag is force-pushed.'
					: '',
				recoveryNote,
			].filter(Boolean).join('\n'),
			actions,
		});
		if (chosen === ACTIONS.forcePush) {
			await this.forcePush(ctx.git.cwd, []);
		} else if (chosen === ACTIONS.openLog) {
			await this.ui.showOutput?.();
		}
	}

	/** Runs the external rewrite tool; injectable through {@link ControllerOptions}. */
	private async runFilterRepo(ctx: RepoContext, command: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const runner = this.options.filterRepoRunner;
		if (runner) {
			return runner(command, ctx.git.cwd);
		}
		return this.runExternal(command, ctx.git.cwd, FILTER_REPO_TIMEOUT_MS);
	}

	/**
	 * Runs a non-git process (the rewrite tool in its binary form, an
	 * installer probe or an installation). `exec` can only start git, so the
	 * `git ...` form of the rewrite tool is routed through it **without its
	 * leading `git`** - handing the full argv to `exec` would run
	 * `git git filter-repo`, which is why every probe used to fail.
	 */
	private async runExternal(command: readonly string[], cwd: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		if (this.options.processExec) {
			const result = await this.options.processExec(command, { cwd, timeoutMs });
			return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
		}
		if (command[0] === 'git' && this.options.exec) {
			const result = await this.options.exec(command.slice(1), { cwd, timeoutMs });
			return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
		}
		return { exitCode: 127, stdout: '', stderr: `no process runner is available to run ${command[0]}` };
	}

	// ------------------------------------------------------- branch operations

	/**
	 * "Create Branch" - from a commit row in the Source Control Graph the branch
	 * starts at that commit, from a branch row at that branch's tip, and from the
	 * palette at HEAD.
	 */
	async createBranch(cwd: string, args: readonly unknown[]): Promise<void> {
		await this.guard('Create branch', async () => {
			const ctx = this.contextFor(cwd);
			const start = await this.resolveBranchStartPoint(ctx, args);
			const info = start ? await ctx.git.commitInfo(start) : undefined;
			const name = await this.ui.input({
				title: 'Create branch',
				prompt: info ? `New branch at ${info.shortSha} - "${info.subject}"` : 'New branch at HEAD',
				value: info ? suggestBranchName(info.subject) : 'new-branch',
				placeholder: 'feature/new-button',
			});
			if (name === undefined) {
				return;
			}
			const trimmed = name.trim();
			if (!trimmed) {
				await this.ui.message('warn', 'Create branch: a branch name is required.');
				return;
			}
			const result = await this.ui.withProgress(`Creating branch ${trimmed}`, () =>
				createBranchCore(ctx, { name: trimmed, startPoint: start }),
			);
			this.ui.log([`Created branch ${result.name} at ${shorten(result.sha)}`, ...result.notes.map((note) => `  ${note}`)].join('\n'));
			const chosen = await this.ui.ask(
				`Branch "${result.name}" now points at ${shorten(result.sha)}.`,
				{ actions: [ACTIONS.checkout, ACTIONS.undo], detail: result.notes.join('\n') || undefined },
			);
			if (chosen === ACTIONS.checkout) {
				// An object, not a bare string: the resolver reads branch names out of
				// menu arguments, and a plain string would be taken for a commit.
				await this.checkoutBranch(cwd, [{ branch: result.name }]);
			} else if (chosen === ACTIONS.undo) {
				await this.undoLast(ctx, true);
			}
		});
	}

	/** "Check Out Branch" - also offered as a follow-up action after creating one. */
	async checkoutBranch(cwd: string, args: readonly unknown[]): Promise<void> {
		await this.guard('Check out branch', async () => {
			const ctx = this.contextFor(cwd);
			const branch = await this.resolveBranchArg(ctx, args, 'Check out which branch?');
			if (!branch) {
				return;
			}
			const result = await this.ui.withProgress(`Checking out ${branch}`, () => checkoutBranchCore(ctx, branch));
			this.ui.log(`Checked out ${result.to}${result.from ? ` (was ${result.from})` : ''}`);
			const chosen = await this.ui.ask(`"${result.to}" is checked out.`, { actions: [ACTIONS.undo] });
			if (chosen === ACTIONS.undo) {
				await this.undoLast(ctx, true);
			}
		});
	}

	/**
	 * "Rename Branch" - the local rename is free of charge; when the branch
	 * tracks a remote branch the user decides what happens to it.
	 */
	async renameBranch(cwd: string, args: readonly unknown[]): Promise<void> {
		await this.guard('Rename branch', async () => {
			const ctx = this.contextFor(cwd);
			const branch = await this.resolveBranchArg(ctx, args, 'Rename which branch?');
			if (!branch) {
				return;
			}
			const typed = await this.ui.input({
				title: `Rename branch ${branch}`,
				prompt: `New name for "${branch}"`,
				value: branch,
				placeholder: 'feature/new-name',
			});
			if (typed === undefined) {
				return;
			}
			const to = typed.trim();
			if (!to) {
				await this.ui.message('warn', 'Rename branch: a new name is required.');
				return;
			}
			if (to === branch) {
				await this.ui.message('info', `"${branch}" is already called that.`);
				return;
			}
			if (await ctx.git.refExists(`refs/heads/${to}`)) {
				const overwrite = await this.ui.confirm(`A branch called "${to}" already exists. Overwrite it?`, {
					confirmLabel: 'Overwrite',
					cancelLabel: 'Cancel',
					destructive: true,
					detail: `The commits it points at stay reachable through the journal and the reflog.`,
				});
				if (!overwrite) {
					this.ui.log(`Rename branch cancelled: "${to}" already exists.`);
					return;
				}
			}

			const upstreamInfo = await ctx.git.upstream(branch);
			const upstream = upstreamInfo ? `${upstreamInfo.remote}/${upstreamInfo.branch}` : undefined;
			let remote: RenameBranchOptions['remote'] = 'keep';
			if (upstreamInfo) {
				const choice = await this.ui.pick<RenameBranchOptions['remote']>(
					[
						{ label: `Leave ${upstream} alone`, description: `"${to}" keeps tracking it`, value: 'keep' },
						{ label: `Rename it on ${upstreamInfo.remote} too`, description: `push "${to}", delete ${upstream}`, value: 'rename' },
						{ label: `Push "${to}", keep ${upstream}`, description: 'both names exist on the remote', value: 'push' },
					],
					{ title: `${branch} tracks ${upstream}`, placeholder: 'What should happen on the remote?' },
				);
				if (choice === undefined) {
					return;
				}
				remote = choice;
				if (remote !== 'keep' && this.settings.confirmDestructiveOperations) {
					const confirmed = await this.ui.confirm(`Push the rename to ${upstreamInfo.remote}?`, {
						confirmLabel: remote === 'rename' ? 'Rename on the Remote' : 'Push New Name',
						cancelLabel: 'Local Only',
						destructive: remote === 'rename',
						detail: [
							remote === 'rename'
								? `Creates ${upstreamInfo.remote}/${to} and deletes ${upstream}.`
								: `Creates ${upstreamInfo.remote}/${to}; ${upstream} stays where it is.`,
							'Anyone else working from the old remote branch has to fetch and re-point their local copy.',
						].join('\n'),
					});
					if (!confirmed) {
						remote = 'keep';
						this.ui.log(`Renaming "${branch}" locally only - the remote branch was left alone.`);
					}
				}
			}

			const result = await this.ui.withProgress(`Renaming ${branch}`, () => renameBranchCore(ctx, { from: branch, to, remote, force: true }));
			this.ui.log(
				[
					`Renamed branch ${result.from} -> ${result.to} (${shorten(result.sha)})`,
					result.upstreamAfter ? `  tracking ${result.upstreamAfter}` : '',
					...result.notes.map((note) => `  ${note}`),
				]
					.filter(Boolean)
					.join('\n'),
			);
			const chosen = await this.ui.ask(`"${result.from}" is now called "${result.to}".`, {
				actions: [ACTIONS.undo],
				detail: result.notes.join('\n') || undefined,
			});
			if (chosen === ACTIONS.undo) {
				await this.undoLast(ctx, true);
			}
		});
	}

	/** "Delete Branch" - refuses the checked-out branch and unmerged work. */
	async deleteBranch(cwd: string, args: readonly unknown[]): Promise<void> {
		await this.guard('Delete branch', async () => {
			const ctx = this.contextFor(cwd);
			const branch = await this.resolveBranchArg(ctx, args, 'Delete which branch?');
			if (!branch) {
				return;
			}
			const inspection = await inspectBranchDeletion(ctx, branch);
			if (inspection.isCurrent) {
				await this.ui.message('error', `"${branch}" is checked out, so it cannot be deleted.`, 'Check out another branch first.');
				return;
			}

			let deleteRemote = false;
			if (inspection.upstream) {
				const scope = await this.ui.pick<boolean>(
					[
						{ label: 'Delete the local branch only', description: `${inspection.upstream} stays on the remote`, value: false },
						{ label: 'Delete the local and the remote branch', description: `${inspection.upstream} is deleted as well`, value: true },
					],
					{ title: `Delete ${branch}`, placeholder: `${branch} tracks ${inspection.upstream}` },
				);
				if (scope === undefined) {
					return;
				}
				deleteRemote = scope;
			}

			if (this.settings.confirmDestructiveOperations) {
				const confirmed = await this.ui.confirm(
					deleteRemote && inspection.upstream ? `Delete "${branch}" locally and ${inspection.upstream} on the remote?` : `Delete branch "${branch}"?`,
					{
						confirmLabel: deleteRemote ? 'Delete Everywhere' : 'Delete Branch',
						cancelLabel: 'Keep It',
						destructive: true,
						detail: [
							`"${branch}" points at ${shorten(inspection.sha)}.`,
							inspection.upstream ? `It tracks ${inspection.upstream}.` : 'It has no remote branch.',
							inspection.unmergedCommits > 0
								? `${inspection.unmergedCommits} commit(s) exist only here: ${inspection.unmerged.slice(0, 10).map((c) => `${shorten(c.sha)} ${previewSubject(c.subject)}`).join('; ')}${inspection.unmerged.length > 10 ? `; ... and ${inspection.unmerged.length - 10} more` : ''}`
								: 'Every commit on it is reachable from elsewhere.',
							'Undo recreates the branch (and pushes it back if the remote copy was deleted).',
						].join('\n'),
					},
				);
				if (!confirmed) {
					this.ui.log(`Delete branch cancelled: "${branch}" was kept.`);
					return;
				}
			}

			const result = await this.deleteBranchWithForcePrompt(ctx, branch, deleteRemote);
			if (!result) {
				return;
			}
			this.ui.log(
				[
					`Deleted branch ${result.name} (${shorten(result.sha)})${result.forced ? ' with force' : ''}`,
					result.deletedRemoteBranch ? `  also deleted ${result.deletedRemoteBranch}` : '',
					...result.notes.map((note) => `  ${note}`),
				]
					.filter(Boolean)
					.join('\n'),
			);
			const chosen = await this.ui.ask(
				`Deleted branch "${result.name}"${result.deletedRemoteBranch ? ` and ${result.deletedRemoteBranch}` : ''}.`,
				{ actions: [ACTIONS.undo], detail: result.notes.join('\n') || undefined },
			);
			if (chosen === ACTIONS.undo) {
				await this.undoLast(ctx, true);
			}
		});
	}

	/**
	 * "Remove Redundant Branches..." - deletes the branches that carry no commit
	 * of their own, which is what piles up after fast-forwarding `main` (the old
	 * tip stays behind as `old`) or after a merged branch was never cleaned up.
	 *
	 * Redundant means: every commit of the branch is already reachable from
	 * another branch, tag or remote-tracking branch, so removing it changes
	 * nothing about the files - only the list of names gets shorter. The user
	 * sees exactly what would go before anything happens: one checkbox list,
	 * every entry pre-ticked and naming the ref that already holds its commits -
	 * untick what should stay, press OK and exactly the ticked names go. No
	 * second gate after that (only a UI without checkboxes falls back to the
	 * modal confirmation). One Undo brings the whole batch back.
	 *
	 * Remote-tracking branches are part of that list: a branch that was merged on
	 * the remote (`origin/fix/x` while `origin/main` holds every commit of it)
	 * carries nothing either. Its local ref goes with the cleanup; whether the
	 * branch is *also* deleted on the remote (`git push --delete`) is a second
	 * question, because that is the half other people see - the same choice
	 * "Delete Branch..." offers.
	 */
	async removeRedundantBranches(cwd: string): Promise<void> {
		await this.guard('Remove redundant branches', async () => {
			const ctx = this.contextFor(cwd);
			const scan = await this.ui.withProgress('Looking for redundant branches', (report) => {
				report('checking which branches carry commits of their own');
				return findRedundantBranches(ctx);
			});

			const localRedundant = scan.redundant.filter((branch) => !branch.remote).length;
			const remoteRedundant = scan.redundant.length - localRedundant;
			this.ui.log(
				[
					`Scanned ${scan.branchCount} local branch(es) and ${scan.remoteCount} remote-tracking branch(es): `
						+ `${localRedundant} local and ${remoteRedundant} remote redundant, ${scan.kept.length} kept.`,
					...scan.redundant.map((branch) => `  redundant: ${branch.name} (${shorten(branch.sha)}) - already in ${branch.keptAliveBy.join(', ')}${branch.remote ? ` [remote branch on ${branch.remote.remote}]` : ''}`),
					...scan.kept.map((branch) => `  kept: ${branch.name} (${shorten(branch.sha)}) - ${branch.reason}${branch.uniqueCommits > 0 ? ` (${branch.uniqueCommits} own commit(s))` : ''}`),
				].join('\n'),
			);

			if (scan.redundant.length === 0) {
				await this.ui.message(
					'info',
					scan.branchCount <= 1 && scan.remoteCount === 0
						? 'There is nothing to clean up: this repository has a single branch.'
						: 'No redundant branches: every branch here has commits no other branch, tag or remote has.',
					scan.kept.map((branch) => `${branch.name} - ${branch.reason}`).join('\n') || undefined,
				);
				return;
			}

			// Pre-selected, but every branch can be unticked: "redundant" is a
			// fact about the history, whether a name is still wanted is not.
			// The checkbox list *is* the confirmation - the user reviews exactly
			// what would go (each entry naming the ref that already holds it),
			// unticks anything to keep, and OK removes exactly the ticked names.
			// A UI without checkboxes falls back to the whole list, in which case
			// the modal confirmation below is the only gate (and lists them all).
			let chosen = scan.redundant;
			let reviewedInCheckboxList = false;
			if (this.ui.pickMany) {
				const picked = await this.ui.pickMany(
					scan.redundant.map((branch) => ({
						label: branch.name,
						description: branch.remote
							? `remote branch on ${branch.remote.remote} - ${shorten(branch.sha)}`
							: `${shorten(branch.sha)}${branch.upstream ? ` - tracks ${branch.upstream}` : ''}`,
						detail: `already contained in ${branch.keptAliveBy.join(', ')}${branch.subject ? ` - ${previewSubject(branch.subject)}` : ''}`,
						value: branch,
						picked: true,
					})),
					{
						title: `Remove ${scan.redundant.length} redundant branch(es)?`,
						placeholder: 'Deleting these changes no file - untick anything you want to keep',
					},
				);
				if (picked === undefined) {
					this.ui.log('Remove redundant branches: cancelled, every branch was kept.');
					return;
				}
				chosen = picked;
				reviewedInCheckboxList = true;
			}
			if (chosen.length === 0) {
				this.ui.log('Remove redundant branches: nothing was selected.');
				return;
			}

			// Remote-tracking branches need one more answer: their local ref goes
			// either way, the branch on the remote only when the user says so.
			let deleteRemote = false;
			const remoteChosen = chosen.filter((branch) => branch.remote);
			if (remoteChosen.length > 0) {
				const remotes = [...new Set(remoteChosen.map((branch) => branch.remote!.remote))].join(', ');
				const scope = await this.ui.pick<boolean>(
					[
						{ label: 'Remove them locally only', description: `the branch(es) stay on ${remotes}`, value: false },
						{ label: 'Remove them locally and on the remote', description: `deleted on ${remotes} with git push --delete`, value: true },
					],
					{
						title: `${remoteChosen.length} of the selected branches are remote branches`,
						placeholder: remoteChosen.map((branch) => branch.name).join(', '),
					},
				);
				if (scope === undefined) {
					this.ui.log('Remove redundant branches: cancelled, every branch was kept.');
					return;
				}
				deleteRemote = scope;
			}

			// The checkbox list already reviewed the exact victim list, so a
			// second modal would only repeat it; only the checkbox-less fallback
			// needs the modal as its gate.
			if (!reviewedInCheckboxList && this.settings.confirmDestructiveOperations) {
				const confirmed = await this.ui.confirm(
					chosen.length === 1 ? `Delete the redundant branch "${chosen[0]!.name}"?` : `Delete ${chosen.length} redundant branches?`,
					{
						confirmLabel: chosen.length === 1 ? 'Delete Branch' : 'Delete Branches',
						cancelLabel: 'Keep Them',
						destructive: true,
						detail: [
							...chosen.map((branch) => `${branch.name} (${shorten(branch.sha)}) - already in ${branch.keptAliveBy.join(', ')}${branch.remote ? ` [remote branch on ${branch.remote.remote}]` : ''}`),
							'',
							'No commit is lost: every one of them is already reachable from another ref,',
							'so the files and the history stay exactly as they are - only the names go.',
							remoteChosen.length === 0
								? 'The remote branches are not touched.'
								: deleteRemote
									? `The remote branch(es) are deleted on ${[...new Set(remoteChosen.map((branch) => branch.remote!.remote))].join(', ')} as well - the commits stay reachable there too.`
									: 'The branches themselves stay on the remote, only the local remote-tracking refs go.',
							deleteRemote ? 'One Undo brings all of them back and pushes the remote ones back.' : 'One Undo brings all of them back.',
						].join('\n'),
					},
				);
				if (!confirmed) {
					this.ui.log('Remove redundant branches: cancelled, every branch was kept.');
					return;
				}
			}

			const result = await this.ui.withProgress('Removing redundant branches', () => deleteRedundantBranches(ctx, chosen, { deleteRemote }));

			this.ui.log(
				[
					`Deleted ${result.deleted.length} redundant branch(es): ${result.deleted.map((b) => `${b.name} (${shorten(b.sha)})`).join(', ') || '(none)'}`,
					...result.skipped.map((entry) => `  skipped ${entry.name}: ${entry.reason}`),
					...result.notes.map((note) => `  ${note}`),
				].join('\n'),
			);

			if (result.deleted.length === 0) {
				await this.ui.message(
					'warn',
					'No branch was deleted.',
					result.skipped.map((entry) => `${entry.name}: ${entry.reason}`).join('\n') || undefined,
				);
				return;
			}

			const chosenAction = await this.ui.ask(
				result.deleted.length === 1
					? `Removed the redundant branch "${result.deleted[0]!.name}".`
					: `Removed ${result.deleted.length} redundant branches: ${result.deleted.map((b) => b.name).join(', ')}.`,
				{
					actions: [ACTIONS.undo],
					detail: [
						...result.notes,
						...result.skipped.map((entry) => `Kept ${entry.name}: ${entry.reason}`),
					].join('\n') || undefined,
				},
			);
			if (chosenAction === ACTIONS.undo) {
				await this.undoLast(ctx, true);
			}
		});
	}

	/**
	 * Git refuses to delete a branch with unmerged commits; ask explicitly before
	 * forcing, because that is the one case where commits really go away.
	 */
	private async deleteBranchWithForcePrompt(
		ctx: RepoContext,
		branch: string,
		deleteRemote: boolean,
	): Promise<import('./branch').DeleteBranchResult | undefined> {
		try {
			return await this.ui.withProgress(`Deleting ${branch}`, () => deleteBranchCore(ctx, { name: branch, deleteRemote }));
		} catch (error) {
			if (!isGecoError(error) || error.code !== 'unmerged-branch') {
				throw error;
			}
			const insist = await this.ui.confirm(`${error.message} Delete it anyway?`, {
				confirmLabel: 'Delete Anyway',
				cancelLabel: 'Keep It',
				destructive: true,
				detail: [error.detail ?? '', 'The commits stay in the journal and the reflog for a while - Undo brings the branch back.'].filter(Boolean).join('\n'),
			});
			if (!insist) {
				this.ui.log(`Kept "${branch}": it has unmerged commits.`);
				await this.ui.message('info', `"${branch}" was kept.`);
				return undefined;
			}
			return this.ui.withProgress(`Deleting ${branch}`, () => deleteBranchCore(ctx, { name: branch, deleteRemote, force: true }));
		}
	}

	/** The branch a menu argument points at, or a picker when there is none. */
	private async resolveBranchArg(ctx: RepoContext, args: readonly unknown[], title: string): Promise<string | undefined> {
		const resolved = resolveMenuArgs(args);
		const fromArgs = resolved.branchRef;
		if (fromArgs && (await ctx.git.branchExists(fromArgs))) {
			return fromArgs;
		}
		if (fromArgs) {
			this.ui.log(`Ignoring "${fromArgs}" from the menu arguments: no such branch in this repository.`);
		}
		const branches = await ctx.git.branches();
		if (branches.length === 0) {
			throw new GecoError('nothing-to-do', 'This repository has no branches yet.');
		}
		const current = await ctx.git.headBranch();
		const items = branches
			.map((branch) => ({
				label: branch.name,
				description: branch.isHead ? 'checked out' : branch.upstream ?? undefined,
				detail: shorten(branch.sha),
				value: branch.name,
			}))
			.sort((a, b) => Number(b.label === current) - Number(a.label === current) || a.label.localeCompare(b.label));
		return this.ui.pick(items, { title, placeholder: current ? `Current branch: ${current}` : 'Pick a branch' });
	}

	/** Where a new branch should start: the row the menu was opened on, else HEAD. */
	private async resolveBranchStartPoint(ctx: RepoContext, args: readonly unknown[]): Promise<string | undefined> {
		const resolved = resolveMenuArgs(args);
		if (resolved.branchRef && (await ctx.git.branchExists(resolved.branchRef))) {
			return resolved.branchRef;
		}
		for (const candidate of resolved.commitRefs) {
			const sha = await ctx.git.tryRun(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
			if (sha) {
				return sha;
			}
			this.ui.log(`Ignoring "${candidate}" from the menu arguments: not a commit in this repository.`);
		}
		return (await ctx.git.headBranch()) ?? 'HEAD';
	}

	async undoLastOperation(cwd: string): Promise<void> {
		await this.guard('Undo', async () => {
			const ctx = this.contextFor(cwd);
			await this.undoLast(ctx, false);
		});
	}

	private async undoLast(ctx: RepoContext, skipPicker: boolean): Promise<void> {
		const journal = await ctx.safety.readJournal();
		if (journal.length === 0) {
			await this.ui.message('info', 'Nothing to undo: no Git Easy Ops operation was recorded for this repository.');
			return;
		}
		const newestFirst = journal.slice().reverse();
		let index = 0;
		if (!skipPicker && newestFirst.length > 1) {
			const picked = await this.ui.pick(
				newestFirst.map((item, i) => ({
					label: `${item.kind} - ${item.summary}`,
					description: `${new Date(item.at).toLocaleString()}${i > 0 ? ` - also undoes ${i} newer operation${i === 1 ? '' : 's'}` : ''}`,
					value: i,
				})),
				{ title: 'Undo which operation?', placeholder: 'Newest first - an older entry also undoes the newer ones' },
			);
			if (picked === undefined) {
				return;
			}
			index = picked;
		}
		// Undoing an older operation means undoing everything that came after it,
		// otherwise the refs no longer line up and git refuses the update.
		const entries = newestFirst.slice(0, index + 1);

		if (this.settings.confirmDestructiveOperations) {
			const confirmed = await this.ui.confirm(
				entries.length === 1
					? `Undo "${entries[0]!.summary}"?`
					: `Undo ${entries.length} operations, back to "${entries[entries.length - 1]!.summary}"?`,
				{
					confirmLabel: 'Undo',
					destructive: true,
					detail: entries.map((entry) => `${entry.kind}: ${entry.summary}\n  ${describeUndo(entry).split('\n').join('\n  ')}`).join('\n\n'),
				},
			);
			if (!confirmed) {
				this.ui.log('Undo cancelled by the user.');
				return;
			}
		}

		const restored: string[] = [];
		for (const entry of entries) {
			const result = await this.ui.withProgress('Undoing', () => ctx.safety.undo(entry));
			restored.push(...result.restored);
			this.ui.log([`Undid: ${entry.summary}`, ...result.restored.map((r) => `  restored ${r}`), ...result.messages.map((m) => `  ${m}`)].join('\n'));
		}
		const summary = entries.length === 1 ? entries[0]!.summary : `${entries.length} operations (newest: ${entries[0]!.summary})`;
		await this.ui.message('info', `Undone: ${summary}${restored.length > 0 ? ` (${restored.join(', ')})` : ''}`);
	}

	async showBackups(cwd: string): Promise<void> {
		await this.guard('Backups', async () => {
			const ctx = this.contextFor(cwd);
			const points = await ctx.safety.listRecoveryPoints();
			const journal = await ctx.safety.readJournal();
			this.ui.log(
				[
					`Recovery points for ${cwd}`,
					points.length === 0 ? '  (none)' : '',
					...points.map((p) => `  ${p.kind === 'ref' ? 'ref   ' : 'branch'} ${p.name} -> ${shorten(p.sha)}${p.createdAt ? ` (${p.createdAt})` : ''} ${p.description}`),
					'',
					`Journal (${journal.length} entries, newest last):`,
					journal.length === 0 ? '  (empty)' : '',
					...journal.map((e) => `  ${e.at} ${e.kind}: ${e.summary}`),
				].filter((line) => line !== '').join('\n'),
			);

			const chosen = await this.ui.ask(
				points.length === 0 && journal.length === 0
					? 'No recovery points yet - they are created automatically before a rewrite or a branch move.'
					: `${points.length} recovery point(s) and ${journal.length} journaled operation(s) - listed in the output log.`,
				{ actions: journal.length > 0 ? [ACTIONS.undo, ACTIONS.openLog] : [ACTIONS.openLog] },
			);
			if (chosen === ACTIONS.undo) {
				await this.undoLastOperation(cwd);
			} else if (chosen === ACTIONS.openLog) {
				await this.ui.showOutput?.();
			}
		});
	}

	async copyCommitSha(cwd: string, args: readonly unknown[]): Promise<void> {
		await this.guard('Copy SHA', async () => {
			const ctx = this.contextFor(cwd);
			const target = await this.resolveCommit(ctx, args, 'Copy which commit?');
			if (!target) {
				return;
			}
			await this.ui.copy(target);
			await this.ui.message('info', `Copied ${shorten(target)} to the clipboard.`);
		});
	}

	async explainMenus(): Promise<void> {
		const body = [
			'Git Easy Ops shows up in these places - all of them need no special build:',
			'  - Source Control sidebar: the "Git Easy Ops" view. Its "Graph" group *is* the',
			'    commit graph (lane art plus ref badges), and its context menus carry every',
			'    operation - right-click a commit, or expand it and right-click a branch.',
			'    Ctrl/Shift-click selects several commit rows, so "Squash Selected Commits..."',
			'    can turn a run of commits into one. The view reloads itself as soon as an',
			'    operation is done, so the graph is never a squash behind.',
			'  - Branch row / view toolbar: "Remove Redundant Branches..." sweeps up the',
			'    names left over after fast-forwarding - branches whose commits another',
			'    branch, tag or remote already has, so deleting them changes no file.',
			'  - Source Control title / repository menu ("..."): "Git Easy Ops" submenu.',
			'  - Timeline view: right-click a commit of the selected file.',
			'  - Command Palette: "Git Easy Ops: ..." (asks for the commit when nothing is selected).',
			'',
			'The commit and branch context menus of the built-in *Source Control Graph*',
			'are different: VS Code only renders "scm/historyItem/context" (commit rows)',
			'and "scm/historyItemRef/context" (branch/ref rows) for extensions it was told',
			'to grant the proposed API contribSourceControlHistoryItemMenu to, and the',
			'Marketplace refuses manifests that ask for it. So it ships as a second build:',
			'',
			'  1. npm run package:graph              # builds dist/<name>-<version>+graph.vsix',
			'  2. code --install-extension dist/<that file>',
			'  3. allow the proposal for the extension id - either in product.json',
			'       "extensionEnabledApiProposals": { "luncat8.git-easy-context-operations":',
			'         ["contribSourceControlHistoryItemMenu", "contribSourceControlHistoryTitleMenu"] }',
			'     which needs no command line at all, or in argv.json',
			'       "enable-proposed-api": ["luncat8.git-easy-context-operations"]',
			'     (Command Palette: "Preferences: Configure Runtime Arguments"), or per launch',
			'       code --enable-proposed-api luncat8.git-easy-context-operations',
			'  4. restart VS Code',
			'',
			'Step 3 is what "Git Easy Ops: Enable Source Control Graph Menu..." does for',
			'you - it offers both files, writes the entry, and reports which half is still',
			'missing.',
			'',
			'In the graph the items are not hidden in a "Git Easy Ops" submenu: they sit',
			'inside the groups the built-in items already use - squash/reword next to',
			'Cherry Pick, patch / fast-forward / force push right after Compare - so',
			'everything is one click away. On a branch badge, "Rename Branch... > main"',
			'lands next to checkout and delete (that per-ref submenu is how VS Code renders',
			'scm/historyItemRef/context - git has no rename in the graph at all).',
			'',
			'The built-in graph cannot select several rows (VS Code turns multi-selection',
			'off for its own history list), so use "Squash with Previous Commits..." there:',
			'it asks how many commits before the one you clicked should become one. Our own',
			'Graph group above *is* multi-select - Ctrl/Shift-click the rows and use',
			'"Squash Selected Commits...".',
		].join('\n');
		this.ui.log(body);
		await this.ui.message('info', 'Git Easy Ops menus: the sidebar view (graph included), Timeline, SCM title and palette work everywhere. The built-in Source Control Graph menus need the graph build - see the output log.');
	}

	/**
	 * Diagnoses (and, with permission, fixes) the thing that keeps the Source
	 * Control Graph commit menu from appearing: the proposal is not allowed for
	 * this extension. There are two ways to allow it - `product.json` (no command
	 * line at all) and `argv.json` (per user) - and this offers both.
	 */
	async enableGraphMenu(build: GraphMenuBuild, argv: ArgvStore, product?: ArgvStore): Promise<void> {
		await this.guard('Graph menu', async () => {
			let status = assessGraphMenu(build, await argv.read(), product ? await product.read() : undefined);
			this.ui.log(status.report);

			if (status.ready) {
				await this.ui.message('info', 'The Source Control Graph commit menu is enabled for Git Easy Ops. If it is not there yet, restart VS Code.');
				return;
			}

			if (!build.hasProposals) {
				// Half one is a build problem: the manifest has to declare the
				// proposal and contribute the menus.
				const chosen = await this.ui.ask(
					'The installed build cannot show the graph commit menu: it does not declare the proposed API. Install the graph build with "npm run package:graph".',
					{ detail: status.steps.join('\n'), actions: [ACTIONS.openLog] },
				);
				if (chosen === ACTIONS.openLog) {
					await this.ui.showOutput?.();
				}
				return;
			}

			// Half two: allow the proposal. Ask *how*, then confirm the edit.
			const options = graphMenuFixOptions(build).filter((option) => option.value !== 'product' || Boolean(product));
			const fix = await this.ui.pick<GraphMenuFix>(options, {
				title: `Allow proposed APIs for ${build.extensionId}?`,
				placeholder: 'Pick the file to update (nothing is written before you confirm)',
			});
			if (fix === undefined) {
				this.ui.log('Nothing was changed.');
				await this.ui.message('warn', 'The graph commit menu is still not available.', status.steps.join('\n'));
				return;
			}
			if (fix === 'none') {
				this.ui.log('No file was modified.');
				await this.ui.message('warn', 'The graph commit menu is still not available.', status.steps.join('\n'));
				return;
			}

			const option = options.find((candidate) => candidate.value === fix)!;
			const confirmed = await this.ui.confirm(
				fix === 'product'
					? `Allow proposed APIs for ${build.extensionId} in the editor's product.json?`
					: `Allow proposed APIs for ${build.extensionId} in argv.json?`,
				{
					confirmLabel: fix === 'product' ? 'Update product.json' : 'Update argv.json',
					detail: option.detail,
				},
			);
			if (!confirmed) {
				this.ui.log(`${fix === 'product' ? 'product.json' : 'argv.json'} was not modified.`);
				await this.ui.message('warn', 'The graph commit menu is still not available.', status.steps.join('\n'));
				return;
			}

			if (fix === 'product') {
				const backup = await product!.backup();
				const updated = addProductProposals((await product!.read()) ?? '{}', build.extensionId, GRAPH_MENU_PROPOSALS);
				await product!.write(updated);
				this.ui.log(`Updated ${build.productPath}${backup ? ` (backup: ${backup})` : ''}`);
			} else {
				const backup = await argv.backup();
				const updated = addProposedApi((await argv.read()) ?? '', build.extensionId);
				await argv.write(updated);
				this.ui.log(`Updated ${build.argvPath}${backup ? ` (backup: ${backup})` : ''}`);
			}

			status = assessGraphMenu(build, await argv.read(), product ? await product.read() : undefined);
			if (status.ready) {
				const chosen = await this.ui.ask('Graph commit menu enabled. Restart VS Code, then right-click a commit in Source Control > Graph.', {
					actions: [ACTIONS.openLog],
				});
				if (chosen === ACTIONS.openLog) {
					await this.ui.showOutput?.();
				}
				return;
			}

			await this.ui.message('warn', 'The graph commit menu is still not available.', status.steps.join('\n'));
		});
	}

	// ---------------------------------------------------------- view helpers

	async listCommits(cwd: string, limit?: number): Promise<CommitPick[]> {
		const ctx = this.contextFor(cwd);
		const commits = await ctx.git.commits({ limit: limit ?? this.settings.commitPickerLimit });
		const refs = await ctx.git.listRefs(['refs/heads', 'refs/tags']);
		const bySha = new Map<string, string[]>();
		for (const ref of refs) {
			const list = bySha.get(ref.sha) ?? [];
			list.push(ref.kind === 'tag' ? `tag:${ref.name}` : ref.name);
			bySha.set(ref.sha, list);
		}
		return commits.map((commit, index) => ({
			sha: commit.sha,
			label: commit.shortSha,
			description: commit.subject,
			detail: [index === 0 ? 'HEAD' : undefined, (bySha.get(commit.sha) ?? []).join(', ') || undefined, `${commit.author.name}, ${commit.author.date}`]
				.filter(Boolean)
				.join(' - ') || undefined,
		}));
	}

	async listBranches(cwd: string): Promise<RefInfo[]> {
		return this.contextFor(cwd).git.branches();
	}

	/**
	 * Everything the "Graph" group of our own Source Control panel shows: the
	 * commits across all refs in topological order, each with its lane art and
	 * the refs that point at it. This is the stand-in for the built-in Source
	 * Control Graph, whose rows cannot be extended without a proposed API.
	 */
	async graphRows(cwd: string): Promise<GraphCommitRow[]> {
		const ctx = this.contextFor(cwd);
		const [commits, refs] = await Promise.all([
			// Real history only: the recovery refs under `refs/geco/` would
			// otherwise show the commits an operation just replaced.
			ctx.git.commits({ refs: ['--branches', '--remotes', '--tags'], limit: this.settings.graphCommitLimit, topoOrder: true }),
			ctx.git.listRefs(['refs/heads', 'refs/remotes', 'refs/tags']),
		]);
		return buildGraphRows(commits, refs, { lanes: this.settings.showGraphLanes });
	}

	/**
	 * The local branches that point at one commit, re-queried from git. The
	 * tree view asks for this when a commit row is (re-)expanded, instead of
	 * trusting the ref snapshot of a row that may have been painted before a
	 * branch was created or deleted.
	 */
	async commitRefs(cwd: string, sha: string): Promise<GraphRefRow[]> {
		const ctx = this.contextFor(cwd);
		const refs = await ctx.git.listRefs(['refs/heads', 'refs/remotes', 'refs/tags']);
		return refRowsAt(refs, sha);
	}

	async listRecoveryPoints(cwd: string): Promise<RecoveryPoint[]> {
		return this.contextFor(cwd).safety.listRecoveryPoints();
	}

	async listJournal(cwd: string): Promise<JournalEntry[]> {
		return this.contextFor(cwd).safety.readJournal();
	}

	async repoSummary(cwd: string): Promise<{ branch?: string; sha?: string; subject?: string; dirty: boolean }> {
		const ctx = this.contextFor(cwd);
		const branch = await ctx.git.headBranch();
		const sha = await ctx.git.revParse('HEAD');
		const subject = sha ? (await ctx.git.commitInfo(sha)).subject : undefined;
		// Untracked files count as "dirty" for a UI summary: they are what the
		// source control view shows and what an operation could trip over.
		return { branch, sha, subject, dirty: await ctx.git.isDirty({ includeUntracked: true }) };
	}

	// --------------------------------------------------------------- internals

	private async resolveCommit(ctx: RepoContext, args: readonly unknown[], title: string): Promise<string | undefined> {
		const resolved = resolveMenuArgs(args);
		for (const candidate of resolved.commitRefs) {
			const sha = await ctx.git.tryRun(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
			if (sha) {
				return sha;
			}
			this.ui.log(`Ignoring "${candidate}" from the menu arguments: not a commit in this repository.`);
		}
		return this.pickCommit(ctx, title);
	}

	private async pickCommit(ctx: RepoContext, title: string): Promise<string | undefined> {
		const commits = await ctx.git.commits({ limit: this.settings.commitPickerLimit });
		if (commits.length === 0) {
			throw new GecoError('nothing-to-do', 'This repository has no commits yet.');
		}
		const refs = await ctx.git.listRefs(['refs/heads', 'refs/tags']);
		const bySha = new Map<string, string[]>();
		for (const ref of refs) {
			const list = bySha.get(ref.sha) ?? [];
			list.push(ref.kind === 'tag' ? `tag:${ref.name}` : ref.name);
			bySha.set(ref.sha, list);
		}

		const items = commits.map((commit, index) => ({
			label: `$(git-commit) ${commit.shortSha}`,
			description: commit.subject,
			detail: [index === 0 ? 'HEAD' : undefined, (bySha.get(commit.sha) ?? []).join(', ') || undefined].filter(Boolean).join(' - ') || undefined,
			value: commit.sha,
		}));
		items.push({ label: '$(keyboard) Type a reference...', description: 'sha, branch, tag, HEAD~3', detail: undefined, value: TYPE_REF });

		const chosen = await this.ui.pick(items, { title, placeholder: `${commits.length} most recent commits` });
		if (chosen === undefined) {
			return undefined;
		}
		if (chosen !== TYPE_REF) {
			return chosen;
		}
		const typed = await this.ui.input({ title, prompt: 'Commit reference', placeholder: 'sha, branch, tag or HEAD~3' });
		if (!typed || !typed.trim()) {
			return undefined;
		}
		const sha = await ctx.git.tryRun(['rev-parse', '--verify', '--quiet', `${typed.trim()}^{commit}`]);
		if (!sha) {
			await this.ui.message('error', `"${typed.trim()}" does not resolve to a commit in this repository.`);
			return undefined;
		}
		return sha;
	}

	private async guard(label: string, body: () => Promise<void>): Promise<void> {
		try {
			await body();
		} catch (error) {
			if (isGecoError(error) && error.code === 'cancelled') {
				this.ui.log(`${label}: cancelled.`);
				return;
			}
			const message = toErrorMessage(error);
			this.ui.log(`${label} failed:\n${message}`);
			const [headline, ...rest] = message.split('\n');
			await this.ui.message('error', `${label}: ${headline}`, rest.length > 0 ? rest.join('\n') : undefined);
		}
	}
}

type SourceChoice =
	| { kind: 'source'; source: PatchSource }
	| { kind: 'commit' }
	| { kind: 'range' }
	| { kind: 'file' };

const TYPE_REF = '__geco_type_ref__';

function describeUndo(entry: JournalEntry): string {
	switch (entry.undo.type) {
		case 'refs': {
			const parts = entry.undo.refs.map((r) => `${r.ref} -> ${shorten(r.restoreTo)}`);
			if (entry.undo.deleteBranches?.length) {
				parts.push(`delete branch(es) ${entry.undo.deleteBranches.join(', ')}`);
			}
			for (const remoteRef of entry.undo.remoteRefs ?? []) {
				parts.push(
					remoteRef.action === 'delete'
						? `delete ${remoteRef.remote}/${remoteRef.branch}`
						: `${remoteRef.remote}/${remoteRef.branch} -> ${shorten(remoteRef.restoreTo ?? '')}`,
				);
			}
			if (entry.undo.worktrees?.length) {
				parts.push(`remove worktree(s) ${entry.undo.worktrees.map((w) => w.path).join(', ')}`);
			}
			if (entry.undo.checkoutRef) {
				parts.push(`check out ${entry.undo.checkoutRef} again`);
			}
			return parts.length > 0 ? parts.join('\n') : 'No refs to restore.';
		}
		case 'remoteRef':
			return `${entry.undo.remote}/${entry.undo.branch} -> ${shorten(entry.undo.restoreTo)} (force push back to the remote)`;
		case 'none':
			return entry.undo.hint;
		default:
			return '';
	}
}
