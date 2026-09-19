/**
 * Feature 3 - force push.
 *
 * Default is `--force-with-lease=<branch>:<sha we last saw>`: the push is
 * refused when somebody else pushed to that branch since our last fetch, which
 * is exactly the accident a force push tends to cause. `--force` is available
 * for the cases where overwriting really is intended.
 *
 * The remote sha before the push is journaled, so "Undo Last Operation" can put
 * the remote branch back.
 */
import type { RepoContext } from './context';
import type { ForcePushMode } from './config';
import { GecoError } from './errors';
import { shorten } from './safety';

export interface ForcePushOptions {
	/** Local branch to push (default: the checked out branch). */
	branch?: string;
	/** Remote to push to (default: the branch's upstream remote, else the first remote). */
	remote?: string;
	/** Branch name on the remote (default: same as the local branch). */
	remoteBranch?: string;
	mode?: ForcePushMode;
	dryRun?: boolean;
	/** Also push annotated tags reachable from the branch (`--follow-tags`). */
	tags?: boolean;
	/** Set the upstream configuration (`-u`). */
	setUpstream?: boolean;
}

export interface ForcePushResult {
	remote: string;
	branch: string;
	remoteBranch: string;
	refspec: string;
	mode: ForcePushMode;
	localSha: string;
	remoteShaBefore?: string;
	remoteShaAfter?: string;
	ahead: number;
	behind: number;
	createdRemoteBranch: boolean;
	dryRun: boolean;
	pushed: boolean;
	output: string;
	leaseRefused: boolean;
}

/** Everything needed to describe a push *before* doing it (used by the UI). */
export interface ForcePushPlan {
	remote: string;
	branch: string;
	remoteBranch: string;
	refspec: string;
	localSha: string;
	remoteShaBefore?: string;
	ahead: number;
	behind: number;
	createdRemoteBranch: boolean;
	/** The remote-tracking ref we would overwrite, when we know it. */
	upstreamRef?: string;
}

export async function planForcePush(ctx: RepoContext, options: ForcePushOptions = {}): Promise<ForcePushPlan> {
	const { git } = ctx;
	await git.requireRepository();

	const branch = options.branch ?? (await git.headBranch());
	if (!branch) {
		throw new GecoError('detached-head', 'HEAD is detached, so there is no branch to push.', 'Pass an explicit branch name to push one anyway.');
	}
	const localSha = await git.revParse(`refs/heads/${branch}`);
	if (!localSha) {
		throw new GecoError('ref-not-found', `Branch "${branch}" does not exist.`);
	}

	const remotes = await git.remotes();
	const upstream = await git.upstream(branch);
	const remote = options.remote ?? upstream?.remote ?? remotes[0];
	if (!remote) {
		throw new GecoError('no-remote', 'This repository has no remote to push to.', 'Add one with `git remote add origin <url>`.');
	}
	if (remotes.length > 0 && !remotes.includes(remote)) {
		throw new GecoError('no-remote', `Remote "${remote}" does not exist.`, `Known remotes: ${remotes.join(', ')}.`);
	}

	const remoteBranch = options.remoteBranch ?? upstream?.branch ?? branch;
	const remoteRef = `refs/remotes/${remote}/${remoteBranch}`;
	const remoteShaBefore = (await git.revParse(remoteRef)) ?? upstream?.sha;

	let ahead = 0;
	let behind = 0;
	if (remoteShaBefore && remoteShaBefore !== localSha) {
		const counts = await git.counts(remoteShaBefore, localSha);
		behind = counts.left;
		ahead = counts.right;
	}

	return {
		remote,
		branch,
		remoteBranch,
		refspec: `${branch}:refs/heads/${remoteBranch}`,
		localSha,
		remoteShaBefore,
		ahead,
		behind,
		createdRemoteBranch: !remoteShaBefore,
		upstreamRef: upstream ? `${upstream.remote}/${upstream.branch}` : undefined,
	};
}

export async function forcePush(ctx: RepoContext, options: ForcePushOptions = {}): Promise<ForcePushResult> {
	const { git, safety, settings } = ctx;
	const plan = await planForcePush(ctx, options);
	const { branch, remote, remoteBranch, refspec, localSha, ahead, behind, createdRemoteBranch } = plan;
	const remoteShaBefore = plan.remoteShaBefore;
	const remoteRef = `refs/remotes/${remote}/${remoteBranch}`;
	const mode: ForcePushMode = options.mode ?? settings.forcePushMode;
	const dryRun = options.dryRun === true;

	const args: string[] = [];
	if (!createdRemoteBranch) {
		if (mode === 'force') {
			args.push('--force');
		} else {
			args.push(`--force-with-lease=${remoteBranch}:${remoteShaBefore}`);
		}
	}
	if (dryRun) {
		args.push('--dry-run');
	}
	if (options.tags) {
		args.push('--follow-tags');
	}
	if (options.setUpstream) {
		args.push('-u');
	}
	args.push(remote, refspec);

	const result = await git.push(args);
	const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
	const leaseRefused = result.exitCode !== 0 && /stale info|--force-with-lease|denied \(non-fast-forward\)/i.test(output);

	if (result.exitCode !== 0) {
		throw new GecoError(
			dryRun ? 'git-failed' : leaseRefused ? 'rejected' : 'git-failed',
			leaseRefused
				? `Push to ${remote}/${remoteBranch} was refused: the remote branch changed since your last fetch.`
				: `Push to ${remote}/${remoteBranch} failed.`,
			[
				output,
				leaseRefused
					? 'Fetch and look at what landed on the remote first (`git fetch`), then force push again if overwriting it is really what you want.'
					: '',
			].filter(Boolean).join('\n'),
		);
	}

	const remoteShaAfter = dryRun ? remoteShaBefore : await git.revParse(remoteRef);

	if (!dryRun) {
		await safety.record({
			kind: 'forcePush',
			summary: `Force pushed ${branch} to ${remote}/${remoteBranch} (${mode})${remoteShaBefore ? `: ${shorten(remoteShaBefore)} -> ${shorten(localSha)}` : ': created the remote branch'}`,
			undo: remoteShaBefore
				? { type: 'remoteRef', remote, branch: remoteBranch, restoreTo: remoteShaBefore }
				: { type: 'none', hint: `${remote}/${remoteBranch} did not exist before this push. Delete it again with: git push ${remote} --delete ${remoteBranch}` },
		});
	}

	return {
		remote,
		branch,
		remoteBranch,
		refspec,
		mode,
		localSha,
		remoteShaBefore,
		remoteShaAfter,
		ahead,
		behind,
		createdRemoteBranch,
		dryRun,
		pushed: !dryRun,
		output,
		leaseRefused: false,
	};
}
