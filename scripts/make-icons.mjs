// 生成插件图标 PNG（零依赖：Node 内置 zlib 手写 PNG）。
//
// Adobe 官方规范（两处图标，别混）：
//   · 插件图标（manifest 根 icons）  文件 24×24 / @2x 48×48，manifest 里必须写 width/height = 48
//   · 面板图标（entrypoint.icons）   文件 23×23 / @2x 46×46，manifest 里写 width/height = 23
//
// ★ 命名是关键：manifest 的 path 是「模板」，不带倍率后缀；磁盘上的文件必须带 @1x/@2x。
//   path: "icons/panelIcon-dark.png" + scale: [1, 2]
//        → PS 实际去找 panelIcon-dark@1x.png 与 panelIcon-dark@2x.png
//   之前写成 scale:[2] + path 里已带 @2x，PS 会去找 ...@2x@2x.png，两个倍率都解析不到 → 标签空白。
//   为兼容个别版本按字面路径取 1x，这里额外再写一份不带后缀的同尺寸文件兜底。
//
// ★ 形状是第二个坑：全不透明铺满的方块会被 PS 按主题着色成接近底色 → 看着就是空白。
//   所以一律「透明底 + 留边字形」：圆角取景框 + 一道对角切割线（呼应切图）。
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function png(n, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8; ihdr[9] = 6;                 // 8-bit, RGBA
  const raw = Buffer.alloc(n * (1 + n * 4));
  for (let y = 0; y < n; y++) {
    raw[y * (1 + n * 4)] = 0;               // filter: none
    for (let x = 0; x < n; x++) {
      const s = (y * n + x) * 4;
      const d = y * (1 + n * 4) + 1 + x * 4;
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2]; raw[d + 3] = rgba[s + 3];
    }
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// 点到线段的距离（画对角切割线用）
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// 透明底上画「留边取景框 + 对角切割线」，用距离场做抗锯齿；rgb 为字形颜色
function makeGlyph(n, rgb) {
  const rgba = Buffer.alloc(n * n * 4);          // 全 0 = 透明
  const m = n * 0.14;                            // 四周留边（官方建议留白，别铺满）
  const lo = m, hi = n - m;                      // 取景框范围
  const cx = n / 2, cy = n / 2;
  const hw = (hi - lo) / 2, hh = hw;
  const frameW = Math.max(1.4, n * 0.085);       // 框线宽
  const cutW = Math.max(1.3, n * 0.075);         // 切割线宽
  const gap = Math.max(1.2, n * 0.07);           // 切割线两端离框留的缝，避免糊成一团
  const c1 = lo + gap, c2 = hi - gap;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = x + 0.5, py = y + 0.5;
      // 轴对齐矩形边框的距离（切比雪夫近似，够用）
      const dFrame = Math.abs(Math.max(Math.abs(px - cx) - hw, Math.abs(py - cy) - hh));
      const dCut = distToSegment(px, py, c2, c1, c1, c2);   // 右上 → 左下
      const aF = frameW / 2 + 0.5 - dFrame;
      const aC = cutW / 2 + 0.5 - dCut;
      let a = Math.max(aF, aC);
      if (a <= 0) continue;
      if (a > 1) a = 1;
      const i = (y * n + x) * 4;
      rgba[i] = rgb[0]; rgba[i + 1] = rgb[1]; rgba[i + 2] = rgb[2]; rgba[i + 3] = Math.round(255 * a);
    }
  }
  return rgba;
}

const LIGHT_GLYPH = [232, 238, 244];   // 深色主题 → 浅色字形
const DARK_GLYPH = [58, 62, 68];       // 浅色主题 → 深色字形

await mkdir('src/icons', { recursive: true });

// 面板停靠图标：23 / 46，明暗两版；带 @1x/@2x 后缀 + 一份无后缀兜底
const panels = [
  ['panelIcon-dark', LIGHT_GLYPH],
  ['panelIcon-light', DARK_GLYPH],
];
for (const [base, rgb] of panels) {
  const at1 = png(23, makeGlyph(23, rgb));
  await writeFile(`src/icons/${base}@1x.png`, at1);
  await writeFile(`src/icons/${base}@2x.png`, png(46, makeGlyph(46, rgb)));
  await writeFile(`src/icons/${base}.png`, at1);          // 兜底：按字面路径取 1x 的实现
}

// 插件图标（Plugins 面板列表用）：24 / 48，PS 会自己着色，只给一版浅字形
const plugin1x = png(24, makeGlyph(24, LIGHT_GLYPH));
await writeFile('src/icons/pluginIcon@1x.png', plugin1x);
await writeFile('src/icons/pluginIcon@2x.png', png(48, makeGlyph(48, LIGHT_GLYPH)));
await writeFile('src/icons/pluginIcon.png', plugin1x);     // 兜底

console.log('icons ok → panelIcon-dark/-light @1x(23)/@2x(46) + pluginIcon @1x(24)/@2x(48)，透明底留边字形');
