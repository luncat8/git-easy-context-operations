/**
 * The primitives behind every operation that rewrites history (reword, squash,
 * ...): creating a replacement commit object and replaying descendants.
 *
 * Nothing here touches HEAD, the index or the working tree - that is what makes
 * the operations safe to run with uncommitted changes.
 */
import type { CommitInfo, Git } from './git';

/**
 * Write a copy of `sha` with a different message, keeping its tree, its
 * parents (mapped to their rewritten versions when they were rewritten) and its
 * author/committer identity.
 */
export async function rewriteCommit(
	git: Git,
	sha: string,
	message: string,
	mapped: Map<string, string>,
	preserveCommitterDate: boolean,
): Promise<string> {
	const info: CommitInfo = await git.commitInfo(sha);
	const committer = preserveCommitterDate
		? info.committer
		: { ...info.committer, date: new Date().toISOString() };
	return git.commitTree({
		tree: info.tree,
		parents: info.parents.map((parent) => mapped.get(parent) ?? parent),
		message,
		author: info.author,
		committer,
	});
}

/** True when the commit carries a signature - which a rewrite cannot keep. */
export async function isSignedCommit(git: Git, sha: string): Promise<boolean> {
	const status = await git.signatureStatus(sha);
	return !!status && status !== 'N';
}

/** Drop a recovery ref again after a failed rewrite (its content is untouched). */
export async function discardRecoveryRef(git: Git, backupRef: string | undefined): Promise<void> {
	if (!backupRef) {
		return;
	}
	await git.run(['update-ref', '-d', backupRef]);
}
