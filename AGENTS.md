# Agents

## Build

The one-command way (Linux, macOS, Windows) - installs what is missing, builds
both `.vsix` files into `dist/`, and leaves no proposed-API manifest behind:

```bash
python3 build.py            # python build.py on Windows
python3 build.py --install  # ...and install the graph build into VS Code
python3 build.py --tests    # run the suite first
```

Or with npm. By default you only need the graph build - it is a superset of the
publishable build (the same extension, plus the proposed-API menus):

```bash
npm install
npm run package:graph
```

This installs the graph flavor in `package.json` temporarily, bundles with esbuild,
runs `vsce`, and restores the manifest. Result:
`dist/git-easy-context-operations-<version>+graph.vsix`

Install in VS Code:
```bash
code --install-extension dist/<new>.vsix
```

Then run "Git Easy Ops: Enable Source Control Graph Menu..." to grant the proposed API.

For the Marketplace-safe build (without graph menus) use:
```bash
npm run package
```

## Versioning and Build Rules

- **Up / bump the version on every big commit** (e.g. `0.4.0` -> `0.4.1` -> `0.4.2`):
  - bump the `"version"` field in `package.json` (and `package-lock.json`).
  - Update all references to the `.vsix` filenames in `README.md`, `AGENTS.md`, and `CHANGELOG.md` to match the new version.
  - **Purpose**: This ensures the user can inspect the version number in VS Code's Extensions view to verify whether the newly built extension is actually installed or if an older build is still cached/active.
- **VSIX Output Location**:
  - All `.vsix` artifacts must be placed in the `dist/` directory (e.g. `dist/...vsix`).
