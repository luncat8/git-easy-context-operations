/**
 * Feature 4 - find the proper base commit/branch for a patch and apply it there.
 *
 * "Proper base" is answered in two steps:
 *
 *   1. cheap blob check - every file in the patch carries its pre-image blob
 *      (`index <old>..<new>`). A candidate commit is an *exact* base when its
 *      tree holds exactly those blobs (and does not hold files the patch adds);
 *   2. authoritative probe - `git read-tree <candidate>` into a throw-away index
 *      file followed by `git apply --check --cached`. This answers "would it
 *      apply?" without touching the user's index, worktree or HEAD.
 *
 * Candidates are tried best-first: parent of the commit the patch came from,
 * merge base with the target branch, branch tips, then the first-parent history
 * (which finds the newest ancestor a patch still fits onto).
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { RepoContext } from './context';
import { GecoError } from './errors';
import { Git, tempIndexPath } from './git';
import { shorten } from './safety';

// ------------------------------------------------------------------ patch model

export interface PatchFileEntry {
	/** Path after the change (`b/` side, or the rename target). */
	path: string;
	/** Path before the change (`a/` side). */
	oldPath: string;
	preImageBlob?: string;
	postImageBlob?: string;
	isNewFile: boolean;
	isDelete: boolean;
	isRename: boolean;
	isBinary: boolean;
	/** Combined (`--cc`) diffs cannot be applied by `git apply`. */
	isCombined: boolean;
	hunkCount: number;
}

export interface ParsedPatch {
	raw: string;
	/** `mailbox` = `git format-patch` output that `git am` can replay with its message. */
	kind: 'mailbox' | 'diff';
	files: PatchFileEntry[];
	commitCount: number;
	commitSha?: string;
	subject?: string;
	authorName?: string;
	authorEmail?: string;
	authorDate?: string;
	hasCombinedDiff: boolean;
}

const MAILBOX_HEADER = /^From ([0-9a-f]{7,64}) /;

export function parsePatch(raw: string): ParsedPatch {
	const text = (raw ?? '').replace(/\r\n/g, '\n');
	const lines = text.split('\n');

	let kind: 'mailbox' | 'diff' = 'diff';
	let commitCount = 0;
	let commitSha: string | undefined;
	let subject: string | undefined;
	let authorName: string | undefined;
	let authorEmail: string | undefined;
	let authorDate: string | undefined;

	for (const line of lines) {
		const mailbox = MAILBOX_HEADER.exec(line);
		if (mailbox) {
			commitCount++;
			kind = 'mailbox';
			commitSha = commitSha ?? mailbox[1];
			continue;
		}
		if (commitCount === 1 && !subject) {
			if (line.startsWith('Subject: ')) {
				subject = decodeMailSubject(line.slice('Subject: '.length));
			} else if (line.startsWith('From: ')) {
				const parsed = parseAuthorHeader(line.slice('From: '.length));
				authorName = parsed.name;
				authorEmail = parsed.email;
			} else if (line.startsWith('Date: ')) {
				authorDate = line.slice('Date: '.length).trim();
			}
		}
	}

	const files: PatchFileEntry[] = [];
	let current: PatchFileEntry | undefined;
	let hasCombinedDiff = false;

	const flush = () => {
		if (current) {
			files.push(current);
			current = undefined;
		}
	};

	for (const line of lines) {
		if (line.startsWith('diff --git ')) {
			flush();
			current = {
				...pathsFromDiffGit(line),
				isNewFile: false,
				isDelete: false,
				isRename: false,
				isBinary: false,
				isCombined: false,
				hunkCount: 0,
			};
			continue;
		}
		if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
			flush();
			hasCombinedDiff = true;
			current = {
				path: stripPrefix(line.split(' ').pop() ?? '', 'b'),
				oldPath: stripPrefix(line.split(' ').pop() ?? '', 'a'),
				isNewFile: false,
				isDelete: false,
				isRename: false,
				isBinary: false,
				isCombined: true,
				hunkCount: 0,
			};
			continue;
		}
		if (!current) {
			continue;
		}
		if (line.startsWith('index ')) {
			const match = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(line);
			if (match) {
				if (!/^0+$/.test(match[1])) {
					current.preImageBlob = match[1];
				}
				if (!/^0+$/.test(match[2])) {
					current.postImageBlob = match[2];
				}
			}
			continue;
		}
		if (line.startsWith('new file mode ')) {
			current.isNewFile = true;
			continue;
		}
		if (line.startsWith('deleted file mode ')) {
			current.isDelete = true;
			continue;
		}
		const renameFrom = /^((?:rename|copy) from )(.*)$/.exec(line);
		if (renameFrom) {
			current.isRename = true;
			current.oldPath = unquoteC(renameFrom[2].trim());
			continue;
		}
		const renameTo = /^((?:rename|copy) to )(.*)$/.exec(line);
		if (renameTo) {
			current.isRename = true;
			current.path = unquoteC(renameTo[2].trim());
			continue;
		}
		if (line.startsWith('similarity index ') || line.startsWith('dissimilarity index ')) {
			continue;
		}
		if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
			current.isBinary = true;
			continue;
		}
		if (line.startsWith('--- ')) {
			const value = headerPath(line.slice(4));
			if (value !== undefined) {
				current.oldPath = stripPrefix(value, 'a');
			}
			continue;
		}
		if (line.startsWith('+++ ')) {
			const value = headerPath(line.slice(4));
			if (value !== undefined) {
				current.path = stripPrefix(value, 'b');
			}
			continue;
		}
		if (line.startsWith('@@')) {
			current.hunkCount++;
		}
	}
	flush();

	return {
		raw: text,
		kind,
		files: files.filter((f) => f.path || f.oldPath),
		commitCount,
		commitSha,
		subject,
		authorName,
		authorEmail,
		authorDate,
		hasCombinedDiff,
	};
}

function pathsFromDiffGit(line: string): { path: string; oldPath: string } {
	// `diff --git a/<old> b/<new>` - paths may contain spaces, so prefer the
	// `---` / `+++` lines later on and only use this as a fallback.
	const body = line.slice('diff --git '.length);
	const quoted = /^"(.*)" "(.*)"$/.exec(body);
	if (quoted) {
		return { oldPath: unquoteC(quoted[1]), path: unquoteC(quoted[2]) };
	}
	const marker = ' b/';
	const index = body.lastIndexOf(marker);
	if (index > 0) {
		return { oldPath: stripPrefix(body.slice(0, index), 'a'), path: body.slice(index + marker.length) };
	}
	return { oldPath: body, path: body };
}

/** `--- a/path`, `+++ "b/path with spaces"` or `/dev/null`. */
function headerPath(value: string): string | undefined {
	const withoutTimestamp = value.split('\t')[0].trim();
	if (withoutTimestamp === '/dev/null' || withoutTimestamp === '') {
		return undefined;
	}
	if (withoutTimestamp.startsWith('"') && withoutTimestamp.endsWith('"') && withoutTimestamp.length > 1) {
		return unquoteC(withoutTimestamp.slice(1, -1));
	}
	return withoutTimestamp;
}

function stripPrefix(value: string, prefix: 'a' | 'b'): string {
	const withPrefix = `${prefix}/`;
	return value.startsWith(withPrefix) ? value.slice(withPrefix.length) : value;
}

function unquoteC(value: string): string {
	return value.replace(/\\([0-7]{3}|n|t|r|"|\\)/g, (_, seq: string) => {
		switch (seq) {
			case 'n': return '\n';
			case 't': return '\t';
			case 'r': return '\r';
			case '"': return '"';
			case '\\': return '\\';
			default: return String.fromCharCode(Number.parseInt(seq, 8));
		}
	});
}

function decodeMailSubject(value: string): string {
	// format-patch prefixes series subjects with `[PATCH 1/2]`.
	return value.replace(/^\s*(\[[^\]]*\]\s*)+/, '').trim();
}

function parseAuthorHeader(value: string): { name?: string; email?: string } {
	const match = /^(.*?)\s*<([^>]+)>$/.exec(value.trim());
	if (match) {
		return { name: match[1].trim() || undefined, email: match[2].trim() };
	}
	return { name: value.trim() || undefined };
}

// -------------------------------------------------------------- patch sources

export type PatchSource =
	| { kind: 'commit'; commit: string; mailbox?: boolean }
	| { kind: 'range'; from: string; to: string; mailbox?: boolean }
	| { kind: 'staged' }
	| { kind: 'worktree' }
	| { kind: 'file'; path: string }
	| { kind: 'text'; patch: string };

export interface MaterializedPatch {
	patch: string;
	label: string;
	/** The commit the patch was taken from, used as the first base candidate. */
	sourceCommit?: string;
}

export async function materializePatch(ctx: RepoContext, source: PatchSource): Promise<MaterializedPatch> {
	const { git } = ctx;
	switch (source.kind) {
		case 'commit': {
			const sha = await git.resolveCommit(source.commit);
			const info = await git.commitInfo(sha);
			if (info.parents.length > 1) {
				const diff = await git.raw(['diff', '--no-color', `${info.parents[0]}`, sha]);
				return { patch: diff, label: `${shorten(sha)} ${info.subject} (merge commit: diff against first parent)`, sourceCommit: sha };
			}
			if (source.mailbox === false) {
				const diff = info.parents.length === 1
					? await git.raw(['diff', '--no-color', info.parents[0], sha])
					: await git.raw(['show', '--no-color', '--format=', sha]);
				return { patch: diff, label: `${shorten(sha)} ${info.subject}`, sourceCommit: sha };
			}
			const mailbox = await git.raw(['format-patch', '-1', '--stdout', '--no-signature', sha]);
			if (!mailbox.trim()) {
				throw new GecoError('nothing-to-do', `Commit ${shorten(sha)} produced an empty patch (it changes nothing).`);
			}
			return { patch: mailbox, label: `${shorten(sha)} ${info.subject}`, sourceCommit: sha };
		}
		case 'range': {
			const from = await git.resolveCommit(source.from);
			const to = await git.resolveCommit(source.to);
			const patch = source.mailbox
				? await git.raw(['format-patch', '--stdout', '--no-signature', `${from}..${to}`])
				: await git.raw(['diff', '--no-color', from, to]);
			if (!patch.trim()) {
				throw new GecoError('nothing-to-do', `The range ${shorten(from)}..${shorten(to)} is empty.`);
			}
			return { patch, label: `${shorten(from)}..${shorten(to)}`, sourceCommit: to };
		}
		case 'staged': {
			const patch = await git.raw(['diff', '--no-color', '--cached']);
			if (!patch.trim()) {
				throw new GecoError('nothing-to-do', 'Nothing is staged.');
			}
			return { patch, label: 'staged changes' };
		}
		case 'worktree': {
			const patch = await git.raw(['diff', '--no-color', 'HEAD']);
			if (!patch.trim()) {
				throw new GecoError('nothing-to-do', 'The working tree matches HEAD.');
			}
			return { patch, label: 'working tree changes' };
		}
		case 'file': {
			const absolute = path.isAbsolute(source.path) ? source.path : path.resolve(git.cwd, source.path);
			let patch: string;
			try {
				patch = await fsp.readFile(absolute, 'utf8');
			} catch (error) {
				throw new GecoError('unsupported', `Cannot read patch file "${source.path}".`, error instanceof Error ? error.message : String(error));
			}
			if (!patch.trim()) {
				throw new GecoError('nothing-to-do', `Patch file "${source.path}" is empty.`);
			}
			return { patch, label: path.basename(absolute) };
		}
		case 'text': {
			if (!source.patch.trim()) {
				throw new GecoError('nothing-to-do', 'The patch is empty.');
			}
			return { patch: source.patch, label: 'pasted patch' };
		}
		default: {
			const exhaustive: never = source;
			throw new GecoError('unsupported', `Unknown patch source ${JSON.stringify(exhaustive)}`);
		}
	}
}

// ---------------------------------------------------------------- base search

export interface BaseCandidate {
	sha: string;
	label: string;
	ref?: string;
}

export interface BaseEvaluation {
	sha: string;
	label: string;
	ref?: string;
	/** All pre-image blobs of the patch exist in this tree. */
	exact: boolean;
	/** `git apply --check` says it applies without help. */
	appliesCleanly: boolean;
	/** A 3-way merge can do something (possibly leaving conflicts). */
	threeWay: boolean;
	threeWayConflicts: boolean;
	reason: string;
	score: number;
	/** Paths whose content differs from the patch's expectation. */
	mismatchedPaths: string[];
}

export interface FindBaseOptions {
	patch: string;
	sourceCommit?: string;
	targetBranch?: string;
	extraCandidates?: string[];
	maxCandidates?: number;
	/** Stop as soon as a base is found (default: true). */
	stopAtFirstMatch?: boolean;
	/** Run the authoritative `git apply --check` probe (default: true). */
	verify?: boolean;
}

export interface FindBaseResult {
	parsed: ParsedPatch;
	candidates: BaseCandidate[];
	evaluated: BaseEvaluation[];
	best?: BaseEvaluation;
}

export async function findProperBase(ctx: RepoContext, options: FindBaseOptions): Promise<FindBaseResult> {
	const parsed = parsePatch(options.patch);
	if (parsed.files.length === 0) {
		throw new GecoError('unsupported', 'This does not look like a patch (no file diffs found).');
	}
	if (parsed.hasCombinedDiff) {
		throw new GecoError('unsupported', 'Combined (`--cc`) diffs cannot be applied. Re-create the patch with `git diff <parent> <commit>`.');
	}

	const candidates = await collectCandidates(ctx, options);
	if (candidates.length === 0) {
		throw new GecoError('ref-not-found', 'No candidate base commits were found in this repository.');
	}

	const verify = options.verify !== false;
	const stopAtFirstMatch = options.stopAtFirstMatch !== false;
	const evaluated: BaseEvaluation[] = [];

	for (const candidate of candidates) {
		const evaluation = await evaluateCandidate(ctx, parsed, candidate, verify);
		evaluated.push(evaluation);
		if (stopAtFirstMatch && (evaluation.exact || evaluation.appliesCleanly)) {
			break;
		}
	}

	const best = pickBest(evaluated);
	return { parsed, candidates, evaluated, best };
}

function pickBest(evaluated: BaseEvaluation[]): BaseEvaluation | undefined {
	if (evaluated.length === 0) {
		return undefined;
	}
	return evaluated
		.slice()
		.sort((a, b) => (b.score - a.score) || (evaluated.indexOf(a) - evaluated.indexOf(b)))[0];
}

async function collectCandidates(ctx: RepoContext, options: FindBaseOptions): Promise<BaseCandidate[]> {
	const { git } = ctx;
	const limit = Math.max(1, options.maxCandidates ?? ctx.settings.patchBaseCandidateLimit);
	const out: BaseCandidate[] = [];
	const seen = new Set<string>();

	const add = (sha: string | undefined, label: string, ref?: string) => {
		if (!sha || seen.has(sha)) {
			return;
		}
		seen.add(sha);
		out.push({ sha, label, ref });
	};

	const targetBranch = options.targetBranch ?? (await git.headBranch());
	const targetSha = targetBranch ? await git.revParse(`refs/heads/${targetBranch}`) : undefined;

	if (options.sourceCommit) {
		const sourceSha = await git.tryRun(['rev-parse', '--verify', '--quiet', `${options.sourceCommit}^{commit}`]);
		if (sourceSha) {
			const info = await git.commitInfo(sourceSha);
			for (const parent of info.parents) {
				add(parent, `parent of ${shorten(sourceSha)} (${info.subject})`);
			}
			if (targetSha) {
				const mergeBase = await git.mergeBase(targetSha, sourceSha);
				if (mergeBase) {
					add(mergeBase, `merge base of ${targetBranch} and ${shorten(sourceSha)}`, targetBranch);
				}
			}
		}
	}

	if (targetSha) {
		add(targetSha, `tip of ${targetBranch}`, targetBranch);
	}
	add(await git.revParse('HEAD'), 'HEAD');

	// First-parent history: finds the newest ancestor a patch still fits onto.
	const walkFrom = targetSha ?? (await git.revParse('HEAD'));
	if (walkFrom) {
		const history = await git.revList(['--first-parent', `--max-count=${limit}`, walkFrom]);
		for (const sha of history) {
			add(sha, `ancestor of ${targetBranch ?? 'HEAD'}`);
		}
	}

	for (const branch of await git.branches()) {
		add(branch.sha, `tip of ${branch.name}`, branch.name);
	}

	for (const extra of options.extraCandidates ?? []) {
		add(await git.revParse(extra), `requested "${extra}"`, extra);
	}

	return out.slice(0, limit);
}

async function evaluateCandidate(ctx: RepoContext, parsed: ParsedPatch, candidate: BaseCandidate, verify: boolean): Promise<BaseEvaluation> {
	const { git } = ctx;
	const paths = Array.from(new Set(parsed.files.flatMap((f) => [f.path, f.oldPath].filter(Boolean))));
	const tree = await git.lsTreePaths(candidate.sha, paths);

	const mismatched: string[] = [];
	for (const file of parsed.files) {
		const entry = tree.get(file.oldPath) ?? tree.get(file.path);
		if (file.isNewFile) {
			if (entry) {
				mismatched.push(file.path);
			}
			continue;
		}
		if (!entry) {
			mismatched.push(file.path);
			continue;
		}
		if (file.preImageBlob && !blobMatches(entry.sha, file.preImageBlob)) {
			mismatched.push(file.path);
		}
	}
	const exact = mismatched.length === 0 && parsed.files.length > 0;

	const evaluation: BaseEvaluation = {
		sha: candidate.sha,
		label: candidate.label,
		ref: candidate.ref,
		exact,
		appliesCleanly: exact,
		threeWay: false,
		threeWayConflicts: false,
		reason: exact ? 'tree holds the exact pre-image of every file' : '',
		score: exact ? 100 : 0,
		mismatchedPaths: mismatched,
	};

	if (exact || !verify) {
		if (!verify && !exact) {
			evaluation.reason = 'not verified';
		}
		return evaluation;
	}

	const indexFile = tempIndexPath('probe');
	try {
		const check = await git.checkPatchAtTree(candidate.sha, parsed.raw, indexFile);
		if (check.applies) {
			evaluation.appliesCleanly = true;
			evaluation.reason = '`git apply --check` succeeded';
			evaluation.score = 60;
			return evaluation;
		}
		if (ctx.settings.threeWayApply) {
			await fsp.rm(indexFile, { force: true }).catch(() => undefined);
			const threeWay = await git.checkPatchAtTree(candidate.sha, parsed.raw, indexFile, { threeWay: true });
			evaluation.threeWay = threeWay.applies || threeWay.conflicts;
			evaluation.threeWayConflicts = threeWay.conflicts;
			if (evaluation.threeWay) {
				evaluation.score = threeWay.conflicts ? 20 : 40;
			}
		}
		evaluation.reason = evaluation.threeWay
			? evaluation.threeWayConflicts
				? 'needs a 3-way merge and would leave conflicts'
				: 'applies through a 3-way merge'
			: 'does not apply here';
		return evaluation;
	} finally {
		await fsp.rm(indexFile, { force: true }).catch(() => undefined);
	}
}

function blobMatches(full: string, expected: string): boolean {
	return full === expected || full.startsWith(expected) || expected.startsWith(full);
}

// ------------------------------------------------------------------- applying

export interface ApplyPatchOptions {
	patch: string;
	/** Explicit base; when omitted the proper base is searched for. */
	base?: string;
	sourceCommit?: string;
	targetBranch?: string;
	destination?: 'current' | 'newBranch' | 'worktree';
	branchName?: string;
	worktreePath?: string;
	threeWay?: boolean;
	/** Commit the result (mailbox patches always commit through `git am`). */
	commit?: boolean;
	commitMessage?: string;
	/** Report what would happen without touching anything. */
	dryRun?: boolean;
	maxCandidates?: number;
}

export interface ApplyPatchResult {
	parsed: ParsedPatch;
	base: BaseEvaluation;
	destination: 'current' | 'newBranch' | 'worktree';
	method: 'apply' | 'apply-3way' | 'am' | 'am-3' | 'none';
	branch?: string;
	worktreePath?: string;
	cwd: string;
	appliedPaths: string[];
	conflicts: string[];
	staged: boolean;
	committed: boolean;
	commitSha?: string;
	alreadyApplied: boolean;
	dryRun: boolean;
	checkedOut: boolean;
	warnings: string[];
	evaluated: BaseEvaluation[];
}

export async function applyPatch(ctx: RepoContext, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
	const { git, safety, settings } = ctx;
	await git.requireRepository();

	const threeWay = options.threeWay ?? settings.threeWayApply;
	const warnings: string[] = [];

	const found = await findProperBase(ctx, {
		patch: options.patch,
		sourceCommit: options.sourceCommit,
		targetBranch: options.targetBranch,
		extraCandidates: options.base ? [options.base] : undefined,
		maxCandidates: options.base ? 1 : options.maxCandidates,
		stopAtFirstMatch: !options.dryRun,
	});
	const parsed = found.parsed;

	let base = options.base ? found.evaluated[0] : found.best;
	if (!base) {
		throw new GecoError('ref-not-found', 'Could not determine a base commit for this patch.');
	}
	if (options.base && !base.exact && !base.appliesCleanly) {
		warnings.push(`The requested base ${shorten(base.sha)} does not take this patch cleanly${threeWay ? '; a 3-way merge will be attempted' : ''}.`);
	}
	// An explicitly requested base is the user's decision: try it and let git
	// report the real conflict instead of refusing up front.
	if (!base.exact && !base.appliesCleanly && !base.threeWay && !options.base) {
		const listing = found.evaluated
			.slice(0, 8)
			.map((e) => `  ${shorten(e.sha)} ${e.label} - ${e.reason}`)
			.join('\n');
		throw new GecoError(
			'conflict',
			'No candidate base accepts this patch.',
			`Candidates that were probed:\n${listing || '  (none)'}\nTry enabling the 3-way merge (geco.threeWayApply) or pick the base yourself.`,
		);
	}
	if (!base.appliesCleanly && base.threeWay) {
		warnings.push(`Best base ${shorten(base.sha)} (${base.label}) needs a 3-way merge${base.threeWayConflicts ? ' and will probably leave conflicts' : ''}.`);
	}
	if (options.base && !base.appliesCleanly && !base.threeWay) {
		warnings.push(`The requested base ${shorten(base.sha)} looks wrong for this patch, applying anyway - expect conflicts.`);
	}

	const headSha = await git.revParse('HEAD');
	const headBranch = await git.headBranch();
	let destination = options.destination ?? settings.applyPatchDestination;

	if (destination === 'current' && base.sha !== headSha) {
		throw new GecoError(
			'unsupported',
			`The proper base for this patch is ${shorten(base.sha)} (${base.label}), not HEAD (${shorten(headSha ?? '')}).`,
			'Apply it on a new branch or in a separate worktree instead - that is the whole point of finding the proper base.',
		);
	}
	if (destination === 'newBranch' && (await git.isDirty())) {
		destination = 'worktree';
		warnings.push('The working tree has uncommitted changes, so the patch is applied in a separate worktree instead of checking out a new branch.');
	}

	if (options.dryRun) {
		return {
			parsed,
			base,
			destination,
			method: 'none',
			cwd: git.cwd,
			appliedPaths: parsed.files.map((f) => f.path || f.oldPath),
			conflicts: [],
			staged: false,
			committed: false,
			alreadyApplied: false,
			dryRun: true,
			checkedOut: false,
			warnings,
			evaluated: found.evaluated,
		};
	}

	const mailbox = parsed.kind === 'mailbox';
	const branchName = options.branchName
		?? (mailbox && parsed.subject ? `geco/${slugify(parsed.subject)}` : `geco/patch-${shorten(base.sha)}`);

	let workDir = git.cwd;
	let createdBranch: string | undefined;
	let createdWorktree: string | undefined;
	let checkedOut = false;
	const previousBranch = headBranch;

	if (destination === 'newBranch') {
		if (await git.branchExists(branchName)) {
			throw new GecoError('ref-exists', `Branch "${branchName}" already exists.`, 'Pass another branch name or delete the existing branch first.');
		}
		await git.createBranch(branchName, base.sha);
		createdBranch = branchName;
		await git.checkout(branchName);
		checkedOut = true;
	} else if (destination === 'worktree') {
		const uniqueBranch = await safety.resolveFreeBranchName(branchName);
		if (uniqueBranch !== branchName) {
			warnings.push(`Branch "${branchName}" was taken, using "${uniqueBranch}".`);
		}
		const target = options.worktreePath ?? path.resolve(git.cwd, '..', settings.worktreeFolder, uniqueBranch.replace(/\//g, '-'));
		await git.worktreeAdd(target, { ref: base.sha, newBranch: uniqueBranch });
		createdWorktree = target;
		createdBranch = uniqueBranch;
		workDir = target;
	}

	const target = new Git(git.exec, workDir);
	try {
		const applied = await applyInWorktree(target, parsed, { threeWay, mailbox, commit: options.commit, commitMessage: options.commitMessage, warnings });
		const commitSha = applied.committed ? await target.revParse('HEAD') : undefined;

		if (createdWorktree || createdBranch) {
			await safety.record({
				kind: 'applyPatch',
				summary: `Applied patch at ${shorten(base.sha)} (${base.label})${createdBranch ? ` on branch ${createdBranch}` : ''}${createdWorktree ? ` in worktree ${createdWorktree}` : ''}`,
				undo: {
					type: 'refs',
					refs: [],
					deleteBranches: createdWorktree ? [createdBranch!] : [],
					worktrees: createdWorktree ? [{ path: createdWorktree, branch: createdBranch }] : [],
					checkoutRef: checkedOut && previousBranch ? previousBranch : undefined,
				},
			});
		} else if (applied.committed && previousBranch && headSha) {
			await safety.record({
				kind: 'applyPatch',
				summary: `Applied patch on ${previousBranch} and committed ${shorten(commitSha ?? '')}`,
				undo: { type: 'refs', refs: [{ ref: `refs/heads/${previousBranch}`, restoreTo: headSha, expected: commitSha, resetHard: true }] },
			});
		} else {
			await safety.record({
				kind: 'applyPatch',
				summary: `Applied patch to the working tree of ${previousBranch ?? 'HEAD'} (not committed)`,
				undo: {
					type: 'none',
					hint: `Nothing was committed. Discard the applied changes with: git restore --staged --worktree ${applied.appliedPaths.map((p) => `"${p}"`).join(' ') || '.'}`,
				},
			});
		}

		return {
			parsed,
			base,
			destination,
			method: applied.method,
			branch: createdBranch ?? (destination === 'current' ? previousBranch : undefined),
			worktreePath: createdWorktree,
			cwd: workDir,
			appliedPaths: applied.appliedPaths,
			conflicts: applied.conflicts,
			staged: applied.staged,
			committed: applied.committed,
			commitSha,
			alreadyApplied: applied.alreadyApplied,
			dryRun: false,
			checkedOut,
			warnings,
			evaluated: found.evaluated,
		};
	} catch (error) {
		// Roll back everything *we* created. When the patch was applied to the
		// user's own checkout ('current') the conflict is deliberately left in
		// place so it can be resolved there - the error explains how.
		if (createdWorktree) {
			await abortAmIfInProgress(target);
			await git.worktreeRemove(createdWorktree, { force: true }).catch(() => undefined);
			await git.worktreePrune();
			if (createdBranch && (await git.branchExists(createdBranch))) {
				await git.deleteBranch(createdBranch, { force: true }).catch(() => undefined);
			}
		} else if (checkedOut && createdBranch) {
			await abortAmIfInProgress(git);
			if (previousBranch) {
				await git.checkout(previousBranch).catch(() => undefined);
			}
			if (await git.branchExists(createdBranch)) {
				await git.deleteBranch(createdBranch, { force: true }).catch(() => undefined);
			}
		}
		throw error;
	}
}

/** Leave no half-finished `git am` behind in something we are about to delete. */
async function abortAmIfInProgress(git: Git): Promise<void> {
	if (await git.amInProgress()) {
		await git.amPatch('', { abort: true });
	}
}

interface ApplyInWorktreeOptions {
	threeWay: boolean;
	mailbox: boolean;
	commit?: boolean;
	commitMessage?: string;
	warnings: string[];
}

interface ApplyInWorktreeResult {
	method: ApplyPatchResult['method'];
	appliedPaths: string[];
	conflicts: string[];
	staged: boolean;
	committed: boolean;
	alreadyApplied: boolean;
}

async function applyInWorktree(git: Git, parsed: ParsedPatch, options: ApplyInWorktreeOptions): Promise<ApplyInWorktreeResult> {
	const paths = parsed.files.map((f) => f.path || f.oldPath).filter(Boolean);

	if (options.mailbox) {
		const result = await git.amPatch(parsed.raw, { threeWay: options.threeWay });
		const output = `${result.stdout}\n${result.stderr}`;
		const alreadyApplied = /No changes -- Patch already applied/i.test(output);
		if (result.exitCode !== 0) {
			const conflicts = await git.conflictedPaths();
			const inProgress = await git.amInProgress();
			throw new GecoError(
				'conflict',
				`git am could not apply the patch${conflicts.length > 0 ? ` (conflicts in ${conflicts.join(', ')})` : ''}.`,
				[
					output.trim(),
					inProgress
						? 'Resolve the conflicts, `git add` the files and run `git am --continue` (or `git am --abort` to go back).'
						: '',
				].filter(Boolean).join('\n'),
			);
		}
		if (alreadyApplied) {
			options.warnings.push('git am reported the patch was already applied.');
		}
		return {
			method: options.threeWay ? 'am-3' : 'am',
			appliedPaths: paths,
			conflicts: [],
			staged: true,
			committed: true,
			alreadyApplied,
		};
	}

	const result = await git.applyPatch(parsed.raw, { threeWay: options.threeWay });
	const output = `${result.stdout}\n${result.stderr}`;
	if (result.exitCode !== 0) {
		const conflicts = await git.conflictedPaths();
		throw new GecoError(
			'conflict',
			`git apply could not apply the patch${conflicts.length > 0 ? ` (conflicts in ${conflicts.join(', ')})` : ''}.`,
			output.trim(),
		);
	}
	const staged = options.threeWay; // `--3way` implies `--index`
	const conflicts = staged ? await git.conflictedPaths() : [];

	let committed = false;
	if (options.commit) {
		if (!staged) {
			await git.ok(['add', '--', ...paths]);
		}
		const message = options.commitMessage ?? `Apply patch (${parsed.files.length} file${parsed.files.length === 1 ? '' : 's'})`;
		const commitResult = await git.run(['commit', '-F', '-'], { input: `${message}\n` });
		if (commitResult.exitCode !== 0) {
			throw new GecoError('git-failed', 'The patch was applied but the commit failed.', `${commitResult.stdout}\n${commitResult.stderr}`.trim());
		}
		committed = true;
	}

	return {
		method: options.threeWay ? 'apply-3way' : 'apply',
		appliedPaths: paths,
		conflicts,
		staged,
		committed,
		alreadyApplied: false,
	};
}

function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9._/-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40) || 'patch';
}
