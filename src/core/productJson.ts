/**
 * Editing the editor's own `product.json`.
 *
 * VS Code decides who may use a proposed API in `ExtensionsProposedApi`: an
 * installed extension that declares `enabledApiProposals` is blocked unless
 * either
 *
 *   1. `~/.vscode/argv.json` lists it under `enable-proposed-api`
 *      (or vsce was launched with `--enable-proposed-api <id>`), or
 *   2. `product.json` - next to the editor's `resources/app` - lists the
 *      extension under `extensionEnabledApiProposals`.
 *
 * Route 2 is the one that needs no command line at all: the shipped graph build
 * already declares the proposals, so one line in `product.json` is enough. It
 * overwrites the manifest's own list, which is why this module *merges* the
 * entry instead of replacing it.
 *
 * Pure text in, text out; the file IO lives in `src/vscode/graphMenu.ts`.
 */

export const PRODUCT_PROPOSALS_KEY = 'extensionEnabledApiProposals';

/** `product.json` of an installation that lives at `appRoot`. */
export function productJsonPath(appRoot: string): string {
	const trimmed = appRoot.replace(/[/\\]+$/, '');
	return `${trimmed}/product.json`;
}

function parseProduct(text: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`product.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('product.json does not contain a JSON object.');
	}
	return parsed as Record<string, unknown>;
}

/** The proposals `product.json` currently allows, as id -> proposal names. */
export function readProductProposals(text: string): Record<string, string[]> {
	const parsed = parseProduct(text);
	const value = parsed[PRODUCT_PROPOSALS_KEY];
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return {};
	}
	const result: Record<string, string[]> = {};
	for (const [id, proposals] of Object.entries(value as Record<string, unknown>)) {
		if (Array.isArray(proposals)) {
			result[id] = proposals.filter((name): name is string => typeof name === 'string');
		}
	}
	return result;
}

export function allowsProductProposals(text: string, extensionId: string, required: readonly string[]): boolean {
	const allowed = readProductProposals(text)[extensionId] ?? [];
	return required.every((proposal) => allowed.includes(proposal));
}

/** `\t`, two spaces or four - whatever the file already uses. */
function detectIndent(text: string): string {
	const match = /\n([ \t]+)"/.exec(text);
	if (match) {
		return match[1]!;
	}
	const objectMatch = /\n([ \t]+)\S/.exec(text);
	return objectMatch ? objectMatch[1]! : '\t';
}

/**
 * Merge `extensionId` -> `proposals` into `extensionEnabledApiProposals`,
 * keeping every other entry, the key order, the indentation and the trailing
 * newline. Returns the input unchanged when the entry is already complete.
 */
export function addProductProposals(text: string, extensionId: string, proposals: readonly string[]): string {
	const id = extensionId.trim();
	if (!id) {
		throw new Error('An extension id is required.');
	}
	const parsed = parseProduct(text);
	const raw = parsed[PRODUCT_PROPOSALS_KEY];
	if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
		throw new Error(`${PRODUCT_PROPOSALS_KEY} in product.json is not an object.`);
	}

	const current = { ...((raw as Record<string, unknown>) ?? {}) };
	const existing = Array.isArray(current[id]) ? (current[id] as unknown[]).filter((name): name is string => typeof name === 'string') : [];
	const merged = [...existing];
	for (const proposal of proposals) {
		if (!merged.includes(proposal)) {
			merged.push(proposal);
		}
	}
	if (merged.length === existing.length && current[id] !== undefined) {
		return text;
	}
	current[id] = merged;

	const updated = { ...parsed, [PRODUCT_PROPOSALS_KEY]: current };
	const indent = detectIndent(text);
	const trailing = text.endsWith('\n') ? '\n' : '';
	return `${JSON.stringify(updated, null, indent)}${trailing}`;
}

/** Remove the entry again; leaves the (possibly empty) key in place. */
export function removeProductProposals(text: string, extensionId: string): string {
	const parsed = parseProduct(text);
	const raw = parsed[PRODUCT_PROPOSALS_KEY];
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return text;
	}
	const current = { ...(raw as Record<string, unknown>) };
	if (!(extensionId in current)) {
		return text;
	}
	delete current[extensionId];
	const updated = { ...parsed, [PRODUCT_PROPOSALS_KEY]: current };
	const indent = detectIndent(text);
	const trailing = text.endsWith('\n') ? '\n' : '';
	return `${JSON.stringify(updated, null, indent)}${trailing}`;
}
