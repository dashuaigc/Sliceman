// 用真实图片直接验证智能分割算法（Node 本地跑，无需 PS）。
// 用法：node scripts/test-real-image.mjs <png路径>
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { findElementBounds } from '../src/lib/segment.js';

/** 极简 PNG 解码：仅支持 8-bit RGB(A) 无交错。 */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error(`仅支持 8bit RGB/RGBA（当前 depth=${bitDepth} color=${colorType}）`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    cur.set(raw.subarray(rp, rp + stride)); rp += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = cur[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      out[i] = cur[x * bpp]; out[i + 1] = cur[x * bpp + 1]; out[i + 2] = cur[x * bpp + 2];
      out[i + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev.set(cur);
  }
  return { rgba: out, width, height };
}

const file = process.argv[2] || 'tmp_analysis.png';
const { rgba, width, height } = decodePng(readFileSync(file));
const info = {};
const boxes = findElementBounds(rgba, width, height, { factor: 2, minAreaPx: 64, mergeGapPx: 'auto', info });
console.log(`图片 ${width}x${height}，模式=${info.mode}，连通块=${info.components}，阈值=${info.thresholdPx}px`);
console.log(`识别元素 ${boxes.length} 个：`);
boxes.forEach((b, i) => console.log(`  [${i}] x${b.left} y${b.top} w${b.right - b.left} h${b.bottom - b.top}`));
