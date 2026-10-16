/**
 * The one UI rule that had a bug of its own: a *message* must never be waited
 * for.
 *
 * VS Code resolves `showInformationMessage` (and the warning/error siblings)
 * only when the notification goes away - 10 s for an info toast, and never
 * while the mouse hovers it or the window is unfocused. The command that
 * showed it stays pending for all of that, and in the built-in Source Control
 * Graph a pending command *is* a progress bar (VS Code wraps every action of
 * that view in `withProgress`). That is what made "Copy Repository Web Link"
 * spin the graph after the link was already on the clipboard.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { followUpWithoutWaiting, reportWithoutWaiting } from '../../core/ui';

/** Long enough for a stray rejection/tick to surface, short enough to not slow the suite. */
function tick(ms = 10): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolves to the value, or rejects after `ms` - so a regression that *does*
 * wait for the notification fails the test instead of hanging the suite.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

describe('reportWithoutWaiting', () => {
	it('does not hold the caller back while the notification is still on screen', async () => {
		let shown = 0;
		const command = (async () => {
			// Exactly what the VS Code adapter does: hand the toast over and
			// carry on. The promise never settles - that is a notification
			// nobody dismissed, which is the normal case, not an error.
			reportWithoutWaiting(() => {
				shown += 1;
				return new Promise<never>(() => undefined);
			});
			return 'done';
		})();

		assert.equal(await withDeadline(command, 1000, 'a command that reported a message'), 'done');
		assert.equal(shown, 1, 'the message was handed to the UI');
	});

	it('swallows a notification that cannot be shown', async () => {
		// A rejected `showInformationMessage` must not turn into an unhandled
		// rejection in the extension host (node:test fails the run on one).
		reportWithoutWaiting(() => Promise.reject(new Error('no notification service')));
		reportWithoutWaiting(() => Promise.reject('not even an Error'));
		await tick();
	});

	it('survives a UI that throws synchronously and one that returns nothing', async () => {
		assert.doesNotThrow(() => reportWithoutWaiting(() => {
			throw new Error('the editor is gone');
		}));
		assert.doesNotThrow(() => reportWithoutWaiting(() => undefined));
		await tick();
	});

	it('accepts a thenable that is not a real promise', async () => {
		// VS Code's `Thenable` is not guaranteed to be a native promise; the
		// rejection of one must be swallowed the same way.
		let askedForAHandler = false;
		const thenable = {
			then(_onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
				askedForAHandler = true;
				onRejected?.(new Error('the toast could not be created'));
			},
		} as unknown as PromiseLike<unknown>;
		reportWithoutWaiting(() => thenable);
		// `Promise.resolve(thenable)` calls `then` in a microtask.
		await tick();
		assert.equal(askedForAHandler, true);
	});
});

describe('followUpWithoutWaiting', () => {
	it('does not hold the caller back, and runs the follow-up when the answer eventually arrives', async () => {
		let answer: (chosen: string | undefined) => void = () => undefined;
		const notification = new Promise<string | undefined>((resolve) => {
			answer = resolve;
		});
		const handled: (string | undefined)[] = [];

		const command = (async () => {
			// Exactly what the patch report does: hand the toast (with its
			// Undo button) over and finish the command around it.
			followUpWithoutWaiting(notification, (chosen) => {
				handled.push(chosen);
			});
			return 'done';
		})();

		assert.equal(await withDeadline(command, 1000, 'a command that reported its result with follow-up actions'), 'done');
		assert.deepEqual(handled, [], 'no follow-up runs before the user picks one');

		answer('Undo');
		await tick();
		assert.deepEqual(handled, ['Undo'], 'the follow-up runs when the button is eventually clicked');
	});

	it('reports a failing follow-up instead of leaking an unhandled rejection', async () => {
		const errors: unknown[] = [];
		followUpWithoutWaiting(
			Promise.resolve('Undo'),
			() => {
				throw new Error('the undo blew up');
			},
			(error) => errors.push(error),
		);
		followUpWithoutWaiting(
			Promise.reject(new Error('the toast could not be created')),
			() => undefined,
			(error) => errors.push(error),
		);
		await tick();
		assert.equal(errors.length, 2);
	});
});
