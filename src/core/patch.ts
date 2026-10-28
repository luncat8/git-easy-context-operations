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
	/** Binary-file diff headers without an embedded payload; the files may be recovered beside a patch file. */
	unavailableBinaryFiles: PatchFileEntry[];
	/** Binary files that could not be recovered from beside the patch file. */
	skippedBinaryPaths: string[];
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
		unavailableBinaryFiles: [],
		skippedBinaryPaths: [],
	};
}

/**
 * `git diff` without `--binary` emits only `Binary files ... differ` for a
 * binary change. That header is not an applicable patch; remove it from the
 * input to git while keeping its blob ids for base matching and possible
 * sidecar recovery. Text changes in the same patch/mailbox remain intact.
 * Binary sections with an actual `GIT binary patch` payload are left intact.
 */
function omitUnavailableBinarySections(raw: string): ParsedPatch {
	const parsed = parsePatch(raw);
	const starts: number[] = [];
	const marker = /^diff --(?:git|cc|combined) .*$/gm;
	for (let match = marker.exec(parsed.raw); match; match = marker.exec(parsed.raw)) {
		starts.push(match.index);
	}
	if (starts.length === 0) {
		return parsed;
	}

	let filtered = parsed.raw.slice(0, starts[0]);
	const unavailable: PatchFileEntry[] = [];
	for (let i = 0; i < starts.length; i++) {
		const section = parsed.raw.slice(starts[i], starts[i + 1] ?? parsed.raw.length);
		if (/^Binary files .* differ\s*$/m.test(section) && !/^GIT binary patch\s*$/m.test(section)) {
			const entry = parsePatch(section).files[0];
			if (entry) {
				unavailable.push(entry);
			}
			continue;
		}
		filtered += section;
	}
	const result = parsePatch(filtered);
	// Keep the old/new blob ids for base matching, but do not leave the
	// unapplyable binary headers in the patch sent to git.
	result.files.push(...unavailable);
	result.unavailableBinaryFiles = unavailable;
	return result;
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
	/** For file patches, the directory to search for binary blobs referenced by index hashes. */
	sourceDirectory?: string;
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
			return { patch, label: path.basename(absolute), sourceDirectory: path.dirname(absolute) };
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
	const parsed = omitUnavailableBinarySections(options.patch);
	if (parsed.files.length === 0) {
		const skipped = parsed.skippedBinaryPaths;
		throw new GecoError(
			'unsupported',
			skipped.length > 0
				? 'The patch contains no applicable files; its binary file diffs have no embedded data.'
				: 'This does not look like a patch (no file diffs found).',
			skipped.length > 0 ? `Skipped binary files: ${skipped.join(', ')}` : undefined,
		);
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
	const mismatchedBinary = parsed.unavailableBinaryFiles.find((file) => mismatched.includes(file.path));
	if (mismatchedBinary) {
		evaluation.reason = `binary pre-image differs for ${mismatchedBinary.path}`;
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

interface RecoveredBinaryFile {
	entry: PatchFileEntry;
	sourcePath: string;
	expectedBlob: string;
	/** Safe repository-relative target path, rooted in whichever worktree receives the patch. */
	targetPath: string;
}

/** Find direct children of the patch directory whose Git blob id matches a missing binary section. */
async function recoverableBinaryFiles(
	git: Git,
	parsed: ParsedPatch,
	sourceDirectory?: string,
): Promise<{ found: RecoveredBinaryFile[]; skipped: PatchFileEntry[] }> {
	if (parsed.unavailableBinaryFiles.length === 0) {
		return { found: [], skipped: [] };
	}
	const candidates: string[] = [];
	if (sourceDirectory) {
		try {
			for (const item of await fsp.readdir(sourceDirectory, { withFileTypes: true })) {
				if (item.isFile()) {
					candidates.push(path.join(sourceDirectory, item.name));
				}
			}
		} catch {
			// A missing/inaccessible sidecar directory simply means the binaries
			// remain skipped; it must not prevent the text parts from applying.
		}
	}

	const found: RecoveredBinaryFile[] = [];
	const skipped: PatchFileEntry[] = [];
	for (const entry of parsed.unavailableBinaryFiles) {
		const relativeTarget = entry.path || entry.oldPath;
		const absoluteTarget = path.resolve(git.cwd, relativeTarget);
		const relativeCheck = path.relative(git.cwd, absoluteTarget);
		if (!relativeTarget || !entry.postImageBlob || !relativeCheck || relativeCheck === '..' || relativeCheck.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCheck)) {
			skipped.push(entry);
			continue;
		}

		let matchedPath: string | undefined;
		let matchedHash: string | undefined;
		let ambiguous = false;
		for (const candidate of candidates) {
			const result = await git.run(['hash-object', `--path=${relativeTarget}`, '--', candidate]);
			const hash = result.stdout.trim();
			if (result.exitCode === 0 && hash.startsWith(entry.postImageBlob)) {
				if (matchedHash && matchedHash !== hash) {
					ambiguous = true;
					break;
				}
				matchedPath ??= candidate;
				matchedHash = hash;
			}
		}
		if (!matchedPath || ambiguous) {
			skipped.push(entry);
			continue;
		}
		found.push({ entry, sourcePath: matchedPath, expectedBlob: entry.postImageBlob, targetPath: relativeTarget });
	}
	return { found, skipped };
}

async function installRecoveredBinaryFiles(git: Git, files: readonly RecoveredBinaryFile[]): Promise<void> {
	const copies: Array<{ source: string; target: string }> = [];
	for (const file of files) {
		const target = path.resolve(git.cwd, file.targetPath);
		const sourceHash = await git.run(['hash-object', `--path=${file.targetPath}`, '--', file.sourcePath]);
		if (sourceHash.exitCode !== 0 || !sourceHash.stdout.trim().startsWith(file.expectedBlob)) {
			throw new GecoError('unsupported', `The sidecar file for "${file.entry.path}" changed after it was verified.`, 'Re-run Apply Patch to verify it again.');
		}
		if (path.resolve(file.sourcePath) === target) {
			continue;
		}

		// Validate every target before copying any of them, and never follow a
		// repository symlink when installing an untrusted patch path.
		let cursor = git.cwd;
		for (const part of file.targetPath.split(/[\\/]/)) {
			cursor = path.join(cursor, part);
			try {
				const stat = await fsp.lstat(cursor);
				if (stat.isSymbolicLink()) {
					throw new GecoError('unsupported', `Cannot install recovered binary "${file.entry.path}" through a symbolic link.`);
				}
			} catch (error) {
				if (error instanceof GecoError) {
					throw error;
				}
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
					throw error;
				}
				break;
			}
		}
		copies.push({ source: file.sourcePath, target });
	}
	for (const copy of copies) {
		await fsp.mkdir(path.dirname(copy.target), { recursive: true });
		await fsp.copyFile(copy.source, copy.target);
	}
}

/**
 * Is this patch already in the repository graph? Returns *why* when it is
 * (a sentence for the log / notification), `undefined` when it looks new.
 *
 * Three proofs, strongest first - any one is enough:
 *
 *  1. **the commit itself is reachable**: a mailbox patch names the commit it
 *     was made from (`From <sha> ...`); when a branch, a tag or HEAD already
 *     contains that sha, the change is in the graph by definition;
 *  2. **patch equivalence**: `git patch-id` hashes the change while ignoring
 *     parent, author, date and message, so the same edit committed twice
 *     under different hashes still matches. Every commit of the patch must
 *     have a counterpart in the graph - a half-applied series is not
 *     "already applied", it is work still to do;
 *  3. (left to the caller) `git apply` / `git am` failing on the change is
 *     also treated as "not usable" by the automatic flow - this function is
 *     the cheap, explainable pre-check, not the only guard.
 *
 * Only the newest `maxCommits` commits of `--all` are patch-id compared:
 * the graph can be huge, and a patch whose twin is older than that is
 * re-checked by the apply itself.
 */
export async function patchAlreadyAppliedReason(
	ctx: RepoContext,
	parsed: ParsedPatch,
	options: { maxCommits?: number } = {},
): Promise<string | undefined> {
	const { git } = ctx;
	if (parsed.files.length === 0) {
		return undefined;
	}

	if (parsed.commitSha) {
		const sha = await git.tryRun(['rev-parse', '--verify', '--quiet', `${parsed.commitSha}^{commit}`]);
		if (sha) {
			const branches = await git.branchesContaining(sha);
			const tags = await git.tagsContaining(sha);
			const onHead = await git.isAncestor(sha, 'HEAD');
			const where = branches[0] ?? tags[0] ?? (onHead ? 'HEAD' : undefined);
			if (where) {
				return `commit ${shorten(sha)}${parsed.subject ? ` ("${parsed.subject}")` : ''} is already in the graph on ${where}`;
			}
		}
	}

	const incoming = await git.patchIdsOfPatch(parsed.raw);
	if (incoming.length === 0) {
		return undefined;
	}
	const limit = Math.max(1, options.maxCommits ?? 200);
	const commits = await git.revList(['--all', `--max-count=${limit}`]);
	// Two git processes for the whole graph slice (`git show` + `git
	// patch-id`) instead of two *per commit*: the per-commit loop spawned up
	// to 400 processes for the default 200 commits on every click.
	const idsBySha = await git.patchIdsOfCommits(commits);
	const wanted = new Set(incoming);
	const matched = new Map<string, string>();
	for (const sha of commits) {
		const id = idsBySha.get(sha);
		if (id && wanted.has(id) && !matched.has(id)) {
			matched.set(id, sha);
		}
	}
	if (matched.size === incoming.length) {
		const first = matched.get(incoming[0]!)!;
		return incoming.length === 1
			? `the same change is already in the graph as commit ${shorten(first)} (same patch-id)`
			: `all ${incoming.length} commits of this patch series are already in the graph (same patch-ids, e.g. ${shorten(first)})`;
	}
	return undefined;
}

// ------------------------------------------------------------------- applying

export interface ApplyPatchOptions {
	patch: string;
	/** Directory containing the original patch file; used only to recover indexed binary blobs. */
	binarySourceDirectory?: string;
	/** Explicit base; when omitted the proper base is searched for. */
	base?: string;
	sourceCommit?: string;
	targetBranch?: string;
	destination?: 'current' | 'newBranch' | 'worktree';
	branchName?: string;
	worktreePath?: string;
	threeWay?: boolean;
	/**
	 * Apply in place on the current branch when the proper base *is* HEAD.
	 *
	 * Only a caller that never asked where the patch should land (the
	 * automatic flow) sets this: when the patch fits the latest HEAD
	 * cleanly, creating `geco/patch-<base>` (or a worktree branch) just to
	 * hold an uncommitted change the user is about to review in their own
	 * checkout is ceremony without a benefit, so the configured
	 * `newBranch` / `worktree` destination is dropped for `current`. The
	 * downgrade only happens when the base is exactly HEAD, the tree probe
	 * says the patch applies without a 3-way merge, and no local change
	 * (staged, unstaged or untracked) touches a path the patch touches -
	 * otherwise the requested destination is honoured as usual. An
	 * interactive caller, who *picked* the branch/worktree destination,
	 * never sets this.
	 */
	applyAtHeadWithoutBranch?: boolean;
	/**
	 * Whether the result may become a commit.
	 *
	 * - a mailbox patch commits through `git am` unless this is `false` -
	 *   with `false` its diff is applied with `git apply` instead, so the
	 *   change lands in the worktree/index *uncommitted* and the user picks
	 *   the commit name;
	 * - a plain diff commits (with `commitMessage`) only when this is `true`.
	 */
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
	const recovery = await recoverableBinaryFiles(git, parsed, options.binarySourceDirectory);
	parsed.skippedBinaryPaths = recovery.skipped.map((entry) => entry.path || entry.oldPath);
	for (const entry of recovery.skipped) {
		const name = entry.path || entry.oldPath || '(unknown binary file)';
		warnings.push(
			`Skipped binary file "${name}": no unique file beside the patch matched the new blob hash${entry.postImageBlob ? ` ${entry.postImageBlob}` : ''}. To include it automatically, put the exact binary file beside the patch before applying.`,
		);
	}
	const textFiles = parsePatch(parsed.raw).files;
	const applyingParsed: ParsedPatch = {
		...parsed,
		files: [...textFiles, ...recovery.found.map((file) => file.entry)],
	};
	if (applyingParsed.files.length === 0) {
		throw new GecoError(
			'unsupported',
			'No patch changes can be applied: its binary file data was not found.',
			warnings.join('\n') || 'Place the binary files beside the patch file, then retry.',
		);
	}

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

	if (
		options.applyAtHeadWithoutBranch
		&& destination !== 'current'
		&& headSha
		&& base.sha === headSha
		&& base.appliesCleanly
	) {
		// "It applies on the last HEAD" is only true for the checkout as it
		// stands: a local edit to a file the patch rewrites would make
		// `git apply` refuse (or, worse, the 3-way fallback would fold the
		// edit into the result), so any overlap keeps the branch/worktree
		// the caller asked for - which then falls back to a worktree of its
		// own accord when the tree is dirty.
		const patchPaths = new Set(parsed.files.flatMap((f) => [f.path, f.oldPath].filter(Boolean)));
		const localChanges = await git.status({ includeUntracked: true });
		const inTheWay = localChanges.some(
			(entry) => patchPaths.has(entry.path) || (entry.originalPath !== undefined && patchPaths.has(entry.originalPath)),
		);
		if (!inTheWay) {
			destination = 'current';
			warnings.push(
				`The proper base is the current HEAD (${shorten(base.sha)}), so the patch is applied directly on ${headBranch ?? 'the current checkout'} instead of creating a new branch.`,
			);
		}
	}

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
			appliedPaths: applyingParsed.files.map((f) => f.path || f.oldPath),
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
		const applied = await applyInWorktree(target, applyingParsed, {
			threeWay,
			mailbox,
			commit: options.commit,
			commitMessage: options.commitMessage,
			recoveredBinaries: recovery.found,
			warnings,
		});
		const commitSha = applied.committed ? await target.revParse('HEAD') : undefined;

		if (createdWorktree || createdBranch) {
			// Uncommitted changes on a branch this call just created: Undo has
			// to discard them first (the guarded `resetHard` refuses once the
			// user has committed on the branch, so their own commit is never
			// destroyed), then delete the branch - that restores the state
			// from before the apply. A *committed* apply keeps the branch as
			// its result; Undo only checks the previous branch out again.
			const uncommittedOnNewBranch = Boolean(createdBranch) && !createdWorktree && !applied.committed;
			await safety.record({
				kind: 'applyPatch',
				summary: `Applied patch at ${shorten(base.sha)} (${base.label})${createdBranch ? ` on branch ${createdBranch}` : ''}${createdWorktree ? ` in worktree ${createdWorktree}` : ''}${applied.committed ? '' : ' (not committed)'}`,
				undo: {
					type: 'refs',
					refs: uncommittedOnNewBranch ? [{ ref: `refs/heads/${createdBranch}`, restoreTo: base.sha, expected: base.sha, resetHard: true }] : [],
					deleteBranches: createdWorktree || uncommittedOnNewBranch ? [createdBranch!] : [],
					worktrees: createdWorktree ? [{ path: createdWorktree, branch: createdBranch }] : [],
					checkoutRef: checkedOut ? previousBranch ?? (uncommittedOnNewBranch ? base.sha : undefined) : undefined,
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
			// Discard whatever the failed apply left in the checkout *we*
			// created - a 3-way apply that stopped with conflicts would
			// otherwise make the checkout below fail and strand the user on
			// the half-built branch. Safe: this destination is only chosen
			// when the tracked files were clean, so everything dirty here is
			// ours.
			await git.reset('hard', base.sha).catch(() => undefined);
			await git.checkout(previousBranch ?? base.sha, previousBranch ? undefined : { detach: true }).catch(() => undefined);
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
	/** See {@link ApplyPatchOptions.commit} - `false` means never commit, mailbox included. */
	commit?: boolean;
	commitMessage?: string;
	recoveredBinaries: readonly RecoveredBinaryFile[];
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
	const binaryPaths = options.recoveredBinaries.map((file) => file.targetPath);
	const hasTextPatch = parsePatch(parsed.raw).files.length > 0;

	// `git am` replays mailbox metadata. A binary without a payload is added
	// afterwards from its hash-verified sidecar and folded into the new commit.
	if (options.mailbox && options.commit !== false && hasTextPatch) {
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
		if (binaryPaths.length > 0) {
			await installRecoveredBinaryFiles(git, options.recoveredBinaries);
			await git.ok(['add', '--', ...binaryPaths]);
			const amended = alreadyApplied
				? await git.run(['commit', '-F', '-'], { input: `${parsed.subject ?? 'Recover binary files from patch'} (recovered binaries)\n` })
				: await git.run(['commit', '--amend', '--no-edit'], { env: { GIT_EDITOR: 'true' } });
			if (amended.exitCode !== 0) {
				throw new GecoError('git-failed', 'The patch text was committed, but the recovered binary could not be added to that commit.', `${amended.stdout}\n${amended.stderr}`.trim());
			}
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

	if (hasTextPatch) {
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
	}

	if (binaryPaths.length > 0) {
		await installRecoveredBinaryFiles(git, options.recoveredBinaries);
	}
	const staged = options.threeWay; // `--3way` implies `--index`
	if (binaryPaths.length > 0 && staged && !options.commit) {
		await git.ok(['add', '--', ...binaryPaths]);
	}
	const conflicts = staged ? await git.conflictedPaths() : [];

	let committed = false;
	if (options.commit) {
		if (!staged) {
			await git.ok(['add', '--', ...paths]);
		} else if (binaryPaths.length > 0) {
			await git.ok(['add', '--', ...binaryPaths]);
		}
		const message = options.commitMessage ?? (parsed.subject || `Apply patch (${parsed.files.length} file${parsed.files.length === 1 ? '' : 's'})`);
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
		.replace(/\.{2,}/g, '.') // `..` is forbidden anywhere in a ref name
		.slice(0, 40)
		.replace(/[./]+$/, '') || 'patch'; // a ref cannot end with `.` or `/`
}
