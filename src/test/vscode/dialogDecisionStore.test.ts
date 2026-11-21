/**
 * The scope-aware decision store: with `global` scope one saved answer is
 * shared by every repository (and any repository path resolves to the single
 * global key); with `perRepository` the buckets stay separate. The store only
 * imports `vscode` as a type, so a tiny fake Memento is enough to exercise it.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type * as vscode from 'vscode';
import {
	DIALOG_DECISIONS_STATE_KEY,
	GLOBAL_DECISION_KEY,
	decisionRepoKey,
	parseDialogDecisions,
	type DialogDecisionId,
	type StorageScope,
} from '../../core/dialogDecisions';
import { WorkspaceDialogDecisionStore } from '../../vscode/dialogDecisionStore';

const repoA = '/repos/alpha';
const repoB = '/repos/beta';
const decision: DialogDecisionId = 'reword.rename';

class FakeMemento implements vscode.Memento {
	private readonly store = new Map<string, unknown>();
	get<T>(key: string, defaultValue?: T): T {
		return (this.store.has(key) ? this.store.get(key) : defaultValue) as T;
	}
	async update(key: string, value: unknown): Promise<void> {
		this.store.set(key, value);
	}
	keys(): readonly string[] {
		return [...this.store.keys()];
	}
}

const stored = (memento: FakeMemento) => parseDialogDecisions(memento.get(DIALOG_DECISIONS_STATE_KEY));
const make = (scope: StorageScope) => new WorkspaceDialogDecisionStore(new FakeMemento(), () => scope);

describe('dialog decision store - scope', () => {
	it('decisionRepoKey maps global scope to the shared key, regardless of repository', () => {
		assert.equal(decisionRepoKey(repoA, 'global'), GLOBAL_DECISION_KEY);
		assert.equal(decisionRepoKey(repoB, 'global'), GLOBAL_DECISION_KEY);
		// A per-repository key is the canonical repository path, never the global one.
		assert.notEqual(decisionRepoKey(repoA, 'perRepository'), GLOBAL_DECISION_KEY);
	});

	it('global scope shares one answer across repositories', async () => {
		const store = make('global');
		assert.equal(await store.get(repoA, decision), undefined);
		await store.save(repoA, decision);
		// Saved on repoA, read back from repoB (and a third path): all "yes".
		assert.equal(await store.get(repoA, decision), 'yes');
		assert.equal(await store.get(repoB, decision), 'yes');
		// The single stored bucket is the global key.
		assert.deepEqual(Object.keys(stored((store as unknown as { state: FakeMemento }).state)), [GLOBAL_DECISION_KEY]);
	});

	it('perRepository scope keeps repositories separate', async () => {
		const store = make('perRepository');
		await store.save(repoA, decision);
		assert.equal(await store.get(repoA, decision), 'yes');
		assert.equal(await store.get(repoB, decision), undefined);
	});

	it('reset and clearAll honour the active scope', async () => {
		const store = make('global');
		await store.save(repoA, decision);
		await store.reset(repoA, decision);
		assert.equal(await store.get(repoA, decision), undefined);
		assert.equal(await store.get(repoB, decision), undefined);
		await store.save(repoA, decision);
		await store.clearAll();
		assert.deepEqual(stored((store as unknown as { state: FakeMemento }).state), {});
	});

	it('changing scope isolates the buckets (global answers are not reused per-repo)', async () => {
		const memento = new FakeMemento();
		let scope: StorageScope = 'global';
		const store = new WorkspaceDialogDecisionStore(memento, () => scope);
		await store.save(repoA, decision);
		// Flip to per-repository: the previously global answer is not visible under repoA.
		scope = 'perRepository';
		assert.equal(await store.get(repoA, decision), undefined);
		// And the global bucket is still physically present, just unscoped.
		assert.equal(stored(memento)[GLOBAL_DECISION_KEY]?.[decision]?.answer, 'yes');
	});
});
