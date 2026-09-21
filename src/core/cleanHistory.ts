/**
 * "Clean History (Remove Dead Paths)" - the repository-wide counterpart of the
 * per-commit operations: find every path that exists somewhere in history but
 * in *no* current ref, and rewrite the history so those files are gone for
 * good (the workflow that used to live in `archive/clean-git-workflow.txt`).
 *
 * The scan is deliberately conservative - a path counts as dead only when no
 * branch, tag, remote-tracking branch *and* not HEAD itself contains it:
 *
 * - `--branches --remotes --tags` (never `--all`): this extension's own
 *   recovery refs under `refs/geco/` would otherwise keep every path of every
 *   reworded or squashed-away commit alive, and the rewrite would drag those
 *   hidden refs along, breaking **Undo**.
 * - `--diff-merges=separate`: plain `git log --name-only` reports *no* files
 *   for merge commits, so a file that only ever entered through a merge side
 *   would be missed entirely.
 * - `core.quotePath=false` *and* unquoting of whatever git still C-quotes (a
 *   path containing `"` or `\\` is quoted no matter the setting): the history
 *   list and the tree list would otherwise disagree about the same file and
 *   produce phantom dead paths - and `filter-repo` would be handed a quoted
 *   path it does not match against anything.
 * - `LC_ALL=C` everywhere: the set difference needs both sides sorted in the
 *   same collation, whatever the user's locale is.
 *
 * The rewrite itself is delegated to `git-filter-repo` (the tool git's own
 * documentation recommends); this module plans it, and the controller runs it
 * behind a modal confirmation, a `git bundle` backup and a journal entry.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { RepoContext } from './context';

/** How many bytes a dead path still occupies in the object store (best effort). */
export interface DeadPathSize {
	path: string;
	bytes: number;
	/** Blob versions of this path found in history. */
	versions: number;
}

export interface DeadPathAnalysis {
	/** Every path that ever appeared in a commit across branches/remotes/tags. */
	historicalPaths: string[];
	/** Every path contained in a current ref (or in HEAD when it is detached). */
	alivePaths: string[];
	/** historicalPaths minus alivePaths - what the rewrite would remove. */
	deadPaths: string[];
	/** True when at least one listed path came back quoted from git. */
	quotedPaths: boolean;
	/** Per-path object-store size of the dead paths (`undefined` when skipped). */
	sizes?: DeadPathSize[];
	/** Sum of `sizes` in bytes (`undefined` when the sizing was skipped). */
	deadBytes?: number;
	/** True when the object walk was too big to size every dead path. */
	sizingSkipped?: boolean;
}

/** Everything about the repository the plan has to warn about. */
export interface CleanFacts {
	/** Tracked modifications (untracked files do not block a history rewrite). */
	dirty: boolean;
	stashes: number;
	/** Linked worktrees besides the main one - filter-repo refuses them. */
	extraWorktrees: string[];
	/** Remotes configured before the rewrite (filter-repo removes them). */
	remotes: { name: string; url: string }[];
	/** This extension's recovery refs; they are excluded from the rewrite. */
	recoveryRefs: string[];
	/** HEAD does not point at a branch - its tree is scanned separately. */
	detachedHead: boolean;
}

export interface CleanPlan {
	analysis: DeadPathAnalysis;
	facts: CleanFacts;
	commands: CleanHistoryCommands;
	/** Human-readable scan report (written to the output log). */
	report: string;
	/** Things the user has to fix or accept before the rewrite can run. */
	warnings: string[];
	filterRepoAvailable: boolean;
	/** Repository root the plan was built for. */
	repoRoot: string;
	/** Where the dead-path list was written (`--paths-from-file`). */
	pathsFile: string;
	/** Backup bundle location (`undefined` when no bundle is planned). */
	bundleFile?: string;
	/** Every ref the backup bundle should cover (recovery refs included). */
	bundleRefs: string[];
}

export interface CommandsOptions {
	/** File holding the dead paths, one per line (`--paths-from-file`). */
	pathsFile: string;
	/** Backup bundle to create before anything is rewritten (`undefined` = none). */
	bundleFile?: string;
	/** Refs the rewrite must leave alone (this extension's recovery refs). */
	refsToKeep?: readonly string[];
	/** Remotes to re-add after the rewrite (filter-repo removes them). */
	droppedRemotes?: readonly { name: string; url: string }[];
	/** Pass `--force` (needed unless the repository is a fresh clone). */
	forceFilterRepo?: boolean;
	/** How filter-repo is started (`['git-filter-repo']` when it is not a git subcommand). */
	filterRepoCommand?: readonly string[];
	/** Refs the backup bundle should cover (empty = `--all`; hidden refs are not covered by `--all`). */
	bundleRefs?: readonly string[];
	/**
	 * The refs the rewrite covers, as full ref names (`refs/heads/main`,
	 * `refs/remotes/origin/x`, `refs/tags/v1`). Only these are handed to
	 * `--refs`, so anything else - the recovery points under `refs/geco/` -
	 * keeps pointing at the commits it recorded.
	 *
	 * The names have to be *ref names*: `git-filter-repo` parses `--refs` with
	 * argparse and stops collecting at the first token that looks like an
	 * option, so the `--branches --remotes --tags` flags `git log`/`rev-list`
	 * take are rejected outright (`error: argument --refs: expected at least
	 * one argument`, exit 2) and nothing gets rewritten. They are also not
	 * expanded by a shell here, so globs (`refs/heads/*`) would be silently
	 * ignored - which rewrites *every* ref, recovery points included.
	 *
	 * Empty (or longer than {@link MAX_EXPLICIT_FILTER_REPO_REFS}) means no
	 * `--refs` limit: everything is rewritten, and {@link
	 * CleanHistoryCommands.recoveryRefsProtected} says so.
	 */
	rewriteRefs?: readonly string[];
	/** Overrides {@link MAX_EXPLICIT_FILTER_REPO_REFS} (tests, tight platforms). */
	maxRewriteRefs?: number;
}

export interface CleanHistoryCommands {
	/** Every line of the runnable script, comments included. */
	all: string[];
	/** The bundle backup command (`undefined` when no bundle was requested). */
	bundle?: string[];
	/** The filter-repo rewrite command. */
	filterRepo: string[];
	/** Everything after the rewrite, as argument arrays: remotes, rescan, gc, push. */
	after: string[][];
	/** Refs the rewrite leaves alone (empty = no `--refs` limit, everything is rewritten). */
	refsToKeep: string[];
	/**
	 * True when the `--refs` limit is in place, i.e. the refs in {@link
	 * refsToKeep} survive the rewrite and **Undo** keeps working. False when
	 * the rewrite covers every ref - only possible with a warning, because
	 * filter-repo repacks at the end and the old objects are gone afterwards.
	 */
	recoveryRefsProtected: boolean;
	/** Remotes that have to be re-added after the rewrite. */
	droppedRemotes: { name: string; url: string }[];
	/** The script as one copy-pasteable block. */
	script: string;
}

/** Result of one external command (`git filter-repo ...`). */
export interface ExecLikeResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Injectable runner for the external rewrite tool (tests fake it). */
export type FilterRepoRunner = (command: readonly string[], cwd: string) => Promise<ExecLikeResult>;

/** Ref selection the scan and the rewrite share - `--all` would include `refs/geco/`. */
export const HISTORY_REF_SELECTION = ['--branches', '--remotes', '--tags'] as const;

/** Above this many refs the bundle falls back to `--all` (argument list limits). */
export const MAX_EXPLICIT_BUNDLE_REFS = 500;

/**
 * Above this many refs the rewrite drops the `--refs` limit instead of
 * listing them (argument list limits: Windows caps a command line at 32 KiB,
 * and a repository with a few thousand tags would blow through that).
 */
export const MAX_EXPLICIT_FILTER_REPO_REFS = 500;

/** Above this many objects the (best-effort) size analysis is skipped. */
export const MAX_OBJECTS_TO_SIZE = 300_000;

/** The scan may take a while on big repositories - 10 minutes per git call. */
const ANALYSIS_TIMEOUT_MS = 600_000;
const BUNDLE_TIMEOUT_MS = 1_800_000;
/** Exported for the controller: a rewrite of a big repository takes its time. */
export const FILTER_REPO_TIMEOUT_MS = 3_600_000;
const GC_TIMEOUT_MS = 1_800_000;

/** Environment that keeps git's output comparable: no quoting, C collation. */
const SCAN_ENV = { LC_ALL: 'C', GIT_CONFIG_PARAMETERS: "'core.quotepath=false'" } as const;

// --------------------------------------------------------------------- scan

/**
 * Parse a list of paths, one per line (`-z` output is also accepted), undoing
 * git's C-quoting on the way. `quoted` reports paths that are *still* quoted
 * after that - which should not happen and would make the comparison unreliable.
 */
export function parsePathList(raw: string): { paths: string[]; quoted: boolean } {
	const lines = raw.split(/[\n\0]/);
	const paths: string[] = [];
	let quoted = false;
	for (const line of lines) {
		const trimmed = line.replace(/\r$/, '');
		if (!trimmed) {
			continue;
		}
		const unquoted = unquoteGitPath(trimmed);
		if (unquoted === undefined) {
			quoted = true;
			paths.push(trimmed);
			continue;
		}
		paths.push(unquoted);
	}
	return { paths: dedupeSorted(paths), quoted };
}

/**
 * Undo git's C-quoting (`"caf\303\251.txt"` -> `café.txt`).
 *
 * `core.quotePath=false` only stops git from escaping *non-ASCII* bytes - a
 * path containing `"` or `\` is quoted no matter what, so the dead-path list
 * has to be unquoted before it is compared (and before it is handed to
 * `filter-repo`, which reads literal paths). Returns `undefined` when the
 * quoted form does not parse.
 */
export function unquoteGitPath(raw: string): string | undefined {
	if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) {
		return raw;
	}
	const body = raw.slice(1, -1);
	const bytes: number[] = [];
	for (let i = 0; i < body.length; i++) {
		const char = body[i]!;
		if (char !== '\\') {
			bytes.push(char.charCodeAt(0));
			continue;
		}
		const next = body[++i];
		if (next === undefined) {
			return undefined;
		}
		switch (next) {
			case 'n': bytes.push(0x0a); break;
			case 't': bytes.push(0x09); break;
			case 'r': bytes.push(0x0d); break;
			case 'a': bytes.push(0x07); break;
			case 'b': bytes.push(0x08); break;
			case 'f': bytes.push(0x0c); break;
			case 'v': bytes.push(0x0b); break;
			case '\\': bytes.push(0x5c); break;
			case '"': bytes.push(0x22); break;
			default: {
				if (next < '0' || next > '7') {
					return undefined;
				}
				// Up to three octal digits: one UTF-8 byte of the real name.
				let octal = next;
				while (octal.length < 3 && i + 1 < body.length && body[i + 1]! >= '0' && body[i + 1]! <= '7') {
					octal += body[++i];
				}
				const value = Number.parseInt(octal, 8);
				if (!Number.isFinite(value) || value > 0xff) {
					return undefined;
				}
				bytes.push(value);
			}
		}
	}
	// A newline inside the quoted form means the real path contains a newline -
	// then line-based output is ambiguous and the caller has to say so.
	if (bytes.includes(0x0a)) {
		return undefined;
	}
	return Buffer.from(bytes).toString('utf8');
}

/** Paths that appear in `history` but in none of `alive`, both pre-sorted. */
export function diffDeadPaths(history: readonly string[], alive: readonly string[]): string[] {
	const aliveSet = new Set(alive);
	const dead: string[] = [];
	for (const candidate of history) {
		if (!aliveSet.has(candidate)) {
			dead.push(candidate);
		}
	}
	return dead;
}

/** Every path any commit ever touched (merges included, hidden refs excluded). */
export async function historicalPaths(ctx: RepoContext): Promise<{ paths: string[]; quoted: boolean }> {
	const result = await ctx.git.run(
		['log', ...HISTORY_REF_SELECTION, '--diff-merges=separate', '--name-only', '--pretty=format:', '--no-show-signature'],
		{ env: { ...SCAN_ENV }, timeoutMs: ANALYSIS_TIMEOUT_MS },
	);
	if (result.exitCode !== 0) {
		// An empty repository answers with "unknown revision" - no history at all.
		return { paths: [], quoted: false };
	}
	return parsePathList(result.stdout);
}

/**
 * Every path a current ref contains - one `ls-tree` per ref tip (git has no
 * multi-revision `ls-tree`, and the `for r in $(git for-each-ref ...)` loop of
 * the original shell workflow is exactly this, only without the word splitting
 * and with `core.quotePath=false`).
 *
 * HEAD is scanned as a ref of its own: a detached HEAD (a commit no branch
 * points at) is not covered by `refs/heads`, and forgetting it would declare
 * the whole checked-out tree dead.
 */
export async function alivePaths(ctx: RepoContext): Promise<{ paths: string[]; quoted: boolean }> {
	const refs = await ctx.git.listRefs(['refs/heads', 'refs/remotes', 'refs/tags']);
	const targets = new Set(refs.map((ref) => ref.sha));
	const head = await ctx.git.revParse('HEAD');
	if (head) {
		targets.add(head);
	}
	const paths: string[] = [];
	let quoted = false;
	// Bounded concurrency: a repository with a thousand refs should not spawn a
	// thousand git processes at once, and one at a time is needlessly slow.
	const queue = [...targets];
	const workers = Array.from({ length: Math.min(8, Math.max(1, queue.length)) }, async () => {
		while (queue.length > 0) {
			const target = queue.shift()!;
			const result = await ctx.git.run(['ls-tree', '-r', '--name-only', '--full-tree', target], {
				env: { ...SCAN_ENV },
				timeoutMs: ANALYSIS_TIMEOUT_MS,
			});
			if (result.exitCode !== 0) {
				continue;
			}
			const parsed = parsePathList(result.stdout);
			quoted = quoted || parsed.quoted;
			paths.push(...parsed.paths);
		}
	});
	await Promise.all(workers);
	return { paths: dedupeSorted(paths), quoted };
}

/**
 * Best-effort size of every dead path: walk all blobs of the scanned refs once
 * (`rev-list --objects`, which prints `<sha> <path>`), keep the ones whose path
 * is dead, then ask `cat-file --batch-check` for their sizes in one call.
 */
export async function deadPathSizes(
	ctx: RepoContext,
	deadPaths: readonly string[],
	options: { maxObjects?: number } = {},
): Promise<{ sizes: DeadPathSize[]; totalBytes: number; skipped: boolean }> {
	if (deadPaths.length === 0) {
		return { sizes: [], totalBytes: 0, skipped: false };
	}
	const listing = await ctx.git.run(['rev-list', '--objects', ...HISTORY_REF_SELECTION], {
		env: { ...SCAN_ENV },
		timeoutMs: ANALYSIS_TIMEOUT_MS,
	});
	if (listing.exitCode !== 0) {
		return { sizes: [], totalBytes: 0, skipped: true };
	}
	const dead = new Set(deadPaths);
	// `<sha> <path>` per line: `%(rest)` of --batch-check is only filled with
	// what follows the object name on the input line, which is how the size
	// comes back attributed to a path (paths may contain spaces - everything
	// after the first space is the path).
	const entries: string[] = [];
	for (const line of listing.stdout.split('\n')) {
		const space = line.indexOf(' ');
		if (space <= 0) {
			continue;
		}
		const objectPath = line.slice(space + 1).trim();
		if (objectPath && dead.has(objectPath)) {
			entries.push(`${line.slice(0, space)} ${objectPath}`);
		}
	}
	if (entries.length === 0) {
		return { sizes: [], totalBytes: 0, skipped: false };
	}
	if (entries.length > (options.maxObjects ?? MAX_OBJECTS_TO_SIZE)) {
		return { sizes: [], totalBytes: 0, skipped: true };
	}

	const sizes = await ctx.git.run(['cat-file', '--batch-check=%(objectsize) %(rest)'], {
		input: `${entries.join('\n')}\n`,
		env: { ...SCAN_ENV },
		timeoutMs: ANALYSIS_TIMEOUT_MS,
	});
	if (sizes.exitCode !== 0) {
		return { sizes: [], totalBytes: 0, skipped: true };
	}
	const byPath = new Map<string, DeadPathSize>();
	for (const line of sizes.stdout.split('\n')) {
		const space = line.indexOf(' ');
		if (space <= 0) {
			continue;
		}
		const size = Number.parseInt(line.slice(0, space), 10);
		const objectPath = line.slice(space + 1).trim();
		if (!Number.isFinite(size) || !objectPath || !dead.has(objectPath)) {
			continue;
		}
		const entry = byPath.get(objectPath) ?? { path: objectPath, bytes: 0, versions: 0 };
		entry.bytes += size;
		entry.versions += 1;
		byPath.set(objectPath, entry);
	}
	const result = [...byPath.values()].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
	return { sizes: result, totalBytes: result.reduce((sum, entry) => sum + entry.bytes, 0), skipped: false };
}

/** The full scan: dead paths, their sizes and everything the plan warns about. */
export async function analyzeDeadPaths(ctx: RepoContext, options: { sizeAnalysis?: boolean } = {}): Promise<DeadPathAnalysis> {
	const [history, alive] = await Promise.all([historicalPaths(ctx), alivePaths(ctx)]);
	const quoted = history.quoted || alive.quoted;
	const deadPaths = diffDeadPaths(history.paths, alive.paths);
	const analysis: DeadPathAnalysis = {
		historicalPaths: history.paths,
		alivePaths: alive.paths,
		deadPaths,
		quotedPaths: quoted,
	};
	if (options.sizeAnalysis === false || deadPaths.length === 0) {
		return analysis;
	}
	const sized = await deadPathSizes(ctx, deadPaths);
	analysis.sizes = sized.sizes;
	analysis.deadBytes = sized.totalBytes;
	analysis.sizingSkipped = sized.skipped;
	return analysis;
}

/** Everything about the repository state the plan has to warn about. */
export async function collectCleanFacts(ctx: RepoContext, recoveryRefPrefix: string): Promise<CleanFacts> {
	const [status, stashOut, worktrees, branch, recovery] = await Promise.all([
		ctx.git.status(),
		ctx.git.tryRun(['stash', 'list']),
		ctx.git.worktreeList(),
		ctx.git.headBranch(),
		ctx.git.refsUnder(recoveryRefPrefix),
	]);
	const remotes: { name: string; url: string }[] = [];
	// `Git.remotes()` answers `undefined` when `git remote` prints nothing at
	// all (tryRun treats an empty stdout as "no output") - a repository without
	// a remote must not look like one with an empty remote name.
	for (const name of (await ctx.git.remotes()) ?? []) {
		if (!name) {
			continue;
		}
		const url = (await ctx.git.tryRun(['remote', 'get-url', name])) ?? '';
		remotes.push({ name, url });
	}
	return {
		dirty: status.length > 0,
		stashes: stashOut ? stashOut.split('\n').filter(Boolean).length : 0,
		extraWorktrees: worktrees.slice(1).map((worktree) => worktree.path),
		remotes,
		recoveryRefs: recovery.map((ref) => ref.name),
		detachedHead: branch === undefined,
	};
}

// -------------------------------------------------------------------- plan

/**
 * The exact commands the cleanup runs (and, when `git-filter-repo` is missing,
 * the script the user gets to run by hand). Order matters: backup first, the
 * rewrite second, remotes and garbage collection last.
 */
export function buildCommands(options: CommandsOptions): CleanHistoryCommands {
	const refsToKeep = [...(options.refsToKeep ?? [])];
	const droppedRemotes = [...(options.droppedRemotes ?? [])];
	const filterRepo = options.filterRepoCommand?.length ? [...options.filterRepoCommand] : ['git', 'filter-repo'];

	const filterRepoArgs = [
		...filterRepo,
		'--invert-paths',
		'--paths-from-file',
		options.pathsFile,
		// `delete-no-add`: leave no refs/replace/ behind - stale replace refs
		// would silently translate old SHAs for everyone who has not re-cloned.
		// (The workflow notes' old value `update-no` is not a valid choice.)
		'--replace-refs',
		'delete-no-add',
	];
	const rewriteRefs = sanitizeRewriteRefs(options.rewriteRefs);
	const limit = options.maxRewriteRefs ?? MAX_EXPLICIT_FILTER_REPO_REFS;
	const recoveryRefsProtected = refsToKeep.length > 0 && rewriteRefs.length > 0 && rewriteRefs.length <= limit;
	if (recoveryRefsProtected) {
		// Only rewrite the public refs, by name: the recovery points under
		// refs/geco/ must keep pointing at the commits they recorded, or Undo
		// breaks. They cannot be excluded any other way - filter-repo has no
		// "everything except", and `--refs` takes ref names, not rev-list flags.
		filterRepoArgs.push('--refs', ...rewriteRefs);
	}
	if (options.forceFilterRepo !== false) {
		// filter-repo insists on a fresh clone unless told otherwise.
		filterRepoArgs.push('--force');
	}

	const all: string[] = [];
	const after: string[][] = [];
	let bundleCommand: string[] | undefined;
	let step = 1;

	if (options.bundleFile) {
		bundleCommand = ['git', ...bundleArgs(options.bundleFile, options.bundleRefs ?? [])];
		all.push(`# ${step++}. Backup - the rewrite cannot be undone by git afterwards.`, shellCommand(bundleCommand));
	}

	all.push(
		recoveryRefsProtected
			? `# ${step++}. Remove every dead path from the ${rewriteRefs.length} public ref(s)${keptPrefix(refsToKeep) ? ` (everything under ${keptPrefix(refsToKeep)}/ is left alone)` : ''}.`
			: `# ${step++}. Remove every dead path from all refs.`,
		shellCommand(filterRepoArgs),
	);

	// filter-repo removes the remotes on purpose (so nobody pushes a
	// half-rewritten history by accident) - put them back.
	if (droppedRemotes.length > 0) {
		all.push('# filter-repo removed every remote; add them back before pushing.');
	}
	for (const remote of droppedRemotes) {
		const add = ['git', 'remote', 'add', remote.name, remote.url];
		all.push(shellCommand(add));
		after.push(add);
	}

	// The rescan the workflow doc ends with. `git ls-tree` takes exactly one
	// tree-ish (the archive version passed --branches/--tags/HEAD to it and
	// silently compared against nothing), so the alive side walks every ref tip
	// in a loop, and LC_ALL=C keeps both sides of `comm` in the same collation.
	const rescan = [
		'ALL=$(mktemp); ALIVE=$(mktemp)',
		"LC_ALL=C git -c core.quotePath=false log --branches --remotes --tags \\",
		"    --diff-merges=separate --name-only --pretty=format: | grep -v '^$' | LC_ALL=C sort -u > \"$ALL\"",
		'{ git rev-parse --verify --quiet HEAD >/dev/null && git -c core.quotePath=false ls-tree -r --name-only HEAD',
		"  for r in $(git for-each-ref --format='%(objectname)' refs/heads refs/remotes refs/tags); do",
		'    git -c core.quotePath=false ls-tree -r --name-only "$r" || true',
		'  done',
		'} | LC_ALL=C sort -u > "$ALIVE"',
		'comm -23 "$ALL" "$ALIVE"   # must print nothing',
		'rm -f "$ALL" "$ALIVE"',
	];
	all.push(`# ${step++}. Rescan: this must print nothing (paths a recovery ref still holds are listed and explained).`);
	all.push(...rescan);
	after.push(['sh', '-c', rescan.join('\n')]);

	const gc = ['git', 'reflog', 'expire', '--expire=now', '--all'];
	const prune = ['git', 'gc', '--prune=now', '--quiet'];
	all.push(`# ${step++}. Reclaim the space: drop the reflogs that still reference the old objects.`, shellCommand(gc), shellCommand(prune));
	after.push(gc, prune);

	if (droppedRemotes.length > 0) {
		const remote = droppedRemotes[0]!.name;
		const pushAll = ['git', 'push', '--force-with-lease', remote, '--all'];
		const pushTags = ['git', 'push', '--force', remote, '--tags'];
		all.push(
			`# ${step++}. Publish the cleaned history. --force-with-lease refuses to overwrite a push you have not seen;`,
			`# tags have no lease, and remote branches that are *gone* locally must be deleted explicitly:`,
			`#   git push ${remote} --delete <branch>   # for every stale remote branch`,
			shellCommand(pushAll),
			shellCommand(pushTags),
		);
		after.push(pushAll, pushTags);
	} else {
		all.push('# No remote is configured - nothing to push.');
	}

	return { all, bundle: bundleCommand, filterRepo: filterRepoArgs, after, refsToKeep, recoveryRefsProtected, droppedRemotes, script: `${all.join('\n')}\n` };
}

/**
 * The ref names that may be handed to `git-filter-repo --refs`, deduped and in
 * `git for-each-ref` order. Anything that is not a plain ref name is dropped:
 * a token starting with `-` would end argparse's argument collection (that is
 * the bug that made every cleanup fail with "argument --refs: expected at
 * least one argument"), and a glob would be passed through to `git rev-list`
 * unexpanded, which rev-list rejects - filter-repo ignores that failure and
 * then rewrites *every* ref, recovery points included.
 */
export function sanitizeRewriteRefs(refs: readonly string[] | undefined): string[] {
	return [...new Set((refs ?? []).filter((ref) => /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(ref)))];
}

/** `git bundle create <file> <refs>` arguments - every ref, or `--all` when there are too many. */
export function bundleArgs(bundleFile: string, refs: readonly string[], limit = MAX_EXPLICIT_BUNDLE_REFS): string[] {
	// `--all` covers branches, tags and remotes but *not* hidden refs such as
	// this extension's recovery points - list the refs explicitly to include
	// them, unless the argument list would grow too long.
	const selection = refs.length > 0 && refs.length <= limit ? [...refs] : ['--all'];
	return ['bundle', 'create', bundleFile, ...selection];
}

/** The scan report + warnings, as it goes to the output log. */
export function formatCleanReport(analysis: DeadPathAnalysis, facts: CleanFacts, options: { pathsFile?: string; listLimit?: number } = {}): string {
	const limit = options.listLimit ?? 25;
	const sizes = new Map((analysis.sizes ?? []).map((entry) => [entry.path, entry]));
	const lines: string[] = [
		`Dead paths: ${analysis.deadPaths.length} (of ${analysis.historicalPaths.length} paths that ever existed in any branch, remote or tag)`,
	];
	if (analysis.deadBytes !== undefined && analysis.deadBytes > 0) {
		lines[0] += `, ${formatBytes(analysis.deadBytes)} of objects they still occupy`;
	}
	for (const dead of analysis.deadPaths.slice(0, limit)) {
		const size = sizes.get(dead);
		lines.push(`  ${size && size.bytes > 0 ? `${formatBytes(size.bytes).padStart(9)}  ` : ''}${dead}${size && size.versions > 1 ? `  (${size.versions} versions)` : ''}`);
	}
	if (analysis.deadPaths.length > limit) {
		lines.push(`  ... ${analysis.deadPaths.length - limit} more${options.pathsFile ? ` - the full list is written to ${options.pathsFile}` : ''}`);
	}
	if (analysis.sizingSkipped) {
		lines.push('  (the size analysis was skipped: too many objects to walk)');
	}

	const warnings = cleanWarnings(analysis, facts);
	if (warnings.length > 0) {
		lines.push('', 'Before the rewrite:');
		for (const warning of warnings) {
			lines.push(`  ! ${warning}`);
		}
	}
	return lines.join('\n');
}

/**
 * The subset of {@link cleanWarnings} that makes a rewrite impossible, not just
 * risky: `git filter-repo` refuses uncommitted changes and linked worktrees, so
 * refusing early spares the user a backup bundle that cannot be used.
 */
export function blockingCleanReasons(facts: CleanFacts): string[] {
	const reasons: string[] = [];
	if (facts.dirty) {
		reasons.push('Uncommitted changes: commit or stash them first (git filter-repo refuses a dirty working tree).');
	}
	if (facts.extraWorktrees.length > 0) {
		reasons.push(`Linked worktrees: ${facts.extraWorktrees.join(', ')} - remove them with "git worktree remove <path>".`);
	}
	return reasons;
}

/** What has to be fixed or accepted before a rewrite may run. */
export function cleanWarnings(analysis: DeadPathAnalysis, facts: CleanFacts): string[] {
	const warnings: string[] = [];
	if (analysis.quotedPaths) {
		warnings.push('Some paths could not be read back unquoted (a literal newline in the file name is the usual reason) - those are reported but not compared, so they will not be removed.');
	}
	if (facts.dirty) {
		warnings.push('The working tree has uncommitted changes. Commit or stash them first - filter-repo refuses to run otherwise.');
	}
	if (facts.stashes > 0) {
		warnings.push(`${facts.stashes} stash entry/stashes still reference old commits (git stash clear removes them).`);
	}
	if (facts.extraWorktrees.length > 0) {
		warnings.push(`Linked worktrees have to go first: ${facts.extraWorktrees.join(', ')} (git worktree remove ...).`);
	}
	if (facts.recoveryRefs.length > 0) {
		warnings.push(
			`${facts.recoveryRefs.length} Git Easy Ops recovery point(s) under refs/geco/ are excluded from the rewrite, so Undo keeps working - `
			+ 'the objects they point at stay in the repository until the recovery points are dropped.',
		);
	}
	if (facts.detachedHead) {
		warnings.push('HEAD is detached; its tree was scanned as a ref of its own.');
	}
	return warnings;
}

/** The modal confirmation text for the destructive part. */
export function describeCleanConfirmation(
	analysis: DeadPathAnalysis,
	facts: CleanFacts,
	options: { bundleFile?: string; pathsFile: string },
): { message: string; detail: string } {
	const message = `Remove ${analysis.deadPaths.length} dead path${analysis.deadPaths.length === 1 ? '' : 's'} from the entire history?`;
	const detail = [
		analysis.deadBytes && analysis.deadBytes > 0
			? `${analysis.deadPaths.length} paths (${formatBytes(analysis.deadBytes)}) exist in old commits but in no branch, tag or remote-tracking branch.`
			: `${analysis.deadPaths.length} paths exist in old commits but in no branch, tag or remote-tracking branch.`,
		analysis.deadPaths.slice(0, 8).map((p) => `  ${p}`).join('\n'),
		analysis.deadPaths.length > 8 ? `  ... ${analysis.deadPaths.length - 8} more (${options.pathsFile})` : undefined,
		'',
		'git filter-repo rewrites EVERY commit: all SHAs change, tags are moved,',
		facts.remotes.length > 0
			? `the remote(s) ${facts.remotes.map((r) => r.name).join(', ')} are removed and re-added, and every collaborator has to re-clone.`
			: 'and every collaborator has to re-clone afterwards.',
		facts.recoveryRefs.length > 0
			? `The ${facts.recoveryRefs.length} recovery point(s) under refs/geco/ are kept (excluded from the rewrite), so they still hold the removed files until you drop them.`
			: undefined,
		options.bundleFile ? `A backup bundle of every ref is written to ${options.bundleFile} first.` : undefined,
		'',
		'There is no Undo for this operation - the bundle is the way back.',
	].filter((line): line is string => line !== undefined).join('\n');
	return { message, detail };
}

// ------------------------------------------------------------------- runner

/** Create the backup bundle; returns an error message instead of throwing. */
export async function createBackupBundle(ctx: RepoContext, bundleFile: string, refs: readonly string[]): Promise<{ ok: boolean; detail: string }> {
	await fsp.mkdir(path.dirname(bundleFile), { recursive: true });
	const args = bundleArgs(bundleFile, refs);
	const result = await ctx.git.run(args, { timeoutMs: BUNDLE_TIMEOUT_MS });
	if (result.exitCode !== 0) {
		return { ok: false, detail: `${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}` };
	}
	return { ok: true, detail: args.includes('--all') ? 'git bundle --all (hidden recovery refs are not covered by --all)' : `${refs.length} refs bundled` };
}

/** `git reflog expire` + `git gc --prune=now` - only after the user agreed. */
export async function reclaimSpace(ctx: RepoContext): Promise<string> {
	const expire = await ctx.git.run(['reflog', 'expire', '--expire=now', '--all'], { timeoutMs: GC_TIMEOUT_MS });
	const gc = await ctx.git.run(['gc', '--prune=now', '--quiet'], { timeoutMs: GC_TIMEOUT_MS });
	if (gc.exitCode !== 0) {
		return `reflogs expired, but git gc failed: ${gc.stderr.trim().split('\n')[0] ?? `exit ${gc.exitCode}`}`;
	}
	return expire.exitCode === 0 ? 'reflogs expired and the object store was repacked (git gc --prune=now)' : `git gc ran; reflog expire reported: ${expire.stderr.trim()}`;
}

/** Default bundle location: next to the repository folder, never inside it. */
export function defaultBundleFile(repoRoot: string): string {
	const base = path.basename(repoRoot) || 'repository';
	return path.join(path.dirname(repoRoot), `${base}-geco-clean-${stamp()}.bundle`);
}

/** Where the dead-path list is written (inside `.git`, so nothing is tracked). */
export async function deadPathsFileFor(ctx: RepoContext): Promise<string> {
	const common = await ctx.git.commonDir();
	return path.join(common, 'geco', 'dead-paths.txt');
}

export async function writeDeadPathsFile(file: string, deadPaths: readonly string[]): Promise<void> {
	await fsp.mkdir(path.dirname(file), { recursive: true });
	// A trailing newline matters: filter-repo reads the file line by line.
	await fsp.writeFile(file, `${deadPaths.join('\n')}\n`, 'utf8');
}

// ------------------------------------------------------------------ helpers

function dedupeSorted(paths: readonly string[]): string[] {
	return [...new Set(paths)];
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return '0 B';
	}
	const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
	const value = bytes / 1024 ** exponent;
	const rounded = Math.round(value);
	// Whole numbers read better without a decimal ("2 MiB", not "2.0 MiB").
	const text = Math.abs(value - rounded) < 0.05 ? String(rounded) : value.toFixed(1);
	return `${text} ${units[exponent]}`;
}

function shellQuote(value: string): string {
	return /[^A-Za-z0-9_@%+=:,./-]/.test(value) ? `'${value.replace(/'/g, `'\\''`)}'` : value;
}

export function shellCommand(args: readonly string[]): string {
	return args.map(shellQuote).join(' ');
}

/** The ref prefix a kept ref lives under (`refs/geco/...` -> `refs/geco`). */
export function keptPrefix(refsToKeep: readonly string[]): string {
	const first = refsToKeep[0];
	if (!first) {
		return '';
	}
	const parts = first.split('/');
	return parts.slice(0, Math.max(2, parts.length - 2)).join('/');
}

function stamp(): string {
	return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
}
