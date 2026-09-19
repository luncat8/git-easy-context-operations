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
import { ACTIONS, type QuickPickChoice, type UI } from './ui';
import { resolveMenuArgs } from './args';
import {
	applyMessageEdit,
	findRewriteBranch,
	messageSubject,
	normalizeMessage,
	rewordCommitMessage,
	type MessageEdit,
	type RewordResult,
} from './reword';
import { fastForwardBranch, resolveBranch, type FastForwardResult } from './fastForward';
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
import { assessGraphMenu, type ArgvStore, type GraphMenuBuild } from './graphMenu';
import { addProposedApi } from './argvJson';
import { shorten, timestamp, type JournalEntry, type RecoveryPoint } from './safety';
import type { CommitInfo, RefInfo } from './git';
import type { ForcePushMode, PatchDestination } from './config';

export type RewordFlow = 'replace' | 'append' | 'findReplace';

export interface ControllerOptions {
	ui: UI;
	settings: Settings;
	exec?: GitExec;
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
		return createRepoContext(cwd, this.settings, this.options.exec);
	}

	// ------------------------------------------------------------- feature 1

	async rewordCommit(cwd: string, args: readonly unknown[], flow: RewordFlow): Promise<void> {
		await this.guard('Reword commit', async () => {
			const ctx = this.contextFor(cwd);
			const target = await this.resolveCommit(ctx, args, 'Reword which commit?');
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
			const newMessage = edit.message !== undefined ? normalizeMessage(edit.message) : applyMessageEdit(oldMessage, edit.edit!);
			if (normalizeMessage(oldMessage) === newMessage) {
				await this.ui.message('info', `The message of ${info.shortSha} is unchanged - nothing was rewritten.`);
				return;
			}

			const descendants = await ctx.git.countCommits(`${target}..refs/heads/${branch}`);
			const total = 1 + descendants;
			const upstream = await ctx.git.upstream(branch);

			if (this.settings.confirmDestructiveOperations) {
				const confirmed = await this.ui.confirm(`Reword ${info.shortSha} on ${branch}?`, {
					confirmLabel: 'Reword',
					destructive: true,
					detail: [
						`"${messageSubject(oldMessage)}"`,
						`   -> "${messageSubject(newMessage)}"`,
						'',
						`${total} commit${total === 1 ? '' : 's'} get a new SHA${descendants > 0 ? ` (${info.shortSha} plus ${descendants} after it)` : ''}. Trees, parents and author dates are kept.`,
						`Recovery point: ${this.settings.backupRefPrefix}... , restore it with "Git Easy Ops: Undo Last Operation".`,
						upstream?.sha ? `${branch} tracks ${upstream.remote}/${upstream.branch}: a force push is needed afterwards.` : '',
					].filter(Boolean).join('\n'),
				});
				if (!confirmed) {
					this.ui.log(`Reword of ${info.shortSha} cancelled by the user.`);
					return;
				}
			}

			const result = await this.ui.withProgress(`Rewording ${info.shortSha}`, async (report) => {
				report(`rewriting ${total} commit${total === 1 ? '' : 's'} on ${branch}`);
				return rewordCommitMessage(ctx, { commit: target, message: edit.message, edit: edit.edit, branch });
			});

			await this.reportReword(ctx, result, cwd);
		});
	}

	private async askForMessage(info: CommitInfo, flow: RewordFlow): Promise<{ message?: string; edit?: MessageEdit } | undefined> {
		if (flow === 'replace') {
			const value = await this.ui.input({
				title: `Reword ${info.shortSha}`,
				prompt: `Commit message (currently "${info.subject}")`,
				value: info.message,
			});
			if (value === undefined) {
				return undefined;
			}
			if (!value.trim()) {
				await this.ui.message('warn', 'A commit message cannot be empty.');
				return undefined;
			}
			return { message: value };
		}

		if (flow === 'append') {
			const value = await this.ui.input({
				title: `Append to ${info.shortSha}`,
				prompt: `Append to "${info.subject}"`,
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
			title: `Rename in ${info.shortSha}`,
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
			title: `Rename in ${info.shortSha}`,
			prompt: `Replace "${find}" with`,
			value: find,
		});
		if (replaceWith === undefined) {
			return undefined;
		}
		return { edit: { mode: 'findReplace', find, text: replaceWith } };
	}

	private async pickRewriteBranch(ctx: RepoContext, target: string, info: CommitInfo): Promise<string | undefined> {
		const rewrite = await findRewriteBranch(ctx, target);
		if (rewrite.branch) {
			return rewrite.branch;
		}
		if (rewrite.candidates.length === 0) {
			await this.ui.message('error', `${info.shortSha} is not reachable from any local branch, so its message cannot be rewritten.`, rewrite.currentBranch ? `HEAD is ${rewrite.currentBranch}.` : 'HEAD is detached.');
			return undefined;
		}
		return this.ui.pick(
			rewrite.candidates.map((name) => ({
				label: name,
				description: name === rewrite.currentBranch ? 'current branch' : undefined,
				value: name,
			})),
			{ title: `Reword ${info.shortSha} on which branch?`, placeholder: 'The commit is on more than one branch' },
		);
	}

	private async reportReword(ctx: RepoContext, result: RewordResult, cwd: string): Promise<void> {
		const where = result.branch ?? 'detached HEAD';
		this.ui.log(
			[
				`Reworded ${shorten(result.targetSha)} -> ${shorten(result.newTargetSha)} on ${where}`,
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

		const message = `Reworded ${shorten(result.newTargetSha)} on ${where}: "${messageSubject(result.newMessage)}"`
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

			if (this.settings.confirmDestructiveOperations) {
				const confirmed = await this.ui.confirm(`Move ${branch} to ${targetInfo.shortSha}?`, {
					confirmLabel: isFastForward ? 'Move' : 'Move anyway',
					destructive: !isFastForward,
					detail: [
						`${branch}: ${shorten(from)} -> ${shorten(target)}`,
						`"${targetInfo.subject}"`,
						'',
						isFastForward
							? `Fast-forward: ${counts.right === 1 ? '1 commit is' : `${counts.right} commits are`} added, nothing is lost.`
							: `NOT a fast-forward: ${counts.left} commit${counts.left === 1 ? '' : 's'} on ${branch} would be left behind.`,
						`The old tip is kept on branch "${backupName}" (a suffix is added if that name is taken).`,
					].join('\n'),
				});
				if (!confirmed) {
					this.ui.log(`Fast-forward of ${branch} cancelled by the user.`);
					return;
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

			await this.reportFastForward(ctx, result, cwd);
		});
	}

	private async askForForce(error: GecoError, branch: string, target: string): Promise<boolean> {
		this.ui.log(`"${branch}" diverged from ${target}: ${error.message}`);
		return this.ui.confirm(`"${branch}" has commits that ${target} does not. Move it anyway?`, {
			confirmLabel: 'Move anyway',
			destructive: true,
			detail: `${error.detail ?? ''}\n\nThe old tip is still moved onto the backup branch first, so nothing is lost.`,
		});
	}

	private async reportFastForward(ctx: RepoContext, result: FastForwardResult, cwd: string): Promise<void> {
		this.ui.log(
			[
				`Moved ${result.branch}: ${shorten(result.from)} -> ${shorten(result.to)} (${result.wasFastForward ? 'fast-forward' : 'forced'})`,
				`  "${result.toSubject}"`,
				`  ahead ${result.ahead}, behind ${result.behind}`,
				result.backup ? `  old tip kept on ${result.backup.name}${result.backup.reused ? ' (reused)' : ''}` : '  no backup branch created',
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
			`${result.branch} now points at ${shorten(result.to)} ("${result.toSubject}")${result.backup ? `, old tip kept on ${result.backup.name}` : ''}.`,
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
			'  - Source Control sidebar: the "Git Easy Ops" view (commits, branches, backups) with a full context menu.',
			'  - Source Control title / repository menu ("..."): "Git Easy Ops" submenu.',
			'  - Timeline view: right-click a commit of the selected file.',
			'  - Command Palette: "Git Easy Ops: ..." (asks for the commit when nothing is selected).',
			'',
			'The commit context menu of the built-in *Source Control Graph* is different:',
			'VS Code only renders "scm/historyItem/context" for extensions it was told to',
			'grant the proposed API contribSourceControlHistoryItemMenu to, and the',
			'Marketplace refuses manifests that ask for it. So it ships as a second build:',
			'',
			'  1. npm run package:graph              # builds <name>-<version>+graph.vsix',
			'  2. code --install-extension <that file>',
			'  3. allow the proposal, either persistently in argv.json',
			'       "enable-proposed-api": ["luncat8.git-easy-context-operations"]',
			'     (Command Palette: "Preferences: Configure Runtime Arguments")',
			'     or per launch: code --enable-proposed-api luncat8.git-easy-context-operations',
			'  4. restart VS Code',
			'',
			'Step 3 is what "Git Easy Ops: Enable Source Control Graph Menu..." does for',
			'you - it also reports which of the two halves is still missing.',
		].join('\n');
		this.ui.log(body);
		await this.ui.message('info', 'Git Easy Ops menus: the sidebar view, Timeline, SCM title and palette work everywhere. The Source Control Graph commit menu needs the graph build - see the output log.');
	}

	/**
	 * Diagnoses (and, with permission, fixes) the one thing that keeps the Source
	 * Control Graph commit menu from appearing: the proposal is not allowed for
	 * this extension in VS Code's runtime arguments file.
	 */
	async enableGraphMenu(build: GraphMenuBuild, store: ArgvStore): Promise<void> {
		await this.guard('Graph menu', async () => {
			let status = assessGraphMenu(build, await store.read());
			this.ui.log(status.report);

			if (status.ready) {
				await this.ui.message('info', 'The Source Control Graph commit menu is enabled for Git Easy Ops. If it is not there yet, restart VS Code.');
				return;
			}

			if (!status.allowedInArgv) {
				const confirmed = await this.ui.confirm(`Allow proposed APIs for ${build.extensionId}?`, {
					confirmLabel: 'Update argv.json',
					detail: [
						`Adds one line to ${build.argvPath}:`,
						'',
						`  "enable-proposed-api": ["${build.extensionId}"]`,
						'',
						'A backup is written next to the file, comments are kept, and VS Code must be restarted.',
						build.hasProposals ? '' : 'Note: the installed build also has to be the graph build (see the output log).',
					].filter((line) => line !== undefined).join('\n'),
				});
				if (!confirmed) {
					this.ui.log('argv.json was not modified.');
				} else {
					const backup = await store.backup();
					const updated = addProposedApi((await store.read()) ?? '', build.extensionId);
					await store.write(updated);
					this.ui.log(`Updated ${build.argvPath}${backup ? ` (backup: ${backup})` : ''}`);
					status = assessGraphMenu(build, updated);
				}
			}

			if (status.ready) {
				const chosen = await this.ui.ask('Graph commit menu enabled. Restart VS Code, then right-click a commit in Source Control > Graph.', {
					actions: [ACTIONS.openLog],
				});
				if (chosen === ACTIONS.openLog) {
					await this.ui.showOutput?.();
				}
				return;
			}

			if (!build.hasProposals) {
				const chosen = await this.ui.ask(
					'The installed build cannot show the graph commit menu: it does not declare the proposed API. Install the graph build with "npm run package:graph".',
					{ detail: status.steps.join('\n'), actions: [ACTIONS.openLog] },
				);
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
