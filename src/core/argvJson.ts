/**
 * Editing VS Code's runtime arguments file (`argv.json`).
 *
 * The built-in Source Control Graph only offers a per-commit context menu
 * through the *proposed* contribution point `scm/historyItem/context`
 * (proposal `contribSourceControlHistoryItemMenu` - still proposed as of VS Code
 * 1.10x). An installed extension may use a proposal when its manifest declares
 * `enabledApiProposals` **and** the user allowed it, either per launch
 * (`code --enable-proposed-api <id>`) or persistently via `argv.json`:
 *
 *     { "enable-proposed-api": ["luncat8.git-easy-context-operations"] }
 *
 * `argv.json` is a hand-edited file that allows comments and trailing commas, so
 * this module patches the *text* instead of round-tripping it through JSON.parse
 * (which would throw away every comment the user wrote).
 *
 * Pure functions only - the file IO lives in `src/vscode/graphMenu.ts`, which is
 * what makes this testable without VS Code.
 */

export const PROPOSED_API_KEY = 'enable-proposed-api';

/** The header VS Code itself writes when it creates the file. */
export const ARGV_JSON_HEADER = [
	'// This configuration file allows you to pass permanent command line arguments to VS Code.',
	'// Only a subset of arguments is currently supported to reduce the likelihood of breaking installs.',
	'//',
	'// PLEASE DO NOT CHANGE WITHOUT UNDERSTANDING THE IMPACT',
	'//',
	'// NOTE: Changing this file requires a restart of VS Code.',
].join('\n');

export const DEFAULT_ARGV_JSON = `${ARGV_JSON_HEADER}\n{\n\t// Enables proposed APIs for the listed extensions (needed for the Source Control Graph commit menu).\n}\n`;

/** Dot-directory of the runtime arguments file, by `vscode.env.appName`. */
export function argvJsonDirFor(appName: string): string {
	switch (appName) {
		case 'Visual Studio Code - Insiders':
			return '.vscode-insiders';
		case 'Visual Studio Code - Exploration':
			return '.vscode-exploration';
		case 'VSCodium':
			return '.vscode-oss';
		case 'Code - OSS':
		case 'OSS':
			return '.vscode-oss';
		case 'Cursor':
			return '.cursor';
		case 'Windsurf':
			return '.windsurf';
		default:
			return '.vscode';
	}
}

interface CodeScan {
	/** The text with comments replaced by spaces (same length, same offsets). */
	code: string;
}

/** Blank out `//` and block comments while keeping string literals intact. */
function stripComments(text: string): CodeScan {
	const out: string[] = [];
	let inString = false;
	let quote = '';
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i]!;
		const next = text[i + 1];

		if (inLineComment) {
			out.push(char === '\n' ? '\n' : ' ');
			if (char === '\n') {
				inLineComment = false;
			}
			continue;
		}
		if (inBlockComment) {
			out.push(char === '\n' ? '\n' : ' ');
			if (char === '*' && next === '/') {
				out.push(' ');
				i++;
				inBlockComment = false;
			}
			continue;
		}
		if (inString) {
			out.push(char);
			if (char === '\\') {
				out.push(next ?? '');
				i++;
			} else if (char === quote) {
				inString = false;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			inString = true;
			quote = char;
			out.push(char);
			continue;
		}
		if (char === '/' && next === '/') {
			inLineComment = true;
			out.push('  ');
			i++;
			continue;
		}
		if (char === '/' && next === '*') {
			inBlockComment = true;
			out.push('  ');
			i++;
			continue;
		}
		out.push(char);
	}
	return { code: out.join('') };
}

/** Locate `"enable-proposed-api": [ ... ]` outside comments. Offsets refer to the original text. */
function findProposedApiArray(text: string): { keyStart: number; arrayStart: number; arrayEnd: number; items: string[] } | undefined {
	const { code } = stripComments(text);
	const match = /"enable-proposed-api"\s*:\s*\[([^\]]*)\]/.exec(code);
	if (!match) {
		return undefined;
	}
	const arrayStart = match.index + match[0].indexOf('[');
	const arrayEnd = match.index + match[0].lastIndexOf(']');
	const items = splitArrayItems(match[1]!);
	return { keyStart: match.index, arrayStart, arrayEnd, items };
}

function splitArrayItems(inner: string): string[] {
	return inner
		.split(',')
		.map((item) => item.trim().replace(/^["']|["']$/g, ''))
		.filter(Boolean);
}

export function readsProposedApi(text: string): string[] {
	return findProposedApiArray(text)?.items ?? [];
}

export function allowsProposedApi(text: string, extensionId: string): boolean {
	return readsProposedApi(text).includes(extensionId);
}

/**
 * Add `extensionId` to `enable-proposed-api`, creating the key when needed and
 * leaving every comment, blank line and other setting exactly where it was.
 * Returns the input unchanged when the id is already there.
 */
export function addProposedApi(text: string, extensionId: string): string {
	const id = extensionId.trim();
	if (!id) {
		throw new Error('An extension id is required.');
	}

	const existing = findProposedApiArray(text);
	if (existing) {
		if (existing.items.includes(id)) {
			return text;
		}
		const inner = text.slice(existing.arrayStart + 1, existing.arrayEnd);
		const addition = inner.trim().length === 0 ? `"${id}"` : `${inner.replace(/\s+$/, '')}, "${id}"`;
		return `${text.slice(0, existing.arrayStart + 1)}${addition}${text.slice(existing.arrayEnd)}`;
	}

	if (!text.trim()) {
		return `${ARGV_JSON_HEADER}\n{\n\t"${PROPOSED_API_KEY}": ["${id}"]\n}\n`;
	}

	const open = stripComments(text).code.indexOf('{');
	if (open < 0) {
		throw new Error('argv.json does not contain a JSON object.');
	}
	const afterOpen = text.slice(open + 1);
	const bodyHasSettings = stripComments(afterOpen).code.replace(/[\s,}]/g, '').length > 0;
	const insertion = bodyHasSettings
		? `\n\t"${PROPOSED_API_KEY}": ["${id}"],`
		: `\n\t"${PROPOSED_API_KEY}": ["${id}"]`;
	const closing = bodyHasSettings ? '' : '\n}';
	const tail = bodyHasSettings ? afterOpen : '';
	return `${text.slice(0, open + 1)}${insertion}${tail}${closing}`;
}

/** Remove `extensionId` again (used by "disable"); leaves the key in place. */
export function removeProposedApi(text: string, extensionId: string): string {
	const existing = findProposedApiArray(text);
	if (!existing || !existing.items.includes(extensionId)) {
		return text;
	}
	const remaining = existing.items.filter((item) => item !== extensionId);
	return `${text.slice(0, existing.arrayStart)}[${remaining.map((item) => `"${item}"`).join(', ')}]${text.slice(existing.arrayEnd + 1)}`;
}
