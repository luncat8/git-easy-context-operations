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
	/**
	 * Proposals the installed VSIX declares, before VS Code filters them for
	 * this session. Read from the runtime manifest's
	 * `originalEnabledApiProposals`; optional because older test fixtures and
	 * callers only supply {@link GraphMenuBuild.hasProposals}.
	 */
	declaredProposals?: readonly string[];
	/**
	 * Proposals VS Code lets this extension use *in this session* - the
	 * runtime manifest's `enabledApiProposals`. The workbench rewrites that
	 * list from the grant that actually applies to the session (product.json,
	 * argv.json / launch flag, Extension Development Host) before it
	 * registers extension points, emptying it when no grant applies. Unlike
	 * the grant *files* (which say what a restart would allow), this list is
	 * what decides whether the proposed menu contributions were registered -
	 * i.e. whether the graph menu is really on screen.
	 */
	enabledProposals?: readonly string[];
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
	/**
	 * The graph menus are registered in *this* session
	 * ({@link isGraphMenuVisible}) - unlike {@link GraphMenuStatus.ready},
	 * which only says the build and a persistent grant are in place. The two
	 * differ in both directions: a grant written a minute ago is `ready` but
	 * not visible until the restart, and a per-launch
	 * `--enable-proposed-api` is visible without being `ready`.
	 */
	visible: boolean;
	/** What is missing, as copy-pasteable steps, in the order they must happen. */
	steps: string[];
	/** The report written to the output log. */
	report: string;
}

export const GRAPH_MENU_KEYS = ['scm/historyItem/context', 'scm/historyItemRef/context', 'scm/history/title'] as const;

/** The proposals a graph build declares. */
export const GRAPH_MENU_PROPOSALS = ['contribSourceControlHistoryItemMenu', 'contribSourceControlHistoryTitleMenu'] as const;

/**
 * Context key mirroring {@link isGraphMenuVisible}: `true` only while the
 * proposed graph menus are registered in this session. The
 * "Why Don't I See the Menus?" entries carry `!geco.graphMenuVisible`, so the
 * question is only offered while it is still open. Unset (extension not yet
 * activated) reads as "not visible" by that negation, so the help entry is
 * the fail-open default until the extension reports otherwise.
 */
export const GRAPH_MENU_VISIBLE_CONTEXT_KEY = 'geco.graphMenuVisible';

/**
 * Whether the proposed Source Control Graph menus are really on screen in
 * this session: this build contributes every graph menu key and VS Code
 * enabled every proposal behind them (see
 * {@link GraphMenuBuild.enabledProposals} for why that list is the
 * session's truth, and not the grant files). Every key and every proposal
 * must be present - a partial grant (say, only the title menu) still leaves
 * a "why don't I see..." question worth answering, and the extension's own
 * grant writers always write both proposals together.
 */
export function isGraphMenuVisible(build: GraphMenuBuild): boolean {
	// Proposal entries may carry a version suffix (`proposal@3`); the menu
	// registration only looks at the bare name.
	const enabled = new Set((build.enabledProposals ?? []).map((proposal) => proposal.split('@')[0]));
	return GRAPH_MENU_KEYS.every((key) => build.menuKeys.includes(key))
		&& GRAPH_MENU_PROPOSALS.every((proposal) => enabled.has(proposal));
}

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
	// `hasProposals` is about what the VSIX declares; when the caller knows
	// the declared list it wins over the boolean, so the session-filtered
	// `enabledApiProposals` can never turn a graph build into a publishable
	// one in this diagnosis.
	const declared = build.declaredProposals;
	const declaresProposals = declared !== undefined
		? (GRAPH_MENU_PROPOSALS as readonly string[]).some((proposal) => declared.includes(proposal))
		: build.hasProposals;
	const ready = declaresProposals && (allowedInArgv || allowedInProduct);
	const visible = isGraphMenuVisible(build);

	const steps: string[] = [];
	if (!declaresProposals) {
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
		`  installed build:        ${declaresProposals ? 'graph build (declares enabledApiProposals)' : 'publishable build (no proposed APIs)'}`,
		`  contributed menu keys:  ${build.menuKeys.length > 0 ? build.menuKeys.join(', ') : '(none)'}`,
		`  product.json:           ${build.productPath}${productExists ? '' : ' (does not exist yet)'}`,
		`  proposal allowed there: ${allowedInProduct ? 'YES' : 'no'}`,
		`  runtime arguments file: ${build.argvPath}${argvExists ? '' : ' (does not exist yet)'}`,
		`  proposal allowed there: ${allowedInArgv ? 'YES' : 'no'}`,
		`  visible in this session: ${visible ? 'YES - the graph menus are on screen' : 'no'}`,
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

	return { build, argvExists, allowedInArgv, productExists, allowedInProduct, ready, visible, steps, report };
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
