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

// 4) 拷贝图标（打包 .ccx 时 manifest.icons 引用，路径相对插件根目录）
await mkdir(`${OUT}/icons`, { recursive: true });
await copyFile('src/icons/icon.png', `${OUT}/icons/icon.png`);
await copyFile('src/icons/icon@2x.png', `${OUT}/icons/icon@2x.png`);

console.log(`build ok → ${OUT}/ (load this folder's manifest.json in UXP Developer Tool)`);
