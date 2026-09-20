/**
 * Everything the operations need, in one value: a Git facade bound to a
 * repository, the safety net (backups + journal) and the resolved settings.
 */
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from './config';
import { Git } from './git';
import { createGitExec, type GitExec } from './gitRunner';
import { SafetyNet } from './safety';

export interface RepoContext {
	readonly cwd: string;
	readonly git: Git;
	readonly safety: SafetyNet;
	readonly settings: Settings;
}

export interface RepoContextOptions {
	exec?: GitExec;
	/**
	 * Called whenever an operation changed the repository (journaled or undone).
	 * The VS Code layer refreshes the tree view with it, so the graph is current
	 * as soon as the operation is done - including the follow-up actions
	 * ("Undo", "Force Push") that run after the command itself returned.
	 */
	onChanged?(): void;
}

export function createRepoContext(
	cwd: string,
	settings?: Partial<Settings> | null,
	execOrOptions?: GitExec | RepoContextOptions,
): RepoContext {
	const options: RepoContextOptions = typeof execOrOptions === 'function' ? { exec: execOrOptions } : execOrOptions ?? {};
	const resolved = normalizeSettings({ ...DEFAULT_SETTINGS, ...(settings ?? {}) } as Record<string, unknown>);
	const gitExec = options.exec ?? createGitExec({ gitPath: resolved.gitPath });
	const git = new Git(gitExec, cwd);
	return { cwd, git, safety: new SafetyNet(git, resolved, options.onChanged), settings: resolved };
}
