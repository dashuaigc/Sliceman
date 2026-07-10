// 生成插件图标 PNG（零依赖：Node 内置 zlib 手写 PNG）。
// Photoshop 面板停靠图标要求：23×23（@2x 46×46）、PNG、可透明、留边、按主题给深/浅两版。
// 全不透明铺满的方块会被 PS 按主题着色成接近底色 → 显示为空白，故改为“透明底 + 留边字形”。
// 字形：一条对角“切割”斜杠（呼应切图）。
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

// 透明底上画一条留边的对角斜杠（带抗锯齿）；rgb 为字形颜色
function makeGlyph(n, rgb) {
  const rgba = Buffer.alloc(n * n * 4);            // 全 0 = 透明
  const margin = Math.round(n * 0.17);             // 四周留边
  const half = Math.max(1.3, n * 0.10);            // 斜杠半宽
  const lo = margin, hi = n - 1 - margin;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (x < lo || x > hi || y < lo || y > hi) continue;   // 留边，不铺满
      const dist = Math.abs(x + y - (n - 1)) / Math.SQRT2;  // 到反对角线距离
      let a = half + 0.5 - dist;                            // 抗锯齿斜坡
      if (a <= 0) continue;
      if (a > 1) a = 1;
      const i = (y * n + x) * 4;
      rgba[i] = rgb[0]; rgba[i + 1] = rgb[1]; rgba[i + 2] = rgb[2]; rgba[i + 3] = Math.round(255 * a);
    }
  }
  return rgba;
}

const LIGHT_GLYPH = [224, 224, 224];   // 深色主题 → 浅色字形
const DARK_GLYPH = [64, 64, 64];       // 浅色主题 → 深色字形

await mkdir('src/icons', { recursive: true });
await writeFile('src/icons/icon-dark.png', png(23, makeGlyph(23, LIGHT_GLYPH)));
await writeFile('src/icons/icon-dark@2x.png', png(46, makeGlyph(46, LIGHT_GLYPH)));
await writeFile('src/icons/icon-light.png', png(23, makeGlyph(23, DARK_GLYPH)));
await writeFile('src/icons/icon-light@2x.png', png(46, makeGlyph(46, DARK_GLYPH)));
console.log('icons ok → icon-dark/-light .png(23) + @2x(46)，透明底留边斜杠');
