import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

const OUT = 'dist/plugin';

// 1) 汇总出一个可被 UXP Developer Tool / .ccx 直接加载的扁平插件目录
await mkdir(OUT, { recursive: true });

// 2) 打包面板脚本（ESM 源 → CJS bundle；photoshop/uxp 为宿主注入，不打包）
await build({
  entryPoints: ['src/ui/panel.js'],
  bundle: true,
  format: 'cjs',
  outfile: `${OUT}/panel.js`,
  platform: 'browser',
  target: ['chrome88'],
  external: ['photoshop', 'uxp'],
});

// 3) 拷贝静态文件到插件目录（扁平结构：manifest/html/css 与 panel.js 同级）
await copyFile('src/manifest.json', `${OUT}/manifest.json`);
await copyFile('src/ui/index.html', `${OUT}/index.html`);
await copyFile('src/ui/styles.css', `${OUT}/styles.css`);

// 注：图标已作为 inline <svg> 内联进 index.html（净化去除了 filter/gradient），
// 不再需要随包拷贝位图目录——位图 <img> 是导致 UXP 面板 native 崩溃的根因。

// 4) 拷贝图标（manifest.icons 引用，路径相对插件根目录）
//    manifest 里的 path 不带倍率后缀，PS 按 scale 自己拼 @1x/@2x —— 所以这两份必须都在；
//    形状必须是透明底留边字形，实心方块会被 PS 按主题着色成接近底色而显示为空白。
//    （两个坑的细节见 scripts/make-icons.mjs 头注释）
await mkdir(`${OUT}/icons`, { recursive: true });
for (const f of [
  'panelIcon-dark.png', 'panelIcon-dark@1x.png', 'panelIcon-dark@2x.png',
  'panelIcon-light.png', 'panelIcon-light@1x.png', 'panelIcon-light@2x.png',
  'pluginIcon.png', 'pluginIcon@1x.png', 'pluginIcon@2x.png',
]) {
  await copyFile(`src/icons/${f}`, `${OUT}/icons/${f}`);
}

console.log(`build ok → ${OUT}/ (load this folder's manifest.json in UXP Developer Tool)`);
