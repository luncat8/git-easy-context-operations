import * as path from 'node:path';

/** Parse NUL-delimited `git diff-tree --name-status -z` output. */
export interface CommitFileChange {
	readonly path: string;
	readonly status: string;
	readonly oldPath?: string;
}

export function parseCommitFileChanges(raw: string): CommitFileChange[] {
	const fields = raw.split('\0');
	const changes: CommitFileChange[] = [];
	for (let i = 0; i < fields.length && fields[i];) {
		const status = fields[i++]!;
		if (!/^(?:[AMDTUXB]|[RC]\d+)$/.test(status)) {
			throw new Error('Invalid git diff output');
		}
		const first = fields[i++];
		const isMove = status.startsWith('R') || status.startsWith('C');
		const target = isMove ? fields[i++] : first;
		if (!first || !target) {
			throw new Error('Incomplete git diff output');
		}
		changes.push({ path: target, status, ...(isMove ? { oldPath: first } : {}) });
	}
	return changes;
}

/** Resolve only extant working-tree files; history's deletion status is not
 * enough to decide availability because a path may have been recreated later. */
export async function availableCommitFiles(
	root: string,
	changes: readonly CommitFileChange[],
	isFile: (absolutePath: string) => Promise<boolean>,
): Promise<(CommitFileChange & { absolutePath: string })[]> {
	const result: (CommitFileChange & { absolutePath: string })[] = [];
	const seen = new Set<string>();
	for (const change of changes) {
		const absolutePath = path.resolve(root, change.path);
		const rel = path.relative(root, absolutePath);
		if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || seen.has(absolutePath)) { continue; }
		if (await isFile(absolutePath)) {
			seen.add(absolutePath);
			result.push({ ...change, absolutePath });
		}
	}
	return result;
}
