/**
 * Error types shared by every operation.
 *
 * Every failure a human can act on is reported as a {@link GecoError} with a
 * stable `code` (so the UI layer can react) plus a short `message` and an
 * optional `detail` block with the raw git output.
 */

export type GecoErrorCode =
	| 'not-a-repository'
	| 'git-not-found'
	| 'commit-not-found'
	| 'ref-not-found'
	| 'detached-head'
	| 'commit-not-on-branch'
	| 'dirty-worktree'
	| 'not-fast-forward'
	| 'no-remote'
	| 'ref-exists'
	| 'nothing-to-do'
	| 'conflict'
	| 'rejected'
	| 'unsupported'
	| 'cancelled'
	| 'git-failed';

export class GecoError extends Error {
	public readonly code: GecoErrorCode;
	public readonly detail?: string;

	constructor(code: GecoErrorCode, message: string, detail?: string) {
		super(message);
		this.name = 'GecoError';
		this.code = code;
		this.detail = detail;
	}

	/** Message plus git's own output, ready to be shown to a human. */
	get userMessage(): string {
		if (!this.detail) {
			return this.message;
		}
		return `${this.message}\n${this.detail}`;
	}
}

export function isGecoError(value: unknown): value is GecoError {
	return value instanceof GecoError ||
		(!!value && typeof value === 'object' && (value as { name?: string }).name === 'GecoError');
}

/** Turn anything thrown into a readable one-liner. */
export function toErrorMessage(error: unknown): string {
	if (isGecoError(error)) {
		return error.userMessage;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

export class CancelledError extends GecoError {
	constructor(message = 'Cancelled.') {
		super('cancelled', message);
	}
}
