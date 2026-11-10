// npm run build:dev 后运行，输出与正式版独立的 UDT 测试包。
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const source = resolve('dist/uxp-dev');
const name = 'Sliceman_UDT_SmartPaste_20261110';
const folder = resolve('dist', name), zip = resolve('dist', `${name}.zip`);
const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
manifest.id = 'com.sliceman.plugin.smartpaste.dev';
manifest.name = 'Sliceman Smart Paste Test';
manifest.entrypoints[0].id = 'sliceman.smartpaste.dev';
manifest.entrypoints[0].label.default = 'Sliceman · 批量粘贴测试';
mkdirSync(join(folder, 'icons'), { recursive: true });
writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const iconSpecs = [...(manifest.icons || []), ...(manifest.entrypoints[0].icons || [])];
const icons = [...new Set(iconSpecs.flatMap(icon => [icon.path,
  ...(icon.scale || [1]).map(scale => icon.path.replace(/\.png$/i, `@${scale}x.png`))]))];
const entries = ['manifest.json', 'index.html', 'panel.js', 'styles.css', ...icons, '测试说明.md'];
for (const file of ['index.html', 'panel.js', 'styles.css', ...icons]) copyFileSync(join(source, file), join(folder, file));
copyFileSync('docs/udt-smart-paste-test.md', join(folder, '测试说明.md'));
if (existsSync('dist/smart-paste-360.png')) {
  entries.push('批量粘贴界面.png'); copyFileSync('dist/smart-paste-360.png', join(folder, '批量粘贴界面.png'));
}
const bundle = readFileSync(join(folder, 'panel.js'), 'utf8');
if (!bundle.includes('pasteIntoSmartObjects') || bundle.includes('captureStyleSample') || bundle.includes('captureLayerSample')) {
  throw Error('构建内容不匹配，请先运行 npm run build:dev');
}
if (existsSync(zip)) unlinkSync(zip);
const quote = value => `'${value.replaceAll("'", "''")}'`;
const zipScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$pasteSource = ${quote(folder)}
$pasteArchive = [System.IO.Compression.ZipFile]::Open(${quote(zip)}, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($pasteEntry in @(${entries.map(quote).join(',')})) {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($pasteArchive, (Join-Path $pasteSource $pasteEntry), $pasteEntry, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $pasteArchive.Dispose() }
`;
execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', zipScript], { stdio: 'inherit' });
console.log(`UDT 测试包：${zip} (${Math.round(statSync(zip).size / 1024)} KB)`);
