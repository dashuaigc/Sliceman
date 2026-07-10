// 把 src/ui/svg/*.svg 净化后内联进 src/ui/index.html，替换其中的 <img src="img/xx.png">。
// 净化目的：去掉 UXP inline SVG 不支持 / 高危的特性，保留纯形状 + 纯色 fill + text。
//   - 删除所有 <filter>/<feDropShadow>（GPU blur，是导致 PS native 崩溃的同类高危项）
//   - linear/radialGradient → 纯色（取中间 stop 作代表色）
//   - 去掉根 <svg> 的 width/height，改由 CSS class 控制尺寸
// 幂等：再次运行时 index.html 已无 <img src="img/..">，不会重复替换。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const SVG_DIR = 'src/ui/svg';
const HTML = 'src/ui/index.html';

// gradient 代表色：取中间 stop（渐变一般由亮到暗，中间最具代表性）
function pickColor(gradBody) {
  const stops = [...gradBody.matchAll(/stop-color="([^"]+)"/g)].map((m) => m[1]);
  if (!stops.length) return '#8a9bb0';
  return stops[Math.floor(stops.length / 2)] || stops[0];
}

function sanitize(svg, cls) {
  // 收集 linear/radialGradient 的 id → 纯色
  const grads = {};
  const gradRe = /<(linear|radial)Gradient id="([^"]+)"[^>]*>([\s\S]*?)<\/\1Gradient>/g;
  for (const m of svg.matchAll(gradRe)) grads[m[2]] = pickColor(m[3]);

  // 删 <defs>（内含 filter 与 gradient 定义）
  svg = svg.replace(/<defs>[\s\S]*?<\/defs>\s*/g, '');
  // url(#id) 引用 → 纯色
  svg = svg.replace(/(fill|stroke)="url\(#([^)]+)\)"/g, (_, prop, id) => `${prop}="${grads[id] || '#8a9bb0'}"`);
  // 去掉 filter 引用属性
  svg = svg.replace(/\s*filter="url\([^)]*\)"/g, '');
  // 根 <svg>：去 width/height，注入 class
  svg = svg.replace(/<svg\b([^>]*)>/, (_, attrs) => {
    attrs = attrs.replace(/\s(width|height)="[^"]*"/g, '');
    return `<svg${cls ? ` class="${cls}"` : ''}${attrs}>`;
  });
  return svg.trim();
}

const svgs = {};
for (const f of readdirSync(SVG_DIR)) {
  if (f.endsWith('.svg')) svgs[f.replace('.svg', '')] = readFileSync(`${SVG_DIR}/${f}`, 'utf8');
}

let html = readFileSync(HTML, 'utf8');
let n = 0;
html = html.replace(/<img\b([^>]*?)\s*\/?>/g, (full, attrs) => {
  const srcM = attrs.match(/src="img\/([^".]+)\.png"/);
  if (!srcM) return full;
  const name = srcM[1];
  const svg = svgs[name];
  if (!svg) { console.warn('缺少 SVG:', name); return full; }
  const clsM = attrs.match(/class="([^"]*)"/);
  n++;
  return sanitize(svg, clsM ? clsM[1] : '');
});
writeFileSync(HTML, html);
console.log(`inline svg 完成：替换了 ${n} 处 <img> → 内联 <svg>`);
