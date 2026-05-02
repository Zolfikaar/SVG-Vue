"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const svg_process_1 = require("./svg-process");
const COMMAND_ID = 'svg-to-vue.generateComponents';
const OUTPUT_CHANNEL_NAME = 'SVG to Vue';
function activate(context) {
    const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    const disposable = vscode.commands.registerCommand(COMMAND_ID, async (uri) => {
        try {
            const folderUri = await resolveSourceFolder(uri);
            if (!folderUri) {
                return;
            }
            output.appendLine(`Using source folder: ${folderUri.fsPath}`);
            const svgFiles = await findSvgFiles(folderUri);
            if (svgFiles.length === 0) {
                const message = 'SVG to Vue: No SVG files found in the selected folder.';
                vscode.window.showWarningMessage(message);
                output.appendLine(message);
                return;
            }
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders?.length) {
                vscode.window.showErrorMessage('SVG to Vue: Please open a workspace folder before running this command.');
                return;
            }
            const workspaceRoot = getWorkspaceRootForSource(workspaceFolders, folderUri);
            const { srcFolder, isNuxt } = await resolveSourceOutputFolder(workspaceRoot, folderUri, output);
            console.log("OUTPUT ROOT:", srcFolder.fsPath);
            const iconsFolder = vscode.Uri.joinPath(srcFolder, 'icons');
            const componentsFolder = vscode.Uri.joinPath(srcFolder, 'components');
            await ensureDirectory(iconsFolder);
            await clearIconsFolderVueFiles(iconsFolder);
            await ensureDirectory(componentsFolder);
            if (isNuxt) {
                output.appendLine('Detected Nuxt project; using app root for output.');
                try {
                    await ensureNuxtComponentsConfig(workspaceRoot, output);
                }
                catch (err) {
                    output.appendLine(`Could not update Nuxt config automatically: ${String(err)}`);
                }
            }
            output.appendLine(`Source output folder: ${srcFolder.fsPath}`);
            output.appendLine(`Icons output folder: ${iconsFolder.fsPath}`);
            output.appendLine(`Components output folder: ${componentsFolder.fsPath}`);
            let generatedCount = 0;
            const registryEntries = [];
            const usedNames = new Set();
            for (const file of svgFiles) {
                try {
                    const svgContent = await vscode.workspace.fs.readFile(file);
                    const componentSource = convertSvgToVueComponent(file, Buffer.from(svgContent).toString('utf8'));
                    if (!componentSource) {
                        output.appendLine(`Skipped: ${file.fsPath} (could not parse <svg>)`);
                        continue;
                    }
                    const iconFileBaseName = ensureUniqueIconName(svgFileNameToKebabCase(file), usedNames);
                    const componentFileName = `${iconFileBaseName}.vue`;
                    const targetUri = vscode.Uri.joinPath(iconsFolder, componentFileName);
                    await vscode.workspace.fs.writeFile(targetUri, Buffer.from(componentSource, 'utf8'));
                    registryEntries.push({
                        iconName: iconFileBaseName,
                        importName: kebabToPascal(iconFileBaseName),
                        fileName: componentFileName
                    });
                    generatedCount += 1;
                    output.appendLine(`Generated: ${targetUri.fsPath}`);
                }
                catch (err) {
                    output.appendLine(`Error processing ${file.fsPath}: ${String(err)}`);
                }
            }
            registryEntries.sort((a, b) => a.iconName.localeCompare(b.iconName));
            if (registryEntries.length > 0) {
                await writeIconRegistry(iconsFolder, registryEntries);
                await writeGlobalIconComponent(componentsFolder);
                output.appendLine(`Generated: ${vscode.Uri.joinPath(iconsFolder, 'index.ts').fsPath}`);
                output.appendLine(`Generated: ${vscode.Uri.joinPath(componentsFolder, 'Icon.vue').fsPath}`);
            }
            const finalMessage = generatedCount === 0
                ? 'SVG to Vue: No components were generated.'
                : `SVG to Vue: ${generatedCount} component${generatedCount === 1 ? '' : 's'} generated successfully`;
            if (generatedCount === 0) {
                vscode.window.showWarningMessage(finalMessage);
            }
            else {
                vscode.window.showInformationMessage(finalMessage);
            }
            output.appendLine(finalMessage);
            output.show(true);
        }
        catch (error) {
            const message = `SVG to Vue: Unexpected error - ${String(error)}`;
            vscode.window.showErrorMessage(message);
            output.appendLine(message);
        }
    });
    context.subscriptions.push(disposable, output);
}
function deactivate() {
    // nothing to clean up
}
async function resolveSourceFolder(uri) {
    // If command is triggered from the explorer context menu, we should receive the folder URI.
    if (uri && uri.scheme === 'file') {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.Directory) {
            return uri;
        }
    }
    // Otherwise, show a folder picker to the user.
    const selection = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select folder with SVG icons'
    });
    if (!selection || selection.length === 0) {
        return undefined;
    }
    return selection[0];
}
async function findSvgFiles(folder) {
    const result = [];
    async function walk(dir) {
        const entries = await vscode.workspace.fs.readDirectory(dir);
        for (const [name, type] of entries) {
            const entryUri = vscode.Uri.joinPath(dir, name);
            if (type & vscode.FileType.Directory) {
                await walk(entryUri);
            }
            else if (type & vscode.FileType.File) {
                if (name.toLowerCase().endsWith('.svg')) {
                    result.push(entryUri);
                }
            }
        }
    }
    await walk(folder);
    return result;
}
async function ensureDirectory(uri) {
    try {
        await vscode.workspace.fs.stat(uri);
    }
    catch {
        await vscode.workspace.fs.createDirectory(uri);
    }
}
function normalizePathForComparison(path) {
    return path.replace(/\\/g, '/').toLowerCase();
}
function getWorkspaceRootForSource(workspaceFolders, sourceFolderUri) {
    const sourcePath = normalizePathForComparison(sourceFolderUri.fsPath);
    let best;
    let bestLength = 0;
    for (const folder of workspaceFolders) {
        const rootPath = normalizePathForComparison(folder.uri.fsPath);
        if (sourcePath.startsWith(rootPath) && rootPath.length > bestLength) {
            best = folder;
            bestLength = rootPath.length;
        }
    }
    return (best ?? workspaceFolders[0]).uri;
}
/**
 * If the source path is under an "app" directory (e.g. .../app/assets/icons),
 * return the Nuxt project root (the parent of "app"). Otherwise return null.
 * This avoids relying on stat() which can fail with path/casing on some setups.
 */
function getNuxtRootFromAppPath(sourceFolderUri) {
    const normalized = sourceFolderUri.fsPath.replace(/\\/g, '/');
    const lower = normalized.toLowerCase();
    const appSegment = '/app/';
    const idx = lower.indexOf(appSegment);
    if (idx === -1) {
        return null;
    }
    const nuxtRootPath = normalized.slice(0, idx);
    if (!nuxtRootPath) {
        return null;
    }
    return vscode.Uri.file(path.resolve(nuxtRootPath));
}
/** Check if the given directory is a Nuxt project root (has nuxt.config.* or an "app" subdirectory). */
async function isNuxtProjectRoot(dirUri) {
    const nuxtConfigNames = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.cjs'];
    for (const name of nuxtConfigNames) {
        try {
            const uri = vscode.Uri.joinPath(dirUri, name);
            await vscode.workspace.fs.stat(uri);
            return true;
        }
        catch {
            // file not found
        }
    }
    try {
        const appUri = vscode.Uri.joinPath(dirUri, 'app');
        const stat = await vscode.workspace.fs.stat(appUri);
        if (stat.type === vscode.FileType.Directory) {
            return true;
        }
    }
    catch {
        // app folder not found
    }
    return false;
}
/** Walk up from the source folder to find the Nuxt project root. */
async function findNuxtRootFromSource(sourceFolderUri, workspaceRootUri) {
    const workspacePath = normalizePathForComparison(workspaceRootUri.fsPath);
    let currentFsPath = sourceFolderUri.fsPath;
    while (currentFsPath) {
        const currentPathNorm = normalizePathForComparison(currentFsPath);
        if (!currentPathNorm.startsWith(workspacePath) && !workspacePath.startsWith(currentPathNorm)) {
            break;
        }
        const currentUri = vscode.Uri.file(currentFsPath);
        if (await isNuxtProjectRoot(currentUri)) {
            return currentUri;
        }
        const parentFsPath = path.dirname(currentFsPath);
        if (!parentFsPath || parentFsPath === currentFsPath) {
            break;
        }
        currentFsPath = parentFsPath;
    }
    return null;
}
async function resolveComponentsFolder(workspaceRoot, sourceFolderUri, output) {
    let nuxtRoot = getNuxtRootFromAppPath(sourceFolderUri);
    if (!nuxtRoot) {
        nuxtRoot = await findNuxtRootFromSource(sourceFolderUri, workspaceRoot);
    }
    else {
        const nuxtRootNorm = normalizePathForComparison(nuxtRoot.fsPath);
        const wsNorm = normalizePathForComparison(workspaceRoot.fsPath);
        if (!nuxtRootNorm.startsWith(wsNorm) && !wsNorm.startsWith(nuxtRootNorm)) {
            nuxtRoot = null;
        }
    }
    if (nuxtRoot) {
        output.appendLine(`Using Nuxt app root: ${nuxtRoot.fsPath}`);
        const appDir = vscode.Uri.joinPath(nuxtRoot, 'app');
        try {
            const appStat = await vscode.workspace.fs.stat(appDir);
            if (appStat.type === vscode.FileType.Directory) {
                const candidates = ['components', 'Components'];
                for (const dirName of candidates) {
                    const candidateUri = vscode.Uri.joinPath(appDir, dirName);
                    try {
                        const stat = await vscode.workspace.fs.stat(candidateUri);
                        if (stat.type === vscode.FileType.Directory) {
                            return { componentsFolder: candidateUri, isNuxt: true };
                        }
                    }
                    catch {
                        // folder does not exist
                    }
                }
                const componentsUri = vscode.Uri.joinPath(appDir, 'components');
                await vscode.workspace.fs.createDirectory(componentsUri);
                return { componentsFolder: componentsUri, isNuxt: true };
            }
        }
        catch {
            // no app directory, fall back to root-level components
        }
        const componentsDir = vscode.Uri.joinPath(nuxtRoot, 'components');
        await ensureDirectory(componentsDir);
        return { componentsFolder: componentsDir, isNuxt: true };
    }
    const candidates = ['components', 'Components'];
    for (const dirName of candidates) {
        const candidateUri = vscode.Uri.joinPath(workspaceRoot, dirName);
        try {
            const stat = await vscode.workspace.fs.stat(candidateUri);
            if (stat.type === vscode.FileType.Directory) {
                return { componentsFolder: candidateUri, isNuxt: false };
            }
        }
        catch {
            // folder does not exist
        }
    }
    const componentsUri = vscode.Uri.joinPath(workspaceRoot, 'components');
    await vscode.workspace.fs.createDirectory(componentsUri);
    return { componentsFolder: componentsUri, isNuxt: false };
}
async function resolveSourceOutputFolder(workspaceRoot, sourceFolderUri, output) {
    const { componentsFolder, isNuxt } = await resolveComponentsFolder(workspaceRoot, sourceFolderUri, output);
    const root = vscode.Uri.file(path.dirname(componentsFolder.fsPath));
    return {
        srcFolder: root,
        isNuxt
    };
}
function svgFileNameToKebabCase(file) {
    const base = file.path.split(/[\\/]/).pop() || 'Icon';
    const withoutExt = base.replace(/\.svg$/i, '');
    const normalized = withoutExt
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
    return normalized || 'icon';
}
function ensureUniqueIconName(baseName, used) {
    if (!used.has(baseName)) {
        used.add(baseName);
        return baseName;
    }
    let index = 2;
    while (used.has(`${baseName}-${index}`)) {
        index += 1;
    }
    const unique = `${baseName}-${index}`;
    used.add(unique);
    return unique;
}
function kebabToPascal(value) {
    return value
        .split('-')
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}
async function writeIconRegistry(iconsFolder, entries) {
    const importLines = entries.map(entry => `import ${entry.importName} from "./${entry.fileName}"`);
    const registryLines = entries.map(entry => `  "${entry.iconName}": ${entry.importName}`);
    const source = `${importLines.join('\n')}\n\n` + `export const icons = {\n${registryLines.join(',\n')}\n}\n`;
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(iconsFolder, 'index.ts'), Buffer.from(source, 'utf8'));
}
async function writeGlobalIconComponent(componentsFolder) {
    const source = `<script setup lang="ts">
import { computed } from "vue"
import { icons } from "../icons"

const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 24 }
})

const iconComponent = computed(() => icons[props.name])
</script>

<template>
  <component
    :is="iconComponent"
    v-if="iconComponent"
    :size="size"
  />
</template>
`;
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(componentsFolder, 'Icon.vue'), Buffer.from(source, 'utf8'));
}
/** Remove previous icon SFCs so re-runs do not leave stale files when SVGs are removed or renamed. */
async function clearIconsFolderVueFiles(iconsFolder) {
    try {
        const entries = await vscode.workspace.fs.readDirectory(iconsFolder);
        for (const [name, type] of entries) {
            if (type === vscode.FileType.File && name.toLowerCase().endsWith('.vue')) {
                await vscode.workspace.fs.delete(vscode.Uri.joinPath(iconsFolder, name));
            }
        }
    }
    catch {
        // folder unreadable; generation will attempt to create files anyway
    }
}
function convertSvgToVueComponent(_file, rawSvg) {
    if (!/<svg[\s\S]*<\/svg>/i.test(rawSvg.trim())) {
        return null;
    }
    let optimized = rawSvg;
    try {
        optimized = (0, svg_process_1.optimizeSvg)(rawSvg);
    }
    catch {
        optimized = rawSvg;
    }
    let doc = (0, svg_process_1.parseSvgDocument)(optimized);
    if (!doc?.documentElement) {
        doc = (0, svg_process_1.parseSvgDocument)(rawSvg);
    }
    if (!doc?.documentElement) {
        return null;
    }
    const svgRoot = doc.documentElement;
    const bbox = (0, svg_process_1.computeContentBBox)(svgRoot);
    const fromGeom = bbox ? (0, svg_process_1.bboxToViewBox)(bbox) : null;
    const viewBox = fromGeom ?? (0, svg_process_1.parseViewBoxFromSvgRoot)(svgRoot) ?? '0 0 24 24';
    let inner = (0, svg_process_1.serializeSvgInnerContent)(svgRoot);
    inner = (0, svg_process_1.applyCurrentColorToFills)(inner);
    const extraAttrs = (0, svg_process_1.formatRootAttributes)(svgRoot);
    const vueComponent = `
<script setup>
defineProps({
  size: { type: [Number, String], default: 24 }
})
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="${viewBox}"
    fill="currentColor"
    xmlns="http://www.w3.org/2000/svg"${extraAttrs}
  >
${inner}
  </svg>
</template>
`.trimStart();
    return vueComponent;
}
async function ensureNuxtComponentsConfig(workspaceRoot, output) {
    // If this Nuxt project uses the app directory, rely on Nuxt's default
    // auto-registration from app/components and do not touch nuxt.config.
    try {
        const appDir = vscode.Uri.joinPath(workspaceRoot, 'app');
        const appStat = await vscode.workspace.fs.stat(appDir);
        if (appStat.type === vscode.FileType.Directory) {
            output.appendLine('Nuxt app directory detected; skipping nuxt.config components modification.');
            return;
        }
    }
    catch {
        // no app directory; proceed with nuxt.config-based components registration
    }
    const nuxtConfigUri = await findNuxtConfigFile(workspaceRoot);
    if (!nuxtConfigUri) {
        output.appendLine('Nuxt config (nuxt.config.ts/js) not found in workspace root; skipping auto components registration.');
        return;
    }
    let fileBuffer;
    try {
        fileBuffer = await vscode.workspace.fs.readFile(nuxtConfigUri);
    }
    catch (err) {
        output.appendLine(`Failed to read Nuxt config: ${String(err)}`);
        return;
    }
    const originalText = Buffer.from(fileBuffer).toString('utf8');
    const updatedText = editNuxtConfigText(originalText);
    if (!updatedText || updatedText === originalText) {
        return;
    }
    try {
        await vscode.workspace.fs.writeFile(nuxtConfigUri, Buffer.from(updatedText, 'utf8'));
        output.appendLine(`Updated Nuxt config to register '~/components' with pathPrefix: false.`);
    }
    catch (err) {
        output.appendLine(`Failed to write updated Nuxt config: ${String(err)}`);
    }
}
function findNuxtConfigFile(workspaceRoot) {
    const candidates = ['nuxt.config.ts', 'nuxt.config.js'];
    return new Promise(resolve => {
        (async () => {
            for (const name of candidates) {
                const candidate = vscode.Uri.joinPath(workspaceRoot, name);
                try {
                    await vscode.workspace.fs.stat(candidate);
                    resolve(candidate);
                    return;
                }
                catch {
                    // continue
                }
            }
            resolve(null);
        })();
    });
}
function editNuxtConfigText(source) {
    const defineIndex = source.indexOf('defineNuxtConfig');
    if (defineIndex === -1) {
        return null;
    }
    const parenIndex = source.indexOf('(', defineIndex);
    if (parenIndex === -1) {
        return null;
    }
    const objStart = source.indexOf('{', parenIndex);
    if (objStart === -1) {
        return null;
    }
    let depth = 0;
    let objEnd = -1;
    for (let i = objStart; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') {
            depth++;
        }
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                objEnd = i;
                break;
            }
        }
    }
    if (objEnd === -1) {
        return null;
    }
    const before = source.slice(0, objStart);
    const objectText = source.slice(objStart, objEnd + 1);
    const after = source.slice(objEnd + 1);
    const updatedObjectText = editNuxtConfigObjectText(objectText);
    if (!updatedObjectText || updatedObjectText === objectText) {
        return null;
    }
    return before + updatedObjectText + after;
}
function editNuxtConfigObjectText(objectText) {
    const existing = ensureComponentsProperty(objectText);
    return existing;
}
function ensureComponentsProperty(objectText) {
    const hasRootPath = /['"`]~\/components['"`]/.test(objectText);
    if (hasRootPath) {
        return null;
    }
    const componentsMatch = /components\s*:\s*\[/m.exec(objectText);
    if (componentsMatch) {
        return appendToExistingComponentsArray(objectText, componentsMatch.index + componentsMatch[0].length - 1);
    }
    return addNewComponentsProperty(objectText);
}
function appendToExistingComponentsArray(objectText, bracketIndex) {
    // bracketIndex points to '['
    let depth = 0;
    let endIndex = -1;
    for (let i = bracketIndex; i < objectText.length; i++) {
        const ch = objectText[i];
        if (ch === '[') {
            depth++;
        }
        else if (ch === ']') {
            depth--;
            if (depth === 0) {
                endIndex = i;
                break;
            }
        }
    }
    if (endIndex === -1) {
        return null;
    }
    const arrayText = objectText.slice(bracketIndex, endIndex + 1);
    const hasRootPath = /['"`]~\/components['"`]/.test(arrayText);
    if (hasRootPath) {
        return null;
    }
    const beforeArray = objectText.slice(0, bracketIndex);
    const afterArray = objectText.slice(endIndex + 1);
    const lineStart = beforeArray.lastIndexOf('\n') + 1;
    const propertyIndent = beforeArray.slice(lineStart).match(/^\s*/)?.[0] ?? '';
    const entryIndent = propertyIndent + '  ';
    const innerIndent = entryIndent + '  ';
    const inner = arrayText.slice(1, -1);
    const hasEntries = inner.trim().length > 0;
    let newArrayText;
    if (!hasEntries) {
        newArrayText =
            '[\n' +
                entryIndent +
                '{\n' +
                innerIndent +
                "path: '~/components',\n" +
                innerIndent +
                'pathPrefix: false\n' +
                entryIndent +
                '}\n' +
                propertyIndent +
                ']';
    }
    else {
        const trimmedInner = inner.trimEnd();
        const needsComma = !trimmedInner.endsWith(',');
        let contentBeforeClosing = inner;
        if (needsComma) {
            contentBeforeClosing = inner.replace(/\s*$/, ',');
        }
        const additions = '\n' +
            entryIndent +
            '{\n' +
            innerIndent +
            "path: '~/components',\n" +
            innerIndent +
            'pathPrefix: false\n' +
            entryIndent +
            '}';
        newArrayText = '[' + contentBeforeClosing + additions + '\n' + propertyIndent + ']';
    }
    return beforeArray + newArrayText + afterArray;
}
function addNewComponentsProperty(objectText) {
    const firstBraceIndex = objectText.indexOf('{');
    if (firstBraceIndex === -1) {
        return null;
    }
    const afterBrace = objectText.slice(firstBraceIndex + 1);
    const hasNewline = afterBrace.startsWith('\n');
    let insertPos = firstBraceIndex + 1;
    let indent = '  ';
    if (hasNewline) {
        insertPos += 1;
        const nextLineEnd = objectText.indexOf('\n', insertPos);
        if (nextLineEnd !== -1) {
            const nextLine = objectText.slice(insertPos, nextLineEnd);
            const detectedIndent = nextLine.match(/^\s*/)?.[0];
            if (detectedIndent && detectedIndent.length > 0) {
                indent = detectedIndent;
            }
        }
    }
    const newline = hasNewline ? '' : '\n';
    const propertyText = newline +
        indent +
        'components: [\n' +
        indent +
        '  {\n' +
        indent +
        "    path: '~/components',\n" +
        indent +
        '    pathPrefix: false\n' +
        indent +
        '  }\n' +
        indent +
        '],' +
        (hasNewline ? '\n' : '');
    return objectText.slice(0, insertPos) + propertyText + objectText.slice(insertPos);
}
//# sourceMappingURL=extension.js.map