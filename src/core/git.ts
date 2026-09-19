/**
 * A thin, promise-based facade over the git command line.
 *
 * Design rules:
 * - every call passes arguments as an array (no shell, no quoting bugs);
 * - multi-value output is parsed with `\x1f` / `\x1e` separators or `-z` (NUL),
 *   so subjects, bodies and paths containing newlines stay intact;
 * - query methods return `undefined` instead of throwing, mutating methods throw
 *   {@link GecoError}.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { GecoError } from './errors';
import type { GitExec, GitExecResult } from './gitRunner';

const US = '\x1f';
const RS = '\x1e';

export interface Identity {
	name: string;
	email: string;
	date: string;
}

export interface CommitInfo {
	sha: string;
	shortSha: string;
	parents: string[];
	tree: string;
	author: Identity;
	committer: Identity;
	subject: string;
	body: string;
	/** Full raw message (subject + body), as `%B` reports it. */
	message: string;
}

export interface RefInfo {
	name: string;
	sha: string;
	kind: 'branch' | 'remote' | 'tag' | 'other';
	isHead: boolean;
	upstream?: string;
}

export interface UpstreamInfo {
	remote: string;
	branch: string;
	ref: string;
	sha?: string;
}

export interface AheadBehind {
	/** Commits reachable from `left` but not from `right`. */
	left: number;
	/** Commits reachable from `right` but not from `left`. */
	right: number;
}

export interface TreeEntry {
	mode: string;
	type: string;
	sha: string;
	path: string;
}

export interface StatusEntry {
	x: string;
	y: string;
	path: string;
	originalPath?: string;
}

export interface CommitTreeOptions {
	tree: string;
	parents: string[];
	message: string;
	author: Identity;
	committer: Identity;
}

export const COMMIT_LOG_FORMAT = [
	'%H', '%h', '%P', '%T', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%s', '%b',
].join(US) + RS;

export class Git {
	constructor(public readonly exec: GitExec, public readonly cwd: string) {}

	// ---------------------------------------------------------------- plumbing

	async run(args: readonly string[], options?: { env?: Record<string, string | undefined>; input?: string; timeoutMs?: number }): Promise<GitExecResult> {
		const result = await this.exec(args, { cwd: this.cwd, env: options?.env, input: options?.input, timeoutMs: options?.timeoutMs });
		if (result.exitCode === 127) {
			// ENOENT is ambiguous: it can be the git binary or a folder that disappeared
			// (a workspace that was moved or deleted while VS Code was open).
			if (!fs.existsSync(this.cwd)) {
				throw new GecoError('not-a-repository', `"${this.cwd}" does not exist.`);
			}
			throw new GecoError('git-not-found', 'The git executable could not be started.', `${result.stderr.trim()}\nCheck the "geco.gitPath" / "git.path" setting.`);
		}
		return result;
	}

	/** Run and require success; returns trimmed stdout. */
	async ok(args: readonly string[], options?: { env?: Record<string, string | undefined>; input?: string; timeoutMs?: number }): Promise<string> {
		const result = await this.run(args, options);
		if (result.exitCode !== 0) {
			throw new GecoError('git-failed', `git ${args[0]} failed (exit ${result.exitCode}).`, describeFailure(args, result));
		}
		if (result.timedOut) {
			throw new GecoError('git-failed', `git ${args[0]} timed out.`, describeFailure(args, result));
		}
		// trimEnd only: `git status --porcelain -z` legitimately starts with a space.
		return result.stdout.trimEnd();
	}

	/**
	 * Run and return stdout *verbatim*. Patch text must not be trimmed: a diff
	 * whose last line loses its newline is rejected as "corrupt patch".
	 */
	async raw(args: readonly string[], options?: { env?: Record<string, string | undefined>; input?: string }): Promise<string> {
		const result = await this.run(args, options);
		if (result.exitCode !== 0) {
			throw new GecoError('git-failed', `git ${args[0]} failed (exit ${result.exitCode}).`, describeFailure(args, result));
		}
		return result.stdout;
	}

	/** Run and return stdout, or `undefined` when git exits non-zero. */
	async tryRun(args: readonly string[], options?: { env?: Record<string, string | undefined>; input?: string }): Promise<string | undefined> {
		const result = await this.run(args, options);
		return result.exitCode === 0 ? result.stdout.trimEnd() : undefined;
	}

	// ------------------------------------------------------------ repo queries

	async isRepository(): Promise<boolean> {
		const result = await this.run(['rev-parse', '--git-dir']);
		return result.exitCode === 0;
	}

	async requireRepository(): Promise<void> {
		if (!(await this.isRepository())) {
			throw new GecoError('not-a-repository', `"${this.cwd}" is not a Git repository.`);
		}
	}

	async repoRoot(): Promise<string> {
		return this.ok(['rev-parse', '--show-toplevel']);
	}

	/** `.git` directory shared by all worktrees (where the journal lives). */
	async commonDir(): Promise<string> {
		const absolute = await this.tryRun(['rev-parse', '--path-format=absolute', '--git-common-dir']);
		if (absolute) {
			return absolute;
		}
		const relative = await this.ok(['rev-parse', '--git-common-dir']);
		return path.resolve(this.cwd, relative);
	}

	// ------------------------------------------------------------------- revs

	async revParse(rev: string): Promise<string | undefined> {
		return this.tryRun(['rev-parse', '--verify', '--quiet', rev]);
	}

	async resolveCommit(rev: string): Promise<string> {
		const sha = await this.tryRun(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
		if (!sha) {
			throw new GecoError('commit-not-found', `Commit "${rev}" does not exist in this repository.`);
		}
		return sha;
	}

	async isAncestor(maybeAncestor: string, of: string): Promise<boolean> {
		const result = await this.run(['merge-base', '--is-ancestor', maybeAncestor, of]);
		return result.exitCode === 0;
	}

	async mergeBase(a: string, b: string): Promise<string | undefined> {
		return this.tryRun(['merge-base', a, b]);
	}

	async headSha(): Promise<string> {
		return this.resolveCommit('HEAD');
	}

	/** Short name of the checked out branch, or `undefined` for a detached HEAD. */
	async headBranch(): Promise<string | undefined> {
		return this.tryRun(['symbolic-ref', '--quiet', '--short', 'HEAD']);
	}

	async counts(left: string, right: string): Promise<AheadBehind> {
		const out = await this.tryRun(['rev-list', '--left-right', '--count', `${left}...${right}`]);
		if (!out) {
			return { left: 0, right: 0 };
		}
		const [l, r] = out.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
		return { left: Number.isFinite(l) ? l : 0, right: Number.isFinite(r) ? r : 0 };
	}

	async revList(args: readonly string[]): Promise<string[]> {
		const out = await this.tryRun(['rev-list', ...args]);
		return out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
	}

	async countCommits(range: string): Promise<number> {
		const out = await this.tryRun(['rev-list', '--count', range]);
		const count = out ? Number.parseInt(out.trim(), 10) : Number.NaN;
		return Number.isFinite(count) ? count : 0;
	}

	/**
	 * `sha -> parents` for every commit `git rev-list --parents <rev>` reports,
	 * in one call. Used to walk a history in memory (`--first-parent` walks the
	 * run of commits a squash is allowed to cover).
	 */
	async parentMap(rev: string, options: { firstParent?: boolean } = {}): Promise<Map<string, string[]>> {
		const args = ['rev-list', '--parents'];
		if (options.firstParent) {
			args.push('--first-parent');
		}
		args.push(rev);
		const out = await this.tryRun(args);
		const map = new Map<string, string[]>();
		for (const line of out ? out.split('\n') : []) {
			const parts = line.trim().split(' ').filter(Boolean);
			if (parts.length === 0) {
				continue;
			}
			map.set(parts[0]!, parts.slice(1));
		}
		return map;
	}

	/** Commits after `from` that lead to `to`, oldest first, merges included. */
	async ancestryPathOldestFirst(from: string, to: string): Promise<string[]> {
		return this.revList(['--reverse', '--ancestry-path', '--topo-order', `${from}..${to}`]);
	}

	// ---------------------------------------------------------------- commits

	async commitInfo(rev: string): Promise<CommitInfo> {
		const sha = await this.resolveCommit(rev);
		const out = await this.ok(['log', '-1', `--format=${COMMIT_LOG_FORMAT}`, '--no-show-signature', sha]);
		const parsed = parseCommits(out);
		if (parsed.length === 0) {
			throw new GecoError('commit-not-found', `Could not read commit "${rev}".`);
		}
		return parsed[0];
	}

	async commits(options: {
		ref?: string;
		limit?: number;
		/** Every ref, *including* this extension's recovery refs. */
		all?: boolean;
		/** Explicit `rev-list`-style rev args, e.g. `['--branches', '--remotes', '--tags']`. */
		refs?: readonly string[];
		firstParent?: boolean;
		topoOrder?: boolean;
	} = {}): Promise<CommitInfo[]> {
		const args = ['log', `--format=${COMMIT_LOG_FORMAT}`, '--no-show-signature'];
		if (options.limit && options.limit > 0) {
			args.push(`--max-count=${options.limit}`);
		}
		if (options.refs && options.refs.length > 0) {
			// `--branches --remotes --tags` is what a commit graph should show:
			// unlike `--all` it leaves the hidden recovery refs out, so an undone
			// or squashed-away commit does not reappear as a second history.
			args.push(...options.refs);
		} else if (options.all) {
			args.push('--all');
		}
		if (options.firstParent) {
			args.push('--first-parent');
		}
		// Lane rendering needs every parent after its children, which only
		// --topo-order guarantees (the default walks by commit date).
		if (options.topoOrder) {
			args.push('--topo-order');
		}
		if (options.ref) {
			args.push(options.ref);
		}
		const out = await this.tryRun(args);
		return out ? parseCommits(out) : [];
	}

	async signatureStatus(sha: string): Promise<string | undefined> {
		return this.tryRun(['log', '-1', '--format=%G?', sha]);
	}

	/**
	 * The raw commit message (`%B`). Used when replaying commits so that the
	 * message of untouched descendants survives byte-for-byte.
	 */
	async rawMessage(rev: string): Promise<string> {
		const sha = await this.resolveCommit(rev);
		return this.ok(['log', '-1', '--format=%B', '--no-show-signature', sha]);
	}

	// ------------------------------------------------------------------- refs

	async refExists(refName: string): Promise<boolean> {
		const result = await this.run(['show-ref', '--verify', '--quiet', refName]);
		return result.exitCode === 0;
	}

	async branchExists(name: string): Promise<boolean> {
		return this.refExists(`refs/heads/${name}`);
	}

	async listRefs(patterns: readonly string[] = ['refs/heads', 'refs/remotes', 'refs/tags']): Promise<RefInfo[]> {
		const format = ['%(refname)', '%(objectname)', '%(HEAD)', '%(upstream:short)', '%(refname:lstrip=2)']
			.join(US) + RS;
		const out = await this.tryRun(['for-each-ref', `--format=${format}`, ...patterns]);
		if (!out) {
			return [];
		}
		const refs: RefInfo[] = [];
		for (const record of out.split(RS).map((r) => r.replace(/^\n/, '')).filter(Boolean)) {
			const [refName, sha, head, upstream, short] = record.split(US);
			if (!refName || !sha) {
				continue;
			}
			refs.push({
				name: short || refName,
				sha,
				kind: refName.startsWith('refs/heads/') ? 'branch'
					: refName.startsWith('refs/remotes/') ? 'remote'
						: refName.startsWith('refs/tags/') ? 'tag' : 'other',
				isHead: head === '*',
				upstream: upstream || undefined,
			});
		}
		return refs;
	}

	async branches(): Promise<RefInfo[]> {
		return (await this.listRefs(['refs/heads'])).map((r) => ({ ...r, kind: 'branch' as const }));
	}

	async remoteBranches(): Promise<RefInfo[]> {
		return (await this.listRefs(['refs/remotes'])).filter((r) => !r.name.endsWith('/HEAD'));
	}

	async branchesContaining(sha: string): Promise<string[]> {
		const out = await this.tryRun(['branch', '--format=%(refname:short)', '--contains', sha]);
		if (!out) {
			return [];
		}
		return out
			.split('\n')
			.map((line) => line.trim())
			// A detached HEAD shows up as "(HEAD detached at <sha>)" / "(no branch)".
			.filter((name) => Boolean(name) && name !== 'HEAD' && !/^\((HEAD detached at|no branch|Head detached)/.test(name));
	}

	async tagsContaining(sha: string): Promise<string[]> {
		const out = await this.tryRun(['tag', '--contains', sha]);
		return out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
	}

	async refsUnder(prefix: string): Promise<RefInfo[]> {
		const out = await this.tryRun(['for-each-ref', `--format=%(refname)${US}%(objectname)${US}%(creatordate:iso8601)${RS}`, prefix]);
		if (!out) {
			return [];
		}
		return out.split(RS).map((r) => r.replace(/^\n/, '')).filter(Boolean).map((record) => {
			const [name, sha] = record.split(US);
			return { name, sha, kind: 'other' as const, isHead: false };
		});
	}

	async remotes(): Promise<string[]> {
		const out = await this.tryRun(['remote']);
		return out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
	}

	async upstream(branch: string): Promise<UpstreamInfo | undefined> {
		const full = await this.tryRun(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`]);
		if (!full) {
			const configuredRemote = await this.tryRun(['config', `branch.${branch}.remote`]);
			if (!configuredRemote) {
				return undefined;
			}
			const ref = `refs/remotes/${configuredRemote}/${branch}`;
			return { remote: configuredRemote, branch, ref, sha: await this.revParse(ref) };
		}
		const slash = full.indexOf('/');
		const remote = slash > 0 ? full.slice(0, slash) : full;
		const remoteBranch = slash > 0 ? full.slice(slash + 1) : branch;
		const ref = `refs/remotes/${full}`;
		return { remote, branch: remoteBranch, ref, sha: await this.revParse(ref) };
	}

	async detectDefaultBranch(): Promise<{ branch?: string; how: 'originHead' | 'main' | 'master' | 'current' | 'none' }> {
		const originHead = await this.tryRun(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
		if (originHead) {
			const local = originHead.includes('/') ? originHead.slice(originHead.indexOf('/') + 1) : originHead;
			if (await this.branchExists(local)) {
				return { branch: local, how: 'originHead' };
			}
		}
		if (await this.branchExists('main')) {
			return { branch: 'main', how: 'main' };
		}
		if (await this.branchExists('master')) {
			return { branch: 'master', how: 'master' };
		}
		const current = await this.headBranch();
		if (current) {
			return { branch: current, how: 'current' };
		}
		return { how: 'none' };
	}

	// -------------------------------------------------------------- ref writes

	async updateRef(ref: string, value: string, options?: { oldValue?: string; message?: string }): Promise<void> {
		const args = ['update-ref'];
		if (options?.message) {
			args.push('-m', options.message);
		}
		args.push(ref, value);
		if (options?.oldValue) {
			args.push(options.oldValue);
		}
		await this.ok(args);
	}

	async deleteRef(ref: string, options?: { oldValue?: string; message?: string }): Promise<void> {
		const args = ['update-ref'];
		if (options?.message) {
			args.push('-m', options.message);
		}
		args.push('-d', ref);
		if (options?.oldValue) {
			args.push(options.oldValue);
		}
		await this.ok(args);
	}

	async createBranch(name: string, start?: string, options?: { force?: boolean }): Promise<void> {
		const args = ['branch'];
		if (options?.force) {
			args.push('-f');
		}
		args.push(name);
		if (start) {
			args.push(start);
		}
		await this.ok(args);
	}

	async deleteBranch(name: string, options?: { force?: boolean }): Promise<void> {
		await this.ok(['branch', options?.force ? '-D' : '-d', name]);
	}

	async checkout(ref: string, options?: { create?: boolean; detach?: boolean }): Promise<void> {
		const args = ['checkout'];
		if (options?.detach) {
			args.push('--detach');
		} else if (options?.create) {
			args.push('-B');
		}
		args.push(ref);
		await this.ok(args);
	}

	async reset(mode: 'soft' | 'mixed' | 'hard' | 'keep', target: string): Promise<void> {
		await this.ok(['reset', `--${mode}`, target]);
	}

	async mergeFastForwardOnly(target: string): Promise<void> {
		await this.ok(['merge', '--ff-only', target]);
	}

	/** Create a commit object without touching HEAD, the index or the worktree. */
	async commitTree(options: CommitTreeOptions): Promise<string> {
		const args = ['commit-tree', options.tree];
		for (const parent of options.parents) {
			args.push('-p', parent);
		}
		const env = identityEnv(options.author, options.committer);
		return this.ok(args, { env, input: options.message });
	}

	// ------------------------------------------------------------------ trees

	async treeOf(rev: string): Promise<string> {
		return this.ok(['rev-parse', `${rev}^{tree}`]);
	}

	/** Blob information for a set of paths inside a commit's tree. */
	async lsTreePaths(rev: string, paths: readonly string[]): Promise<Map<string, TreeEntry>> {
		const result = new Map<string, TreeEntry>();
		if (paths.length === 0) {
			return result;
		}
		const out = await this.tryRun(['ls-tree', '-r', '-z', rev, '--', ...paths]);
		if (!out) {
			return result;
		}
		for (const record of out.split('\0').filter(Boolean)) {
			const headerEnd = record.indexOf('\t');
			if (headerEnd < 0) {
				continue;
			}
			const [mode, type, sha] = record.slice(0, headerEnd).split(' ');
			const entryPath = record.slice(headerEnd + 1);
			if (mode && type && sha) {
				result.set(entryPath, { mode, type, sha, path: entryPath });
			}
		}
		return result;
	}

	// ----------------------------------------------------------------- status

	async status(options?: { includeUntracked?: boolean }): Promise<StatusEntry[]> {
		const untracked = options?.includeUntracked ? 'all' : 'no';
		const out = await this.tryRun(['status', '--porcelain=v1', '-z', `--untracked-files=${untracked}`]);
		if (!out) {
			return [];
		}
		const entries: StatusEntry[] = [];
		const parts = out.split('\0');
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			if (!part || part.length < 4) {
				continue;
			}
			const x = part[0];
			const y = part[1];
			const entryPath = part.slice(3);
			if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
				const originalPath = parts[i + 1];
				if (originalPath !== undefined) {
					i++;
					entries.push({ x, y, path: entryPath, originalPath });
					continue;
				}
			}
			entries.push({ x, y, path: entryPath });
		}
		return entries;
	}

	async isDirty(options?: { includeUntracked?: boolean }): Promise<boolean> {
		return (await this.status(options)).length > 0;
	}

	// ------------------------------------------------------------------ patch

	/**
	 * Non-destructive "does this patch apply to that commit?" probe.
	 *
	 * A throw-away index file is populated with the candidate tree and the patch
	 * is checked against it, so the user's index and worktree are never touched.
	 */
	async checkPatchAtTree(rev: string, patch: string, indexFile: string, options?: { threeWay?: boolean }): Promise<{ applies: boolean; conflicts: boolean; output: string }> {
		await this.ok(['read-tree', rev], { env: { GIT_INDEX_FILE: indexFile } });
		// `--check` cannot be combined with `--3way`, so the 3-way probe really
		// applies into the throw-away index (which is deleted right afterwards).
		const args = ['apply', '--cached', '--whitespace=nowarn'];
		args.push(options?.threeWay ? '--3way' : '--check');
		args.push('-');
		const result = await this.run(args, { env: { GIT_INDEX_FILE: indexFile }, input: patch });
		const output = `${result.stdout}${result.stderr}`.trim();
		return { applies: result.exitCode === 0, conflicts: /with conflicts/i.test(output), output };
	}

	/** Apply a patch to the working tree (and index, with `--3way`). */
	async applyPatch(patch: string, options?: { threeWay?: boolean; check?: boolean; cached?: boolean; indexFile?: string }): Promise<GitExecResult> {
		const args = ['apply'];
		if (options?.threeWay) {
			args.push('--3way');
		}
		if (options?.check) {
			args.push('--check');
		}
		if (options?.cached) {
			args.push('--cached');
		}
		args.push('--whitespace=nowarn', '-');
		return this.run(args, { input: patch, env: options?.indexFile ? { GIT_INDEX_FILE: options.indexFile } : undefined });
	}

	/** `git am` a mailbox patch (keeps author + commit message). */
	async amPatch(patch: string, options?: { threeWay?: boolean; abort?: boolean; continue?: boolean; skip?: boolean }): Promise<GitExecResult> {
		if (options?.abort) {
			return this.run(['am', '--abort']);
		}
		if (options?.continue) {
			return this.run(['am', '--continue'], { env: { GIT_EDITOR: 'true' } });
		}
		if (options?.skip) {
			return this.run(['am', '--skip']);
		}
		const args = ['am'];
		if (options?.threeWay) {
			args.push('--3way');
		}
		args.push('-');
		return this.run(args, { input: patch, env: { GIT_EDITOR: 'true' } });
	}

	/** True while an interrupted `git am` is waiting for the user. */
	async amInProgress(): Promise<boolean> {
		const result = await this.run(['rev-parse', '--git-path', 'rebase-apply']);
		if (result.exitCode !== 0) {
			return false;
		}
		const reported = result.stdout.trim();
		if (!reported) {
			return false;
		}
		const resolved = path.isAbsolute(reported) ? reported : path.resolve(this.cwd, reported);
		return fs.existsSync(resolved);
	}

	async conflictedPaths(): Promise<string[]> {
		const out = await this.tryRun(['diff', '--name-only', '--diff-filter=U', '-z']);
		return out ? out.split('\0').filter(Boolean) : [];
	}

	// --------------------------------------------------------------- worktrees

	async worktreeList(): Promise<{ path: string; head?: string; branch?: string; detached: boolean }[]> {
		const out = await this.tryRun(['worktree', 'list', '--porcelain']);
		if (!out) {
			return [];
		}
		const result: { path: string; head?: string; branch?: string; detached: boolean }[] = [];
		let current: { path: string; head?: string; branch?: string; detached: boolean } | undefined;
		for (const line of out.split('\n')) {
			if (line.startsWith('worktree ')) {
				if (current) {
					result.push(current);
				}
				current = { path: line.slice('worktree '.length).trim(), detached: false };
			} else if (current && line.startsWith('HEAD ')) {
				current.head = line.slice(5).trim();
			} else if (current && line.startsWith('branch ')) {
				current.branch = line.slice(7).trim();
			} else if (current && line === 'detached') {
				current.detached = true;
			}
		}
		if (current) {
			result.push(current);
		}
		return result;
	}

	async worktreeAdd(target: string, options: { ref?: string; newBranch?: string; detach?: boolean }): Promise<void> {
		const args = ['worktree', 'add'];
		if (options.detach) {
			args.push('--detach');
		}
		if (options.newBranch) {
			args.push('-b', options.newBranch);
		}
		args.push(target);
		if (options.ref) {
			args.push(options.ref);
		}
		await this.ok(args);
	}

	async worktreeRemove(target: string, options?: { force?: boolean }): Promise<void> {
		await this.ok(['worktree', 'remove', ...(options?.force ? ['--force'] : []), target]);
	}

	async worktreePrune(): Promise<void> {
		await this.run(['worktree', 'prune']);
	}

	// ------------------------------------------------------------------ remote

	async push(args: readonly string[]): Promise<GitExecResult> {
		return this.run(['push', ...args], { timeoutMs: 600_000 });
	}
}

// ------------------------------------------------------------------- helpers

function identityEnv(author: Identity, committer: Identity): Record<string, string> {
	return {
		GIT_AUTHOR_NAME: author.name,
		GIT_AUTHOR_EMAIL: author.email,
		GIT_AUTHOR_DATE: author.date,
		GIT_COMMITTER_NAME: committer.name,
		GIT_COMMITTER_EMAIL: committer.email,
		GIT_COMMITTER_DATE: committer.date,
	};
}

export function parseCommits(raw: string): CommitInfo[] {
	const commits: CommitInfo[] = [];
	for (const record of raw.split(RS)) {
		const trimmed = record.replace(/^\n+/, '');
		if (!trimmed.trim()) {
			continue;
		}
		const fields = trimmed.split(US);
		if (fields.length < 12) {
			continue;
		}
		const [sha, shortSha, parents, tree, an, ae, aI, cn, ce, cI, subject, ...rest] = fields;
		const body = rest.join(US);
		commits.push({
			sha,
			shortSha,
			parents: parents ? parents.split(' ').filter(Boolean) : [],
			tree,
			author: { name: an, email: ae, date: aI },
			committer: { name: cn, email: ce, date: cI },
			subject,
			body: body.replace(/\n+$/, ''),
			message: body.trim().length > 0 ? `${subject}\n\n${body.replace(/\n+$/, '')}` : subject,
		});
	}
	return commits;
}

function describeFailure(args: readonly string[], result: GitExecResult): string {
	const stderr = result.stderr.trim();
	const stdout = result.stdout.trim();
	const parts = [`$ git ${args.join(' ')}`];
	if (stderr) {
		parts.push(stderr);
	}
	if (stdout) {
		parts.push(stdout);
	}
	if (result.timedOut) {
		parts.push('(timed out)');
	}
	return parts.join('\n');
}

/** A collision-free path for a throw-away index file. */
export function tempIndexPath(label = 'idx'): string {
	return path.join(os.tmpdir(), `geco-${label}-${process.pid}-${crypto.randomBytes(6).toString('hex')}.index`);
}
