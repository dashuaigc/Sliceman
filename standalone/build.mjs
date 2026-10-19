import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, cp, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const sourceManifest = join(root, 'src/manifest.json');
const manifest = JSON.parse(await readFile(sourceManifest, 'utf8'));
manifest.id = 'com.sliceman.plugin.local';
manifest.name = 'Sliceman';
for (const panel of manifest.entrypoints) {
  panel.id = 'sliceman.local.panel';
  panel.label.default = 'Sliceman';
}
const name = `Sliceman_Setup_v${manifest.version}`;
const release = join(here, 'release');
const output = join(release, name);
const plugin = join(output, 'plugin');
await mkdir(plugin, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/ui/panel.js'], bundle: true, format: 'cjs',
  outfile: join(plugin, 'panel.js'), platform: 'browser', target: ['chrome88'],
  external: ['photoshop', 'uxp'],
  plugins: [{ name: 'local-edition-manifest', setup(builder) {
    builder.onLoad({ filter: /[\\/]manifest\.json$/ }, (args) => {
      if (resolve(args.path) === sourceManifest) return { contents: JSON.stringify(manifest), loader: 'json' };
    });
  } }],
});
await writeFile(join(plugin, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await copyFile(join(root, 'src/ui/index.html'), join(plugin, 'index.html'));
await copyFile(join(root, 'src/ui/styles.css'), join(plugin, 'styles.css'));
await cp(join(root, 'src/icons'), join(plugin, 'icons'), { recursive: true });
for (const file of ['install.ps1', 'README.md']) {
  const source = await readFile(join(here, file), 'utf8');
  const text = source.replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n');
  await writeFile(join(output, file), (file.endsWith('.ps1') ? '\uFEFF' : '') + text);
}
// Remove only the two obsolete launcher files from this exact release directory.
for (const file of ['一键安装.bat', '卸载本地版.bat']) {
  await unlink(join(output, file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
const icons = join(release, 'icons');
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'build-icons.ps1'), '-OutputDirectory', icons], { stdio: 'inherit' });
const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
for (const [file, icon, define] of [['一键安装.exe', 'install', 'INSTALL'], ['卸载.exe', 'uninstall', 'UNINSTALL']]) {
  execFileSync(compiler, ['/nologo', '/target:winexe', '/platform:anycpu', `/define:${define}`, '/main:LauncherProgram',
    `/out:${join(output, file)}`, `/win32icon:${join(icons, icon + '.ico')}`,
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', join(here, 'Launcher.cs')], { stdio: 'inherit' });
}
await copyFile(join(root, 'LICENSE'), join(output, 'LICENSE'));
// Paths are passed as environment data, never interpolated into PowerShell code.
const zip = join(release, name + '.zip');
execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  '$ErrorActionPreference = "Stop"; Compress-Archive -LiteralPath $env:SLICEMAN_PACKAGE_SOURCE -DestinationPath $env:SLICEMAN_PACKAGE_ZIP -Force'],
  { env: { ...process.env, SLICEMAN_PACKAGE_SOURCE: output, SLICEMAN_PACKAGE_ZIP: zip }, stdio: 'inherit' });
console.log(`Built: ${zip}`);
