/**
 * Typed settings + defaults.
 *
 * The VS Code layer maps `workspace.getConfiguration('geco')` onto
 * {@link Settings}; every other layer only ever sees a plain object, which keeps
 * the operations testable without VS Code.
 */

export const CONFIG_SECTION = 'geco';

export type ForcePushMode = 'lease' | 'force';
export type PatchDestination = 'current' | 'newBranch' | 'worktree';

export interface Settings {
	gitPath: string;
	defaultBackupBranchName: string;
	backupRefPrefix: string;
	forcePushMode: ForcePushMode;
	confirmDestructiveOperations: boolean;
	preserveCommitterDateOnReword: boolean;
	commitPickerLimit: number;
	patchBaseCandidateLimit: number;
	applyPatchDestination: PatchDestination;
	worktreeFolder: string;
	threeWayApply: boolean;
	journalMaxEntries: number;
	showGraphMenuHint: boolean;
	graphCommitLimit: number;
	showGraphLanes: boolean;
}

/**
 * Every key contributed in `package.json` -> `contributes.configuration`.
 * `src/test/core/manifest.test.ts` asserts this stays in sync with the manifest.
 */
export const CONFIG_KEYS: Readonly<Record<keyof Settings, string>> = {
	gitPath: 'geco.gitPath',
	defaultBackupBranchName: 'geco.defaultBackupBranchName',
	backupRefPrefix: 'geco.backupRefPrefix',
	forcePushMode: 'geco.forcePushMode',
	confirmDestructiveOperations: 'geco.confirmDestructiveOperations',
	preserveCommitterDateOnReword: 'geco.preserveCommitterDateOnReword',
	commitPickerLimit: 'geco.commitPickerLimit',
	patchBaseCandidateLimit: 'geco.patchBaseCandidateLimit',
	applyPatchDestination: 'geco.applyPatchDestination',
	worktreeFolder: 'geco.worktreeFolder',
	threeWayApply: 'geco.threeWayApply',
	journalMaxEntries: 'geco.journalMaxEntries',
	showGraphMenuHint: 'geco.showGraphMenuHint',
	graphCommitLimit: 'geco.graphCommitLimit',
	showGraphLanes: 'geco.showGraphLanes',
};

export const DEFAULT_SETTINGS: Settings = {
	gitPath: '',
	defaultBackupBranchName: 'old',
	backupRefPrefix: 'refs/geco/',
	forcePushMode: 'lease',
	confirmDestructiveOperations: true,
	preserveCommitterDateOnReword: true,
	commitPickerLimit: 50,
	patchBaseCandidateLimit: 40,
	applyPatchDestination: 'newBranch',
	worktreeFolder: '.geco-worktrees',
	threeWayApply: true,
	journalMaxEntries: 100,
	showGraphMenuHint: true,
	graphCommitLimit: 200,
	showGraphLanes: true,
};

const FORCE_PUSH_MODES: readonly ForcePushMode[] = ['lease', 'force'];
const PATCH_DESTINATIONS: readonly PatchDestination[] = ['current', 'newBranch', 'worktree'];

function asString(value: unknown, fallback: string): string {
	return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return fallback;
	}
	const clamped = Math.round(value);
	return Math.min(max, Math.max(min, clamped));
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Merge raw configuration (possibly partial, possibly garbage) with the
 * defaults. Never throws - a bad setting falls back to its default.
 */
export function normalizeSettings(raw: Record<string, unknown> | undefined | null): Settings {
	const source = raw ?? {};
	return {
		gitPath: typeof source.gitPath === 'string' ? source.gitPath : DEFAULT_SETTINGS.gitPath,
		defaultBackupBranchName: asString(source.defaultBackupBranchName, DEFAULT_SETTINGS.defaultBackupBranchName).trim() || 'old',
		backupRefPrefix: normalizeRefPrefix(asString(source.backupRefPrefix, DEFAULT_SETTINGS.backupRefPrefix)),
		forcePushMode: asEnum(source.forcePushMode, FORCE_PUSH_MODES, DEFAULT_SETTINGS.forcePushMode),
		confirmDestructiveOperations: asBoolean(source.confirmDestructiveOperations, DEFAULT_SETTINGS.confirmDestructiveOperations),
		preserveCommitterDateOnReword: asBoolean(source.preserveCommitterDateOnReword, DEFAULT_SETTINGS.preserveCommitterDateOnReword),
		commitPickerLimit: asInt(source.commitPickerLimit, DEFAULT_SETTINGS.commitPickerLimit, 5, 1000),
		patchBaseCandidateLimit: asInt(source.patchBaseCandidateLimit, DEFAULT_SETTINGS.patchBaseCandidateLimit, 1, 500),
		applyPatchDestination: asEnum(source.applyPatchDestination, PATCH_DESTINATIONS, DEFAULT_SETTINGS.applyPatchDestination),
		worktreeFolder: asString(source.worktreeFolder, DEFAULT_SETTINGS.worktreeFolder).trim().replace(/^[/\\]+|[/\\]+$/g, '').trim() || '.geco-worktrees',
		threeWayApply: asBoolean(source.threeWayApply, DEFAULT_SETTINGS.threeWayApply),
		journalMaxEntries: asInt(source.journalMaxEntries, DEFAULT_SETTINGS.journalMaxEntries, 1, 1000),
		showGraphMenuHint: asBoolean(source.showGraphMenuHint, DEFAULT_SETTINGS.showGraphMenuHint),
		graphCommitLimit: asInt(source.graphCommitLimit, DEFAULT_SETTINGS.graphCommitLimit, 10, 5000),
		showGraphLanes: asBoolean(source.showGraphLanes, DEFAULT_SETTINGS.showGraphLanes),
	};
}

export function normalizeRefPrefix(prefix: string): string {
	const trimmed = prefix.trim();
	if (!trimmed) {
		return DEFAULT_SETTINGS.backupRefPrefix;
	}
	const withRefs = trimmed.startsWith('refs/') ? trimmed : `refs/${trimmed}`;
	return withRefs.endsWith('/') ? withRefs : `${withRefs}/`;
}
