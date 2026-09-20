/**
 * The drift test for "Customize Context Menus": the row catalogue,
 * `package.json` and `scripts/apply-graph-menu.mjs` must describe the exact
 * same menus - in both directions. A menu entry without a visibility fragment
 * can never be hidden; a catalogue row without a manifest entry hides a menu
 * that does not exist. Either direction fails here with the exact offender.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	MENU_ROWS,
	MENU_SURFACES,
	visibilityFragment,
	submenuItemsFragment,
	type MenuSurfaceId,
} from '../../core/menuCatalog';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
	contributes: {
		commands: { command: string; title: string; category: string; icon: string }[];
		submenus: { id: string; label: string }[];
		menus: Record<string, { command?: string; submenu?: string; when?: string; group?: string }[]>;
	};
};
const graphScript = fs.readFileSync(path.join(ROOT, 'scripts', 'apply-graph-menu.mjs'), 'utf8');

interface MenuEntry {
	command?: string;
	submenu?: string;
	when?: string;
	group?: string;
}

/** Whether the entry carries this row's visibility fragment. */
function hasVisibilityFragment(entry: MenuEntry, rowId: string): boolean {
	return (entry.when ?? '').includes(visibilityFragment(rowId));
}

/**
 * The menu entries one surface has, from the source of truth that contributes
 * them: the default manifest - or, for the proposed-API graph menus, the
 * patcher script (they only exist in the +graph build).
 */
function entriesForSurface(surfaceId: MenuSurfaceId): MenuEntry[] {
	const surface = MENU_SURFACES.find((s) => s.id === surfaceId)!;
	const all: (MenuEntry & { key?: string })[] = surface.graphOnly
		? graphEntries().map((entry) => ({ ...entry }))
		: manifest.contributes.menus[surface.menuKey] ?? [];
	// A key that is exactly one surface of ours (a submenu id) needs no matcher.
	const needsMatcher = Boolean(surface.viewItem || surface.viewItemEquals || surface.view || surface.expands);
	if (!needsMatcher) {
		return all;
	}
	return all.filter((entry) => surfaceOfEntry(entry) === surfaceId);
}

/**
 * Which catalogue surface a manifest entry belongs to, by comparing the
 * `viewItem` pattern **source** (not a sample match - the test must not pass
 * because two patterns happen to overlap).
 */
function surfaceOfEntry(entry: MenuEntry): MenuSurfaceId | undefined {
	const when = entry.when ?? '';
	for (const surface of MENU_SURFACES) {
		if (surface.viewItem) {
			const match = /viewItem =~ \/([^/]+)\//.exec(when);
			if (match && match[1] === surface.viewItem.source) {
				return surface.id;
			}
		} else if (surface.viewItemEquals) {
			if (when.includes(`viewItem == ${surface.viewItemEquals}`)) {
				return surface.id;
			}
		} else if (surface.view) {
			if (when.startsWith(`view == ${surface.view}`)) {
				return surface.id;
			}
		} else if (surface.expands) {
			if (entry.submenu === surface.expands) {
				return surface.id;
			}
		}
	}
	return undefined;
}

describe('menu catalogue', () => {
	it('has unique row ids that are all declared commands', () => {
		const ids = MENU_ROWS.map((row) => row.id);
		assert.equal(new Set(ids).size, ids.length, 'row ids are not unique');
		const declared = new Set(manifest.contributes.commands.map((command) => command.command));
		for (const id of ids) {
			assert.ok(declared.has(id), `${id} is a row but not a contributed command`);
		}
	});

	it('has catalogue labels that match the manifest titles (the UI prefers the manifest)', () => {
		for (const row of MENU_ROWS) {
			const command = manifest.contributes.commands.find((c) => c.command === row.id);
			assert.ok(command, `${row.id} missing from contributes.commands`);
			assert.equal(row.label, command!.title, `${row.id}: catalogue label drifted from the manifest title`);
		}
	});

	it('lists only surfaces this build actually contributes rows for', () => {
		for (const surface of MENU_SURFACES) {
			const entries = manifest.contributes.menus[surface.menuKey] ?? (surface.graphOnly ? graphEntries() : []);
			assert.ok(entries.length > 0, `surface ${surface.id}: menu key ${surface.menuKey} has no entries at all`);
		}
	});

	it('matches every row surface to what the manifest really contributes (drift test)', () => {
		for (const row of MENU_ROWS) {
			for (const surfaceId of row.surfaces) {
				const entries = entriesForSurface(surfaceId).filter((entry) => entry.command === row.id);
				assert.ok(entries.length > 0, `${row.id} lists surface ${surfaceId}, but the manifest never places it there`);
				for (const entry of entries) {
					if (row.required) {
						assert.equal(hasVisibilityFragment(entry, row.id), false, `${row.id} is required but carries a visibility fragment`);
					} else {
						assert.equal(hasVisibilityFragment(entry, row.id), true, `${row.id} entry on ${surfaceId} has no visibility fragment: ${entry.when}`);
					}
				}
			}
		}
	});

	it('matches every manifest entry back to a catalogue row (the other drift direction)', () => {
		const surfacesOf = (command: string, surfaceId: MenuSurfaceId) => MENU_ROWS.find((row) => row.id === command)?.surfaces.includes(surfaceId) ?? false;
		const toggleableKeys: [MenuSurfaceId, string][] = [
			['view.commit', 'view/item/context'],
			['view.branch', 'view/item/context'],
			['view.backup', 'view/item/context'],
			['view.graphGroup', 'view/item/context'],
			['view.title', 'view/title'],
			['submenu.commit', 'geco.commitSubmenu'],
			['submenu.branch', 'geco.branchSubmenu'],
		];
		for (const [surfaceId, menuKey] of toggleableKeys) {
			for (const entry of entriesForSurface(surfaceId)) {
				if (!entry.command) {
					continue;
				}
				const row = MENU_ROWS.find((r) => r.id === entry.command);
				assert.ok(row, `${menuKey} places ${entry.command} on ${surfaceId}, but no catalogue row exists for it`);
				assert.ok(surfacesOf(entry.command, surfaceId), `${entry.command} on ${surfaceId} is missing from row.surfaces in the catalogue`);
			}
		}
	});

	it('appends the submenu guard to every parent that opens a submenu', () => {
		for (const surface of MENU_SURFACES.filter((s) => s.expands)) {
			const entries = (manifest.contributes.menus[surface.menuKey] ?? []).filter((entry) => entry.submenu === surface.expands);
			assert.ok(entries.length > 0, `${surface.id}: nothing opens ${surface.expands}`);
			for (const entry of entries) {
				assert.ok(
					(entry.when ?? '').includes(submenuItemsFragment(surface.expands!)),
					`${surface.id}: the ${surface.expands} parent has no menuHasItems guard: ${entry.when}`,
				);
			}
		}
	});

	it('keeps a required row in every menu we contribute, as the way back', () => {
		for (const surfaceId of MENU_ROWS.find((row) => row.required)!.surfaces) {
			const entries = entriesForSurface(surfaceId).filter((entry) => entry.command === 'geco.customizeMenus');
			assert.ok(entries.length > 0, `surface ${surfaceId}: no required "Customize Context Menus..." entry`);
		}
	});

	it('uses exactly the same fragments in the graph patcher script', () => {
		const graphMenus = graphEntries();
		assert.ok(graphMenus.length >= 17, `the graph script lost entries (${graphMenus.length})`);
		const surfaceForKey: Record<string, MenuSurfaceId> = {
			'scm/historyItem/context': 'graph.commit',
			'scm/historyItemRef/context': 'graph.ref',
			'scm/history/title': 'graph.title',
		};
		for (const entry of graphMenus) {
			const expectedSurface = surfaceForKey[entry.key];
			const row = MENU_ROWS.find((r) => r.id === entry.command);
			assert.ok(row, `graph script contributes unknown command ${entry.command}`);
			assert.ok(row.surfaces.includes(expectedSurface), `${entry.command} is in ${entry.key} but not on ${expectedSurface} in the catalogue`);
			if (row.required) {
				assert.equal(hasVisibilityFragment(entry, row.id), false, `${row.id} is required - no fragment in the graph script`);
			} else {
				assert.equal(hasVisibilityFragment(entry, row.id), true, `${entry.command} graph entry has no visibility fragment: ${entry.when}`);
			}
		}
	});
});

/**
 * The ordering half of "Customize Context Menus": a row can be switched off but
 * not moved, so where a row sits is the manifest's business - and the user's.
 * The branch cleanup has exactly one place: **last in the branch group, right
 * after Create Branch...** - on every surface that shows commit rows, and in
 * the branch group of the built-in graph (`2_branch`, where git.branch is
 * `2_branch@2`).
 */
describe('menu order - Remove Redundant Branches... follows Create Branch...', () => {
	const GROUP = /^(\w+)@(\d+)$/;
	const groupName = (group: string | undefined) => GROUP.exec(group ?? '')?.[1];
	const orderOf = (group: string | undefined) => Number.parseInt(GROUP.exec(group ?? '')?.[2] ?? '-1', 10);

	it('is the last entry of the branch group on every surface that has Create Branch...', () => {
		const surfaces: MenuSurfaceId[] = ['view.commit', 'view.branch', 'submenu.commit', 'submenu.branch'];
		for (const surfaceId of surfaces) {
			const entries = entriesForSurface(surfaceId);
			const create = entries.find((entry) => entry.command === 'geco.createBranch');
			const cleanup = entries.find((entry) => entry.command === 'geco.removeRedundantBranches');
			assert.ok(create && cleanup, `${surfaceId}: both entries must exist`);
			assert.equal(
				groupName(cleanup!.group),
				groupName(create!.group),
				`${surfaceId}: the cleanup belongs in the same (branch) group as Create Branch...`,
			);
			assert.ok(
				orderOf(cleanup!.group) > orderOf(create!.group),
				`${surfaceId}: the cleanup must come after Create Branch... (${create!.group} vs ${cleanup!.group})`,
			);
			const group = entries.filter((entry) => groupName(entry.group) === groupName(cleanup!.group));
			assert.equal(
				group[group.length - 1]!.command,
				'geco.removeRedundantBranches',
				`${surfaceId}: the cleanup must be the last entry of the branch group`,
			);
		}
	});

	it('sits in the built-in branch group of the graph commit row - and never on a ref badge', () => {
		// git.branch ("Create Branch...") is 2_branch@2 in the built-in graph, so
		// the next slot of that group is what "last, right after Create Branch..."
		// means there.
		const entries = graphEntries();
		const commitRow = entries.find((entry) => entry.key === 'scm/historyItem/context' && entry.command === 'geco.removeRedundantBranches');
		assert.ok(commitRow, 'the graph commit row carries the cleanup');
		assert.equal(commitRow!.group, '2_branch@3');

		// The per-ref badge menu must NOT carry the cleanup: VS Code expands
		// every entry there into "Remove Redundant Branches... > <branch>", and
		// a sub-item naming the selected branch reads as "this branch gets
		// deleted" - the opposite of a whole-graph sweep. Rename stays (it is
		// genuinely about the one ref).
		const refRow = entries.find((entry) => entry.key === 'scm/historyItemRef/context' && entry.command === 'geco.removeRedundantBranches');
		assert.equal(refRow, undefined, 'the cleanup must not sit on the ref badge (it would expand into per-branch sub-items)');
		const rename = entries.find((entry) => entry.key === 'scm/historyItemRef/context' && entry.command === 'geco.renameBranch');
		assert.ok(rename, 'rename is still on the badge');
	});
});

interface GraphEntry extends MenuEntry {
	key: string;
}

/**
 * The generated entries inside scripts/apply-graph-menu.mjs, parsed line by
 * line (single quotes for plain `when` strings, backticks for the ones built
 * from the BRANCH_WHEN constant).
 */
function graphEntries(): GraphEntry[] {
	const source = graphScript.slice(graphScript.indexOf('const GRAPH_MENUS'), graphScript.indexOf('const action ='));
	const entries: GraphEntry[] = [];
	let key = '';
	for (const line of source.split('\n')) {
		const keyMatch = /^'([\w/]+)': \[$/.exec(line.trim());
		if (keyMatch) {
			key = keyMatch[1]!;
			continue;
		}
		const entryMatch = /\{ command: '([\w.]+)', when: '([^']*)', group: '([\w@]+)' \}/.exec(line)
			?? /\{ command: '([\w.]+)', when: `([^`]*)`, group: '([\w@]+)' \}/.exec(line);
		if (entryMatch && key) {
			entries.push({ command: entryMatch[1], when: entryMatch[2], group: entryMatch[3], key });
		}
	}
	return entries;
}
