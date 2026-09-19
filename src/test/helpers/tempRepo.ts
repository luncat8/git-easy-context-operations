/**
 * Test harness: a throw-away git repository with a hermetic environment.
 *
 * HOME, system config, user identity and the default branch are all pinned, so
 * tests behave the same on any machine and never pick up the developer's own
 * git config, hooks, credentials or signing keys.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRepoContext, type RepoContext } from '../../core/context';
import { createGitExec, type GitExec, type GitExecResult } from '../../core/gitRunner';
import { DEFAULT_SETTINGS, type Settings } from '../../core/config';
import { Git } from '../../core/git';

export interface TempRepoOptions {
	settings?: Partial<Settings>;
	defaultBranch?: string;
	/** Extra repository-local git config. */
	config?: Record<string, string>;
}

export interface LogLine {
	sha: string;
	shortSha: string;
	subject: string;
	body: string;
	parents: string[];
	tree: string;
	authorDate: string;
	committerDate: string;
	authorName: string;
	committerName: string;
}

export class TempRepo {
	private constructor(
		readonly dir: string,
		readonly root: string,
		readonly home: string,
		readonly exec: GitExec,
		readonly ctx: RepoContext,
	) {}

	get api(): Git {
		return this.ctx.git;
	}

	static async create(options: TempRepoOptions = {}): Promise<TempRepo> {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'geco-repo-'));
		const home = path.join(root, 'home');
		fs.mkdirSync(home, { recursive: true });
		fs.writeFileSync(
			path.join(home, '.gitconfig'),
			[
				'[user]',
				'\tname = Test User',
				'\temail = test@example.com',
				'[init]',
				`\tdefaultBranch = ${options.defaultBranch ?? 'main'}`,
				'[commit]',
				'\tgpgsign = false',
				'[core]',
				'\tautocrlf = false',
				'\tquotepath = false',
				'[gc]',
				'\tauto = 0',
				'',
			].join('\n'),
			'utf8',
		);

		const exec = createGitExec({
			baseEnv: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				XDG_CONFIG_HOME: path.join(home, '.config'),
				GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
				GIT_CONFIG_SYSTEM: os.devNull,
				GIT_CONFIG_NOSYSTEM: '1',
			},
		});

		const dir = path.join(root, 'repo');
		fs.mkdirSync(dir, { recursive: true });

		const repo = new TempRepo(dir, root, home, exec, createRepoContext(dir, { ...DEFAULT_SETTINGS, ...options.settings }, exec));
		await repo.gitOk(['init', '--quiet', `--initial-branch=${options.defaultBranch ?? 'main'}`]);
		for (const [key, value] of Object.entries(options.config ?? {})) {
			await repo.gitOk(['config', key, value]);
		}
		return repo;
	}

	// ------------------------------------------------------------- git access

	async git(args: readonly string[], options?: { env?: Record<string, string>; input?: string; cwd?: string }): Promise<GitExecResult> {
		return this.exec(args, { cwd: options?.cwd ?? this.dir, env: options?.env, input: options?.input });
	}

	async gitOk(args: readonly string[], options?: { env?: Record<string, string>; input?: string; cwd?: string }): Promise<string> {
		const result = await this.git(args, options);
		if (result.exitCode !== 0) {
			throw new Error(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
		}
		return result.stdout.trimEnd();
	}

	async gitQuiet(args: readonly string[], options?: { cwd?: string }): Promise<GitExecResult> {
		return this.git(args, options);
	}

	// ------------------------------------------------------------------ files

	write(file: string, content: string): void {
		const target = path.join(this.dir, file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content, 'utf8');
	}

	read(file: string): string {
		return fs.readFileSync(path.join(this.dir, file), 'utf8');
	}

	exists(file: string): boolean {
		return fs.existsSync(path.join(this.dir, file));
	}

	// ---------------------------------------------------------------- commits

	async commit(message: string, files: Record<string, string> = {}): Promise<string> {
		for (const [name, content] of Object.entries(files)) {
			this.write(name, content);
		}
		await this.gitOk(['add', '-A']);
		await this.gitOk(['commit', '--quiet', '-m', message]);
		return this.gitOk(['rev-parse', 'HEAD']);
	}

	/** Commit with an explicit author/committer date (for date-sensitive tests). */
	async commitAt(message: string, files: Record<string, string>, date: string): Promise<string> {
		for (const [name, content] of Object.entries(files)) {
			this.write(name, content);
		}
		await this.gitOk(['add', '-A']);
		await this.gitOk(['commit', '--quiet', '-m', message], { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
		return this.gitOk(['rev-parse', 'HEAD']);
	}

	async commitEmpty(message: string): Promise<string> {
		await this.gitOk(['commit', '--quiet', '--allow-empty', '-m', message]);
		return this.gitOk(['rev-parse', 'HEAD']);
	}

	async mergeNoFastForward(branch: string, message?: string): Promise<string> {
		await this.gitOk(['merge', '--no-ff', '--no-edit', ...(message ? ['-m', message] : []), branch]);
		return this.gitOk(['rev-parse', 'HEAD']);
	}

	// ------------------------------------------------------------------ queries

	async sha(rev: string): Promise<string> {
		return this.gitOk(['rev-parse', '--verify', `${rev}^{commit}`]);
	}

	async branchSha(branch: string): Promise<string | undefined> {
		const result = await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
		return result.exitCode === 0 ? result.stdout.trim() : undefined;
	}

	async message(rev: string): Promise<string> {
		return this.gitOk(['log', '-1', '--format=%B', rev]);
	}

	async subject(rev: string): Promise<string> {
		return this.gitOk(['log', '-1', '--format=%s', rev]);
	}

	async tree(rev: string): Promise<string> {
		return this.gitOk(['rev-parse', `${rev}^{tree}`]);
	}

	async log(ref = 'HEAD', limit = 100): Promise<LogLine[]> {
		const raw = await this.gitOk(['log', '--format=%H%x1f%h%x1f%s%x1f%b%x1f%P%x1f%T%x1f%aI%x1f%cI%x1f%an%x1f%cn%x1e', `--max-count=${limit}`, ref]);
		return raw.split('\x1e').map((r) => r.replace(/^\n+/, '')).filter(Boolean).map((record) => {
			const [sha, shortSha, subject, body, parents, tree, authorDate, committerDate, authorName, committerName] = record.split('\x1f');
			return { sha, shortSha, subject, body, parents: parents ? parents.split(' ').filter(Boolean) : [], tree, authorDate, committerDate, authorName, committerName };
		});
	}

	async branches(): Promise<string[]> {
		const out = await this.gitOk(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
		return out.split('\n').filter(Boolean);
	}

	async hasBranch(name: string): Promise<boolean> {
		return (await this.git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`])).exitCode === 0;
	}

	async hasRef(name: string): Promise<boolean> {
		return (await this.git(['show-ref', '--verify', '--quiet', name])).exitCode === 0;
	}

	async checkout(ref: string, options?: { create?: boolean }): Promise<void> {
		await this.gitOk(['checkout', '--quiet', ...(options?.create ? ['-b'] : []), ref]);
	}

	async statusLines(): Promise<string[]> {
		const out = await this.gitOk(['status', '--porcelain=v1']);
		return out ? out.split('\n').filter(Boolean) : [];
	}

	async worktrees(): Promise<string[]> {
		const out = await this.gitOk(['worktree', 'list', '--porcelain']);
		return out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
	}

	// ----------------------------------------------------------------- remotes

	/** Create a bare repository, wire it up as a remote and push branches to it. */
	async addBareRemote(name = 'origin', branches: string[] = ['main']): Promise<string> {
		const remoteDir = path.join(this.root, `${name}.git`);
		fs.mkdirSync(remoteDir, { recursive: true });
		await this.gitOk(['init', '--quiet', '--bare', remoteDir]);
		await this.gitOk(['remote', 'add', name, remoteDir]);
		for (const branch of branches) {
			if (await this.hasBranch(branch)) {
				await this.gitOk(['push', '--quiet', '-u', name, `${branch}:${branch}`]);
			}
		}
		const setHead = await this.git(['remote', 'set-head', name, '--auto']);
		if (setHead.exitCode !== 0) {
			// Not fatal: default branch detection just falls back to main/master.
		}
		return remoteDir;
	}

	/** What the remote itself has for a branch (authoritative, not our cache). */
	async remoteBranchSha(remoteDir: string, branch: string): Promise<string | undefined> {
		const result = await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: remoteDir });
		return result.exitCode === 0 ? result.stdout.trim() : undefined;
	}

	/** Clone the remote elsewhere and push from there, simulating a colleague. */
	async pushFromElsewhere(remoteDir: string, message: string, branch = 'main'): Promise<string> {
		const otherDir = path.join(this.root, `other-${Math.random().toString(36).slice(2, 8)}`);
		await this.gitOk(['clone', '--quiet', remoteDir, otherDir]);
		await this.gitOk(['config', 'user.name', 'Other Person'], { cwd: otherDir });
		await this.gitOk(['config', 'user.email', 'other@example.com'], { cwd: otherDir });
		fs.writeFileSync(path.join(otherDir, `from-other-${Math.random().toString(36).slice(2, 8)}.txt`), 'someone else was here\n', 'utf8');
		await this.gitOk(['add', '-A'], { cwd: otherDir });
		await this.gitOk(['commit', '--quiet', '-m', message], { cwd: otherDir });
		await this.gitOk(['push', '--quiet', 'origin', `HEAD:${branch}`], { cwd: otherDir });
		return otherDir;
	}

	async fetch(remote = 'origin'): Promise<void> {
		await this.gitOk(['fetch', '--quiet', remote]);
	}

	cleanup(): void {
		fs.rmSync(this.root, { recursive: true, force: true });
	}
}

export async function createTempRepo(options?: TempRepoOptions): Promise<TempRepo> {
	return TempRepo.create(options);
}

/**
 * A small linear history used by many tests:
 *
 *   v0.1 -> v0.2 -> v0.3 -> v0.4   (main, HEAD)
 */
export async function createLinearRepo(options?: TempRepoOptions): Promise<{ repo: TempRepo; shas: Record<string, string> }> {
	const repo = await createTempRepo(options);
	const shas: Record<string, string> = {};
	shas.v01 = await repo.commit('v0.1', { 'a.txt': 'a\n' });
	shas.v02 = await repo.commit('v0.2', { 'b.txt': 'b\n' });
	shas.v03 = await repo.commit('v0.3', { 'c.txt': 'c\n' });
	shas.v04 = await repo.commit('v0.4', { 'd.txt': 'd\n' });
	return { repo, shas };
}
