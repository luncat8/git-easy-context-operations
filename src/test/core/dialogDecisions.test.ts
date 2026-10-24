/**
 * Saved dialog decisions: the registry, the tolerant store and the wired
 * confirmations. The flow tests drive the controller against real
 * repositories, exactly like the other controller suites — with the mode
 * on, one decision must skip exactly one question, and nothing else.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_SETTINGS, type Settings } from '../../core/config';
import { Controller } from '../../core/controller';
import {
	DIALOG_DECISIONS,
	InMemoryDialogDecisionStore,
	countDecisionRepositories,
	dialogDecisionById,
	dialogDecisionRows,
	isEligibleDecision,
	normalizeRepoKey,
	parseDialogDecisions,
	savedDecision,
	savedDecisionIds,
	serializeDialogDecisions,
	withSavedDecision,
	withoutSavedDecision,
	type DialogDecisionMemory,
} from '../../core/dialogDecisions';
import { createLinearRepo } from '../helpers/tempRepo';
import { FakeUI } from '../helpers/fakeUi';

const ON: Settings = { ...DEFAULT_SETTINGS, rememberDialogDecisions: true };
const repoA = '/repos/alpha';
const repoB = '/repos/beta';

describe('dialog decisions - registry', () => {
	it('has unique stable ids, an answer for eligible rows and a reason for the rest', () => {
		const ids = DIALOG_DECISIONS.map((def) => def.id);
		assert.equal(new Set(ids).size, ids.length);
		for (const def of DIALOG_DECISIONS) {
			assert.ok(def.policyVersion >= 1, `${def.id} has no policy version`);
			assert.ok(def.action.length > 0 && def.question.length > 0, `${def.id} is not described`);
			if (def.kind === 'eligible') {
				assert.ok(def.confirmLabel, `${def.id} is eligible without an affirmative label`);
			} else {
				assert.ok(def.ineligibleReason && def.ineligibleReason.length > 20, `${def.id} gives no reason`);
			}
		}
	});

	it('keeps force push with lease and hard --force as separate decisions', () => {
		assert.equal(isEligibleDecision('forcePush.lease'), true);
		assert.equal(isEligibleDecision('forcePush.force'), true);
		assert.notEqual(dialogDecisionById('forcePush.lease'), dialogDecisionById('forcePush.force'));
	});

	it('keeps deleting locally and deleting everywhere as separate decisions', () => {
		assert.equal(isEligibleDecision('branch.deleteLocal'), true);
		assert.equal(isEligibleDecision('branch.deleteEverywhere'), true);
	});

	it('never makes Undo, the lock file or a failed bundle rememberable', () => {
		for (const id of ['undo.confirm', 'pushSync.removeLock', 'cleanHistory.rewriteWithoutBundle'] as const) {
			assert.equal(dialogDecisionById(id)?.kind, 'ineligible', `${id} must stay interactive`);
			assert.equal(isEligibleDecision(id), false);
		}
	});

	it('wires every eligible id into the controller and no ineligible one', () => {
		const source = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'src', 'core', 'controller.ts'), 'utf8');
		for (const def of DIALOG_DECISIONS) {
			if (def.kind === 'eligible') {
				assert.ok(source.includes(`'${def.id}'`), `${def.id} is eligible but never asked through confirmDecision`);
			} else {
				const wired = new RegExp(`confirmDecision\\([\\s\\S]{0,80}'${def.id.replace(/\./g, '\\.')}'`).test(source);
				assert.equal(wired, false, `${def.id} must not be wired as a saved decision`);
			}
		}
	});
});

describe('dialog decisions - store shape', () => {
	it('round-trips a saved answer and isolates repositories', () => {
		let raw: unknown = serializeDialogDecisions({});
		raw = withSavedDecision(raw, repoA, 'forcePush.lease');
		assert.equal(savedDecision(raw, repoA, 'forcePush.lease'), 'yes');
		assert.equal(savedDecision(raw, repoB, 'forcePush.lease'), undefined, 'another repository inherits nothing');
		assert.equal(savedDecision(raw, repoA, 'forcePush.force'), undefined, 'lease approval never approves hard force');
		assert.deepEqual(savedDecisionIds(raw, repoA), ['forcePush.lease']);
		assert.equal(countDecisionRepositories(raw), 1);
		raw = withoutSavedDecision(raw, repoA, 'forcePush.lease');
		assert.equal(savedDecision(raw, repoA, 'forcePush.lease'), undefined, 'reset returns to Default');
		assert.equal(countDecisionRepositories(raw), 0);
	});

	it('normalises repository keys so the same repo maps to one scope', () => {
		assert.equal(normalizeRepoKey('/repos/alpha/'), '/repos/alpha');
		assert.equal(normalizeRepoKey('\\\\repos\\\\alpha\\\\'), '/repos/alpha');
		const raw = withSavedDecision(serializeDialogDecisions({}), `${repoA}/`, 'squash.confirm');
		assert.equal(savedDecision(raw, repoA, 'squash.confirm'), 'yes');
	});

	it('treats unknown ids, unknown answers, stale policies and junk as unset', () => {
		const junk: unknown[] = [undefined, null, 42, 'yes', [], { version: 99, byRepo: {} }, { byRepo: {} }];
		for (const value of junk) {
			assert.deepEqual(parseDialogDecisions(value), {});
		}
		const raw = {
			version: 1,
			byRepo: {
				[repoA]: {
					'forcePush.lease': { answer: 'yes', policyVersion: 1 },
					'forcePush.force': { answer: 'always', policyVersion: 1 },
					'undo.confirm': { answer: 'yes', policyVersion: 1 },
					'reword.rename': { answer: 'yes', policyVersion: 999 },
					'made.up': { answer: 'yes', policyVersion: 1 },
				},
			},
		};
		assert.deepEqual(savedDecisionIds(raw, repoA), ['forcePush.lease']);
	});

	it('never saves for an empty repository identity or an ineligible id', () => {
		const raw = withSavedDecision(withSavedDecision(serializeDialogDecisions({}), '', 'forcePush.lease'), repoA, 'undo.confirm');
		assert.deepEqual(parseDialogDecisions(raw), {});
		assert.equal(savedDecision(raw, '', 'forcePush.lease'), undefined);
	});

	it('describes rows as Default, Enabled, inactive and not eligible', () => {
		const raw = withSavedDecision(serializeDialogDecisions({}), repoA, 'forcePush.lease');
		const on = dialogDecisionRows(raw, repoA, true);
		assert.equal(on.find((row) => row.def.id === 'forcePush.lease')?.state, 'enabled');
		assert.match(on.find((row) => row.def.id === 'forcePush.lease')?.stateLabel ?? '', /Enabled — always/);
		assert.equal(on.find((row) => row.def.id === 'forcePush.force')?.state, 'default');
		assert.equal(on.find((row) => row.def.id === 'undo.confirm')?.state, 'ineligible');
		const off = dialogDecisionRows(raw, repoA, false);
		assert.equal(off.find((row) => row.def.id === 'forcePush.lease')?.state, 'inactive', 'a saved answer with the mode off is kept but inactive');
	});
});

describe('dialog decisions - controller flows', () => {
	it('offers "(always)" only as the second button, saves it, then skips only that question', async () => {
		const { repo } = await createLinearRepo();
		try {
			const store = new InMemoryDialogDecisionStore();
			const ui = new FakeUI({ inputs: ['renamed once'], choices: ['always'] });
			const controller = new Controller({ ui, settings: ON, exec: repo.exec, dialogDecisions: store });
			const tip = await repo.sha('main');
			await controller.rewordCommit(repo.dir, [tip], 'replace');

			assert.equal(ui.chooseCalls.length, 1);
			assert.deepEqual(
				ui.chooseCalls[0]!.options.choices.map((choice) => choice.label),
				['Rename', 'Rename (always)', 'Cancel'],
				'the ordinary action stays first, enrolling is explicit',
			);
			assert.equal(ui.chooseCalls[0]!.options.choices[0]!.primary, true, 'Enter uses the ordinary action');
			assert.equal(store.get(repo.dir, 'reword.rename'), 'yes');
			assert.equal((await repo.message('main')).trim(), 'renamed once');

			// The next rename of the same repository asks nothing at all.
			const second = new FakeUI({ inputs: ['renamed twice'] });
			const tip2 = await repo.sha('main');
			await new Controller({ ui: second, settings: ON, exec: repo.exec, dialogDecisions: store })
				.rewordCommit(repo.dir, [tip2], 'replace');
			assert.equal(second.chooseCalls.length + second.confirmCalls.length, 0, 'the saved question is skipped');
			assert.equal((await repo.message('main')).trim(), 'renamed twice');
			// …but the decision belongs to this repository, not to any other.
			assert.equal(store.get('/somewhere/else', 'reword.rename'), undefined);
		} finally {
			repo.cleanup();
		}
	});

	it('never saves a one-time answer, a cancel or a dismissal', async () => {
		const { repo } = await createLinearRepo();
		try {
			for (const choices of [['once'], [null], ['cancel']] as const) {
				const store = new InMemoryDialogDecisionStore();
				const ui = new FakeUI({ inputs: ['maybe'], choices: [...choices] as (string | null)[] });
				const tip = await repo.sha('main');
				const before = (await repo.message('main')).trim();
				await new Controller({ ui, settings: ON, exec: repo.exec, dialogDecisions: store })
					.rewordCommit(repo.dir, [tip], 'replace');
				assert.equal(store.get(repo.dir, 'reword.rename'), undefined, `choices=${JSON.stringify(choices)} saved something`);
				if (choices[0] === 'once') {
					assert.equal((await repo.message('main')).trim(), 'maybe');
				} else {
					assert.equal((await repo.message('main')).trim(), before, 'a cancelled rename changed nothing');
				}
			}
		} finally {
			repo.cleanup();
		}
	});

	it('ignores stored answers while the master switch is off, and resumes them when it returns', async () => {
		const { repo } = await createLinearRepo();
		try {
			const store = new InMemoryDialogDecisionStore();
			store.save(repo.dir, 'reword.rename');
			const ui = new FakeUI({ inputs: ['should not happen'], confirms: [false] });
			const tip = await repo.sha('main');
			await new Controller({ ui, settings: DEFAULT_SETTINGS, exec: repo.exec, dialogDecisions: store })
				.rewordCommit(repo.dir, [tip], 'replace');
			assert.equal(ui.chooseCalls.length, 0, 'no "(always)" offer while the mode is off');
			assert.equal(ui.confirmCalls.length, 1, 'the ordinary confirmation is asked while the mode is off');
			assert.notEqual((await repo.message('main')).trim(), 'should not happen');

			await store.reset(repo.dir, 'reword.rename');
			assert.equal(store.get(repo.dir, 'reword.rename'), undefined, 'per-row reset restores Default even while inactive');
		} finally {
			repo.cleanup();
		}
	});

	it('falls back to asking when reading fails, and keeps the one-time answer when saving fails', async () => {
		const { repo } = await createLinearRepo();
		try {
			const broken: DialogDecisionMemory = {
				get: () => { throw new Error('store exploded'); },
				save: () => { throw new Error('store exploded'); },
				reset: () => undefined,
				clearAll: () => undefined,
			};
			const ui = new FakeUI({ inputs: ['asked anyway'], confirms: [true] });
			const tip = await repo.sha('main');
			await new Controller({ ui, settings: ON, exec: repo.exec, dialogDecisions: broken })
				.rewordCommit(repo.dir, [tip], 'replace');
			assert.equal(ui.confirmCalls.length, 1, 'a broken store asks normally');
			assert.equal((await repo.message('main')).trim(), 'asked anyway');

			const writeBroken: DialogDecisionMemory = {
				get: () => undefined,
				save: () => { throw new Error('disk full'); },
				reset: () => undefined,
				clearAll: () => undefined,
			};
			const second = new FakeUI({ inputs: ['one time only'], choices: ['always'] });
			const tip2 = await repo.sha('main');
			await new Controller({ ui: second, settings: ON, exec: repo.exec, dialogDecisions: writeBroken })
				.rewordCommit(repo.dir, [tip2], 'replace');
			assert.equal((await repo.message('main')).trim(), 'one time only', 'the explicit one-time action still runs');
			assert.match(second.allLogs(), /could not be saved|saving .* failed/i);
		} finally {
			repo.cleanup();
		}
	});

	it('a saved lease decision never authorizes a hard force push', async () => {
		const { repo } = await createLinearRepo();
		let remoteDir = '';
		try {
			remoteDir = await repo.addBareRemote('origin', ['main']);
			const store = new InMemoryDialogDecisionStore();
			store.save(repo.dir, 'forcePush.lease');

			const leaseUi = new FakeUI({});
			await new Controller({ ui: leaseUi, settings: ON, exec: repo.exec, dialogDecisions: store })
				.forcePush(repo.dir, []);
			assert.equal(leaseUi.chooseCalls.length + leaseUi.confirmCalls.length, 0, 'the saved lease question is skipped');

			const hardUi = new FakeUI({ choices: ['once'] });
			await new Controller({ ui: hardUi, settings: ON, exec: repo.exec, dialogDecisions: store })
				.forcePush(repo.dir, [], 'force');
			assert.equal(hardUi.chooseCalls.length, 1, 'hard --force still asks');
			assert.equal(store.get(repo.dir, 'forcePush.force'), undefined, 'a one-time hard push saved nothing');
			assert.ok(remoteDir.length > 0);
		} finally {
			repo.cleanup();
		}
	});

	it('a saved "Move" decision never authorizes a forced move of a diverged branch', async () => {
		const { repo } = await createLinearRepo();
		try {
			// Diverge: main has a commit that the feature tip does not have.
			await repo.gitOk(['checkout', '--quiet', '-b', 'feature', await repo.sha('main')]);
			const featureSha = await repo.commit('feature work', { 'feature.txt': 'f\n' });
			await repo.checkout('main');
			await repo.commit('main moved on too', { 'main.txt': 'm\n' });

			const store = new InMemoryDialogDecisionStore();
			store.save(repo.dir, 'fastForward.move');

			// The saved "Move" skips its own dialog - but the branch is
			// diverged, so the force question keeps its own gate instead of
			// riding on the saved plain-move approval.
			const ui = new FakeUI();
			await new Controller({ ui, settings: ON, exec: repo.exec, dialogDecisions: store })
				.fastForward(repo.dir, [featureSha], { askBranch: false });

			assert.equal(ui.confirmCalls.length, 0, 'no two-button dialog at all');
			assert.equal(ui.chooseCalls.length, 1, `exactly one question left: ${ui.transcript}`);
			assert.match(ui.chooseCalls[0]!.message, /has commits that .* does not\. Move it anyway\?/);
			assert.match(ui.allLogs(), /Saved decision.*skipping its confirmation/);
			assert.equal(await repo.sha('main'), featureSha, 'the confirmed forced move ran');
			assert.equal(store.get(repo.dir, 'fastForward.moveAnyway'), undefined, 'the one-time answer saved nothing');
		} finally {
			repo.cleanup();
		}
	});

	it('Undo still asks even with the mode on and other decisions saved', async () => {
		const { repo } = await createLinearRepo();
		try {
			const store = new InMemoryDialogDecisionStore();
			store.save(repo.dir, 'reword.rename');
			const ui = new FakeUI({ inputs: ['to be undone'] });
			const controller = new Controller({ ui, settings: ON, exec: repo.exec, dialogDecisions: store });
			const tip = await repo.sha('main');
			await controller.rewordCommit(repo.dir, [tip], 'replace');
			assert.equal((await repo.message('main')).trim(), 'to be undone');

			const undoUi = new FakeUI({ confirms: [true] });
			await new Controller({ ui: undoUi, settings: ON, exec: repo.exec, dialogDecisions: store })
				.undoLastOperation(repo.dir);
			assert.equal(undoUi.chooseCalls.length, 0, 'Undo never offers "(always)"');
			assert.equal(undoUi.confirmCalls.length, 1, 'Undo still asks its own question');
			assert.notEqual((await repo.message('main')).trim(), 'to be undone', 'the confirmed Undo ran');
		} finally {
			repo.cleanup();
		}
	});
});
