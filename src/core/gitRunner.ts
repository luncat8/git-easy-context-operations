/**
 * The only place in the extension that actually talks to the `git` binary.
 *
 * Everything is spawned as an argument array (never through a shell), so commit
 * messages, branch names and patch contents cannot inject commands.
 */
import { spawn } from 'child_process';

export interface GitExecOptions {
	cwd: string;
	/** Extra environment variables. `undefined` removes an inherited variable. */
	env?: Record<string, string | undefined>;
	/** Written to the child's stdin (used for patch content and commit messages). */
	input?: string;
	timeoutMs?: number;
	/** Refuse to buffer more than this many bytes per stream. */
	maxOutputBytes?: number;
}

export interface GitExecResult {
	readonly args: readonly string[];
	readonly cwd: string;
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly truncated: boolean;
}

export type GitExec = (args: readonly string[], options: GitExecOptions) => Promise<GitExecResult>;

/** 5 minutes: long enough for a big push, short enough to not hang forever. */
export const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Environment every git invocation gets:
 * - `GIT_TERMINAL_PROMPT=0` never block on a credential prompt we cannot show.
 * - `GIT_OPTIONAL_LOCKS=0` do not take index locks for read-only queries.
 * - `LC_ALL=C` keep git's own messages parseable and identical everywhere.
 */
export const GIT_BASE_ENV: Readonly<Record<string, string>> = {
	GIT_TERMINAL_PROMPT: '0',
	GIT_OPTIONAL_LOCKS: '0',
	LC_ALL: 'C',
};

export interface SpawnLike {
	(command: string, args: readonly string[], options: Record<string, unknown>): SpawnedProcess;
}

export interface SpawnedProcess {
	stdout: EventSource | null;
	stderr: EventSource | null;
	stdin: { write(chunk: string): boolean; end(): void } | null;
	on(event: 'error', listener: (err: Error) => void): void;
	on(event: 'close', listener: (code: number | null) => void): void;
	kill(signal?: string): void;
}

interface EventSource {
	on(event: 'data', listener: (chunk: Buffer | string) => void): void;
}

export interface CreateGitExecOptions {
	gitPath?: string;
	/** Injectable for tests - defaults to `child_process.spawn`. */
	spawnImpl?: SpawnLike;
	baseEnv?: Record<string, string | undefined>;
}

export function createGitExec(options: CreateGitExecOptions = {}): GitExec {
	const gitPath = options.gitPath && options.gitPath.trim().length > 0 ? options.gitPath : 'git';
	const spawnImpl: SpawnLike = options.spawnImpl ?? (spawn as unknown as SpawnLike);
	const baseEnv = options.baseEnv ?? (process.env as Record<string, string | undefined>);

	return async (args, execOptions) => {
		// The git binary is prepended here: `GitExec` receives pure git args.
		return runSpawned(spawnImpl, gitPath, args, execOptions, baseEnv);
	};
}

/**
 * A runner for *arbitrary* processes - `git-filter-repo`, `pip3`, `brew`, ...
 * Unlike {@link createGitExec} (which always spawns the git binary and
 * therefore receives pure git args), `args[0]` is the binary to start.
 */
export function createProcessExec(options: CreateGitExecOptions = {}): GitExec {
	const spawnImpl: SpawnLike = options.spawnImpl ?? (spawn as unknown as SpawnLike);
	const baseEnv = options.baseEnv ?? (process.env as Record<string, string | undefined>);

	return async (args, execOptions) => {
		const [binary, ...rest] = args;
		if (!binary) {
			return {
				args,
				cwd: execOptions.cwd,
				exitCode: 127,
				stdout: '',
				stderr: 'no command given',
				timedOut: false,
				truncated: false,
			};
		}
		return runSpawned(spawnImpl, binary, rest, execOptions, baseEnv);
	};
}

/** Shared spawn/collect plumbing for both runners. */
function runSpawned(
	spawnImpl: SpawnLike,
	binary: string,
	args: readonly string[],
	execOptions: GitExecOptions,
	baseEnv: Record<string, string | undefined>,
): Promise<GitExecResult> {
		const env: Record<string, string | undefined> = { ...baseEnv, ...GIT_BASE_ENV };
		if (execOptions.env) {
			for (const [key, value] of Object.entries(execOptions.env)) {
				env[key] = value;
			}
		}

		const timeoutMs = execOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const maxOutputBytes = execOptions.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

		return new Promise<GitExecResult>((resolve) => {
			const stdoutChunks: Buffer[] = [];
			const stderrChunks: Buffer[] = [];
			let truncated = false;
			let timedOut = false;
			let settled = false;

			const child = spawnImpl(binary, args, {
				cwd: execOptions.cwd,
				env,
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
			});

			const timer = timeoutMs > 0
				? setTimeout(() => {
					timedOut = true;
					try { child.kill('SIGKILL'); } catch { /* already gone */ }
				}, timeoutMs)
				: undefined;

			const finish = (exitCode: number) => {
				if (settled) {
					return;
				}
				settled = true;
				if (timer) {
					clearTimeout(timer);
				}
				resolve({
					args,
					cwd: execOptions.cwd,
					exitCode,
					stdout: Buffer.concat(stdoutChunks).toString('utf8'),
					stderr: Buffer.concat(stderrChunks).toString('utf8'),
					timedOut,
					truncated,
				});
			};

			const collect = (source: EventSource | null, into: Buffer[]) => {
				if (!source) {
					return;
				}
				source.on('data', (chunk) => {
					const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
					if (buffer.length > maxOutputBytes) {
						truncated = true;
						into.push(buffer.subarray(0, maxOutputBytes));
						return;
					}
					into.push(buffer);
				});
			};

			collect(child.stdout, stdoutChunks);
			collect(child.stderr, stderrChunks);

			child.on('error', (err: Error) => {
				// ENOENT == git binary not found / not executable.
				stderrChunks.push(Buffer.from(`${err.message}\n`, 'utf8'));
				finish(err.message.includes('ENOENT') ? 127 : 1);
			});
			child.on('close', (code) => finish(code ?? -1));

			if (execOptions.input !== undefined && child.stdin) {
				try {
					child.stdin.write(execOptions.input);
					child.stdin.end();
				} catch {
					// stdin already closed - git will just see an empty message.
				}
			} else if (child.stdin) {
				try { child.stdin.end(); } catch { /* ignore */ }
			}
		});
}
