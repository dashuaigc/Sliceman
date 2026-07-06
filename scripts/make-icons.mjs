// 生成插件图标 PNG（零依赖：Node 内置 zlib 手写 PNG）。
// 打包 .ccx 时 manifest 必须声明 icons，本脚本产出 src/icons/ 下的图标。
// 设计：Sliceman 蓝底 (#2680eb) + 一条白色反斜线，呼应"切图"。
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

function makeRgba(n) {
  const rgba = Buffer.alloc(n * n * 4);
  const th = Math.max(2, Math.round(n / 7));  // 斜线粗细随尺寸缩放
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const dist = Math.abs(x - (n - 1 - y));   // 到反对角线的距离
      let r = 0x26, g = 0x80, b = 0xeb;         // 底色蓝
      if (dist < th) { r = g = b = 0xff; }      // 白色切线
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 0xff;
    }
  }
  return rgba;
}

await mkdir('src/icons', { recursive: true });
await writeFile('src/icons/icon.png', png(24, makeRgba(24)));
await writeFile('src/icons/icon@2x.png', png(48, makeRgba(48)));
console.log('icons ok → src/icons/icon.png (24), src/icons/icon@2x.png (48)');
