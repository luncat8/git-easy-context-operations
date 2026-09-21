/**
 * End-to-end tests for "Clean History (Remove Dead Paths)..." - the scripted
 * fake UI drives the controller against real repositories, with a fake
 * `git filter-repo` standing in for the external rewrite tool (which is not
 * installed everywhere, and must not be required by the test suite).
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Controller } from '../../core/controller';
import { ACTIONS, type UI } from '../../core/ui';
import { DEFAULT_SETTINGS } from '../../core/config';
import { analyzeDeadPaths, parsePathList, type FilterRepoRunner } from '../../core/cleanHistory';
import { SUDO_PROBE, type InstallerRunner } from '../../core/installFilterRepo';
import { createTempRepo, TempRepo } from '../helpers/tempRepo';
import { FakeUI } from '../helpers/fakeUi';

interface FakeRun {
	runner: FilterRepoRunner;
	calls: string[][];
}

/**
 * A stand-in for `git filter-repo`: answers `--version`, fails when told to,
 * and otherwise really rewrites the branch so the `--paths-from-file` paths are
 * gone from *every* commit (via `git filter-branch`, which is available
 * everywhere) - enough for the verification rescan to see a cleaned history
 * without depending on the real tool being installed.
 */
function fakeFilterRepo(repo: TempRepo, options: { notInstalled?: boolean; failWith?: string; removeRemotes?: boolean } = {}): FakeRun {
	const calls: string[][] = [];
	const runner: FilterRepoRunner = async (command) => {
		calls.push([...command]);
		if (command.includes('--version')) {
			return options.notInstalled
				? { exitCode: 1, stdout: '', stderr: "git: 'filter-repo' is not a git command. See 'git --help'." }
				: { exitCode: 0, stdout: '2.38.0\n', stderr: '' };
		}
		if (options.failWith) {
			return { exitCode: 1, stdout: '', stderr: options.failWith };
		}
		const pathsFlag = command.indexOf('--paths-from-file');
		const pathsFile = pathsFlag >= 0 ? command[pathsFlag + 1]! : undefined;
		const dead = pathsFile && fs.existsSync(pathsFile) ? parsePathList(fs.readFileSync(pathsFile, 'utf8')).paths : [];
		const remove = command.includes('--refs') === false || dead.length > 0;
		if (dead.length > 0 && remove) {
			const indexFilter = `git rm -r -q --cached --ignore-unmatch -- ${dead.map((p) => `'${p}'`).join(' ')}`;
			await repo.gitOk(['filter-branch', '--force', '--index-filter', indexFilter, '--prune-empty', '--', '--all'], {
				env: { FILTER_BRANCH_SQUELCH_WARNING: '1' },
			});
			// filter-branch parks the original history on refs/original/ - the
			// real filter-repo leaves no such thing behind, and the rescan must
			// not see it either (it would keep every dead path alive).
			const originals = (await repo.git(['for-each-ref', '--format=%(refname)', 'refs/original/'])).stdout.split('\n').filter(Boolean);
			for (const ref of originals) {
				await repo.gitOk(['update-ref', '-d', ref]);
			}
		}
		if (options.removeRemotes) {
			for (const remote of (await repo.git(['remote'])).stdout.split('\n').filter(Boolean)) {
				await repo.gitOk(['remote', 'remove', remote]);
			}
		}
		return { exitCode: 0, stdout: 'Rewriting history...\n', stderr: '' };
	};
	return { runner, calls };
}

function controllerFor(ui: UI, repo: TempRepo, runner?: FilterRepoRunner, installer?: InstallerRunner): Controller {
	return new Controller({ ui, settings: DEFAULT_SETTINGS, exec: repo.exec, filterRepoRunner: runner, filterRepoInstaller: installer });
}

/**
 * A stand-in for the installer probes and the installation itself, so the
 * "ask and install" flow does not depend on the tools of the host machine.
 * `available` lists installer ids whose `--version` probe succeeds (first
 * argv token, with `python3`/`py` pip variants keyed as `python3-pip` /
 * `py-pip`); `succeeds` lists the ids whose install command exits 0.
 */
function fakeInstaller(options: { available?: string[]; succeeds?: string[]; sudoWorks?: boolean; failStderr?: string } = {}): { runner: InstallerRunner; calls: string[][] } {
	const calls: string[][] = [];
	const fail = (stderr: string) => ({ exitCode: 1, stdout: '', stderr });
	const runner: InstallerRunner = async (command) => {
		calls.push([...command]);
		if (command.join(' ') === SUDO_PROBE.join(' ')) {
			return options.sudoWorks === false ? fail('sudo: a password is required') : { exitCode: 0, stdout: '', stderr: '' };
		}
		// sudo-wrapped installs (`sudo -n apt-get install ...`) key by the wrapped tool.
		const first = command[1] === '-n' ? command[2]! : command[0]!;
		const key = first === 'python3' ? `python3-${command[2]}` : first === 'py' ? `py-${command[3]}` : first;
		if (command.at(-1) === '--version') {
			return options.available?.includes(key)
				? { exitCode: 0, stdout: `${key} 1.0\n`, stderr: '' }
				: fail(`${key}: command not found`);
		}
		return options.succeeds?.includes(key)
			? { exitCode: 0, stdout: 'Successfully installed git-filter-repo\n', stderr: '' }
			: fail(options.failStderr ?? `${key}: install failed`);
	};
	return { runner, calls };
}

function bundlesIn(root: string): string[] {
	return fs.readdirSync(root).filter((name) => name.endsWith('.bundle'));
}

/** main: v1 adds keep.txt + gone.bin, v2 drops gone.bin -> gone.bin is dead. */
async function repoWithDeadPath(): Promise<TempRepo> {
	const repo = await createTempRepo({ config: { 'gc.auto': '0' } });
	await repo.commit('v1', { 'keep.txt': 'keep\n', 'gone.bin': 'x'.repeat(4096) });
	await repo.gitOk(['rm', '--quiet', 'gone.bin']);
	await repo.commit('v2 drop the dead file');
	return repo;
}

describe('controller - cleanHistory flows', () => {
	it('cleans the whole graph: bundle backup, rewrite, rescan, journal entry', async () => {
		const repo = await repoWithDeadPath();
		try {
			const analysisBefore = await analyzeDeadPaths(repo.ctx, { sizeAnalysis: false });
			assert.deepEqual(analysisBefore.deadPaths, ['gone.bin']);

			const ui = new FakeUI();
			const fake = fakeFilterRepo(repo);
			await controllerFor(ui, repo, fake.runner).cleanHistory(repo.dir);

			// The modal confirmation is the gate - and it says what cannot be undone.
			assert.equal(ui.confirmCalls.length, 1);
			assert.match(ui.confirmCalls[0]!.message, /Remove 1 dead path from the entire history\?/);
			assert.equal(ui.confirmCalls[0]!.options!.confirmLabel, 'Clean History');
			assert.equal(ui.confirmCalls[0]!.options!.destructive, true);
			assert.match(ui.confirmCalls[0]!.options!.detail!, /gone\.bin/);
			assert.match(ui.confirmCalls[0]!.options!.detail!, /no Undo/i);

			// A bundle of every ref was written *next to* the repository (never
			// inside it - a bundle in the worktree would show up as untracked).
			const bundles = bundlesIn(repo.root);
			assert.equal(bundles.length, 1, `expected one backup bundle, found ${bundles.join(', ')}`);
			assert.match(bundles[0]!, /^repo-geco-clean-.*\.bundle$/);
			const bundlePath = path.join(repo.root, bundles[0]!);
			assert.ok(fs.statSync(bundlePath).size > 0);
			const verifyBundle = await repo.git(['bundle', 'verify', bundlePath]);
			assert.equal(verifyBundle.exitCode, 0, verifyBundle.stderr);
			// Full ref names: a bundle of "main" cannot be restored as refs/heads/main.
			const heads = await repo.git(['bundle', 'list-heads', bundlePath]);
			assert.match(heads.stdout, /refs\/heads\/main/);

			// filter-repo ran exactly once (plus the --version probe).
			assert.equal(fake.calls.length, 2);
			assert.deepEqual(fake.calls[0], ['git', 'filter-repo', '--version']);
			assert.deepEqual(fake.calls[1]!.slice(0, 4), ['git', 'filter-repo', '--invert-paths', '--paths-from-file']);
			assert.equal(fake.calls[1]![4], path.join(repo.dir, '.git', 'geco', 'dead-paths.txt'));
			assert.deepEqual(fs.readFileSync(fake.calls[1]![4]!, 'utf8').trim().split('\n'), ['gone.bin'], 'the list filter-repo gets is the scan result');
			assert.ok(fake.calls[1]!.includes('--force'), 'a working copy is not a fresh clone');

			// The verification rescan found nothing left.
			const analysisAfter = await analyzeDeadPaths(repo.ctx, { sizeAnalysis: false });
			assert.deepEqual(analysisAfter.deadPaths, []);
			assert.match(ui.allLogs(), /Verification: no dead paths remain/);

			// The journal knows where the way back is.
			const journal = await repo.ctx.safety.readJournal();
			const entry = journal.find((e) => e.kind === 'cleanHistory');
			assert.ok(entry, 'no journal entry');
			assert.match(entry!.summary, /Removed 1 dead path/);
			assert.equal(entry!.undo.type, 'none');
			assert.match(entry!.undo.type === 'none' ? entry!.undo.hint : '', new RegExp(bundles[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

			// The follow-up offers the log (no remote -> no force push).
			assert.match(ui.askCalls[0]!.message, /Cleaned the history: 1 dead path\(s\) removed/);
			assert.deepEqual(ui.askCalls[0]!.options.actions, [ACTIONS.openLog]);
		} finally {
			repo.cleanup();
		}
	});

	it('refuses a dirty working tree before writing a bundle', async () => {
		const repo = await repoWithDeadPath();
		try {
			repo.write('keep.txt', 'an uncommitted change\n');
			const ui = new FakeUI();
			const fake = fakeFilterRepo(repo);
			await controllerFor(ui, repo, fake.runner).cleanHistory(repo.dir);

			assert.match(ui.askCalls[0]!.message, /Cannot rewrite this history yet - 1 thing\(s\) have to go first/);
			assert.match(ui.askCalls[0]!.options.detail ?? '', /Uncommitted changes/);
			assert.equal(ui.confirmCalls.length, 0, 'no destructive dialog for a rewrite that cannot run');
			assert.deepEqual(bundlesIn(repo.root), [], 'no bundle was written');
			assert.deepEqual(fake.calls, [['git', 'filter-repo', '--version']]);
			assert.equal((await repo.ctx.safety.readJournal()).length, 0);
		} finally {
			repo.cleanup();
		}
	});

	it('refuses a linked worktree, which filter-repo would reject anyway', async () => {
		const repo = await repoWithDeadPath();
		try {
			const worktree = path.join(repo.root, 'linked');
			await repo.gitOk(['worktree', 'add', '--quiet', worktree, '-b', 'wt']);
			const ui = new FakeUI();
			await controllerFor(ui, repo, fakeFilterRepo(repo).runner).cleanHistory(repo.dir);

			assert.match(ui.askCalls[0]!.options.detail ?? '', /Linked worktrees: .*linked/);
			assert.deepEqual(ui.askCalls[0]!.options.actions, [ACTIONS.removeWorktrees, ACTIONS.openLog]);
			assert.deepEqual(bundlesIn(repo.root), []);
			await repo.gitOk(['worktree', 'remove', '--force', worktree]);
		} finally {
			repo.cleanup();
		}
	});

	it('removes linked worktrees on request and proceeds with clean history', async () => {
		const repo = await repoWithDeadPath();
		try {
			const worktree = path.join(repo.root, 'linked');
			await repo.gitOk(['worktree', 'add', '--quiet', worktree, '-b', 'wt']);
			const fake = fakeFilterRepo(repo);
			const ui = new FakeUI({
				asks: [ACTIONS.removeWorktrees],
				confirms: [true],
			});
			await controllerFor(ui, repo, fake.runner).cleanHistory(repo.dir);

			assert.equal((await repo.worktrees()).length, 1);
			assert.equal(fs.existsSync(worktree), false);
			assert.equal(fake.calls.length, 3);
			assert.deepEqual(fake.calls[0], ['git', 'filter-repo', '--version']);
			assert.deepEqual(fake.calls[1], ['git', 'filter-repo', '--version']);
			assert.ok(fake.calls[2]!.includes('--paths-from-file'));
		} finally {
			repo.cleanup();
		}
	});

	it('rewrites nothing when the user declines the confirmation', async () => {
		const repo = await repoWithDeadPath();
		try {
			const ui = new FakeUI({ confirms: [false] });
			const fake = fakeFilterRepo(repo);
			await controllerFor(ui, repo, fake.runner).cleanHistory(repo.dir);

			assert.deepEqual(fake.calls, [['git', 'filter-repo', '--version']], 'only the probe ran');
			assert.deepEqual(bundlesIn(repo.root), [], 'no bundle before the user agreed');
			assert.equal((await repo.ctx.safety.readJournal()).length, 0);
			assert.match(ui.allLogs(), /cancelled by the user/);
			const analysis = await analyzeDeadPaths(repo.ctx, { sizeAnalysis: false });
			assert.deepEqual(analysis.deadPaths, ['gone.bin'], 'the history is untouched');
		} finally {
			repo.cleanup();
		}
	});

	it('says so when the history is already clean', async () => {
		const repo = await createTempRepo();
		try {
			await repo.commit('v1', { 'a.txt': 'a\n' });
			const ui = new FakeUI();
			const fake = fakeFilterRepo(repo);
			await controllerFor(ui, repo, fake.runner).cleanHistory(repo.dir);

			assert.equal(ui.confirmCalls.length, 0, 'nothing to confirm');
			assert.deepEqual(fake.calls, [], 'the tool is not even probed');
			assert.deepEqual(bundlesIn(repo.root), []);
			assert.match(ui.messages[0]!.message, /No dead paths/);
			assert.equal(ui.messages[0]!.kind, 'info');
		} finally {
			repo.cleanup();
		}
	});

	it('refuses an empty repository', async () => {
		const repo = await createTempRepo();
		try {
			const ui = new FakeUI();
			await controllerFor(ui, repo, fakeFilterRepo(repo).runner).cleanHistory(repo.dir);
			assert.match(ui.messages[0]!.message, /no commits yet/);
			assert.equal(ui.messages[0]!.kind, 'error');
		} finally {
			repo.cleanup();
		}
	});

	it('hands over the exact script when git-filter-repo is not installed and nothing can install it', async () => {
		const repo = await repoWithDeadPath();
		try {
			const ui = new FakeUI({ asks: [ACTIONS.copyCommands] });
			const fake = fakeFilterRepo(repo, { notInstalled: true });
			// No installer tool answers its probe - informing is all that is left.
			const installer = fakeInstaller({ available: [], sudoWorks: false });
			await controllerFor(ui, repo, fake.runner, installer.runner).cleanHistory(repo.dir);

			assert.equal(ui.confirmCalls.length, 0, 'no destructive confirmation without the tool');
			assert.match(ui.askCalls[0]!.message, /1 dead path\(s\) found, but git-filter-repo is not installed/);
			assert.deepEqual(ui.askCalls[0]!.options.actions, [ACTIONS.copyCommands, ACTIONS.openLog]);
			assert.equal(ui.copied.length, 1);

			const script = ui.copied[0]!;
			assert.match(script, /git bundle create .*repo-geco-clean-.*\.bundle (?:--all|refs\/|main)/, 'the backup comes first');
			assert.match(script, /git filter-repo --invert-paths --paths-from-file/);
			assert.match(script, /reflog expire --expire=now --all/);
			assert.match(script, /gc --prune=now/);
			assert.match(script, /No remote is configured/);

			// The dead-path list already exists, so the copied script is runnable.
			const pathsFile = path.join(repo.dir, '.git', 'geco', 'dead-paths.txt');
			assert.deepEqual(fs.readFileSync(pathsFile, 'utf8').trim().split('\n'), ['gone.bin']);
			assert.equal((await repo.ctx.safety.readJournal()).length, 0);
			assert.deepEqual(bundlesIn(repo.root), [], 'nothing was backed up or rewritten');
		} finally {
			repo.cleanup();
		}
	});

	it('asks to install git-filter-repo, installs it, and continues the cleanup', async () => {
		const repo = await repoWithDeadPath();
		try {
			// The fake rewrite tool only becomes available once the "install" ran.
			const fakeOptions: { notInstalled?: boolean } = { notInstalled: true };
			const fake = fakeFilterRepo(repo, fakeOptions);
			const plain = fakeInstaller({ available: ['pip3'], succeeds: ['pip3'] });
			const installer: InstallerRunner = async (command, cwd) => {
				const result = await plain.runner(command, cwd);
				if (result.exitCode === 0 && command.includes('install')) {
					fakeOptions.notInstalled = false;
				}
				return result;
			};

			const ui = new FakeUI({ asks: ['Install with pip3'] }); // then the final follow-up ask: dismissed
			await controllerFor(ui, repo, fake.runner, installer).cleanHistory(repo.dir);

			assert.match(ui.askCalls[0]!.message, /1 dead path\(s\) found, but git-filter-repo is not installed - install it now\?/);
			assert.deepEqual(ui.askCalls[0]!.options.actions, ['Install with pip3', ACTIONS.copyCommands, ACTIONS.openLog]);
			assert.match(ui.askCalls[0]!.options.detail ?? '', /pip3 install git-filter-repo/, 'the dialog says what will run');
			assert.ok(ui.progressTitles.includes('Installing git-filter-repo (pip3)'), 'the install runs behind a progress');
			assert.ok(ui.messages.some((m) => /installed - continuing with the cleanup/.test(m.message)), 'the flow announces the continuation');

			// The cleanup itself ran to completion after the install.
			assert.equal(ui.confirmCalls.length, 1, 'the destructive confirmation still gates the rewrite');
			assert.match(ui.confirmCalls[0]!.message, /Remove 1 dead path from the entire history\?/);
			assert.equal((await repo.ctx.safety.readJournal()).length, 1, 'the rewrite was journalled');
			assert.ok(bundlesIn(repo.root).length > 0, 'the backup bundle was written');
			const after = await analyzeDeadPaths(repo.ctx, { sizeAnalysis: false });
			assert.deepEqual(after.deadPaths, [], 'the dead path is gone from the history');
			assert.ok(ui.logs.some((log) => /installed with pip3/.test(log)));
		} finally {
			repo.cleanup();
		}
	});

	it('does nothing when the user declines the install offer', async () => {
		const repo = await repoWithDeadPath();
		try {
			const fake = fakeFilterRepo(repo, { notInstalled: true });
			const installer = fakeInstaller({ available: ['pip3'], succeeds: ['pip3'] });

			const ui = new FakeUI({}); // no ask answer: the dialog is dismissed
			await controllerFor(ui, repo, fake.runner, installer.runner).cleanHistory(repo.dir);

			assert.equal(ui.askCalls[0]!.options.actions[0], 'Install with pip3');
			assert.equal(ui.confirmCalls.length, 0, 'no rewrite was attempted');
			assert.equal(ui.copied.length, 0);
			assert.equal((await repo.ctx.safety.readJournal()).length, 0);
			assert.match(ui.allLogs(), /dialog dismissed/);
		} finally {
			repo.cleanup();
		}
	});

	it('falls through to the next installer when pip is PEP 668 locked down', async () => {
		const repo = await repoWithDeadPath();
		try {
			const fakeOptions: { notInstalled?: boolean } = { notInstalled: true };
			const fake = fakeFilterRepo(repo, fakeOptions);
			const plain = fakeInstaller({
				available: ['pip3', 'python3-pip'],
				succeeds: ['python3-pip'],
				failStderr: 'error: externally-managed-environment\n\n× This environment is externally managed',
			});
			const installer: InstallerRunner = async (command, cwd) => {
				const result = await plain.runner(command, cwd);
				if (result.exitCode === 0 && command.includes('install')) {
					fakeOptions.notInstalled = false;
				}
				return result;
			};

			const ui = new FakeUI({ asks: ['Install with pip3', 'Install with python3 -m pip'] });
			await controllerFor(ui, repo, fake.runner, installer).cleanHistory(repo.dir);

			assert.equal(ui.askCalls[0]!.options.actions[0], 'Install with pip3');
			assert.equal(ui.askCalls[1]!.options.actions[0], 'Install with python3 -m pip', 'the next candidate is offered after the refusal');
			assert.match(ui.allLogs(), /externally managed \(PEP 668\)/, 'the PEP 668 refusal gets its own explanation');
			assert.equal((await repo.ctx.safety.readJournal()).length, 1, 'the cleanup still completed');
		} finally {
			repo.cleanup();
		}
	});

	it('never offers a sudo installer when sudo would ask for a password', async () => {
		const repo = await repoWithDeadPath();
		try {
			const fake = fakeFilterRepo(repo, { notInstalled: true });
			// Only the sudo-wrapped distro installer exists, but sudo needs a password.
			const installer = fakeInstaller({ available: ['apt-get'], succeeds: [], sudoWorks: false });

			const ui = new FakeUI({ asks: [ACTIONS.copyCommands] });
			await controllerFor(ui, repo, fake.runner, installer.runner).cleanHistory(repo.dir);

			assert.match(ui.allLogs(), /sudo needs a password/, 'the skip is explained in the log');
			assert.equal(ui.askCalls.length, 1);
			assert.deepEqual(ui.askCalls[0]!.options.actions, [ACTIONS.copyCommands, ACTIONS.openLog], 'fell through to informing');
			assert.equal(ui.confirmCalls.length, 0);
		} finally {
			repo.cleanup();
		}
	});

	it('keeps the recovery points out of the rewrite, then offers to drop them', async () => {
		const repo = await repoWithDeadPath();
		try {
			const v1 = await repo.sha('HEAD~1');
			await repo.gitOk(['update-ref', 'refs/geco/reword/main/20260919T120000Z-abcdef1234', v1]);

			const ui = new FakeUI(); // confirms default to true: rewrite, then drop
			const fake = fakeFilterRepo(repo);
			await controllerFor(ui, repo, fake.runner).cleanHistory(repo.dir);

			assert.equal(ui.confirmCalls.length, 2);
			assert.match(ui.confirmCalls[0]!.options!.detail!, /recovery point/i);
			assert.match(ui.confirmCalls[0]!.options!.detail!, /refs\/geco\//);
			assert.match(ui.confirmCalls[1]!.message, /Drop the 1 Git Easy Ops recovery point\(s\) and reclaim the space\?/);
			assert.equal(ui.confirmCalls[1]!.options!.confirmLabel, 'Drop & GC');

			// The rewrite was limited to the public refs...
			assert.ok(fake.calls[1]!.includes('--refs'), 'the recovery refs are excluded');
			assert.equal(fake.calls[1]![fake.calls[1]!.indexOf('--refs') + 1], 'refs/heads/main', 'named, not a rev-list flag');
			assert.ok(
				!fake.calls[1]!.some((arg) => arg.startsWith('-') && arg !== '--invert-paths' && arg !== '--paths-from-file'
					&& arg !== '--replace-refs' && arg !== '--refs' && arg !== '--force'),
				'git-filter-repo only gets flags it knows',
			);
			// ...and the bundle covered them, so they are recoverable.
			const bundle = path.join(repo.root, bundlesIn(repo.root)[0]!);
			const list = await repo.git(['bundle', 'list-heads', bundle]);
			assert.match(list.stdout, /refs\/geco\/reword\/main/, 'the recovery ref is in the bundle');

			// Dropping them removed the refs and repacked.
			assert.equal(await repo.hasRef('refs/geco/reword/main/20260919T120000Z-abcdef1234'), false);
			assert.match(ui.allLogs(), /Dropped 1 recovery point\(s\)/);
		} finally {
			repo.cleanup();
		}
	});

	it('keeps the recovery points when the user declines, and says what that costs', async () => {
		const repo = await repoWithDeadPath();
		try {
			const v1 = await repo.sha('HEAD~1');
			await repo.gitOk(['update-ref', 'refs/geco/squash/main/20260919T130000Z-abcdef1234', v1]);

			const ui = new FakeUI({ confirms: [true, false] });
			await controllerFor(ui, repo, fakeFilterRepo(repo).runner).cleanHistory(repo.dir);

			assert.equal(await repo.hasRef('refs/geco/squash/main/20260919T130000Z-abcdef1234'), true);
			assert.match(ui.allLogs(), /recovery points kept/);
			assert.match(ui.askCalls[0]!.options.detail ?? '', /recovery points kept/);
		} finally {
			repo.cleanup();
		}
	});

	it('puts the remote back that filter-repo removed, and offers the force push', async () => {
		const repo = await repoWithDeadPath();
		try {
			await repo.addBareRemote('origin', ['main']);
			const ui = new FakeUI();
			const fake = fakeFilterRepo(repo, { removeRemotes: true });
			await controllerFor(ui, repo, fake.runner).cleanHistory(repo.dir);

			assert.match(ui.allLogs(), /Re-added remote\(s\): origin/);
			assert.deepEqual((await repo.git(['remote', 'get-url', 'origin'])).stdout.trim(), path.join(repo.root, 'origin.git'));
			assert.match(ui.askCalls[0]!.options.detail ?? '', /OLD history/);
			assert.deepEqual(ui.askCalls[0]!.options.actions, [ACTIONS.forcePush, ACTIONS.openLog]);
			// The lease push is what the copied script recommends as well.
			assert.match(fake.calls[1]!.join(' '), /--paths-from-file/);
		} finally {
			repo.cleanup();
		}
	});

	it('reports a failing rewrite and points at the bundle', async () => {
		const repo = await repoWithDeadPath();
		try {
			const ui = new FakeUI();
			const fake = fakeFilterRepo(repo, { failWith: 'Aborting: Refs need to be fully packed' });
			await controllerFor(ui, repo, fake.runner).cleanHistory(repo.dir);

			assert.equal(ui.messages[0]!.kind, 'error');
			assert.match(ui.messages[0]!.message, /Clean history: git filter-repo failed/);
			assert.match(ui.messages[0]!.detail ?? '', /Refs need to be fully packed/);
			assert.match(ui.messages[0]!.detail ?? '', /Backup bundle: .*\.bundle/, 'the way back is named in the error');
			assert.equal((await repo.ctx.safety.readJournal()).length, 0, 'a failed rewrite is not journaled as done');
			const analysis = await analyzeDeadPaths(repo.ctx, { sizeAnalysis: false });
			assert.deepEqual(analysis.deadPaths, ['gone.bin']);
		} finally {
			repo.cleanup();
		}
	});

	it('stops when the backup bundle cannot be written, unless the user insists', async () => {
		const repo = await repoWithDeadPath();
		// Make the folder the bundle would be written to read-only: `git bundle`
		// cannot create its file, and the flow has to notice before rewriting.
		fs.chmodSync(repo.root, 0o500);
		try {
			const ui = new FakeUI({ confirms: [true, false] });
			const fake = fakeFilterRepo(repo);
			await controllerFor(ui, repo, fake.runner).cleanHistory(repo.dir);

			assert.match(ui.allLogs(), /Backup bundle failed/);
			assert.match(ui.confirmCalls[1]!.message, /backup bundle could not be created\. Rewrite the history anyway\?/);
			assert.equal(ui.confirmCalls[1]!.options!.confirmLabel, 'Rewrite Anyway');
			assert.deepEqual(fake.calls, [['git', 'filter-repo', '--version']], 'the rewrite did not run');
			assert.equal((await repo.ctx.safety.readJournal()).length, 0);
		} finally {
			fs.chmodSync(repo.root, 0o700);
			repo.cleanup();
		}
	});

	it('still rewrites when the user accepts the missing backup, and the journal says so', async () => {
		const repo = await repoWithDeadPath();
		fs.chmodSync(repo.root, 0o500);
		try {
			const ui = new FakeUI(); // every confirmation accepted
			const fake = fakeFilterRepo(repo);
			await controllerFor(ui, repo, fake.runner).cleanHistory(repo.dir);

			assert.equal(fake.calls.length, 2, 'the rewrite ran after the explicit ok');
			const entry = (await repo.ctx.safety.readJournal()).find((e) => e.kind === 'cleanHistory');
			assert.ok(entry);
			assert.match(entry!.undo.type === 'none' ? entry!.undo.hint : '', /the bundle FAILED/, 'the journal must not promise a backup that does not exist');
		} finally {
			fs.chmodSync(repo.root, 0o700);
			repo.cleanup();
		}
	});
});

describe('controller - cleanHistory scan coverage', () => {
	let repo: TempRepo;

	before(async () => {
		repo = await createTempRepo();
		await repo.commit('v1', { 'a.txt': 'a\n', 'big.log': 'y'.repeat(1024) });
		await repo.gitOk(['rm', '--quiet', 'big.log']);
		await repo.commit('v2');
	});
	after(() => repo.cleanup());

	it('measures what the dead paths still occupy and logs it', async () => {
		const ui = new FakeUI();
		await controllerFor(ui, repo, fakeFilterRepo(repo).runner).cleanHistory(repo.dir);
		assert.match(ui.allLogs(), /Dead paths: 1 \(of 2 paths/);
		assert.match(ui.allLogs(), /KiB of objects they still occupy/);
		assert.match(ui.allLogs(), /big\.log/);
	});
});
