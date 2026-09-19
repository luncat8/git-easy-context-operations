// Bundles src/extension.ts -> dist/extension.js (CommonJS, `vscode` stays external).
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
	entryPoints: ['src/extension.ts'],
	outfile: 'dist/extension.js',
	bundle: true,
	format: 'cjs',
	platform: 'node',
	target: 'node18',
	sourcemap: !production,
	minify: production,
	logLevel: 'info',
	external: ['vscode'],
};

async function main() {
	if (watch) {
		const ctx = await esbuild.context(options);
		await ctx.watch();
		return;
	}
	await esbuild.build(options);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
