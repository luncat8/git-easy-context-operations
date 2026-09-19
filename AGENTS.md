# Agents

## Build

By default you only need the graph build - it is a superset of the publishable build
(the same extension, plus the proposed-API menus):

```bash
npm install
npm run package:graph
```

This installs the graph flavor in `package.json` temporarily, bundles with esbuild,
runs `vsce`, and restores the manifest. Result:
`git-easy-context-operations-0.2.0+graph.vsix`

Install in VS Code:
```bash
code --install-extension git-easy-context-operations-0.2.0+graph.vsix
```

Then run "Git Easy Ops: Enable Source Control Graph Menu..." to grant the proposed API.

For the Marketplace-safe build (without graph menus) use:
```bash
npm run package
```
