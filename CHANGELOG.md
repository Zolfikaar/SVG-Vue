[0.0.6] - 2026-05-05
Fixed
Activation Error: Resolved the issue where the extension failed to load due to the missing @xmldom/xmldom dependency after installation.

Path Resolution: Fixed the filename undefined error by ensuring absolute paths are correctly derived using uri.fsPath and safe path string handling.

Added
Bundling Process: Integrated esbuild to bundle all source files and external libraries into a single, self-contained dist/extension.js file.

Performance Optimization: Enabled minification for the production bundle to reduce extension size and improve load times.

Build Automation: Updated vscode:prepublish script to ensure every publish cycle uses the latest bundled and minified code.