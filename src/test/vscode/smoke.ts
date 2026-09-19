/**
 * Integration smoke test: runs *inside* a real VS Code extension host.
 *
 * The git engine is covered exhaustively by the headless suite (`npm test`), so
 * this file only proves the parts that need an editor: the manifest loads, the
 * extension activates, every contributed command is registered, and a command
 * driven from the outside really reaches git.
 *
 * Run with `npm run test:vscode` (on Linux: `xvfb-run -a npm run test:vscode`).
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'luncat8.git-easy-context-operations';

const EXPECTED_COMMANDS = [
	'geco.rewordCommit',
	'geco.rewordCommitAppend',
	'geco.rewordCommitRename',
	'geco.squashSelectedCommits',
	'geco.squashWithPreviousCommits',
	'geco.fastForwardDefaultBranch',
	'geco.fastForwardBranch',
	'geco.forcePush',
	'geco.forcePushHard',
	'geco.applyPatchAtProperBase',
	'geco.findProperBase',
	'geco.createBackupBranch',
	'geco.createBranch',
	'geco.renameBranch',
	'geco.deleteBranch',
	'geco.checkoutBranch',
	'geco.undoLastOperation',
	'geco.showBackups',
	'geco.copyCommitSha',
	'geco.refresh',
	'geco.explainMenus',
	'geco.enableGraphMenu',
];

export async function run(): Promise<void> {
	const results: [string, () => Promise<void>][] = [
		['the manifest is loaded with its contributions', testManifest],
		['the extension activates', testActivation],
		['every contributed command is registered', testCommands],
		['refresh works without a repository', testRefresh],
		['a command reaches git and copies a sha', testCopySha],
	];

	const failures: string[] = [];
	for (const [name, test] of results) {
		try {
			await test();
			console.log(`  ok  ${name}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failures.push(`${name}: ${message}`);
			console.error(`  FAIL ${name}\n       ${message}`);
		}
	}
	if (failures.length > 0) {
		throw new Error(`${failures.length} integration check(s) failed:\n${failures.join('\n')}`);
	}
	console.log('All VS Code integration checks passed.');
}

async function testManifest(): Promise<void> {
	const extension = vscode.extensions.getExtension(EXTENSION_ID);
	assert.ok(extension, `${EXTENSION_ID} is not installed in the test instance`);
	const contributes = extension.packageJSON.contributes;
	assert.equal(contributes.views.scm[0].id, 'geco.history');
	assert.equal(contributes.viewsWelcome[0].view, 'geco.history');
	assert.ok(contributes.commands.length >= EXPECTED_COMMANDS.length - 1, 'commands are contributed');
	assert.equal(contributes.configuration.title, 'Git Easy Ops');
	assert.ok(Object.keys(contributes.configuration.properties).length >= 13, 'settings are contributed');
	// A shipped manifest must not ask for proposed APIs, or activation is blocked.
	assert.equal(extension.packageJSON.enabledApiProposals, undefined);
	for (const key of ['scm/historyItem/context', 'scm/historyItemRef/context', 'scm/history/title']) {
		assert.equal(key in contributes.menus, false, `${key} must stay out of the default manifest`);
	}
}

async function testActivation(): Promise<void> {
	const extension = vscode.extensions.getExtension(EXTENSION_ID)!;
	if (!extension.isActive) {
		await extension.activate();
	}
	assert.equal(extension.isActive, true);
}

async function testCommands(): Promise<void> {
	const registered = await vscode.commands.getCommands(true);
	const missing = EXPECTED_COMMANDS.filter((id) => !registered.includes(id));
	assert.deepEqual(missing, [], `commands are not registered: ${missing.join(', ')}`);
}

async function testRefresh(): Promise<void> {
	await vscode.commands.executeCommand('geco.refresh');
}

async function testCopySha(): Promise<void> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geco-vscode-'));
	try {
		const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv(dir) });
		fs.mkdirSync(path.join(dir, 'home'));
		git(['init', '--quiet', '--initial-branch=main']);
		git(['config', 'user.name', 'VS Code Test']);
		git(['config', 'user.email', 'test@example.com']);
		fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n', 'utf8');
		git(['add', '-A']);
		git(['commit', '--quiet', '-m', 'v0.1']);
		const sha = git(['rev-parse', 'HEAD']).trim();

		await vscode.env.clipboard.writeText('');
		// Not awaited: the command ends with a notification that only resolves
		// once the user dismisses it.
		void vscode.commands.executeCommand('geco.copyCommitSha', { gecoKind: 'commit', sha, repoPath: dir });

		const deadline = Date.now() + 15000;
		let value = '';
		while (Date.now() < deadline) {
			value = await vscode.env.clipboard.readText();
			if (value === sha) {
				break;
			}
			await sleep(100);
		}
		assert.equal(value, sha, 'the command resolved the menu argument and copied the sha');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function gitEnv(dir: string): NodeJS.ProcessEnv {
	const home = path.join(dir, 'home');
	return {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
		GIT_CONFIG_SYSTEM: os.devNull,
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_TERMINAL_PROMPT: '0',
		LC_ALL: 'C',
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
