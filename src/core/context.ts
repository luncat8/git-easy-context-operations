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

export function createRepoContext(cwd: string, settings?: Partial<Settings> | null, exec?: GitExec): RepoContext {
	const resolved = normalizeSettings({ ...DEFAULT_SETTINGS, ...(settings ?? {}) } as Record<string, unknown>);
	const gitExec = exec ?? createGitExec({ gitPath: resolved.gitPath });
	const git = new Git(gitExec, cwd);
	return { cwd, git, safety: new SafetyNet(git, resolved), settings: resolved };
}
