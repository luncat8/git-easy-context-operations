/** Settings come from a JSON file a human can edit: nothing may crash on junk. */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { CONFIG_KEYS, CONFIG_SECTION, DEFAULT_SETTINGS, normalizeRefPrefix, normalizeSettings } from '../../core/config';

describe('config - defaults', () => {
	it('returns the defaults for empty, null and undefined input', () => {
		for (const input of [undefined, null, {}]) {
			assert.deepEqual(normalizeSettings(input), DEFAULT_SETTINGS);
		}
	});

	it('has a default for every declared key', () => {
		assert.equal(Object.keys(CONFIG_KEYS).length, Object.keys(DEFAULT_SETTINGS).length);
		for (const key of Object.keys(CONFIG_KEYS)) {
			assert.ok(key in DEFAULT_SETTINGS, `no default for ${key}`);
			assert.ok((DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key] !== undefined, `default for ${key} is undefined`);
		}
	});

	it('uses the section name the manifest contributes under', () => {
		assert.equal(CONFIG_SECTION, 'geco');
		for (const key of Object.values(CONFIG_KEYS)) {
			assert.ok(key.startsWith(`${CONFIG_SECTION}.`), key);
		}
	});

	it('keeps the values the README documents', () => {
		assert.equal(DEFAULT_SETTINGS.defaultBackupBranchName, 'old');
		assert.equal(DEFAULT_SETTINGS.backupRefPrefix, 'refs/geco/');
		assert.equal(DEFAULT_SETTINGS.forcePushMode, 'lease');
		assert.equal(DEFAULT_SETTINGS.confirmDestructiveOperations, true);
		assert.equal(DEFAULT_SETTINGS.preserveCommitterDateOnReword, true);
		assert.equal(DEFAULT_SETTINGS.applyPatchDestination, 'newBranch');
		assert.equal(DEFAULT_SETTINGS.threeWayApply, true);
	});
});

describe('config - normalisation', () => {
	it('accepts valid values unchanged', () => {
		const settings = normalizeSettings({
			gitPath: '/usr/local/bin/git',
			defaultBackupBranchName: 'archive',
			backupRefPrefix: 'refs/backup/',
			forcePushMode: 'force',
			confirmDestructiveOperations: false,
			preserveCommitterDateOnReword: false,
			commitPickerLimit: 120,
			patchBaseCandidateLimit: 12,
			applyPatchDestination: 'worktree',
			worktreeFolder: 'wt',
			threeWayApply: false,
			journalMaxEntries: 5,
			showGraphMenuHint: false,
		});
		assert.equal(settings.gitPath, '/usr/local/bin/git');
		assert.equal(settings.defaultBackupBranchName, 'archive');
		assert.equal(settings.backupRefPrefix, 'refs/backup/');
		assert.equal(settings.forcePushMode, 'force');
		assert.equal(settings.confirmDestructiveOperations, false);
		assert.equal(settings.commitPickerLimit, 120);
		assert.equal(settings.applyPatchDestination, 'worktree');
		assert.equal(settings.worktreeFolder, 'wt');
		assert.equal(settings.journalMaxEntries, 5);
	});

	it('replaces junk with the default instead of throwing', () => {
		const settings = normalizeSettings({
			gitPath: 42,
			defaultBackupBranchName: null,
			backupRefPrefix: ['refs/geco/'],
			forcePushMode: 'yolo',
			confirmDestructiveOperations: 'yes',
			preserveCommitterDateOnReword: 1,
			commitPickerLimit: 'lots',
			patchBaseCandidateLimit: Number.NaN,
			applyPatchDestination: 'somewhere',
			worktreeFolder: 7,
			threeWayApply: undefined,
			journalMaxEntries: Infinity,
			showGraphMenuHint: {},
		});
		assert.deepEqual(settings, { ...DEFAULT_SETTINGS, gitPath: DEFAULT_SETTINGS.gitPath });
	});

	it('clamps numbers into the documented ranges and rounds them', () => {
		assert.equal(normalizeSettings({ commitPickerLimit: 1 }).commitPickerLimit, 5);
		assert.equal(normalizeSettings({ commitPickerLimit: 99999 }).commitPickerLimit, 1000);
		assert.equal(normalizeSettings({ commitPickerLimit: 12.6 }).commitPickerLimit, 13);
		assert.equal(normalizeSettings({ patchBaseCandidateLimit: 0 }).patchBaseCandidateLimit, 1);
		assert.equal(normalizeSettings({ patchBaseCandidateLimit: 5000 }).patchBaseCandidateLimit, 500);
		assert.equal(normalizeSettings({ journalMaxEntries: -3 }).journalMaxEntries, 1);
		assert.equal(normalizeSettings({ journalMaxEntries: 1e9 }).journalMaxEntries, 1000);
	});

	it('never accepts an empty backup branch name or worktree folder', () => {
		assert.equal(normalizeSettings({ defaultBackupBranchName: '   ' }).defaultBackupBranchName, 'old');
		assert.equal(normalizeSettings({ worktreeFolder: '   ' }).worktreeFolder, '.geco-worktrees');
		assert.equal(normalizeSettings({ worktreeFolder: '/wt/' }).worktreeFolder, 'wt', 'slashes are trimmed so the path stays relative');
		assert.equal(normalizeSettings({ worktreeFolder: '\\wt\\' }).worktreeFolder, 'wt');
	});

	it('normalises the backup ref prefix into a full, trailing-slash ref prefix', () => {
		assert.equal(normalizeRefPrefix('geco'), 'refs/geco/');
		assert.equal(normalizeRefPrefix('refs/geco'), 'refs/geco/');
		assert.equal(normalizeRefPrefix('refs/geco/'), 'refs/geco/');
		assert.equal(normalizeRefPrefix('  refs/backup  '), 'refs/backup/');
		assert.equal(normalizeRefPrefix(''), 'refs/geco/');
		assert.equal(normalizeRefPrefix('   '), 'refs/geco/');
		assert.equal(normalizeSettings({ backupRefPrefix: 'my-backups' }).backupRefPrefix, 'refs/my-backups/');
	});

	it('keeps an empty gitPath empty so the caller can fall back to git.path', () => {
		assert.equal(normalizeSettings({ gitPath: '' }).gitPath, '');
		assert.equal(normalizeSettings({ gitPath: 'git' }).gitPath, 'git');
	});
});
