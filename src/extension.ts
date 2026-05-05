import * as path from 'path';
import * as vscode from 'vscode';

import {
  applyCurrentColorToFills,
  bboxToViewBox,
  computeContentBBox,
  formatRootAttributes,
  optimizeSvg,
  parseSvgDocument,
  parseViewBoxFromSvgRoot,
  serializeSvgInnerContent
} from './svg-process';

const COMMAND_ID = 'svg-to-vue.generateComponents';
const OUTPUT_CHANNEL_NAME = 'SVG to Vue';

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);

  const disposable = vscode.commands.registerCommand(
    COMMAND_ID,
    async (uri?: vscode.Uri) => {
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
        console.log("OUTPUT ROOT:", srcFolder.fsPath)
        const iconsFolder = vscode.Uri.joinPath(srcFolder, 'icons');
        const componentsFolder = vscode.Uri.joinPath(srcFolder, 'components');
        await ensureDirectory(iconsFolder);
        await clearIconsFolderVueFiles(iconsFolder);
        await ensureDirectory(componentsFolder);
        if (isNuxt) {
          output.appendLine('Detected Nuxt project; using app root for output.');
          try {
            await ensureNuxtComponentsConfig(workspaceRoot, output);
          } catch (err) {
            output.appendLine(`Could not update Nuxt config automatically: ${String(err)}`);
          }
        }
        output.appendLine(`Source output folder: ${srcFolder.fsPath}`);
        output.appendLine(`Icons output folder: ${iconsFolder.fsPath}`);
        output.appendLine(`Components output folder: ${componentsFolder.fsPath}`);

        let generatedCount = 0;
        const registryEntries: Array<{ iconName: string; importName: string; fileName: string }> = [];
        const usedNames = new Set<string>();
        for (const file of svgFiles) {
          try {
            const svgContent = await vscode.workspace.fs.readFile(file);
            const componentSource = convertSvgToVueComponent(
              file,
              Buffer.from(svgContent).toString('utf8')
            );
            if (!componentSource) {
              output.appendLine(`Skipped: ${file.fsPath} (could not parse <svg>)`);
              continue;
            }

            const iconFileBaseName = ensureUniqueIconName(svgFileNameToKebabCase(file), usedNames);
            const componentFileName = `${iconFileBaseName}.vue`;
            const targetUri = vscode.Uri.joinPath(iconsFolder, componentFileName);
            await vscode.workspace.fs.writeFile(
              targetUri,
              Buffer.from(componentSource, 'utf8')
            );
            registryEntries.push({
              iconName: iconFileBaseName,
              importName: kebabToPascal(iconFileBaseName),
              fileName: componentFileName
            });
            generatedCount += 1;
            output.appendLine(`Generated: ${targetUri.fsPath}`);
          } catch (err) {
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

        const finalMessage =
          generatedCount === 0
            ? 'SVG to Vue: No components were generated.'
            : `SVG to Vue: ${generatedCount} component${generatedCount === 1 ? '' : 's'} generated successfully`;

        if (generatedCount === 0) {
          vscode.window.showWarningMessage(finalMessage);
        } else {
          vscode.window.showInformationMessage(finalMessage);
        }
        output.appendLine(finalMessage);
        output.show(true);
      } catch (error) {
        const message = `SVG to Vue: Unexpected error - ${String(error)}`;
        vscode.window.showErrorMessage(message);
        output.appendLine(message);
      }
    }
  );

  context.subscriptions.push(disposable, output);
}

export function deactivate() {
  // nothing to clean up
}

async function resolveSourceFolder(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
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

async function findSvgFiles(folder: vscode.Uri): Promise<vscode.Uri[]> {
  const result: vscode.Uri[] = [];

  async function walk(dir: vscode.Uri): Promise<void> {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    for (const [name, type] of entries) {
      const entryUri = vscode.Uri.joinPath(dir, name);
      if (type & vscode.FileType.Directory) {
        await walk(entryUri);
      } else if (type & vscode.FileType.File) {
        if (name.toLowerCase().endsWith('.svg')) {
          result.push(entryUri);
        }
      }
    }
  }

  await walk(folder);
  return result;
}

async function ensureDirectory(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    await vscode.workspace.fs.createDirectory(uri);
  }
}

function normalizePathForComparison(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

function getWorkspaceRootForSource(
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  sourceFolderUri: vscode.Uri
): vscode.Uri {
  const sourcePath = normalizePathForComparison(sourceFolderUri.fsPath);
  let best: vscode.WorkspaceFolder | undefined;
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
function getNuxtRootFromAppPath(sourceFolderUri: vscode.Uri): vscode.Uri | null {
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
async function isNuxtProjectRoot(dirUri: vscode.Uri): Promise<boolean> {
  const nuxtConfigNames = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.cjs'];
  for (const name of nuxtConfigNames) {
    try {
      const uri = vscode.Uri.joinPath(dirUri, name);
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      // file not found
    }
  }
  try {
    const appUri = vscode.Uri.joinPath(dirUri, 'app');
    const stat = await vscode.workspace.fs.stat(appUri);
    if (stat.type === vscode.FileType.Directory) {
      return true;
    }
  } catch {
    // app folder not found
  }
  return false;
}

/** Walk up from the source folder to find the Nuxt project root. */
async function findNuxtRootFromSource(
  sourceFolderUri: vscode.Uri,
  workspaceRootUri: vscode.Uri
): Promise<vscode.Uri | null> {
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

async function resolveComponentsFolder(
  workspaceRoot: vscode.Uri,
  sourceFolderUri: vscode.Uri,
  output: vscode.OutputChannel
): Promise<{ componentsFolder: vscode.Uri; isNuxt: boolean }> {
  let nuxtRoot: vscode.Uri | null = getNuxtRootFromAppPath(sourceFolderUri);
  if (!nuxtRoot) {
    nuxtRoot = await findNuxtRootFromSource(sourceFolderUri, workspaceRoot);
  } else {
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
          } catch {
            // folder does not exist
          }
        }
        const componentsUri = vscode.Uri.joinPath(appDir, 'components');
        await vscode.workspace.fs.createDirectory(componentsUri);
        return { componentsFolder: componentsUri, isNuxt: true };
      }
    } catch {
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
    } catch {
      // folder does not exist
    }
  }

  const componentsUri = vscode.Uri.joinPath(workspaceRoot, 'components');
  await vscode.workspace.fs.createDirectory(componentsUri);
  return { componentsFolder: componentsUri, isNuxt: false };
}

async function resolveSourceOutputFolder(
  workspaceRoot: vscode.Uri,
  sourceFolderUri: vscode.Uri,
  output: vscode.OutputChannel
): Promise<{ srcFolder: vscode.Uri; isNuxt: boolean }> {

  const { componentsFolder, isNuxt } =
    await resolveComponentsFolder(workspaceRoot, sourceFolderUri, output);

  const root = vscode.Uri.file(path.dirname(componentsFolder.fsPath));

  return {
    srcFolder: root,
    isNuxt
  };
}

function svgFileNameToKebabCase(file: vscode.Uri): string {
  const base = path.basename(file.fsPath || '') || 'Icon';
  const withoutExt = base.replace(/\.svg$/i, '');
  const normalized = withoutExt
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return normalized || 'icon';
}

function ensureUniqueIconName(baseName: string, used: Set<string>): string {
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

function kebabToPascal(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

async function writeIconRegistry(
  iconsFolder: vscode.Uri,
  entries: Array<{ iconName: string; importName: string; fileName: string }>
): Promise<void> {
  const importLines = entries.map(entry => `import ${entry.importName} from "./${entry.fileName}"`);
  const registryLines = entries.map(entry => `  "${entry.iconName}": ${entry.importName}`);
  const source =
    `${importLines.join('\n')}\n\n` + `export const icons = {\n${registryLines.join(',\n')}\n}\n`;
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(iconsFolder, 'index.ts'),
    Buffer.from(source, 'utf8')
  );
}

async function writeGlobalIconComponent(componentsFolder: vscode.Uri): Promise<void> {
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
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(componentsFolder, 'Icon.vue'),
    Buffer.from(source, 'utf8')
  );
}

/** Remove previous icon SFCs so re-runs do not leave stale files when SVGs are removed or renamed. */
async function clearIconsFolderVueFiles(iconsFolder: vscode.Uri): Promise<void> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(iconsFolder);
    for (const [name, type] of entries) {
      if (type === vscode.FileType.File && name.toLowerCase().endsWith('.vue')) {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(iconsFolder, name));
      }
    }
  } catch {
    // folder unreadable; generation will attempt to create files anyway
  }
}

function convertSvgToVueComponent(_file: vscode.Uri, rawSvg: string): string | null {
  if (!/<svg[\s\S]*<\/svg>/i.test(rawSvg.trim())) {
    return null;
  }

  let optimized = rawSvg;
  try {
    optimized = optimizeSvg(rawSvg);
  } catch {
    optimized = rawSvg;
  }

  let doc = parseSvgDocument(optimized);
  if (!doc?.documentElement) {
    doc = parseSvgDocument(rawSvg);
  }
  if (!doc?.documentElement) {
    return null;
  }

  const svgRoot = doc.documentElement;
  const bbox = computeContentBBox(svgRoot);
  const fromGeom = bbox ? bboxToViewBox(bbox) : null;
  const viewBox =
    fromGeom ?? parseViewBoxFromSvgRoot(svgRoot) ?? '0 0 24 24';

  let inner = serializeSvgInnerContent(svgRoot);
  inner = applyCurrentColorToFills(inner);
  const extraAttrs = formatRootAttributes(svgRoot);

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

async function ensureNuxtComponentsConfig(
  workspaceRoot: vscode.Uri,
  output: vscode.OutputChannel
): Promise<void> {
  // If this Nuxt project uses the app directory, rely on Nuxt's default
  // auto-registration from app/components and do not touch nuxt.config.
  try {
    const appDir = vscode.Uri.joinPath(workspaceRoot, 'app');
    const appStat = await vscode.workspace.fs.stat(appDir);
    if (appStat.type === vscode.FileType.Directory) {
      output.appendLine('Nuxt app directory detected; skipping nuxt.config components modification.');
      return;
    }
  } catch {
    // no app directory; proceed with nuxt.config-based components registration
  }

  const nuxtConfigUri = await findNuxtConfigFile(workspaceRoot);
  if (!nuxtConfigUri) {
    output.appendLine('Nuxt config (nuxt.config.ts/js) not found in workspace root; skipping auto components registration.');
    return;
  }

  let fileBuffer: Uint8Array;
  try {
    fileBuffer = await vscode.workspace.fs.readFile(nuxtConfigUri);
  } catch (err) {
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
  } catch (err) {
    output.appendLine(`Failed to write updated Nuxt config: ${String(err)}`);
  }
}

function findNuxtConfigFile(workspaceRoot: vscode.Uri): Promise<vscode.Uri | null> {
  const candidates = ['nuxt.config.ts', 'nuxt.config.js'];

  return new Promise(resolve => {
    (async () => {
      for (const name of candidates) {
        const candidate = vscode.Uri.joinPath(workspaceRoot, name);
        try {
          await vscode.workspace.fs.stat(candidate);
          resolve(candidate);
          return;
        } catch {
          // continue
        }
      }
      resolve(null);
    })();
  });
}

function editNuxtConfigText(source: string): string | null {
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
    } else if (ch === '}') {
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

function editNuxtConfigObjectText(objectText: string): string | null {
  const existing = ensureComponentsProperty(objectText);
  return existing;
}

function ensureComponentsProperty(objectText: string): string | null {
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

function appendToExistingComponentsArray(objectText: string, bracketIndex: number): string | null {
  // bracketIndex points to '['
  let depth = 0;
  let endIndex = -1;
  for (let i = bracketIndex; i < objectText.length; i++) {
    const ch = objectText[i];
    if (ch === '[') {
      depth++;
    } else if (ch === ']') {
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

  let newArrayText: string;
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
  } else {
    const trimmedInner = inner.trimEnd();
    const needsComma = !trimmedInner.endsWith(',');

    let contentBeforeClosing = inner;
    if (needsComma) {
      contentBeforeClosing = inner.replace(/\s*$/, ',');
    }

    const additions =
      '\n' +
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

function addNewComponentsProperty(objectText: string): string | null {
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
  const propertyText =
    newline +
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
