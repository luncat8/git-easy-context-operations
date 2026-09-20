/**
 * The visibility state machine: tolerant parsing, fail-open default state,
 * hidden-list round trips, the required-row rule, the submenu guard and the
 * unknown-id preservation. These are the acceptance criteria of
 * `0.3-plan-interactive-menu-editor.md` Phases 1-2 in test form.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
	EXPANDED_SUBMENUS,
	MENU_ROWS,
	submenuItemsKey,
	visibilityKey,
	menuRowById,
} from '../../core/menuCatalog';
import {
	canHide,
	contextKeysFor,
	hiddenRows,
	isHidden,
	parseHiddenItems,
	splitUnknownIds,
	summarizeState,
	surfaceCounts,
} from '../../core/menuVisibility';

describe('menu visibility - parsing', () => {
	it('accepts garbage without throwing and keeps unknown ids', () => {
		assert.deepEqual(parseHiddenItems(undefined), []);
		assert.deepEqual(parseHiddenItems(null), []);
		assert.deepEqual(parseHiddenItems('nope'), []);
		assert.deepEqual(parseHiddenItems({ a: 1 }), []);
		assert.deepEqual(parseHiddenItems([42, null, '  ', 'geco.refresh']), ['geco.refresh']);
		assert.deepEqual(parseHiddenItems(['b', 'a', 'b', 'a']), ['b', 'a'], 'dedupes, keeps first-seen order');
		assert.deepEqual(parseHiddenItems(['geco.futureCommand', 'geco.refresh']), ['geco.futureCommand', 'geco.refresh'], 'unknown ids are kept, not pruned');
	});
});

describe('menu visibility - default state (the no-op acceptance criterion)', () => {
	it('shows everything with the default (empty) hidden list', () => {
		const keys = contextKeysFor([]);
		for (const row of MENU_ROWS) {
			assert.equal(keys[visibilityKey(row.id)], true, `${row.id} must be visible by default`);
		}
		for (const submenuId of EXPANDED_SUBMENUS) {
			assert.equal(keys[submenuItemsKey(submenuId)], true, `${submenuId} has items by default`);
		}
	});

	it('never hides a required row, even with a hostile setting', () => {
		const keys = contextKeysFor(MENU_ROWS.filter((row) => !row.required).map((row) => row.id));
		for (const row of MENU_ROWS.filter((r) => r.required)) {
			assert.equal(keys[visibilityKey(row.id)], true, `${row.id} is required`);
		}
		// ...and the submenu guard stays true, because the required row inside
		// the submenu is still visible.
		assert.equal(keys[submenuItemsKey('geco.commitSubmenu')], true);
	});

	it('emits every fragment with value true by default (fail-open shape)', () => {
		const keys = contextKeysFor([]);
		assert.ok(Object.keys(keys).length >= MENU_ROWS.length, 'one key per row at least');
		assert.ok(Object.values(keys).every((value) => value === true));
	});
});

describe('menu visibility - toggling', () => {
	it('flips exactly the hidden row and leaves the others alone', () => {
		const keys = contextKeysFor(['geco.forcePushHard', 'geco.refresh']);
		assert.equal(keys[visibilityKey('geco.forcePushHard')], false);
		assert.equal(keys[visibilityKey('geco.refresh')], false);
		assert.equal(keys[visibilityKey('geco.forcePush')], true);
		assert.equal(keys[visibilityKey('geco.customizeMenus')], true);
	});

	it('keeps the submenu parent visible while any row inside is visible', () => {
		const commitRows = MENU_ROWS.filter((row) => row.surfaces.includes('submenu.commit') && !row.required);
		const almostAll = commitRows.slice(1).map((row) => row.id);
		assert.equal(contextKeysFor(almostAll)[submenuItemsKey('geco.commitSubmenu')], true, 'rows left');
		// Hiding every toggleable row still leaves the required entry, so the
		// parent legitimately stays (a parent never opens an empty menu).
		assert.equal(contextKeysFor(commitRows.map((row) => row.id))[submenuItemsKey('geco.commitSubmenu')], true);
	});

	it('hides a submenu parent that would open empty (proved on a synthetic submenu)', () => {
		const synthetic = [
			{ id: 'x.a', label: 'A', surfaces: ['submenu.commit' as const] },
			{ id: 'x.b', label: 'B', surfaces: ['submenu.commit' as const] },
			{ id: 'x.c', label: 'C', surfaces: ['view.title' as const] },
		];
		assert.equal(contextKeysFor(['x.a', 'x.b'], synthetic)[submenuItemsKey('geco.commitSubmenu')], false, 'everything inside is hidden');
		assert.equal(contextKeysFor(['x.a'], synthetic)[submenuItemsKey('geco.commitSubmenu')], true, 'one row left');
		// The keys are only computed for the submenus the manifest actually opens.
		assert.equal(submenuItemsKey('geco.commitSubmenu') in contextKeysFor([], synthetic), true);
	});

	it('round-trips through the setting and back', () => {
		const saved = parseHiddenItems(['geco.squashSelectedCommits']);
		assert.equal(isHidden(saved, menuRowById('geco.squashSelectedCommits')!), true);
		assert.equal(isHidden(saved, menuRowById('geco.rewordCommit')!), false);
		assert.deepEqual(hiddenRows(saved).map((row) => row.id), ['geco.squashSelectedCommits']);
	});
});

describe('menu visibility - canHide', () => {
	it('refuses required rows and allows everything else', () => {
		for (const row of MENU_ROWS) {
			assert.equal(canHide(row), !row.required, `${row.id}: canHide=${canHide(row)}`);
		}
	});

	it('hides a row on every surface it appears on with one id', () => {
		const hidden = ['geco.cleanHistory'];
		for (const surfaceId of menuRowById('geco.cleanHistory')!.surfaces) {
			const counts = surfaceCounts(hidden, surfaceId);
			assert.equal(counts.visible, counts.total - 1, `${surfaceId}: one item less`);
		}
	});
});

describe('menu visibility - unknown ids and summaries', () => {
	it('splits known from unknown and keeps the unknown for the next version', () => {
		const { known, unknown } = splitUnknownIds(['geco.refresh', 'geco.somethingFromV4', 'geco.rewordCommit']);
		assert.deepEqual(known, ['geco.refresh', 'geco.rewordCommit']);
		assert.deepEqual(unknown, ['geco.somethingFromV4']);
	});

	it('summarizes the state in one line', () => {
		assert.match(summarizeState([]), /^0 of \d+ menu items hidden$/);
		assert.match(summarizeState(['geco.refresh', 'geco.fromTheFuture']), /1 of \d+ menu items hidden/);
		assert.match(summarizeState(['geco.refresh', 'geco.fromTheFuture']), /1 saved id unknown to this version \(kept\)/);
	});
});
