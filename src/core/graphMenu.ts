/**
 * "Why is there no Git Easy Ops entry in the Source Control Graph commit menu?"
 *
 * Because that menu is a **proposed** contribution point. VS Code renders
 * `scm/historyItem/context` for an installed extension only when two things
 * line up:
 *
 *   1. the extension's own manifest declares `enabledApiProposals`
 *      (`contribSourceControlHistoryItemMenu`) and contributes the menu -
 *      the Marketplace rejects such a manifest, so it ships as a separate
 *      "graph build" produced by `npm run package:graph`;
 *   2. the user allowed the proposal for that extension id, either per launch
 *      (`code --enable-proposed-api <id>`) or persistently in `argv.json`.
 *
 * This module works out which of the two is missing and says so precisely,
 * instead of leaving the user staring at an empty context menu. Pure logic, so
 * the diagnostics are covered by tests; the file IO lives in `src/vscode/`.
 */

import { allowsProposedApi } from './argvJson';

export interface GraphMenuBuild {
	/** `<publisher>.<name>` as VS Code knows it. */
	extensionId: string;
	/** The installed build declares `enabledApiProposals` (i.e. it is a graph build). */
	hasProposals: boolean;
	/** Proposed menu keys this build contributes. */
	menuKeys: readonly string[];
	/** Absolute path of the runtime arguments file for this VS Code flavour. */
	argvPath: string;
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
	/** Everything the extension needs is in place - a restart may still be needed. */
	ready: boolean;
	/** What is missing, as copy-pasteable steps, in the order they must happen. */
	steps: string[];
	/** The report written to the output log. */
	report: string;
}

export const GRAPH_MENU_KEYS = ['scm/historyItem/context', 'scm/historyItemRef/context', 'scm/history/title'] as const;

export function assessGraphMenu(build: GraphMenuBuild, argvText: string | undefined): GraphMenuStatus {
	const allowedInArgv = argvText !== undefined && readAllowed(argvText, build.extensionId);
	const argvExists = argvText !== undefined;
	const ready = build.hasProposals && allowedInArgv;

	const steps: string[] = [];
	if (!build.hasProposals) {
		steps.push(
			'The installed build is the publishable one, which does not ask for proposed APIs.',
			'  Build and install the graph build instead:',
			'    npm run package:graph',
			`    ${build.cliCommand} --install-extension ${build.graphVsixName ?? 'git-easy-ops-graph.vsix'}`,
		);
	}
	if (!allowedInArgv) {
		steps.push(
			`Allow the proposal for this extension - add one line to ${build.argvPath}`,
			'  (Command Palette: "Preferences: Configure Runtime Arguments"):',
			`    "${'enable-proposed-api'}": ["${build.extensionId}"]`,
			`  or launch once with: ${build.cliCommand} --enable-proposed-api ${build.extensionId}`,
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
		`  runtime arguments file: ${build.argvPath}${argvExists ? '' : ' (does not exist yet)'}`,
		`  proposal allowed there: ${allowedInArgv ? 'yes' : 'no'}`,
		`  status:                 ${ready ? 'READY - the graph commit menu is available' : 'NOT available yet'}`,
		steps.length > 0 ? `  to fix:\n${steps.map((s) => `    ${s}`).join('\n')}` : '',
		'',
		'Why: VS Code renders a commit context menu in the built-in Source Control',
		'Graph only through the proposed contribution point scm/historyItem/context',
		'(proposal contribSourceControlHistoryItemMenu). A Marketplace-published',
		'extension cannot declare it, which is why this ships as a separate build.',
		'',
		'Always available without any of this: the "Git Easy Ops" view in the Source',
		'Control sidebar (right-click a commit), the Timeline view, the Source Control',
		'title/repository menus and the Command Palette.',
	].filter((line) => line !== '').join('\n');

	return { build, argvExists, allowedInArgv, ready, steps, report };
}

function readAllowed(argvText: string, extensionId: string): boolean {
	return allowsProposedApi(argvText, extensionId);
}
