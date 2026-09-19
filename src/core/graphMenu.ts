/**
 * "Why is there no Git Easy Ops entry in the Source Control Graph commit menu?"
 *
 * Because that menu is a **proposed** contribution point. VS Code renders
 * `scm/historyItem/context` / `scm/historyItemRef/context` / `scm/history/title`
 * for an installed extension only when two things line up:
 *
 *   1. the extension's own manifest declares `enabledApiProposals`
 *      (`contribSourceControlHistoryItemMenu`) and contributes the menus -
 *      the Marketplace rejects such a manifest, so it ships as a separate
 *      "graph build" produced by `npm run package:graph`;
 *   2. the user allowed the proposal for that extension id, through *any* of
 *        - `product.json` -> `extensionEnabledApiProposals` (needs no command
 *          line and no launch flag - the route this module now recommends),
 *        - `argv.json` -> `enable-proposed-api` (persistent, needs one restart),
 *        - `code --enable-proposed-api <id>` on the command line.
 *
 * This module works out which of those halves is missing and says so precisely,
 * instead of leaving the user staring at an empty context menu. Pure logic, so
 * the diagnostics are covered by tests; the file IO lives in `src/vscode/`.
 */

import { allowsProposedApi } from './argvJson';
import { allowsProductProposals } from './productJson';

export interface GraphMenuBuild {
	/** `<publisher>.<name>` as VS Code knows it. */
	extensionId: string;
	/** The installed build declares `enabledApiProposals` (i.e. it is a graph build). */
	hasProposals: boolean;
	/** Proposed menu keys this build contributes. */
	menuKeys: readonly string[];
	/** Absolute path of the runtime arguments file for this VS Code flavour. */
	argvPath: string;
	/** Absolute path of the editor's own `product.json` (next to `resources/app`). */
	productPath: string;
	/** `code`, `code-insiders`, `codium`, ... - what the user types in a terminal. */
	cliCommand: string;
	/** File name of the graph build, when this checkout can produce one. */
	graphVsixName?: string;
}

/** Reads and writes the runtime arguments file; injectable for tests. */
export interface ArgvStore {
	read(): Promise<string | undefined>;
	write(text: string): Promise<void>;
	/** Copy the current file aside before writing; returns the backup path. */
	backup(): Promise<string | undefined>;
}

export interface GraphMenuStatus {
	build: GraphMenuBuild;
	argvExists: boolean;
	allowedInArgv: boolean;
	productExists: boolean;
	allowedInProduct: boolean;
	/** Everything the extension needs is in place - a restart may still be needed. */
	ready: boolean;
	/** What is missing, as copy-pasteable steps, in the order they must happen. */
	steps: string[];
	/** The report written to the output log. */
	report: string;
}

export const GRAPH_MENU_KEYS = ['scm/historyItem/context', 'scm/historyItemRef/context', 'scm/history/title'] as const;

/** The proposals a graph build declares. */
export const GRAPH_MENU_PROPOSALS = ['contribSourceControlHistoryItemMenu', 'contribSourceControlHistoryTitleMenu'] as const;

/** A way to allow the proposal. `none` = just explain. */
export type GraphMenuFix = 'product' | 'argv' | 'none';

export interface GraphMenuFixOption {
	value: GraphMenuFix;
	label: string;
	description: string;
	detail: string;
}

export function assessGraphMenu(build: GraphMenuBuild, argvText: string | undefined, productText?: string): GraphMenuStatus {
	const allowedInArgv = argvText !== undefined && readAllowed(argvText, build.extensionId);
	const argvExists = argvText !== undefined;
	const allowedInProduct = productText !== undefined && allowsProductProposals(productText, build.extensionId, GRAPH_MENU_PROPOSALS);
	const productExists = productText !== undefined;
	const ready = build.hasProposals && (allowedInArgv || allowedInProduct);

	const steps: string[] = [];
	if (!build.hasProposals) {
		steps.push(
			'The installed build is the publishable one, which does not ask for proposed APIs.',
			'  Build and install the graph build instead:',
			'    npm run package:graph',
			`    ${build.cliCommand} --install-extension ${build.graphVsixName ?? 'git-easy-ops-graph.vsix'}`,
		);
	}
	if (!allowedInArgv && !allowedInProduct) {
		steps.push(
			'Allow the proposal for this extension. Pick one - both are one edit:',
			'',
			`  a) The editor's product.json (no command line, survives restarts): ${build.productPath}`,
			`       "${'extensionEnabledApiProposals'}": { "${build.extensionId}": [${GRAPH_MENU_PROPOSALS.map((p) => `"${p}"`).join(', ')}] }`,
			'',
			`  b) The runtime arguments file (Command Palette: "Preferences: Configure Runtime Arguments"): ${build.argvPath}`,
			`       "${'enable-proposed-api'}": ["${build.extensionId}"]`,
			'',
			`  c) Or launch once with: ${build.cliCommand} --enable-proposed-api ${build.extensionId}`,
			'',
			'"Git Easy Ops: Enable Source Control Graph Menu..." does a) or b) for you.',
		);
	}
	if (steps.length > 0) {
		steps.push('Then restart VS Code.');
	}

	const report = [
		'Source Control Graph commit menu',
		`  extension:              ${build.extensionId}`,
		`  installed build:        ${build.hasProposals ? 'graph build (declares enabledApiProposals)' : 'publishable build (no proposed APIs)'}`,
		`  contributed menu keys:  ${build.menuKeys.length > 0 ? build.menuKeys.join(', ') : '(none)'}`,
		`  product.json:           ${build.productPath}${productExists ? '' : ' (does not exist yet)'}`,
		`  proposal allowed there: ${allowedInProduct ? 'YES' : 'no'}`,
		`  runtime arguments file: ${build.argvPath}${argvExists ? '' : ' (does not exist yet)'}`,
		`  proposal allowed there: ${allowedInArgv ? 'YES' : 'no'}`,
		`  status:                 ${ready ? 'READY - the graph commit menu is available' : 'NOT available yet'}`,
		steps.length > 0 ? `  to fix:\n${steps.map((s) => `    ${s}`).join('\n')}` : '',
		'',
		'Why: VS Code renders a commit context menu in the built-in Source Control',
		'Graph only through the proposed contribution point scm/historyItem/context',
		'(proposal contribSourceControlHistoryItemMenu). A Marketplace-published',
		'extension cannot declare it, which is why this ships as a separate build -',
		'and VS Code additionally requires the proposal to be allowed for the id.',
		'',
		'The menu items are not nested under an extension name: they sit in the groups',
		'the built-in entries already use (squash/reword next to Cherry Pick, patch and',
		'fast-forward/force-push in their own sections after Compare). On a branch badge',
		'that is "Rename Branch... > main" - VS Code turns every item contributed to',
		'scm/historyItemRef/context into a per-ref entry of the commit menu, exactly',
		'like the built-in Checkout and Delete Branch.',
		'',
		'Always available without any of this: the "Git Easy Ops" view in the Source',
		'Control sidebar - it now shows the graph itself (lanes, ref badges and the',
		'same context menus) - plus the Timeline view, the Source Control',
		'title/repository menus and the Command Palette.',
	].filter((line) => line !== '').join('\n');

	return { build, argvExists, allowedInArgv, productExists, allowedInProduct, ready, steps, report };
}

/** The fixes "Enable Source Control Graph Menu..." offers, most convenient first. */
export function graphMenuFixOptions(build: GraphMenuBuild): GraphMenuFixOption[] {
	return [
		{
			value: 'product',
			label: 'Add it to product.json (no command line, no launch flag)',
			description: build.productPath,
			detail: [
				`Writes one entry to ${build.productPath}:`,
				'',
				`  "extensionEnabledApiProposals": { "${build.extensionId}": [${GRAPH_MENU_PROPOSALS.map((p) => `"${p}"`).join(', ')}] }`,
				'',
				'A backup is written next to the file and everything else in it stays as it is.',
				'Needs write access to the editor installation and a restart; an update of',
				'VS Code may replace product.json and undo it.',
			].join('\n'),
		},
		{
			value: 'argv',
			label: 'Add it to argv.json (per user, survives updates)',
			description: build.argvPath,
			detail: [
				`Writes one line to ${build.argvPath}:`,
				'',
				`  "enable-proposed-api": ["${build.extensionId}"]`,
				'',
				'A backup is written next to the file, comments are kept, and VS Code must be restarted.',
			].join('\n'),
		},
		{
			value: 'none',
			label: 'Just show me the details',
			description: 'Nothing is written',
			detail: 'The output log lists every half that is missing, with copy-pasteable commands.',
		},
	];
}

function readAllowed(argvText: string, extensionId: string): boolean {
	return allowsProposedApi(argvText, extensionId);
}
