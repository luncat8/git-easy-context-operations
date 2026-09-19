/**
 * Entry point handed to `@vscode/test-electron` (`extensionTestsPath`).
 * It must export `run()`; a rejection fails the whole integration run.
 */
import { run as smoke } from './smoke';

export async function run(): Promise<void> {
	console.log('Git Easy Ops - VS Code integration smoke test');
	await smoke();
}
