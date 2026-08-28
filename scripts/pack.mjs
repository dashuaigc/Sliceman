// 把 dist/plugin/ 打成可双击安装的 .ccx（本质就是 zip，manifest.json 必须在压缩包根目录）。
// 环境无 zip 命令，用 Windows 自带 Compress-Archive —— 0.0.10 那个能正常装的包就是它出的，保持一致。
// 版本号取 src/manifest.json，避免 .ccx 文件名和 manifest 里的版本对不上。
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync, copyFileSync, statSync } from 'node:fs';

const OUT_DIR = 'dist';
const SRC_DIR = 'dist/plugin';

if (!existsSync(`${SRC_DIR}/manifest.json`)) {
  console.error(`缺少 ${SRC_DIR}/manifest.json —— 先跑 npm run build`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(`${SRC_DIR}/manifest.json`, 'utf8'));
const zip = `${OUT_DIR}/Sliceman_v${manifest.version}.zip`;
const ccx = `${OUT_DIR}/Sliceman_v${manifest.version}.ccx`;

// 打包前自检：manifest 声明的每个图标，PS 会按 scale 拼 @1x/@2x 去找，逐个断言存在
// （path 是模板不是真文件名，少个 @1x 后缀就是面板标签空白，见 scripts/make-icons.mjs）
const iconSets = [manifest.icons || [], ...(manifest.entrypoints || []).map((e) => e.icons || [])];
const missing = [];
for (const set of iconSets) {
  for (const entry of set) {
    for (const s of entry.scale || [1]) {
      const f = entry.path.replace(/\.png$/i, `@${s}x.png`);
      if (!existsSync(`${SRC_DIR}/${f}`)) missing.push(f);
    }
  }
}
if (missing.length) {
  console.error(`图标缺失（manifest 会解析到这些名字）：\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

for (const f of [zip, ccx]) if (existsSync(f)) rmSync(f);

// -Path 用 目录/* ：压缩包里是扁平内容，不套一层 plugin/ 目录
execFileSync('powershell', [
  '-NoProfile', '-NonInteractive', '-Command',
  `Compress-Archive -Path '${SRC_DIR}/*' -DestinationPath '${zip}' -Force`,
], { stdio: 'inherit' });

copyFileSync(zip, ccx);
console.log(`pack ok → ${ccx}（${(statSync(ccx).size / 1024).toFixed(0)} KB），双击安装；${zip} 为同内容备份`);
