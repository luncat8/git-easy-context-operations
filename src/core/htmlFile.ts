/**
 * HTML detection for "Open Current Version with Live Server".
 *
 * Kept free of any `vscode` import so it can be unit-tested headlessly. The
 * handler resolves a Git revision / diff URI into a plain working-tree
 * `FileUriLike` (see `editorFileArgs.ts`) whose `fsPath` is what we classify.
 *
 * A historical file can arrive with a trailing revision marker on its path
 * (e.g. a `git:` URI's `index.html.git` suffix). `editorFileArgs` strips that
 * before resolving, but we strip defensively here too: if a stray `.git` / `.diff`
 * suffix ever survives resolution, it would otherwise defeat a `.html` match.
 *
 * We also accept the bare `index` entry name (no extension) - the classic web
 * server default document, which is HTML even though it carries no extension.
 */

/** Extensions that mark a file as an HTML entry point Live Server can serve. */
export const HTML_EXTENSIONS = ['.html', '.htm'] as const;

/** Bare filenames (no extension) we treat as HTML entry points. */
export const HTML_ENTRY_NAMES = new Set(['index']);

/** A minimal structural view of a URI - enough to read a path, no `vscode`. */
export interface HtmlCandidatePath {
	readonly fsPath?: string;
	readonly path?: string;
}

/** Drop a trailing `.git` / `.diff` revision marker if one is present. */
export function stripRevisionSuffix(value: string): string {
	return value.replace(/\.(?:git|diff)$/i, '');
}

/**
 * Whether `candidate` is an HTML file Live Server can serve. Accepts `.html`
 * / `.htm` (case-insensitive) and the extension-less `index` entry name, after
 * stripping any revision suffix that survived resolution.
 */
export function isHtmlFile(candidate: HtmlCandidatePath): boolean {
	const raw = candidate.fsPath || candidate.path || '';
	const basename = raw.split(/[\\/]/).pop() ?? raw;
	const stripped = stripRevisionSuffix(basename);
	const lower = stripped.toLowerCase();
	return HTML_EXTENSIONS.some((ext) => lower.endsWith(ext)) || HTML_ENTRY_NAMES.has(lower);
}
