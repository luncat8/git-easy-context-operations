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
	'geco.removeRedundantBranches',
	'geco.checkoutBranch',
	'geco.undoLastOperation',
	'geco.showBackups',
	'geco.cleanHistory',
	'geco.copyCommitSha',
	'geco.copyRepositoryWebLink',
	'geco.refresh',
	'geco.explainMenus',
	'geco.enableGraphMenu',
	'geco.customizeMenus',
	'geco.menuResetAll',
	'geco.menuCopyItemName',
];

export async function run(): Promise<void> {
	const results: [string, () => Promise<void>][] = [
		['the manifest is loaded with its contributions', testManifest],
		['the extension activates', testActivation],
		['every contributed command is registered', testCommands],
		['refresh works without a repository', testRefresh],
		['menu item names can be copied', testCopyMenuItemName],
		['a command reaches git and copies a sha', testCopySha],
		['a command does not wait for its own notification', testCommandDoesNotWaitForItsNotification],
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
	assert.equal(contributes.views.scm[1].id, 'geco.menuEditor');
	assert.equal(contributes.views.scm[1].visibility, 'hidden');
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

/**
 * The command ends with an info notification, and VS Code resolves the promise
 * of a *non-modal* notification only when the notification goes away - 10 s for
 * an info toast, and never while the mouse hovers it or the window is
 * unfocused. Everything that awaits it stays pending for that long, and an
 * action started from the built-in **Source Control Graph** runs under a
 * progress indicator that lasts exactly as long as the command's promise (VS
 * Code wraps every action of that view in `withProgress`). Awaiting the
 * notification is therefore what left the graph spinning after "Copy
 * Repository Web Link" had already copied the link.
 *
 * The progress indicator itself cannot be inspected from here; the promise it
 * is tied to can. The deadline is below the 10 s the toast would live, so a
 * command that waits for its own notification fails this check instead of
 * passing it slowly.
 */
async function testCommandDoesNotWaitForItsNotification(): Promise<void> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geco-vscode-'));
	try {
		const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv(dir) });
		fs.mkdirSync(path.join(dir, 'home'));
		git(['init', '--quiet', '--initial-branch=main']);
		git(['config', 'user.name', 'VS Code Test']);
		git(['config', 'user.email', 'test@example.com']);
		git(['remote', 'add', 'origin', 'git@github.com:luncat8/git-easy-context-operations.git']);
		fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n', 'utf8');
		git(['add', '-A']);
		git(['commit', '--quiet', '-m', 'v0.1']);

		await vscode.env.clipboard.writeText('');
		await withDeadline(
			vscode.commands.executeCommand('geco.copyRepositoryWebLink', { repoPath: dir }),
			8000,
			'geco.copyRepositoryWebLink',
		);
		assert.equal(
			await vscode.env.clipboard.readText(),
			'https://github.com/luncat8/git-easy-context-operations',
			'the web link of the origin remote is on the clipboard',
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Resolves to the value, or rejects after `ms` - never hangs the test run. */
function withDeadline<T>(promise: Thenable<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
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

async function testCopyMenuItemName(): Promise<void> {
 const previous = await vscode.env.clipboard.readText();
 try {
  await vscode.commands.executeCommand('geco.menuCopyItemName', {
   nodeKind: 'row', label: 'Rename Commit Message...',
  });
  assert.equal(await vscode.env.clipboard.readText(), 'Rename Commit Message...');
  await vscode.commands.executeCommand('geco.menuCopyItemName');
  assert.equal(await vscode.env.clipboard.readText(), 'Rename Commit Message...');
 } finally { await vscode.env.clipboard.writeText(previous); }
}
