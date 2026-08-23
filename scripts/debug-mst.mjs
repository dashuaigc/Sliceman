// 调试：复刻彩度门限掩码 → 组件框 → MST 边距分布（对真实图片）
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { labelComponents } from '../src/lib/segment.js';

function decodePng(buf) {
  let pos = 8, width = 0, height = 0, colorType = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3; const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp; const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride); const cur = new Uint8Array(stride); let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]; cur.set(raw.subarray(rp, rp + stride)); rp += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0; let v = cur[x];
      if (filter === 1) v += a; else if (filter === 2) v += b; else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : (pb <= pc ? b : c); }
      cur[x] = v & 255;
    }
    for (let x = 0; x < width; x++) { const i = (y * width + x) * 4; out[i] = cur[x * bpp]; out[i + 1] = cur[x * bpp + 1]; out[i + 2] = cur[x * bpp + 2]; out[i + 3] = bpp === 4 ? cur[x * bpp + 3] : 255; }
    prev.set(cur);
  }
  return { rgba: out, width, height };
}

const { rgba, width, height } = decodePng(readFileSync('tmp_analysis.png'));
const f = 2;
const gw = Math.ceil(width / f), gh = Math.ceil(height / f);
// 背景（边框中位数）
const rs = [], gs = [], bs = [];
for (let x = 0; x < width; x += 4) for (const y of [0, height - 1]) { const i = (y * width + x) * 4; rs.push(rgba[i]); gs.push(rgba[i + 1]); bs.push(rgba[i + 2]); }
for (let y = 0; y < height; y += 4) for (const x of [0, width - 1]) { const i = (y * width + x) * 4; rs.push(rgba[i]); gs.push(rgba[i + 1]); bs.push(rgba[i + 2]); }
const med = a => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
const bg = [med(rs), med(gs), med(bs)];
// 彩度门限掩码（同 segment.js color 模式）
const alpha = new Uint8Array(gw * gh);
for (let gy = 0; gy < gh; gy++) {
  for (let gx = 0; gx < gw; gx++) {
    let solid = 0;
    outer: for (let y = gy * f; y < Math.min(height, (gy + 1) * f); y++)
      for (let x = gx * f; x < Math.min(width, (gx + 1) * f); x++) {
        const i = (y * width + x) * 4;
        const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        const d = Math.max(Math.abs(r - bg[0]), Math.abs(g - bg[1]), Math.abs(b - bg[2]));
        if (d > 24 && Math.max(r, g, b) - Math.min(r, g, b) > 24) { solid = 1; break outer; }
      }
    alpha[gy * gw + gx] = solid;
  }
}
const comps = labelComponents(alpha, gw, gh, 1);
console.log(`组件 ${comps.length} 个（网格坐标，×2=像素）`);
comps.sort((a, b) => (a.top - b.top) || (a.left - b.left));
comps.forEach((c, i) => console.log(`  [${i}] x${c.left * 2} y${c.top * 2} w${(c.right - c.left) * 2} h${(c.bottom - c.top) * 2}`));
// 组件两两间隙（网格）
const gap = (a, b) => {
  const dx = Math.max(0, Math.max(a.left - b.right, b.left - a.right));
  const dy = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom));
  return Math.hypot(dx, dy);
};
const n = comps.length;
const all = [];
for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) all.push(gap(comps[i], comps[j]));
all.sort((a, b) => a - b);
console.log('全部两两间隙(网格, ×2=px):', all.map(g => (g * 2).toFixed(0)).join(' '));
// MST 边距（Prim）
const inT = new Uint8Array(n); const dist = new Float64Array(n).fill(Infinity); const link = new Int32Array(n).fill(-1);
inT[0] = 1;
for (let j = 1; j < n; j++) { dist[j] = gap(comps[0], comps[j]); link[j] = 0; }
const edges = [];
for (let k = 1; k < n; k++) {
  let m = -1;
  for (let j = 0; j < n; j++) if (!inT[j] && (m < 0 || dist[j] < dist[m])) m = j;
  inT[m] = 1; edges.push(dist[m]);
  for (let j = 0; j < n; j++) { if (inT[j]) continue; const g = gap(comps[m], comps[j]); if (g < dist[j]) { dist[j] = g; link[j] = m; } }
}
edges.sort((a, b) => a - b);
console.log('MST 边距(px):', edges.map(g => (g * 2).toFixed(0)).join(' '));
