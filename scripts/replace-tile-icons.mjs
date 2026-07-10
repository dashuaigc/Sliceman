// 用 src/ui/svg/01..04.svg 替换 index.html 里 4 个磁贴图标（tile-icon）。
// 这些是 image-trace 的高精度彩色矢量：整数化坐标（图标仅 34px，肉眼无损）大幅减体积/解析负载，
// 加 viewBox、去 width/height、注入 class，再按出现顺序替换 4 个 tile-icon。
import { readFileSync, writeFileSync } from 'node:fs';

const HTML = 'src/ui/index.html';

function processSvg(raw) {
  let s = raw.replace(/<\?xml[^?]*\?>\s*/g, '');                 // 去 xml 声明
  s = s.replace(/-?\d+\.\d+/g, (m) => String(Math.round(parseFloat(m))));  // 坐标整数化
  s = s.replace(/<svg\b([^>]*)>/, (_, attrs) => {
    const w = (attrs.match(/width="(\d+)"/) || [])[1] || '128';
    const h = (attrs.match(/height="(\d+)"/) || [])[1] || '128';
    attrs = attrs.replace(/\s(width|height)="[^"]*"/g, '').replace(/\sversion="[^"]*"/g, '');
    return `<svg class="tile-icon" viewBox="0 0 ${w} ${h}"${attrs}>`;
  });
  return s.replace(/\s*\n\s*/g, '').trim();                      // 压平空白
}

const icons = ['01', '02', '03', '04'].map((n) => processSvg(readFileSync(`src/ui/svg/${n}.svg`, 'utf8')));

let html = readFileSync(HTML, 'utf8');
let i = 0;
html = html.replace(/<svg class="tile-icon"[\s\S]*?<\/svg>/g, () => icons[i++] ?? '');
writeFileSync(HTML, html);
console.log('替换 tile-icon 数量:', i, '（应为 4）');
